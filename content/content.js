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

// A configured domain covers itself and its subdomains only: "bank.com" matches
// "bank.com" and "www.bank.com", never "notbank.com" or "bank.com.evil.test".
function hostMatchesDomain(host, domain) {
  const h = String(host || '').trim().toLowerCase().replace(/\.$/, '');
  const d = String(domain || '').trim().toLowerCase().replace(/^\*?\./, '').replace(/\.$/, '');
  return Boolean(h && d) && (h === d || h.endsWith(`.${d}`));
}

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
  if (sensitiveBlocklist.some(pattern => hostMatchesDomain(host, pattern))) return true;
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
const BLOCK_SELECTOR = 'p,li,div,h1,h2,h3,h4,h5,h6,blockquote,td,th,article,section';

// ─── Chinese islands (English pages, reviewed words only) ───
// Islands, not bridges: one reviewed Chinese word or course phrase at a time,
// never composed, and never touching another island or Chinese text.
const ZH_PAGE_ISLAND_LIMIT = 10;
const ZH_SAME_WORD_LIMIT = 2;
const ZH_BLOCKED_PAGE_LANGUAGE = /^(zh|ja|ko)(-|$)/i;
const CJK_TEXT = /[\u2e80-\u2fdf\u3000-\u30ff\u3100-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]|[\u{20000}-\u{3ffff}]/u;
const BRIDGE_GAP = /^[\s\p{P}\p{S}]*$/u;
const PINYIN_MODES = new Set(['auto', 'always', 'popup']);
let zhPinyinMode = 'auto';
let zhPinyinTaps = {};
let zhIslandBudget = { page: 0, words: new Map(), sentences: new WeakMap() };

function isZhTarget(word) {
  const code = String(word && word.term_language || '').toLowerCase().replace(/_/g, '-');
  return code === 'zh' || code.startsWith('zh-');
}

// Chinese targets sync only for a zh-hans active course; never mix them with
// Spanish islands on the same page.
function vocabularyForPage(words) {
  const list = Array.isArray(words) ? words : [];
  const chinese = list.filter(isZhTarget);
  return chinese.length ? chinese : list;
}

function ownBlockText(block) {
  let text = '';
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!node.parentElement || node.parentElement.closest(`[${LP_PROCESSED}]`)) continue;
    text += node.textContent;
  }
  return text;
}

function zhIslandAllowed(textNode, match, context) {
  const parent = textNode.parentElement;
  if (!parent || !context) return false;
  const marked = parent.closest('[lang]');
  if (marked && ZH_BLOCKED_PAGE_LANGUAGE.test(marked.getAttribute('lang') || '')) return false;
  const block = parent.closest(BLOCK_SELECTOR) || parent;
  if (CJK_TEXT.test(ownBlockText(block))) return false;
  const wordId = String(match.word.id);
  const sentenceKey = String(context.sentence);
  if (zhIslandBudget.page >= ZH_PAGE_ISLAND_LIMIT) return false;
  if ((zhIslandBudget.words.get(wordId) || 0) >= ZH_SAME_WORD_LIMIT) return false;
  const blockSentences = zhIslandBudget.sentences.get(block) || new Set();
  if (blockSentences.has(sentenceKey)) return false;
  zhIslandBudget.page += 1;
  zhIslandBudget.words.set(wordId, (zhIslandBudget.words.get(wordId) || 0) + 1);
  blockSentences.add(sentenceKey);
  zhIslandBudget.sentences.set(block, blockSentences);
  return true;
}

function recentTapCount(wordId) {
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  return (Array.isArray(zhPinyinTaps[wordId]) ? zhPinyinTaps[wordId] : []).filter(time => time > weekAgo).length;
}

// Pinyin ruby follows the server's SRS stage and the learner's mode. Two or
// more taps on a word within 7 days step it back toward full pinyin.
function effectivePinyinStage(word) {
  if (zhPinyinMode === 'popup') return 'hidden';
  if (zhPinyinMode === 'always') return 'full';
  const order = ['full', 'faded', 'hidden'];
  let index = Math.max(0, order.indexOf(word.pinyin_stage || 'full'));
  if (recentTapCount(String(word.id)) >= 2) index = Math.max(0, index - 1);
  return order[index];
}

