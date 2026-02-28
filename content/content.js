/**
 * Content Script — DOM scanning, word replacement, and popup UI.
 * Runs on every page, processes text nodes and replaces matched vocabulary.
 */
/* global browser, VocabMatcher, GrammarRules */

// ─── Sensitive Page Exclusion ────────────────────
const SENSITIVE_PATTERNS = [
  /^chrome:\/\//, /^about:/, /^moz-extension:/,
  // Financial
  /bank/i, /paypal/i, /stripe\.com/i, /\.gov\//i,
  /banking/i, /investment/i, /brokerage/i, /tax/i, /\birs\b/i,
  // Auth / checkout
  /signin|login|checkout|payment/i,
  // Healthcare
  /health/i, /medical/i, /patient/i, /hipaa/i, /pharmacy/i,
  /insurance/i, /medicare/i, /medicaid/i,
  // Legal
  /attorney/i, /court/i, /legal/i,
];

function _pageHasPasswordFields() {
  return document.querySelectorAll('input[type="password"]').length > 0;
}

async function shouldExcludePage() {
  // Always exclude browser-internal pages
  if (/^(chrome|about|moz-extension):\/\//.test(window.location.href)) return true;

  // Check user preference for sensitive site exclusion
  const { excludeSensitive } = await browser.storage.local.get('excludeSensitive');
  if (excludeSensitive === false) return false; // User explicitly disabled

  // Auto-exclude pages with password fields
  if (_pageHasPasswordFields()) return true;

  // User-configurable blocklist
  const { sensitiveBlocklist = [] } = await browser.storage.local.get('sensitiveBlocklist');
  const href = window.location.href;
  if (sensitiveBlocklist.some(pattern => href.includes(pattern))) return true;

  // Default: exclude sensitive pages
  return SENSITIVE_PATTERNS.some(p => p.test(href));
}

// Wrap everything in an async IIFE so we can await the exclusion check
(async () => {
if (await shouldExcludePage()) return;

  // ─── Main Extension Logic ────────────────────────

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP',
  'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'NOSCRIPT',
  'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME',
]);

const LP_PROCESSED = 'data-lp-processed';
const LP_CLASS = 'lp-vocab-word';

let matcher = null;
let whitelistedDomains = [];
let popupEl = null;

// ─── Theme Detection ─────────────────────────────
function detectTheme() {
  const bg = getComputedStyle(document.body).backgroundColor;
  const match = bg.match(/\d+/g);
  if (!match || match.length < 3) return; // transparent or unparseable

  const [r, g, b] = match.map(Number);
  // Relative luminance (ITU-R BT.709)
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

  const osDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const pageDark = luminance < 0.4;

  // Only override if page disagrees with OS setting
  if (pageDark !== osDark) {
    document.documentElement.setAttribute('data-lp-theme', pageDark ? 'dark' : 'light');
  }
}

// ─── Batched Encounter Recording ─────────────────
const encounterBuffer = [];
let flushTimer = null;

function recordEncounter(wordId, domain, wasClicked) {
  encounterBuffer.push({ word_id: wordId, domain, was_clicked: wasClicked });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushEncounterBuffer, 2000);
  if (encounterBuffer.length >= 50) flushEncounterBuffer();
}

function flushEncounterBuffer() {
  if (encounterBuffer.length === 0) return;
  const batch = encounterBuffer.splice(0);
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  browser.runtime.sendMessage({ type: 'RECORD_ENCOUNTERS_BATCH', encounters: batch });
}

