/**
 * Content Script — DOM scanning, word replacement, and popup UI.
 * Runs on every page, processes text nodes and replaces matched vocabulary.
 */
/* global browser, VocabMatcher, VocabPopup, GrammarRules, LangslyRequestCoordinator */

// ─── Sensitive Page Exclusion ────────────────────
const SENSITIVE_PATTERNS = [
  /(^|[.-])(bank|banking|paypal|stripe|checkout|payment|payments)([.-]|$)/i,
  /(^|[.-])(health|medical|patient|pharmacy|insurance|medicare|medicaid)([.-]|$)/i,
  /(^|[.-])(legal|attorney|court|law)([.-]|$)/i,
  /(^|[.-])(login|signin|auth|account)([.-]|$)/i,
  /\.(gov|gob)(\.[a-z]{2})?$/i,
];

function _pageHasPasswordFields() {
  return document.querySelectorAll('input[type="password"]').length > 0;
}

function _pageRequiresImmediateExclusion() {
  if (/^(chrome|about|moz-extension):\/\//.test(window.location.href)) return true;
  if (_pageHasPasswordFields()) return true;
  const host = window.location.hostname.toLowerCase();
  const path = window.location.pathname.toLowerCase();
  if (/\/(login|signin|sign-in|oauth|authorize|checkout|payment|patient|legal)(\/|$)/i.test(path)) return true;
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(host));
}

async function shouldExcludePage() {
  // Baseline exclusions are mandatory and cannot be disabled.
  if (_pageRequiresImmediateExclusion()) return true;

  // User-configurable blocklist
  const { sensitiveBlocklist = [] } = await browser.storage.local.get('sensitiveBlocklist');
  const host = window.location.hostname.toLowerCase();
  if (sensitiveBlocklist.some(pattern => host.includes(String(pattern).toLowerCase()))) return true;
  return false;
}