function rubySyllables(word) {
  const reading = word.reading || (word.zh_target && word.zh_target.reading) || {};
  const citation = Array.isArray(reading.citation) ? reading.citation : [];
  const spoken = Array.isArray(reading.spoken) ? reading.spoken : null;
  // The reviewer chooses whether 一/不 show their spoken (sandhi) tone.
  return [...String(word.term || '')].map((char, index) => (
    reading.ruby === 'spoken' && spoken && ['一', '不'].includes(char) ? spoken[index] : citation[index]
  ) || '');
}

function renderChineseIsland(span, word) {
  span.textContent = '';
  span.setAttribute('lang', 'zh-Hans');
  span.setAttribute('translate', 'no');
  const stage = effectivePinyinStage(word);
  span.setAttribute('data-lp-pinyin', stage);
  if (stage === 'hidden') {
    span.textContent = word.term;
    return;
  }
  const ruby = document.createElement('ruby');
  ruby.className = stage === 'faded' ? 'lp-pinyin lp-pinyin-faded' : 'lp-pinyin';
  const syllables = rubySyllables(word);
  [...String(word.term)].forEach((char, index) => {
    ruby.appendChild(document.createTextNode(char));
    const rt = document.createElement('rt');
    rt.textContent = syllables[index];
    ruby.appendChild(rt);
  });
  span.appendChild(ruby);
}

function revertIsland(island) {
  if (!island.parentNode) return;
  island.parentNode.replaceChild(document.createTextNode(getPrivate(island).original || island.textContent), island);
}

// Leftmost island wins. Whitespace and punctuation between two islands, or
// between an island and existing Chinese text, still make a bridge.
function enforceNoBridges(island) {
  const block = island.parentElement && (island.parentElement.closest(BLOCK_SELECTOR) || island.parentElement);
  if (!block) return;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.classList.contains('lp-zh-island')) return NodeFilter.FILTER_ACCEPT;
        if (node.classList.contains('lp-validation-pending')) return NodeFilter.FILTER_SKIP;
        return node.hasAttribute(LP_PROCESSED) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      }
      return node.parentElement && node.parentElement.closest('.lp-zh-island')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    },
  });
  const sequence = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) sequence.push(node);
  let neighbour = false;
  for (const node of sequence) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      if (neighbour) {
        revertIsland(node);
        neighbour = false; // the restored English word ends the run
      } else {
        neighbour = true;
      }
      continue;
    }
    for (const char of node.textContent) {
      if (CJK_TEXT.test(char)) neighbour = true;
      else if (!BRIDGE_GAP.test(char)) neighbour = false;
    }
  }
}

function recordPinyinTap(wordId) {
  const id = String(wordId);
  const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  zhPinyinTaps = { ...zhPinyinTaps, [id]: [...(zhPinyinTaps[id] || []).filter(time => time > weekAgo), Date.now()].slice(-10) };
  browser.storage.local.set({ zhPinyinTaps }).catch(() => {});
}

async function loadPinyinPreferences() {
  try {
    const stored = await browser.storage.local.get(['zhPinyinMode', 'zhPinyinTaps']);
    zhPinyinMode = PINYIN_MODES.has(stored.zhPinyinMode) ? stored.zhPinyinMode : 'auto';
    zhPinyinTaps = stored.zhPinyinTaps && typeof stored.zhPinyinTaps === 'object' ? stored.zhPinyinTaps : {};
  } catch {
    zhPinyinMode = 'auto';
    zhPinyinTaps = {};
  }
}

// One contrast line, built only from other synced (reviewed) Chinese rows that
// share a trigger with this word, e.g. "知道 = to know (a fact)".
function chineseContrast(word) {
  const triggers = new Set((word.source_forms || []).map(form => String(form).toLowerCase()));
  for (const other of matcher ? matcher.wordsById.values() : []) {
    if (String(other.id) === String(word.id) || !isZhTarget(other)) continue;
    if ((other.source_forms || []).some(form => triggers.has(String(form).toLowerCase()))) {
      return { term: other.term, gloss: other.translation || '' };
    }
  }
  return null;
}