// ─── Initialization ──────────────────────────────
async function init() {
  const { vocabWords, frontendUrl } = await browser.storage.local.get(['vocabWords', 'frontendUrl']);
  if (!vocabWords || vocabWords.length === 0) return;

  // Never translate on Language Planet's own site (would interfere with lessons)
  try {
    const lpHost = frontendUrl ? new URL(frontendUrl).hostname : 'localhost';
    if (window.location.hostname === lpHost) return;
  } catch (_) {
    // frontendUrl is malformed — skip check, allow translation
  }

  // Check whitelist
  const domain = window.location.hostname;
  const response = await browser.runtime.sendMessage({ type: 'GET_WHITELIST' });
  if (response && response.domains) {
    whitelistedDomains = response.domains;
    if (whitelistedDomains.some(d => domain.includes(d) || d.includes(domain))) return;
  }

  matcher = new VocabMatcher(vocabWords);
  detectTheme();
  processDocument();
  observeMutations();

  // Flush encounters on page unload
  window.addEventListener('beforeunload', flushEncounterBuffer);
}

// ─── DOM Processing ──────────────────────────────
function processDocument() {
  if (!matcher) return;
  processNode(document.body);
}

function processNode(root) {
  if (!root) return;

  const walker = document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest(`[${LP_PROCESSED}]`)) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        if (parent.isContentEditable) return NodeFilter.FILTER_REJECT;
        if (node.textContent.trim().length < 2) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  const textNodes = [];
  let node;
  while ((node = walker.nextNode())) textNodes.push(node);

  // Process in batches using requestIdleCallback
  let index = 0;
  function processBatch(deadline) {
    while (index < textNodes.length && deadline.timeRemaining() > 2) {
      replaceInTextNode(textNodes[index]);
      index++;
    }
    if (index < textNodes.length) {
      requestIdleCallback(processBatch);
    }
  }

  if (textNodes.length > 0) {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(processBatch);
    } else {
      textNodes.forEach(replaceInTextNode);
    }
  }
}

function replaceInTextNode(textNode) {
  const text = textNode.textContent;
  const { singles, phrases } = matcher.findMatches(text);
  if (singles.length === 0 && phrases.length === 0) return;

  // Merge singles and phrases into a unified sorted event list
  // Each event: { start, end, type: 'single'|'phrase', data }
  const events = [];

  for (const match of singles) {
    events.push({ start: match.start, end: match.end, type: 'single', data: match });
  }
  for (const phrase of phrases) {
    events.push({ start: phrase.start, end: phrase.end, type: 'phrase', data: phrase });
  }
  events.sort((a, b) => a.start - b.start);

  const fragment = document.createDocumentFragment();
  let lastEnd = 0;
  const domain = window.location.hostname;

  for (const event of events) {
    // Add text before this event
    if (event.start > lastEnd) {
      fragment.appendChild(document.createTextNode(text.substring(lastEnd, event.start)));
    }

    if (event.type === 'single') {
      fragment.appendChild(buildSingleWordSpan(event.data, domain));
    } else {
      fragment.appendChild(buildPhraseSpan(event.data, text, domain));
    }

    lastEnd = event.end;
  }

  // Add remaining text
  if (lastEnd < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastEnd)));
  }

  if (!textNode.parentNode) return;
  textNode.parentNode.replaceChild(fragment, textNode);
}

/**
 * Build a span for a single matched word (preserves current behavior exactly).
 */
function buildSingleWordSpan(match, domain) {
  const span = document.createElement('span');
  span.className = LP_CLASS;
  span.textContent = match.word.term;
  span.setAttribute(LP_PROCESSED, 'true');
  span.dataset.wordId = match.word.id;
  span.dataset.original = match.original;
  span.dataset.translation = match.word.term;
  span.dataset.baseTranslation = match.word.translation || '';
  span.dataset.matchedForm = match.matchedForm || match.original;
  span.dataset.termLanguage = match.word.term_language || 'es';
  span.dataset.pos = match.word.part_of_speech || '';
  span.dataset.hint = match.word.context_hint || '';
  span.dataset.example = match.word.example_sentence || '';
  span.dataset.exampleTranslation = match.word.example_translation || '';
  span.dataset.audioUrl = match.word.pronunciation_audio || '';

  span.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showPopup(span);
    recordEncounter(match.word.id, domain, true);
  });

  recordEncounter(match.word.id, domain, false);
  return span;
}

/**
 * Build a span for a phrase group.
 * Attempts client-side grammar composition first; falls back to word-by-word
 * rendering with async backend upgrade for low-confidence or unmatched patterns.
 */