// Wrap everything in an async IIFE so page-safety changes can be reevaluated.
(async () => {

  // ─── Main Extension Logic ────────────────────────

const SKIP_TAGS = new Set([
  'SCRIPT', 'STYLE', 'CODE', 'PRE', 'KBD', 'SAMP',
  'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'NOSCRIPT',
  'SVG', 'MATH', 'CANVAS', 'VIDEO', 'AUDIO', 'IFRAME',
]);

const LP_PROCESSED = 'data-lp-processed';
const LP_CLASS = 'lp-vocab-word';
let privateState = globalThis.LangslyPrivateState || new WeakMap();
globalThis.LangslyPrivateState = privateState;
const getPrivate = (element) => privateState.get(element) || {};
const setPrivate = (element, values) => {
  const next = { ...getPrivate(element), ...values };
  privateState.set(element, next);
  return next;
};
const MAX_TEXT_NODES_PER_SCAN = 500;
const MAX_MUTATION_NODES = 200;

let matcher = null;
let whitelistedDomains = [];
let rotationSalt = '';
let extensionActive = false;
let contentObserver = null;
let mutationDebounceTimer = null;
let pendingMutationNodes = [];
let lifecycleGeneration = 0;
let lifecycleState = 'idle';
let initPromise = null;
let scanInProgress = false;
const pendingScanRoots = [];
const scanIdleHandles = new Set();
const scanTimeoutHandles = new Set();
const automaticEncounterWordIds = new Set();
let disambiguationState = new WeakMap();
const phraseCoordinator = LangslyRequestCoordinator.createRequestCoordinator({
  maxConcurrent: 2,
  maxUnique: 20,
  keyOf: (payload) => JSON.stringify([payload.source_phrase, payload.source_language, payload.target_language, payload.word_ids]),
  send: (payload) => browser.runtime.sendMessage({ type: 'PHRASE_TRANSLATE', ...payload }),
});
const disambiguationCoordinator = LangslyRequestCoordinator.createBatchCoordinator({
  maxBatch: 20,
  maxPerWindow: 60,
  windowMs: 60_000,
  send: (items) => browser.runtime.sendMessage({ type: 'DISAMBIGUATE', items })
    .then((response) => (response && Array.isArray(response.results) ? response.results : [])),
});
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
let encounterFlushChain = Promise.resolve();
let encounterGeneration = 0;

function recordEncounter(wordId, domain, wasClicked) {
  const normalizedWordId = String(wordId || '');
  if (!wasClicked) {
    if (automaticEncounterWordIds.has(normalizedWordId)) return;
    automaticEncounterWordIds.add(normalizedWordId);
  }
  encounterBuffer.push({
    word_id: wordId,
    domain,
    interaction: wasClicked ? 'trusted_tap' : 'automatic_view',
  });
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(flushEncounterBuffer, 2000);
  if (encounterBuffer.length >= 50) flushEncounterBuffer();
}

function flushEncounterBuffer() {
  if (encounterBuffer.length === 0) return;
  const batch = encounterBuffer.splice(0, 50);
  const generation = encounterGeneration;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  encounterFlushChain = encounterFlushChain.then(() => {
    if (generation !== encounterGeneration) return null;
    return browser.runtime.sendMessage({ type: 'RECORD_ENCOUNTERS_BATCH', encounters: batch });
  }).catch(() => null).then((result) => {
    if (generation === encounterGeneration && encounterBuffer.length > 0) {
      flushTimer = setTimeout(flushEncounterBuffer, 0);
    }
    return result;
  });
  return encounterFlushChain;
}

// ─── Initialization ──────────────────────────────
function init() {
  if (extensionActive || initPromise) return initPromise;
  if (['disabled', 'unavailable', 'logged-out'].includes(lifecycleState)) return null;
  const generation = lifecycleGeneration;
  lifecycleState = 'initializing';
  initPromise = runInit(generation).finally(() => {
    if (generation === lifecycleGeneration) initPromise = null;
  });
  return initPromise;
}

async function runInit(generation) {
  if (await shouldExcludePage()) {
    if (generation === lifecycleGeneration) lifecycleState = 'excluded';
    return;
  }
  if (generation !== lifecycleGeneration) return;
  const { frontendUrl } = await browser.storage.local.get('frontendUrl');
  if (generation !== lifecycleGeneration) return;
  const resolvedFrontendUrl = resolveFrontendUrl(frontendUrl);

  // Never translate on Langsly's own site (would interfere with lessons)
  try {
    const lpHost = new URL(resolvedFrontendUrl).hostname;
    if (window.location.hostname === lpHost || window.location.hostname.endsWith(`.${lpHost}`)) {
      lifecycleState = 'disabled';
      return;
    }
  } catch (_) {
    // frontendUrl is malformed — skip check, allow translation
  }

  const { vocabWords, rotation_salt } = await browser.storage.local.get(['vocabWords', 'rotation_salt']);
  if (generation !== lifecycleGeneration) return;
  if (!vocabWords || vocabWords.length === 0) {
    lifecycleState = 'unavailable';
    return;
  }
  rotationSalt = rotation_salt || '';

  // Check whitelist
  const domain = window.location.hostname;
  const response = await browser.runtime.sendMessage({ type: 'GET_WHITELIST' });
  if (generation !== lifecycleGeneration) return;
  if (response && response.domains) {
    whitelistedDomains = response.domains;
    if (whitelistedDomains.some(d => domain.includes(d) || d.includes(domain))) {
      lifecycleState = 'disabled';
      return;
    }
  }

  matcher = new VocabMatcher(vocabWords, { rotationSalt: rotationSalt });
  extensionActive = true;
  lifecycleState = 'active';
  detectTheme();
  processDocument();
  observeMutations();

  // Flush encounters on page unload
  window.removeEventListener('beforeunload', flushEncounterBuffer);
  window.addEventListener('beforeunload', flushEncounterBuffer);
}

// ─── DOM Processing ──────────────────────────────
function processDocument() {
  if (!matcher) return;
  processNode(document.body);
}

function processNode(root) {
  const mustExclude = _pageRequiresImmediateExclusion();
  if (!root || !root.isConnected || mustExclude) {
    if (extensionActive && mustExclude) deactivateForSensitivePage();
    return;
  }
  if (!pendingScanRoots.some((queued) => queued === root || queued.contains(root))) {
    pendingScanRoots.push(root);
  }
  drainScanQueue();
}

function drainScanQueue() {
  if (scanInProgress || pendingScanRoots.length === 0) return;
  const root = pendingScanRoots.shift();
  scanInProgress = true;
  runProcessNode(root, () => {
    scanInProgress = false;
    drainScanQueue();
  });
}

function scheduleIdleWork(callback) {
  const handle = requestIdleCallback((deadline) => {
    scanIdleHandles.delete(handle);
    callback(deadline);
  }, { timeout: 1000 });
  scanIdleHandles.add(handle);
}

function scheduleScanTimeout(callback) {
  const handle = setTimeout(() => {
    scanTimeoutHandles.delete(handle);
    callback();
  }, 0);
  scanTimeoutHandles.add(handle);
}

function runProcessNode(root, complete) {
  if (!root || !root.isConnected || !extensionActive || document.hidden || _pageRequiresImmediateExclusion()) {
    if (extensionActive && _pageRequiresImmediateExclusion()) deactivateForSensitivePage();
    complete();
    return;
  }

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
  let collectionComplete = false;
  let index = 0;

  function stoppedOrUnsafe() {
    if (!extensionActive || document.hidden || !root.isConnected) return true;
    if (_pageRequiresImmediateExclusion()) {
      deactivateForSensitivePage();
      return true;
    }
    return false;
  }

  function finishCollectionBatch(limit, hasTime) {
    let collected = 0;
    while (collected < limit && (collected === 0 || hasTime())) {
      const node = walker.nextNode();
      if (!node) {
        collectionComplete = true;
        break;
      }
      textNodes.push(node);
      collected += 1;
    }
  }

  function processBatch(deadline) {
    if (stoppedOrUnsafe()) { complete(); return; }
    let processed = 0;
    while (index < textNodes.length && (processed === 0 || deadline.timeRemaining() > 3)) {
      replaceInTextNode(textNodes[index]);
      index++;
      processed++;
    }
    if (index < textNodes.length) {
      scheduleIdleWork(processBatch);
    } else {
      // All text nodes processed — request async disambiguation for ambiguous words
      requestDisambiguation();
      complete();
    }
  }

  const fallbackProcessBatch = () => {
    if (stoppedOrUnsafe()) { complete(); return; }
    const end = Math.min(index + 20, textNodes.length);
    while (index < end) replaceInTextNode(textNodes[index++]);
    if (index < textNodes.length) scheduleScanTimeout(fallbackProcessBatch);
    else { requestDisambiguation(); complete(); }
  };

  if ('requestIdleCallback' in window) {
    const collectIdleBatch = (deadline) => {
      if (stoppedOrUnsafe()) { complete(); return; }
      finishCollectionBatch(MAX_TEXT_NODES_PER_SCAN, () => deadline.timeRemaining() > 3);
      if (!collectionComplete) scheduleIdleWork(collectIdleBatch);
      else if (textNodes.length > 0) scheduleIdleWork(processBatch);
      else complete();
    };
    scheduleIdleWork(collectIdleBatch);
  } else {
    const collectFallbackBatch = () => {
      if (stoppedOrUnsafe()) { complete(); return; }
      finishCollectionBatch(MAX_TEXT_NODES_PER_SCAN, () => true);
      if (!collectionComplete) scheduleScanTimeout(collectFallbackBatch);
      else if (textNodes.length > 0) fallbackProcessBatch();
      else complete();
    };
    collectFallbackBatch();
  }
}

function replaceInTextNode(textNode) {
  if (!textNode || !textNode.isConnected || !textNode.parentNode) return;
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
  setPrivate(span, {
    wordId: match.word.id,
    original: match.original,
    translation: match.word.term,
    baseTranslation: match.word.translation || '',
    matchedForm: match.matchedForm || match.original,
    termLanguage: match.word.term_language || 'es',
    pos: match.word.part_of_speech || '',
    hint: match.word.context_hint || '',
    example: match.word.example_sentence || '',
    exampleTranslation: match.word.example_translation || '',
    audioUrl: match.word.pronunciation_audio || '',
    sourceLanguage: match.word.search_language || 'en',
    targetLanguage: match.word.term_language || 'es',
    meaningKey: match.word.meaning_key || match.word._localMeaningKey || '',
    method: match.word._method || match.word._localMethod || 'local',
    disambigAlternatives: Array.isArray(match.word._alternatives) ? match.word._alternatives : [],
    disambigCandidates: match.word._isAmbiguous ? match.word._candidateIds : [],
    disambigSentence: String(match.word._sentenceContext || '').slice(0, 320),
    disambigOffset: Number(match.word._matchOffset) || 0,
    disambigSourceLang: match.word.search_language || 'en',
  });

  // Mark ambiguous words for async backend disambiguation
  if (match.word._isAmbiguous) {
    span.classList.add('lp-disambig-pending');
  }

  const localConfidence = parseFloat(match.word._localConfidence || '0');
  if (!Number.isNaN(localConfidence) && localConfidence > 0 && localConfidence < 0.62) {
    span.classList.add('lp-uncertain');
    setPrivate(span, { uncertain: 'true' });
  } else {
    setPrivate(span, { uncertain: 'false' });
  }

  span.addEventListener('click', (e) => {
    if (!e.isTrusted) return;
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
  setPrivate(span, {
    original: sourceText,
    phraseType: composed && composed.source !== 'rules_low' ? 'composed' : 'word-by-word',
    words: matches.map(m => m.word.id),
    sourcePhrase: sourceText,
    targetLang,
  });

  if (composed && composed.source !== 'rules_low') {
    // High-confidence composition — render as a single phrase span
    span.className = 'lp-vocab-phrase';
    span.textContent = composed.translation;
    setPrivate(span, { source: composed.source, confidence: composed.confidence });
  } else {
    // Low confidence or no rule match — render words individually inside phrase span
    // Mark for potential async backend upgrade
    span.className = 'lp-vocab-phrase lp-phrase-pending';

    // Render each match word with gap text between them
    let lastMatchEnd = start;
    for (const match of matches) {
      if (match.start > lastMatchEnd) {
        span.appendChild(document.createTextNode(fullText.substring(lastMatchEnd, match.start)));
      }
      const wordSpan = document.createElement('span');
      wordSpan.className = LP_CLASS;
      wordSpan.textContent = match.word.term;
      wordSpan.setAttribute(LP_PROCESSED, 'true');
      setPrivate(wordSpan, {
        wordId: match.word.id,
        original: match.original,
        translation: match.word.term,
        baseTranslation: match.word.translation || '',
        matchedForm: match.matchedForm || match.original,
        termLanguage: match.word.term_language || 'es',
        pos: match.word.part_of_speech || '',
        hint: match.word.context_hint || '',
        example: match.word.example_sentence || '',
        exampleTranslation: match.word.example_translation || '',
        audioUrl: match.word.pronunciation_audio || '',
        sourceLanguage: match.word.search_language || 'en',
        targetLanguage: match.word.term_language || 'es',
      });
      wordSpan.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.preventDefault();
        e.stopPropagation();
        Promise.resolve(VocabPopup.showWord(wordSpan)).catch(() => {});
        recordEncounter(match.word.id, domain, true);
      });
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
    if (!e.isTrusted) return;
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
  const generation = lifecycleGeneration;

  phraseCoordinator.request({
    source_phrase: sourcePhrase,
    source_language: sourceLang,
    target_language: targetLang,
    word_ids: matches.map(m => m.word.id),
  }).then(response => {
    if (generation === lifecycleGeneration && response && response.translated_phrase && span.isConnected) {
      // Upgrade the span from word-by-word to composed
      span.textContent = response.translated_phrase;
      span.className = 'lp-vocab-phrase';
      span.classList.remove('lp-phrase-pending');
      setPrivate(span, {
        phraseType: 'composed',
        source: response.source || 'backend',
        cacheEntryId: response.cache_entry_id || '',
      });
    }
  }).catch(() => {
    // Silent failure — word-by-word rendering remains as fallback
  }).finally(() => {
    if (span.isConnected) span.classList.remove('lp-phrase-pending');
  });
}

/**
 * Collect all ambiguous word spans and request spaCy-based disambiguation
 * from the backend. On response, upgrades spans where the backend chose
 * a different candidate than the local keyword heuristic.
 */
function requestDisambiguation() {
  const pending = document.querySelectorAll('.lp-disambig-pending');
  pending.forEach((span) => {
    if (disambiguationState.has(span)) return;
    const state = getPrivate(span);
    const candidates = Array.isArray(state.disambigCandidates) ? state.disambigCandidates : [];
    if (candidates.length < 2) {
      disambiguationState.set(span, 'resolved');
      span.classList.remove('lp-disambig-pending');
      return;
    }

    const item = {
      sentence: String(state.disambigSentence || '').slice(0, 320),
      matched_text: state.matchedForm || state.original || '',
      match_offset: Number(state.disambigOffset) || 0,
      candidate_ids: candidates,
      source_language: state.disambigSourceLang || 'en',
      rotation_salt: rotationSalt,
    };
    const generation = lifecycleGeneration;
    disambiguationState.set(span, 'queued');
    disambiguationCoordinator.request(item).then((result) => {
      if (generation === lifecycleGeneration && result && result.chosen_id && span.isConnected) {
        upgradeDisambiguatedSpan(span, result.chosen_id, result);
      }
    }).catch(() => null).finally(() => {
      disambiguationState.set(span, 'resolved');
      if (span.isConnected) span.classList.remove('lp-disambig-pending');
    });
  });
}

function requestDisambiguationLegacy() {
  const pending = document.querySelectorAll('.lp-disambig-pending');
  if (pending.length === 0) return;

  const items = [];
  const spanMap = new Map(); // index → span element

  pending.forEach((span, i) => {
    try {
      const state = getPrivate(span);
      const candidates = Array.isArray(state.disambigCandidates) ? state.disambigCandidates : [];
      if (candidates.length < 2) return;

      items.push({
        sentence: String(state.disambigSentence || '').slice(0, 320),
        matched_text: state.matchedForm || state.original || '',
        match_offset: Number(state.disambigOffset) || 0,
        candidate_ids: candidates,
        source_language: state.disambigSourceLang || 'en',
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

    // Update extension-owned metadata without exposing IDs to page scripts.
    span.textContent = newWord.term;
    const previous = getPrivate(span);
    setPrivate(span, {
      wordId: newWord.id,
      translation: newWord.term,
      baseTranslation: newWord.translation || '',
      termLanguage: newWord.term_language || 'es',
      pos: newWord.part_of_speech || '',
      hint: newWord.context_hint || '',
      example: newWord.example_sentence || '',
      exampleTranslation: newWord.example_translation || '',
      audioUrl: newWord.pronunciation_audio || '',
      sourceLanguage: newWord.search_language || previous.sourceLanguage || 'en',
      targetLanguage: newWord.term_language || previous.targetLanguage || 'es',
      meaningKey: (result && result.chosen_meaning_key) || newWord.meaning_key || previous.meaningKey || '',
      method: (result && result.method) || previous.method || 'spacy',
    });

    if (result && Array.isArray(result.alternatives)) {
      setPrivate(span, { disambigAlternatives: result.alternatives });
    }

    if (result && typeof result.uncertain === 'boolean') {
      setPrivate(span, { uncertain: result.uncertain ? 'true' : 'false' });
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
  if (contentObserver) contentObserver.disconnect();
  contentObserver = new MutationObserver((mutations) => {
    if (!extensionActive || document.hidden) return;
    if (_pageRequiresImmediateExclusion()) {
      deactivateForSensitivePage();
      return;
    }
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (pendingMutationNodes.length < MAX_MUTATION_NODES && node.nodeType === Node.ELEMENT_NODE && !node.hasAttribute(LP_PROCESSED)) {
          pendingMutationNodes.push(node);
        }
      }
    }
    if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
    mutationDebounceTimer = setTimeout(() => {
      mutationDebounceTimer = null;
      const nodes = pendingMutationNodes.splice(0);
      for (const n of nodes) {
        processNode(n);
      }
    }, 150);
  });

  contentObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });
}

// ─── Message Listener ────────────────────────────
browser.runtime.onMessage.addListener((message) => {
  if (message.type === 'AUTH_CLEARED') {
    stopDocumentWork({ loggedOut: true });
    return { success: true };
  }

  if (message.type === 'SITE_ACCESS_CHANGED') {
    if (message.enabled) {
      lifecycleGeneration += 1;
      lifecycleState = 'idle';
      startSafetyController();
      void init();
    } else {
      stopDocumentWork();
      lifecycleState = 'disabled';
    }
    return { success: true };
  }

  if (message.type === 'VOCAB_UPDATED' && message.words) {
    restoreOriginalPageText();
    browser.storage.local.get('rotation_salt').then(({ rotation_salt }) => {
      rotationSalt = rotation_salt || '';
      if (extensionActive) {
        matcher = new VocabMatcher(message.words, { rotationSalt });
        processDocument();
      } else {
        lifecycleGeneration += 1;
        lifecycleState = 'idle';
        startSafetyController();
        void init();
      }
    });
  }
});

// ─── Start ───────────────────────────────────────
function restoreOriginalPageText() {
  document.querySelectorAll('.lp-vocab-phrase').forEach((element) => {
    if (!element.parentNode) return;
    element.parentNode.replaceChild(document.createTextNode(getPrivate(element).original || element.textContent), element);
  });
  document.querySelectorAll(`.${LP_CLASS}`).forEach((element) => {
    if (!element.parentNode) return;
    element.parentNode.replaceChild(document.createTextNode(getPrivate(element).original || element.textContent), element);
  });
}

function stopDocumentWork({ loggedOut = false } = {}) {
  lifecycleGeneration += 1;
  extensionActive = false;
  lifecycleState = loggedOut ? 'logged-out' : 'excluded';
  initPromise = null;
  matcher = null;
  rotationSalt = '';
  whitelistedDomains = [];
  if (contentObserver) contentObserver.disconnect();
  contentObserver = null;
  if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
  mutationDebounceTimer = null;
  pendingMutationNodes = [];
  pendingScanRoots.splice(0);
  scanInProgress = false;
  for (const handle of scanIdleHandles) cancelIdleCallback(handle);
  scanIdleHandles.clear();
  for (const handle of scanTimeoutHandles) clearTimeout(handle);
  scanTimeoutHandles.clear();
  encounterBuffer.splice(0);
  encounterGeneration += 1;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  restoreOriginalPageText();
  VocabPopup.reset();
  privateState = globalThis.LangslyPrivateState;
  disambiguationState = new WeakMap();
  document.documentElement.removeAttribute('data-lp-theme');
  window.removeEventListener('beforeunload', flushEncounterBuffer);
  if (loggedOut) {
    automaticEncounterWordIds.clear();
    phraseCoordinator.cancel();
    disambiguationCoordinator.cancel();
    stopSafetyController();
  }
}

function deactivateForSensitivePage() {
  stopDocumentWork();
}

let safetyTimer = null;
let safetyControllerActive = false;
const originalHistoryMethods = new Map();
async function evaluateSafety() {
  const excluded = await shouldExcludePage();
  if (excluded && extensionActive) deactivateForSensitivePage();
  if (!excluded && !extensionActive && !document.hidden) await init();
}
function scheduleSafetyCheck() {
  if (_pageRequiresImmediateExclusion()) {
    if (extensionActive) deactivateForSensitivePage();
    return;
  }
  if (safetyTimer) return;
  safetyTimer = setTimeout(() => {
    safetyTimer = null;
    void evaluateSafety();
  }, 200);
}

const safetyObserver = new MutationObserver(scheduleSafetyCheck);
function handleVisibilityChange() {
  if (document.hidden) return;
  scheduleSafetyCheck();
  if (extensionActive) processDocument();
}

const startSafetyController = () => {
  if (safetyControllerActive) return;
  safetyControllerActive = true;
  safetyObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['type'],
  });
  window.addEventListener('popstate', scheduleSafetyCheck);
  window.addEventListener('hashchange', scheduleSafetyCheck);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    originalHistoryMethods.set(method, original);
    history[method] = function (...args) {
      const result = original.apply(this, args);
      scheduleSafetyCheck();
      return result;
    };
  }
  void evaluateSafety();
};

function stopSafetyController() {
  if (!safetyControllerActive) return;
  safetyControllerActive = false;
  safetyObserver.disconnect();
  clearTimeout(safetyTimer);
  safetyTimer = null;
  window.removeEventListener('popstate', scheduleSafetyCheck);
  window.removeEventListener('hashchange', scheduleSafetyCheck);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  for (const [method, original] of originalHistoryMethods) history[method] = original;
  originalHistoryMethods.clear();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startSafetyController, { once: true });
else startSafetyController();

})(); // end async IIFE (sensitive-page guard)