let matcher = null;
let whitelistedDomains = [];
let rotationSalt = '';
let extensionActive = false;
let contentObserver = null;
let mutationDebounceTimer = null;
let pendingMutationNodes = [];
let lifecycleGeneration = 0;
let vocabularyRevision = 0;
let validationSequence = 0;
let lifecycleState = 'idle';
let initPromise = null;
let scanInProgress = false;
const pendingScanRoots = [];
const scanIdleHandles = new Set();
const scanTimeoutHandles = new Set();
const automaticEncounterWordIds = new Set();
const validationCoordinator = LangslyRequestCoordinator.createBatchCoordinator({
  maxBatch: 20,
  maxPerWindow: 60,
  windowMs: 60_000,
  keyOf: ({ item_id, ...item }) => JSON.stringify(item),
  send: (items) => browser.runtime.sendMessage({ type: 'VALIDATE_REPLACEMENTS', items })
    .then(response => {
      const byId = new Map((response && Array.isArray(response.results) ? response.results : [])
        .map(result => [result.item_id, result]));
      return items.map(item => byId.get(item.item_id) || null);
    }),
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
    if (whitelistedDomains.some(d => hostMatchesDomain(domain, d))) {
      lifecycleState = 'disabled';
      return;
    }
  }

  await loadPinyinPreferences();
  if (generation !== lifecycleGeneration) return;
  matcher = new VocabMatcher(vocabularyForPage(vocabWords), { rotationSalt: rotationSalt });
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
      requestPendingValidations();
      complete();
    }
  }

  const fallbackProcessBatch = () => {
    if (stoppedOrUnsafe()) { complete(); return; }
    const end = Math.min(index + 20, textNodes.length);
    while (index < end) replaceInTextNode(textNodes[index++]);
    if (index < textNodes.length) scheduleScanTimeout(fallbackProcessBatch);
    else { requestPendingValidations(); complete(); }
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
    event.context = sentenceContextForNode(textNode, event.start);
    // Add text before this event
    if (event.start > lastEnd) {
      fragment.appendChild(document.createTextNode(text.substring(lastEnd, event.start)));
    }

    if (event.type === 'single' && isZhTarget(event.data.word) && !zhIslandAllowed(textNode, event.data, event.context)) {
      fragment.appendChild(document.createTextNode(event.data.original));
    } else if (event.type === 'single') {
      fragment.appendChild(buildPendingSingleSpan(event.data, domain, event.context));
    } else {
      fragment.appendChild(buildPendingPhraseSpan(event.data, text, domain, event.context));
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

function sentenceContextForNode(textNode, matchStart) {
  const blockSelector = BLOCK_SELECTOR;
  const block = textNode.parentElement.closest(blockSelector) || textNode.parentElement;
  if (!block || block.querySelector('script,style,code,pre,input,textarea,select,button,[contenteditable]')) return null;
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  let combined = '';
  let position = -1;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest(`[${LP_PROCESSED}]`) || SKIP_TAGS.has(parent.tagName)
      || parent.isContentEditable || (parent !== block && parent.closest(blockSelector) !== block)) return null;
    if (node === textNode) position = combined.length + matchStart;
    combined += node.textContent;
    if (combined.length > 500) return null;
  }
  return position < 0 ? null : matcher._extractSentence(combined, position);
}

function displaySingleTerm(term, original) {
  const target = String(term || '');
  const source = String(original || '');
  return target.toLocaleLowerCase() === source.toLocaleLowerCase() ? source : target;
}

function displayPhraseTerm(match, index) {
  const term = displaySingleTerm(match.word.term, match.original);
  const pos = String(match.word.part_of_speech || '').toLowerCase();
  if (index > 0
    && ['verb', 'article', 'pronoun', 'preposition', 'conjunction'].includes(pos)
    && /^[A-Z][a-z]+$/.test(term)) {
    return `${term.charAt(0).toLowerCase()}${term.slice(1)}`;
  }
  return term;
}