function buildPhraseSpan(phrase, fullText, domain) {
  const { matches, sourceText, start, end } = phrase;
  const GR = window.GrammarRules;

  // Prepare word data for composition rules
  const wordData = matches.map(m => ({
    word: m.word,
    pos: m.word.part_of_speech || '',
    term: m.word.term,
    original: m.original,
    matchedForm: m.matchedForm,
  }));

  // Detect target language from vocab term data
  const targetLang = matches[0].word.term_language || 'es';

  // Attempt client-side composition
  const composed = GR ? GR.composePhrase(wordData, targetLang) : null;

  const span = document.createElement('span');
  span.setAttribute(LP_PROCESSED, 'true');

  if (composed && composed.source !== 'rules_low') {
    // High-confidence composition — render as a single phrase span
    span.className = 'lp-vocab-phrase';
    span.textContent = composed.translation;
    span.dataset.original = sourceText;
    span.dataset.phraseType = 'composed';
    span.dataset.source = composed.source;
    span.dataset.confidence = String(composed.confidence);
    span.dataset.words = JSON.stringify(matches.map(m => m.word.id));
  } else {
    // Low confidence or no rule match — render words individually inside phrase span
    // Mark for potential async backend upgrade
    span.className = 'lp-vocab-phrase lp-phrase-pending';
    span.dataset.original = sourceText;
    span.dataset.phraseType = 'word-by-word';
    span.dataset.words = JSON.stringify(matches.map(m => m.word.id));
    span.dataset.sourcePhrase = sourceText;
    span.dataset.targetLang = targetLang;

    // Render each match word with gap text between them
    let lastMatchEnd = start;
    for (const match of matches) {
      if (match.start > lastMatchEnd) {
        span.appendChild(document.createTextNode(fullText.substring(lastMatchEnd, match.start)));
      }
      const wordSpan = document.createElement('span');
      wordSpan.className = LP_CLASS;
      wordSpan.textContent = match.word.term;
      wordSpan.dataset.wordId = match.word.id;
      wordSpan.dataset.original = match.original;
      wordSpan.dataset.translation = match.word.term;
      wordSpan.dataset.baseTranslation = match.word.translation || '';
      wordSpan.dataset.matchedForm = match.matchedForm || match.original;
      wordSpan.dataset.termLanguage = match.word.term_language || 'es';
      wordSpan.dataset.pos = match.word.part_of_speech || '';
      wordSpan.dataset.hint = match.word.context_hint || '';
      wordSpan.dataset.example = match.word.example_sentence || '';
      wordSpan.dataset.exampleTranslation = match.word.example_translation || '';
      wordSpan.dataset.audioUrl = match.word.pronunciation_audio || '';
      span.appendChild(wordSpan);
      lastMatchEnd = match.end;
    }
    if (lastMatchEnd < end) {
      span.appendChild(document.createTextNode(fullText.substring(lastMatchEnd, end)));
    }

    // Request async backend translation for pending phrases
    requestPhraseTranslation(span, sourceText, targetLang, matches);
  }

  // Click handler — show phrase popup with all component words
  span.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    showPhrasePopup(span, matches);
    for (const m of matches) {
      recordEncounter(m.word.id, domain, true);
    }
  });

  // Record show encounters for all words
  for (const m of matches) {
    recordEncounter(m.word.id, domain, false);
  }

  return span;
}

/**
 * Request async backend phrase translation via the service worker.
 * On success, upgrades the phrase span from word-by-word to composed.
 */
