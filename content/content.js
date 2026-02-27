/**
 * Content Script — DOM scanning, word replacement, and popup UI.
 * Runs on every page, processes text nodes and replaces matched vocabulary.
 */
/* global browser, VocabMatcher */

// ─── Sensitive Page Exclusion ────────────────────
const SENSITIVE_PATTERNS = [
  /^chrome:\/\//, /^about:/, /^moz-extension:/,
  /bank/i, /paypal/i, /stripe\.com/i, /\.gov\//i,
  /signin|login|checkout|payment/i,
];

async function shouldExcludePage() {
  // Always exclude browser-internal pages
  if (/^(chrome|about|moz-extension):\/\//.test(window.location.href)) return true;

  // Check user preference for sensitive site exclusion
  const { excludeSensitive } = await browser.storage.local.get('excludeSensitive');
  if (excludeSensitive === false) return false; // User explicitly disabled

  // Default: exclude sensitive pages
  return SENSITIVE_PATTERNS.some(p => p.test(window.location.href));
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
  const matches = matcher.findMatches(text);
  if (matches.length === 0) return;

  const fragment = document.createDocumentFragment();
  let lastEnd = 0;
  const domain = window.location.hostname;

  for (const match of matches) {
    // Add text before the match
    if (match.start > lastEnd) {
      fragment.appendChild(document.createTextNode(text.substring(lastEnd, match.start)));
    }

    // Create vocab span
    const span = document.createElement('span');
    span.className = LP_CLASS;
    span.textContent = match.word.term;
    span.setAttribute(LP_PROCESSED, 'true');
    span.dataset.wordId = match.word.id;
    span.dataset.original = match.original;
    span.dataset.translation = match.word.term;
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

    fragment.appendChild(span);

    // Record show encounter (batched)
    recordEncounter(match.word.id, domain, false);

    lastEnd = match.end;
  }

  // Add remaining text
  if (lastEnd < text.length) {
    fragment.appendChild(document.createTextNode(text.substring(lastEnd)));
  }

  if (!textNode.parentNode) return; // node removed from DOM since collection
  textNode.parentNode.replaceChild(fragment, textNode);
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

function showPopup(span) {
  hidePopup();

  const { original, translation, pos, hint, example, exampleTranslation, audioUrl } = span.dataset;

  popupEl = document.createElement('div');
  popupEl.className = 'lp-vocab-popup';
  popupEl.setAttribute(LP_PROCESSED, 'true');

  // Header: original → translation [POS]
  const header = createEl('div', 'lp-popup-header');
  header.appendChild(createEl('span', 'lp-popup-original', original));
  header.appendChild(createEl('span', 'lp-popup-arrow', '\u2192'));
  header.appendChild(createEl('span', 'lp-popup-translation', translation));
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
    playAudioFromPopup(audioUrl, translation);
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

async function playAudioFromPopup(audioUrl, translation) {
  if (audioUrl) {
    const { apiBase } = await getContentConfig();
    const fullUrl = audioUrl.startsWith('http') ? audioUrl : `${apiBase.replace('/api', '')}${audioUrl}`;
    const audio = new Audio(fullUrl);
    audio.play();
  } else {
    const utterance = new SpeechSynthesisUtterance(translation);
    utterance.lang = 'es';
    speechSynthesis.speak(utterance);
  }
}

async function getContentConfig() {
  const { apiBase } = await browser.storage.local.get('apiBase');
  return { apiBase: apiBase || 'http://localhost:8080/api' };
}

function hidePopup() {
  if (popupEl) {
    popupEl.remove();
    popupEl = null;
  }
  document.removeEventListener('click', handleOutsideClick);
}

function handleOutsideClick(e) {
  if (popupEl && !popupEl.contains(e.target) && !e.target.classList.contains(LP_CLASS)) {
    hidePopup();
  }
}

// ─── Message Listener ────────────────────────────
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'VOCAB_UPDATED' && message.words) {
    // Remove existing replacements
    document.querySelectorAll(`.${LP_CLASS}`).forEach(el => {
      if (!el.parentNode) return; // node already removed from DOM
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