function buildPendingSingleSpan(match, domain, context) {
  if (!context || !context.sentence || !Number.isInteger(context.offset)) {
    return document.createTextNode(match.original);
  }
  const span = document.createElement('span');
  const componentCandidates = match.word._candidateIds || [match.word.id];
  const contextualVerb = match.word.validation_version !== 3 && Boolean(match.word._needsContextualRewrite);
  const supportingPronouns = contextualVerb ? [...matcher.wordsById.values()]
    .filter(word => String(word.part_of_speech || '').toLowerCase() === 'pronoun'
      && word.search_language === match.word.search_language
      && word.term_language === match.word.term_language)
    .map(word => word.id)
    .filter(id => !componentCandidates.map(String).includes(String(id)))
    .slice(0, Math.max(0, 20 - componentCandidates.length)) : [];
  span.textContent = match.original;
  span.setAttribute(LP_PROCESSED, 'true');
  span.className = 'lp-validation-pending';
  setPrivate(span, {
    original: match.original,
    sentence: context.sentence,
    offset: context.offset,
    candidates: [...componentCandidates, ...supportingPronouns],
    components: [match.word.id],
    componentCandidates: [componentCandidates],
    proposed: displaySingleTerm(match.word.term, match.original),
    validationVersion: match.word.validation_version === 3 ? 3 : 2,
    sourceLanguage: match.word.search_language || '',
    targetLanguage: match.word.term_language || '',
    domain,
    phrase: contextualVerb,
    phraseMatches: [match],
  });
  return span;
}

function buildPendingPhraseSpan(phrase, fullText, domain, contextOverride) {
  const { matches, sourceText, start } = phrase;
  if (!contextOverride || !contextOverride.sentence || !Number.isInteger(contextOverride.offset)) {
    return document.createTextNode(sourceText);
  }
  const span = document.createElement('span');
  span.textContent = sourceText;
  span.setAttribute(LP_PROCESSED, 'true');
  span.className = 'lp-validation-pending';
  const context = contextOverride;
  const composed = window.GrammarRules?.composePhrase(matches.map((match, index) => ({
    word: match.word,
    pos: match.word.part_of_speech || '',
    term: displayPhraseTerm(match, index),
    original: match.original,
    matchedForm: match.matchedForm,
  })), matches[0].word.term_language || '');
  setPrivate(span, {
    original: sourceText,
    sentence: context.sentence,
    offset: context.offset,
    candidates: [...new Set(matches.flatMap(match => match.word._candidateIds || [match.word.id]))],
    components: matches.map(match => match.word.id),
    componentCandidates: matches.map(match => match.word._candidateIds || [match.word.id]),
    proposed: composed?.translation || matches.map((match, index) => displayPhraseTerm(match, index)).join(' '),
    sourceLanguage: matches[0].word.search_language || '',
    targetLanguage: matches[0].word.term_language || '',
    domain,
    phrase: true,
    phraseMatches: matches,
  });
  return span;
}