function requestPhraseTranslation(span, sourcePhrase, targetLang, matches) {
  // Detect source language
  const sourceLang = matches[0].word.search_language || 'en';

  browser.runtime.sendMessage({
    type: 'PHRASE_TRANSLATE',
    source_phrase: sourcePhrase,
    source_language: sourceLang,
    target_language: targetLang,
    word_ids: matches.map(m => m.word.id),
  }).then(response => {
    if (response && response.translated_phrase && span.isConnected) {
      // Upgrade the span from word-by-word to composed
      span.textContent = response.translated_phrase;
      span.className = 'lp-vocab-phrase';
      span.classList.remove('lp-phrase-pending');
      span.dataset.phraseType = 'composed';
      span.dataset.source = response.source || 'backend';
    }
  }).catch(() => {
    // Silent failure — word-by-word rendering remains as fallback
  });
}

// ─── Debounced MutationObserver ──────────────────
function observeMutations() {
  let pendingNodes = [];
  let debounceTimer = null;

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && !node.hasAttribute(LP_PROCESSED)) {
          pendingNodes.push(node);
        }
      }
    }
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      const nodes = pendingNodes.splice(0);
      for (const n of nodes) {
        processNode(n);
      }
    }, 150);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ─── Popup UI (safe DOM construction) ────────────
function createEl(tag, className, textContent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent) el.textContent = textContent;
  return el;
}

function showPhrasePopup(span, matches) {
  hidePopup();

  const original = span.dataset.original || '';
  const phraseType = span.dataset.phraseType || 'word-by-word';
  const composedText = phraseType === 'composed' ? span.textContent : null;

  popupEl = document.createElement('div');
  popupEl.className = 'lp-vocab-popup lp-phrase-popup';
  popupEl.setAttribute(LP_PROCESSED, 'true');

  // Phrase header
  const header = createEl('div', 'lp-popup-header');
  header.appendChild(createEl('span', 'lp-popup-original', original));
  if (composedText) {
    header.appendChild(createEl('span', 'lp-popup-arrow', '\u2192'));
    header.appendChild(createEl('span', 'lp-popup-translation', composedText));
  }
  const badge = createEl('span', 'lp-popup-pos', 'phrase');
  header.appendChild(badge);
  popupEl.appendChild(header);

  // Component words list
  const wordsList = createEl('div', 'lp-phrase-words');
  for (const m of matches) {
    const wordRow = createEl('div', 'lp-phrase-word-row');
    wordRow.appendChild(createEl('span', 'lp-phrase-word-original', m.original));
    wordRow.appendChild(createEl('span', 'lp-popup-arrow', '\u2192'));
    wordRow.appendChild(createEl('span', 'lp-phrase-word-term', m.word.term));
    if (m.word.part_of_speech) {
      wordRow.appendChild(createEl('span', 'lp-popup-pos', m.word.part_of_speech));
    }
    wordsList.appendChild(wordRow);
  }
  popupEl.appendChild(wordsList);

  // Report button for composed phrases
  if (composedText) {
    const actions = createEl('div', 'lp-popup-actions');
    const reportBtn = createEl('button', 'lp-popup-listen', '\u26A0 Report');
    reportBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      reportPhraseTranslation(span, original, composedText);
      reportBtn.textContent = '\u2713 Reported';
      reportBtn.disabled = true;
    });
    actions.appendChild(reportBtn);
    popupEl.appendChild(actions);
  }

  document.body.appendChild(popupEl);

  // Position popup
  const rect = span.getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();

  let top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;

  if (left + popupRect.width > window.innerWidth) {
    left = window.innerWidth - popupRect.width - 10;
  }
  if (left < 10) left = 10;

  popupEl.style.top = `${top}px`;
  popupEl.style.left = `${left}px`;

  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 10);
}

function reportPhraseTranslation(span, original, translated) {
  browser.runtime.sendMessage({
    type: 'PHRASE_TRANSLATE_FLAG',
    source_phrase: original,
    translated_phrase: translated,
    reason: 'user_reported',
  }).catch(() => {});
}

