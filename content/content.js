/**
 * Content Script — DOM scanning, word replacement, and popup UI.
 * Runs on every page, processes text nodes and replaces matched vocabulary.
 */
/* global browser, VocabMatcher, VocabPopup, GrammarRules */

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
let rotationSalt = '';
const LEGACY_FRONTEND_URL = 'http://localhost:3000';
const DEFAULT_FRONTEND_URL = 'https://langsly.com';

function normalizeUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function resolveFrontendUrl(value) {
  const normalized = normalizeUrl(value);
  return !normalized || normalized === normalizeUrl(LEGACY_FRONTEND_URL)
    ? DEFAULT_FRONTEND_URL
    : normalized;
}

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
  const { vocabWords, frontendUrl, rotation_salt } = await browser.storage.local.get([
    'vocabWords',
    'frontendUrl',
    'rotation_salt',
  ]);
  if (!vocabWords || vocabWords.length === 0) return;
  rotationSalt = rotation_salt || '';
  const resolvedFrontendUrl = resolveFrontendUrl(frontendUrl);

  // Never translate on Langsly's own site (would interfere with lessons)
  try {
    const lpHost = new URL(resolvedFrontendUrl).hostname;
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

  matcher = new VocabMatcher(vocabWords, { rotationSalt: rotationSalt });
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
    } else {
      // All text nodes processed — request async disambiguation for ambiguous words
      requestDisambiguation();
    }
  }

  if (textNodes.length > 0) {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(processBatch);
    } else {
      textNodes.forEach(replaceInTextNode);
      requestDisambiguation();
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
  span.dataset.sourceLanguage = match.word.search_language || 'en';
  span.dataset.targetLanguage = match.word.term_language || 'es';
  span.dataset.meaningKey = match.word.meaning_key || match.word._localMeaningKey || '';
  span.dataset.method = match.word._method || match.word._localMethod || 'local';

  if (Array.isArray(match.word._alternatives) && match.word._alternatives.length > 0) {
    span.dataset.disambigAlternatives = JSON.stringify(match.word._alternatives);
  }

  // Mark ambiguous words for async backend disambiguation
  if (match.word._isAmbiguous) {
    span.classList.add('lp-disambig-pending');
    span.dataset.disambigCandidates = JSON.stringify(match.word._candidateIds);
    span.dataset.disambigSentence = match.word._sentenceContext;
    span.dataset.disambigOffset = String(match.word._matchOffset);
    span.dataset.disambigSourceLang = match.word.search_language || 'en';
  }

  const localConfidence = parseFloat(match.word._localConfidence || '0');
  if (!Number.isNaN(localConfidence) && localConfidence > 0 && localConfidence < 0.62) {
    span.classList.add('lp-uncertain');
    span.dataset.uncertain = 'true';
  } else {
    span.dataset.uncertain = 'false';
  }

  span.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    Promise.resolve(VocabPopup.showWord(span)).catch(() => {});
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
    Promise.resolve(VocabPopup.showPhrase(span, matches)).catch(() => {});
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
      if (response.cache_entry_id) {
        span.dataset.cacheEntryId = response.cache_entry_id;
      }
    }
  }).catch(() => {
    // Silent failure — word-by-word rendering remains as fallback
  });
}

/**
 * Collect all ambiguous word spans and request spaCy-based disambiguation
 * from the backend. On response, upgrades spans where the backend chose
 * a different candidate than the local keyword heuristic.
 */
function requestDisambiguation() {
  const pending = document.querySelectorAll('.lp-disambig-pending');
  if (pending.length === 0) return;

  const items = [];
  const spanMap = new Map(); // index → span element

  pending.forEach((span, i) => {
    try {
      const candidates = JSON.parse(span.dataset.disambigCandidates || '[]');
      if (candidates.length < 2) return;

      items.push({
        sentence: span.dataset.disambigSentence || '',
        matched_text: span.dataset.matchedForm || span.dataset.original || '',
        match_offset: parseInt(span.dataset.disambigOffset || '0', 10),
        candidate_ids: candidates,
        source_language: span.dataset.disambigSourceLang || 'en',
        rotation_salt: rotationSalt,
      });
      spanMap.set(items.length - 1, span);
    } catch {
      // Skip malformed data
    }
  });

  if (items.length === 0) return;

  browser.runtime.sendMessage({
    type: 'DISAMBIGUATE',
    items,
  }).then(response => {
    if (!response || !response.results) return;

    for (let i = 0; i < response.results.length; i++) {
      const result = response.results[i];
      const span = spanMap.get(i);
      if (!result || !span || !span.isConnected) continue;

      if (result.chosen_id) {
        upgradeDisambiguatedSpan(span, result.chosen_id, result);
      }

      span.classList.remove('lp-disambig-pending');
    }
  }).catch(() => {
    // Silent failure — local disambiguation remains
    pending.forEach(span => span.classList.remove('lp-disambig-pending'));
  });
}

/**
 * Upgrade a span to use a different VocabularyWord after disambiguation.
 * Looks up the new word from the cached vocabWords in storage.
 */
function upgradeDisambiguatedSpan(span, newWordId, result = null) {
  browser.storage.local.get('vocabWords').then(({ vocabWords }) => {
    if (!vocabWords) return;
    const newWord = vocabWords.find(w => w.id === newWordId);
    if (!newWord || !span.isConnected) return;

    // Update the span content and data attributes
    span.textContent = newWord.term;
    span.dataset.wordId = newWord.id;
    span.dataset.translation = newWord.term;
    span.dataset.baseTranslation = newWord.translation || '';
    span.dataset.termLanguage = newWord.term_language || 'es';
    span.dataset.pos = newWord.part_of_speech || '';
    span.dataset.hint = newWord.context_hint || '';
    span.dataset.example = newWord.example_sentence || '';
    span.dataset.exampleTranslation = newWord.example_translation || '';
    span.dataset.audioUrl = newWord.pronunciation_audio || '';
    span.dataset.sourceLanguage = newWord.search_language || span.dataset.sourceLanguage || 'en';
    span.dataset.targetLanguage = newWord.term_language || span.dataset.targetLanguage || 'es';
    span.dataset.meaningKey = (result && result.chosen_meaning_key) || newWord.meaning_key || span.dataset.meaningKey || '';
    span.dataset.method = (result && result.method) || span.dataset.method || 'spacy';

    if (result && Array.isArray(result.alternatives)) {
      span.dataset.disambigAlternatives = JSON.stringify(result.alternatives);
    }

    if (result && typeof result.uncertain === 'boolean') {
      span.dataset.uncertain = result.uncertain ? 'true' : 'false';
      if (result.uncertain) {
        span.classList.add('lp-uncertain');
      } else {
        span.classList.remove('lp-uncertain');
      }
    }
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
    browser.storage.local.get('rotation_salt').then(({ rotation_salt }) => {
      rotationSalt = rotation_salt || '';
      matcher = new VocabMatcher(message.words, { rotationSalt });
      processDocument();
    });
  }
});

// ─── Start ───────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

})(); // end async IIFE (sensitive-page guard)