function requestPendingValidations() {
  document.querySelectorAll('.lp-validation-pending').forEach(span => {
    const state = getPrivate(span);
    if (state.validationQueued) return;
    setPrivate(span, { validationQueued: true });
    const item = {
      item_id: String(++validationSequence),
      validation_version: state.validationVersion || 2,
      sentence: String(state.sentence || ''),
      matched_text: state.original,
      match_offset: Number(state.offset),
      candidate_ids: state.candidates,
      component_ids: state.components,
      component_candidate_ids: state.componentCandidates,
      proposed_replacement: state.proposed,
      source_language: state.sourceLanguage,
      target_language: state.targetLanguage,
      phrase: state.phrase,
    };
    const generation = lifecycleGeneration;
    const revision = vocabularyRevision;
    const original = state.original;
    let expired = false;
    let stale = false;
    const editObserver = new MutationObserver(mutations => {
      if (mutations.some(mutation => {
        const element = mutation.target.nodeType === Node.TEXT_NODE
          ? mutation.target.parentElement : mutation.target;
        return !element?.closest(`[${LP_PROCESSED}]`);
      })) stale = true;
    });
    if (span.parentElement) editObserver.observe(span.parentElement, {
      subtree: true, childList: true, characterData: true,
    });
    const timer = setTimeout(() => {
      expired = true;
      editObserver.disconnect();
      if (span.isConnected && span.textContent === original && span.parentNode) {
        span.parentNode.replaceChild(document.createTextNode(original), span);
      }
    }, 8000);
    validationCoordinator.request(item).then(result => {
      // Identical pending occurrences share a request. The coordinator has
      // already matched the backend item ID; give this subscriber its own ID.
      if (result && result.item_id !== item.item_id) result = { ...result, item_id: item.item_id };
      clearTimeout(timer);
      if (expired || stale || generation !== lifecycleGeneration || revision !== vocabularyRevision
        || !extensionActive || !span.isConnected || span.textContent !== original
        || result?.item_id !== item.item_id || result?.validation_version !== item.validation_version
        || result?.decision !== 'replace' || !result.replacement_text) return;
      const ids = Array.isArray(result.vocabulary_ids) ? result.vocabulary_ids.map(String) : [];
      if (!ids.length || ids.some(id => !state.candidates.map(String).includes(id))) return;
      const words = ids.map(id => matcher.wordsById.get(id));
      if (words.some(word => !word)) return;
      let exactForm = null;
      let grammarDetails = [];
      if (item.validation_version === 3) {
        if (result.source_range?.offset !== item.match_offset || result.source_range?.text !== item.matched_text) return;
        if (!Array.isArray(result.form_ids) || result.form_ids.length !== ids.length) return;
        const forms = result.form_ids.map(id => words.flatMap(word => word.word_forms || []).find(form => form.id === id));
        if (forms.some(form => !form) || !result.plan || !Array.isArray(result.plan.atoms)
          || result.plan.atoms.some(atom => atom.form_id && !result.form_ids.includes(atom.form_id))) return;
        exactForm = forms[0];
        grammarDetails = forms.map(form => ({ surface: form.surface, features: form.features || {}, learningScope: form.learning_scope,
          lemma: words.find(word => (word.word_forms || []).some(row => row.id === form.id))?.grammar_profile?.lemma || '' }));
      }
      const selected = words[0];
      const chineseIsland = isZhTarget(selected);
      // A Chinese island shows the synced reviewed term, nothing else.
      if (chineseIsland && (state.phrase || ids.length !== 1 || result.replacement_text !== selected.term)) return;
      if (chineseIsland) renderChineseIsland(span, selected);
      else span.textContent = result.replacement_text;
      span.className = state.phrase ? 'lp-vocab-phrase' : LP_CLASS;
      if (chineseIsland) span.classList.add('lp-zh-island');
      setPrivate(span, {
        wordId: selected.id,
        words: ids,
        original,
        translation: result.replacement_text,
        baseTranslation: ids.length > 1 ? '' : selected.translation || '',
        termLanguage: selected.term_language || state.targetLanguage,
        sourceLanguage: state.sourceLanguage,
        targetLanguage: state.targetLanguage,
        pos: ids.length > 1 ? '' : selected.part_of_speech || '',
        hint: item.validation_version === 3 ? grammarExplanation(result.explanation, state.sourceLanguage) : selected.context_hint || '',
        // Chinese: only the reviewed chunk, never an unreviewed example.
        example: chineseIsland ? '' : selected.example_sentence || '',
        exampleTranslation: chineseIsland ? '' : selected.example_translation || '',
        zh: chineseIsland ? {
          term: selected.term,
          reading: selected.reading || selected.zh_target.reading,
          measureWords: selected.measure_words || selected.zh_target.measure_words,
          usageNote: selected.zh_target.usage_note || '',
          chunk: selected.zh_target.chunk || null,
          gloss: selected.translation || '',
          pinyinStage: effectivePinyinStage(selected),
          contrast: chineseContrast(selected),
        } : null,
        audioUrl: exactForm ? (result.replacement_text === exactForm.surface ? exactForm.pronunciation_audio || '' : '') : selected.pronunciation_audio || '',
        // Writing practice only ever attaches to a single, whole-word replacement.
        hanziWriting: ids.length === 1 && !state.phrase && !exactForm ? selected.hanzi_writing || null : null,
        grammarForm: !!exactForm,
        grammarDetails,
        meaningKey: selected.meaning_key || '',
        phraseType: state.phrase ? 'composed' : undefined,
        method: result.method || 'validation_v2',
        uncertain: 'false',
      });
      span.addEventListener('click', event => {
        if (!event.isTrusted) return;
        event.preventDefault();
        event.stopPropagation();
        if (chineseIsland) recordPinyinTap(selected.id);
        const popup = state.phrase
          ? VocabPopup.showPhrase(span, ids.map(id => {
            const match = state.phraseMatches.find(entry => String(entry.word.id) === id);
            return { word: matcher.wordsById.get(id), original: match?.original || original };
          }))
          : VocabPopup.showWord(span);
        Promise.resolve(popup).catch(() => {});
        ids.forEach(id => recordEncounter(id, state.domain, true));
      });
      if (chineseIsland) {
        // Re-checked on every async apply: a later island next to this one reverts.
        enforceNoBridges(span);
        if (!span.isConnected) return;
      }
      ids.forEach(id => recordEncounter(id, state.domain, false));
    }).catch(() => {}).finally(() => {
      clearTimeout(timer);
      editObserver.disconnect();
      if (span.isConnected && span.classList.contains('lp-validation-pending') && span.parentNode) {
        span.parentNode.replaceChild(document.createTextNode(original), span);
      }
    });
  });
}