function showPopup(span) {
  hidePopup();

  const {
    original,
    translation,
    baseTranslation,
    termLanguage,
    pos,
    hint,
    example,
    exampleTranslation,
    audioUrl,
  } = span.dataset;

  popupEl = document.createElement('div');
  popupEl.className = 'lp-vocab-popup';
  popupEl.setAttribute(LP_PROCESSED, 'true');

  // Header: matched_form → term (base translation) [POS]
  const header = createEl('div', 'lp-popup-header');
  header.appendChild(createEl('span', 'lp-popup-original', original));
  header.appendChild(createEl('span', 'lp-popup-arrow', '\u2192'));
  header.appendChild(createEl('span', 'lp-popup-translation', translation));
  if (baseTranslation && baseTranslation.toLowerCase() !== original.toLowerCase()) {
    header.appendChild(createEl('span', 'lp-popup-base', `(${baseTranslation})`));
  }
  if (pos) header.appendChild(createEl('span', 'lp-popup-pos', pos));
  popupEl.appendChild(header);

  // Hint
  if (hint) {
    popupEl.appendChild(createEl('div', 'lp-popup-hint', hint));
  }

  // Example
  if (example) {
    const exDiv = createEl('div', 'lp-popup-example');
    exDiv.appendChild(createEl('div', 'lp-popup-example-text', `\u201C${example}\u201D`));
    if (exampleTranslation) {
      exDiv.appendChild(createEl('div', 'lp-popup-example-translation', `\u201C${exampleTranslation}\u201D`));
    }
    popupEl.appendChild(exDiv);
  }

  // Listen button
  const actions = createEl('div', 'lp-popup-actions');
  const listenBtn = createEl('button', 'lp-popup-listen', '\uD83D\uDD0A Listen');
  listenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    playAudioFromPopup(audioUrl, translation, termLanguage);
  });
  actions.appendChild(listenBtn);
  popupEl.appendChild(actions);

  document.body.appendChild(popupEl);

  // Position popup below the word
  const rect = span.getBoundingClientRect();
  const popupRect = popupEl.getBoundingClientRect();

  let top = rect.bottom + window.scrollY + 6;
  let left = rect.left + window.scrollX;

  // Keep within viewport
  if (left + popupRect.width > window.innerWidth) {
    left = window.innerWidth - popupRect.width - 10;
  }
  if (left < 10) left = 10;

  popupEl.style.top = `${top}px`;
  popupEl.style.left = `${left}px`;

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', handleOutsideClick);
  }, 10);
}

async function playAudioFromPopup(audioUrl, translation, termLanguage) {
  if (audioUrl) {
    const { apiBase } = await getContentConfig();
    const fullUrl = audioUrl.startsWith('http') ? audioUrl : `${apiBase.replace('/api', '')}${audioUrl}`;
    const audio = new Audio(fullUrl);
    audio.play();
  } else {
    const utterance = new SpeechSynthesisUtterance(translation);
    utterance.lang = termLanguage || 'es';
    speechSynthesis.speak(utterance);
  }
}

async function getContentConfig() {
  const { apiBase } = await browser.storage.local.get('apiBase');
  return { apiBase: apiBase || 'http://localhost:8000/api' };
}

function hidePopup() {
  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
  document.removeEventListener('click', handleOutsideClick);
}

function handleOutsideClick(e) {
  if (popupEl && !popupEl.contains(e.target)
    && !e.target.classList.contains(LP_CLASS)
    && !e.target.classList.contains('lp-vocab-phrase')) {
    hidePopup();
  }
}

// ─── Message Listener ────────────────────────────
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'VOCAB_UPDATED' && message.words) {
    // Remove existing single-word replacements
    document.querySelectorAll(`.${LP_CLASS}`).forEach(el => {
      if (!el.parentNode) return;
      const text = document.createTextNode(el.dataset.original || el.textContent);
      el.parentNode.replaceChild(text, el);
    });
    // Remove existing phrase spans
    document.querySelectorAll('.lp-vocab-phrase').forEach(el => {
      if (!el.parentNode) return;
      const text = document.createTextNode(el.dataset.original || el.textContent);
      el.parentNode.replaceChild(text, el);
    });
    // Rebuild with new words
    matcher = new VocabMatcher(message.words);
    processDocument();
  }
});

// ─── Start ───────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})(); // end async IIFE (sensitive-page guard)