function grammarExplanation(code, language) {
  const spanish = language === 'es';
  const explanations = {
    approved_default_masculine: spanish ? 'Forma masculina predeterminada; el género no estaba especificado.' : "Masculine default; gender wasn't specified.",
    approved_default_feminine: spanish ? 'Forma femenina predeterminada; el género no estaba especificado.' : "Feminine default; gender wasn't specified.",
    reviewed_noun_agreement: spanish ? 'Forma revisada que concuerda en género y número.' : 'Reviewed form with matching gender and number.',
    authored_expression: spanish ? 'Expresión completa enseñada en tu curso.' : 'Complete expression taught in your course.',
    reviewed_identity: spanish ? 'Identidad u ocupación; se conserva la persona y el número.' : 'Identity or occupation; person and number are preserved.',
    reviewed_condition: spanish ? 'Estado actual; se conserva la persona y el número.' : 'Current condition; person and number are preserved.',
  };
  return explanations[code] || '';
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

  if (message.type === 'SUBSCRIPTION_REQUIRED') {
    // Vocab Pass access lapsed: restore the page and wait for VOCAB_UPDATED.
    stopDocumentWork();
    lifecycleState = 'unavailable';
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
    vocabularyRevision += 1;
    validationCoordinator.cancel();
    restoreOriginalPageText();
    browser.storage.local.get('rotation_salt').then(({ rotation_salt }) => {
      rotationSalt = rotation_salt || '';
      if (extensionActive) {
        matcher = new VocabMatcher(vocabularyForPage(message.words), { rotationSalt });
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
  zhIslandBudget = { page: 0, words: new Map(), sentences: new WeakMap() };
  document.querySelectorAll('.lp-validation-pending').forEach((element) => {
    if (!element.parentNode) return;
    element.parentNode.replaceChild(document.createTextNode(getPrivate(element).original || element.textContent), element);
  });
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
  vocabularyRevision += 1;
  validationCoordinator.cancel();
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
  document.documentElement.removeAttribute('data-lp-theme');
  window.removeEventListener('beforeunload', flushEncounterBuffer);
  if (loggedOut) {
    automaticEncounterWordIds.clear();
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
