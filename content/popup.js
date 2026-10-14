/**
 * Popup UI module — handles vocabulary word and phrase popups.
 * Loaded before content.js; exposes VocabPopup on window.
 */
/* global browser */

const VocabPopup = (() => {
  const LP_PROCESSED = 'data-lp-processed';
  const LP_CLASS = 'lp-vocab-word';
  const LEGACY_API_BASE = 'http://localhost:8000/api';
  const DEFAULT_API_BASE = 'https://api.langsly.com/api';
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const PHOSPHOR_ICON_PATHS = {
    'speaker-high': 'M160,32.25a8,8,0,0,0-8.78,1.43L80.35,80H32A16,16,0,0,0,16,96v64a16,16,0,0,0,16,16H80.35l70.87,46.32A8,8,0,0,0,164,216V40A8,8,0,0,0,160,32.25ZM148,201.23,87.78,161.88A8,8,0,0,0,83.4,160H32V96H83.4a8,8,0,0,0,4.38-1.31L148,55.25Zm54-106.67a40,40,0,0,1,0,66.88,8,8,0,1,1-8.91-13.29,24,24,0,0,0,0-40.3A8,8,0,1,1,202,94.56Zm32.5-25.08a80,80,0,0,1,0,117,8,8,0,1,1-10.91-11.7,64,64,0,0,0,0-93.62,8,8,0,1,1,10.91-11.7Z',
    'warning-circle': 'M128,24A104,104,0,1,0,232,128,104.11,104.11,0,0,0,128,24Zm0,192a88,88,0,1,1,88-88A88.1,88.1,0,0,1,128,216Zm-8-80V80a8,8,0,0,1,16,0v56a8,8,0,0,1-16,0Zm20,36a12,12,0,1,1-12-12A12,12,0,0,1,140,172Z',
    'check-circle': 'M173.66,98.34a8,8,0,0,1,0,11.32l-56,56a8,8,0,0,1-11.32,0l-24-24a8,8,0,0,1,11.32-11.32L112,148.69l50.34-50.35A8,8,0,0,1,173.66,98.34ZM232,128A104,104,0,1,1,128,24,104.11,104.11,0,0,1,232,128Zm-16,0a88,88,0,1,0-88,88A88.1,88.1,0,0,0,216,128Z',
  };

  let popupEl = null;
  let popupHost = null;
  let popupAnchor = null;
  let popupGeneration = 0;
  let practicePanel = null;
  let privateState = globalThis.LangslyPrivateState || new WeakMap();
  globalThis.LangslyPrivateState = privateState;
  const privateData = (element) => privateState.get(element) || {};
  const setPrivateData = (element, values) => {
    const next = { ...privateData(element), ...values };
    privateState.set(element, next);
    return next;
  };

  function t(key, substitutions, fallback) {
    if (globalThis.LangslyI18n) return globalThis.LangslyI18n.t(key, substitutions, fallback);
    if (fallback === undefined && typeof substitutions === 'string') return substitutions;
    return fallback || key;
  }

  const POS_KEYS = {
    noun: 'posNoun', verb: 'posVerb', adjective: 'posAdjective', adverb: 'posAdverb',
    pronoun: 'posPronoun', preposition: 'posPreposition', conjunction: 'posConjunction',
    interjection: 'posInterjection', article: 'posArticle', determiner: 'posDeterminer',
    number: 'posNumber', numeral: 'posNumber', phrase: 'phraseBadge', expression: 'posExpression',
  };

  // part_of_speech arrives as English curriculum data; label it in the extension's UI language.
  function posLabel(pos) {
    const raw = String(pos || '').trim();
    if (!raw) return '';
    const key = POS_KEYS[raw.toLowerCase()];
    if (key) return t(key, raw.toLowerCase());
    // Unknown values are untranslated English, so show them only in an English UI.
    return String(t('@@ui_locale', 'en')).toLowerCase().startsWith('en') ? raw : '';
  }

  function normalizeUrl(url) {
    return String(url || '').trim().replace(/\/+$/, '');
  }

  function resolveApiBase(value) {
    const normalized = normalizeUrl(value);
    return !normalized || normalized === normalizeUrl(LEGACY_API_BASE)
      ? DEFAULT_API_BASE
      : normalized;
  }

  function createEl(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent) el.textContent = textContent;
    return el;
  }

  function createSvgEl(tag) {
    return typeof document.createElementNS === 'function'
      ? document.createElementNS(SVG_NS, tag)
      : document.createElement(tag);
  }

  function createPhosphorIcon(name, className) {
    const icon = createSvgEl('svg');
    icon.setAttribute('class', `lp-popup-icon ${className || ''}`.trim());
    icon.setAttribute('aria-hidden', 'true');
    icon.setAttribute('focusable', 'false');
    icon.setAttribute('viewBox', '0 0 256 256');
    icon.setAttribute('fill', 'currentColor');
    icon.setAttribute('data-icon-source', 'phosphor');
    icon.setAttribute('data-icon-name', name);

    const pathData = PHOSPHOR_ICON_PATHS[name];
    if (pathData) {
      const path = createSvgEl('path');
      path.setAttribute('d', pathData);
      icon.appendChild(path);
    }
    return icon;
  }

  function setIconButtonContent(button, iconName, label, iconClassName) {
    button.textContent = '';
    button.appendChild(createPhosphorIcon(iconName, iconClassName));
    button.appendChild(createEl('span', 'lp-popup-listen-label', label));
  }

  function setListenButtonContent(button, label) {
    setIconButtonContent(button, 'speaker-high', label, 'lp-popup-listen-icon');
  }

  function setActionButtonContent(button, iconName, label) {
    setIconButtonContent(button, iconName, label, 'lp-popup-action-icon');
  }

  function handleOutsideClick(e) {
    // A stroke that ends outside the popup must never close practice.
    if (practicePanel && practicePanel.drawing) return;
    if (popupHost && !popupHost.contains(e.target)
      && !e.target.classList.contains(LP_CLASS)
      && !e.target.classList.contains('lp-vocab-phrase')) {
      hide();
    }
  }

  function closePractice() {
    if (!practicePanel) return;
    const panel = practicePanel;
    practicePanel = null;
    panel.close();
  }

  function hide() {
    closePractice();
    if (popupEl) {
      popupHost.remove();
      popupEl = null;
      popupHost = null;
    }
    popupAnchor = null;
    document.removeEventListener('click', handleOutsideClick);
  }

  function reset() {
    popupGeneration += 1;
    hide();
    privateState = new WeakMap();
    globalThis.LangslyPrivateState = privateState;
  }

  function positionPopup(anchor) {
    const expectedGeneration = popupGeneration;
    popupAnchor = anchor;
    const rect = anchor.getBoundingClientRect();
    const popupRect = popupEl.getBoundingClientRect();

    const margin = 10;
    const gap = 6;
    const below = rect.bottom + gap;
    const above = rect.top - popupRect.height - gap;
    const viewportTop = below + popupRect.height <= window.innerHeight - margin
      ? below
      : Math.max(margin, above);
    const viewportLeft = Math.min(
      Math.max(margin, rect.left),
      Math.max(margin, window.innerWidth - popupRect.width - margin)
    );
    const top = viewportTop + window.scrollY;
    const left = viewportLeft + window.scrollX;

    popupEl.style.top = `${top}px`;
    popupEl.style.left = `${left}px`;

    setTimeout(() => {
      if (expectedGeneration === popupGeneration && popupHost) {
        document.addEventListener('click', handleOutsideClick);
      }
    }, 10);
  }

  async function getContentConfig() {
    const { apiBase } = await browser.storage.local.get('apiBase');
    return { apiBase: resolveApiBase(apiBase) };
  }

  function mountPopup() {
    popupHost = document.createElement('span');
    popupHost.setAttribute(LP_PROCESSED, 'true');
    const shadow = popupHost.attachShadow({ mode: 'closed' });
    if (adoptPopupStyles(shadow)) {
      shadow.append(popupEl);
    } else {
      // Fallback (Firefox only, where the stylesheet stays web-accessible behind
      // a random per-install UUID).
      const stylesheet = document.createElement('link');
      stylesheet.rel = 'stylesheet';
      stylesheet.href = browser.runtime.getURL('content/content.css');
      stylesheet.addEventListener('load', () => {
        if (popupAnchor && popupEl && popupAnchor.isConnected) positionPopup(popupAnchor);
      }, { once: true });
      shadow.append(stylesheet, popupEl);
    }
    document.body.appendChild(popupHost);
  }

  // The popover's styles are bundled (content/content-styles.js) and adopted as a
  // constructed stylesheet, so no extension file has to be web-accessible.
  function adoptPopupStyles(shadow) {
    const css = globalThis.LangslyContentStyles;
    if (typeof css !== 'string' || typeof CSSStyleSheet !== 'function' || !('adoptedStyleSheets' in shadow)) return false;
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      shadow.adoptedStyleSheets = [sheet];
      return true;
    } catch {
      return false;
    }
  }

  function resolveAudioUrl(audioUrl, apiBase) {
    const trimmed = String(audioUrl || '').trim();
    if (!trimmed) return '';

    try {
      return new URL(trimmed).href;
    } catch {
      // Relative media paths come from the API host, not from the page host.
    }

    try {
      const baseUrl = new URL(apiBase);
      baseUrl.pathname = baseUrl.pathname.replace(/\/api\/?$/, '/') || '/';
      baseUrl.search = '';
      baseUrl.hash = '';
      return new URL(trimmed, baseUrl.href).href;
    } catch {
      return '';
    }
  }

  function isChineseLanguage(languageCode) {
    const code = String(languageCode || '').toLowerCase().replace(/_/g, '-');
    return code === 'zh' || code.startsWith('zh-');
  }

  function speakFallback(translation, termLanguage) {
    const text = String(translation || '').trim();
    // Chinese is reviewed audio only: browser voices may be zh-TW or Cantonese.
    // With no language at all, speech would guess one, so stay silent.
    if (!termLanguage || isChineseLanguage(termLanguage)) return false;
    if (!text || typeof SpeechSynthesisUtterance === 'undefined' || typeof speechSynthesis === 'undefined') return false;

    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = termLanguage;
      speechSynthesis.speak(utterance);
      return true;
    } catch {
      return false;
    }
  }

  function playRealAudio(fullUrl) {
    return new Promise((resolve, reject) => {
      let audio;
      try {
        audio = new Audio(fullUrl);
      } catch (err) {
        reject(err);
        return;
      }

      let settled = false;
      const settle = (callback, value) => {
        if (settled) return;
        settled = true;
        if (typeof audio.removeEventListener === 'function') {
          audio.removeEventListener('error', onError);
        }
        callback(value);
      };
      const onError = () => settle(reject, new Error('Audio failed to load'));

      if (typeof audio.addEventListener === 'function') {
        audio.addEventListener('error', onError, { once: true });
      }

      let playPromise;
      try {
        playPromise = audio.play();
      } catch (err) {
        settle(reject, err);
        return;
      }

      if (playPromise && typeof playPromise.then === 'function') {
        playPromise.then(
          () => settle(resolve),
          err => settle(reject, err),
        );
      } else {
        settle(resolve);
      }
    });
  }

  async function playAudioThroughExtension(fullUrl) {
    const response = await browser.runtime.sendMessage({
      type: 'FETCH_AUDIO',
      url: fullUrl,
    });
    const dataUrl = response && response.success ? String(response.dataUrl || '') : '';
    if (!dataUrl) throw new Error('Extension audio fetch failed');
    await playRealAudio(dataUrl);
  }

  // Plays a recorded pronunciation; false when neither the page nor the extension
  // could play it (blocked, missing or an expired signed URL).
  async function tryPlayRecorded(audioUrl) {
    if (!String(audioUrl || '').trim()) return false;
    const { apiBase } = await getContentConfig();
    const fullUrl = resolveAudioUrl(audioUrl, apiBase);
    if (!fullUrl) return false;
    try {
      await playRealAudio(fullUrl);
      return true;
    } catch {
      try {
        await playAudioThroughExtension(fullUrl);
        return true;
      } catch {
        return false;
      }
    }
  }

  async function playAudio(audioUrl, translation, termLanguage) {
    if (await tryPlayRecorded(audioUrl)) return 'audio';
    // Fall through to speech synthesis so the popup remains useful.
    if (isChineseLanguage(termLanguage)) return 'unavailable';
    speakFallback(translation, termLanguage);
    return 'fallback';
  }

  function isSpanishLanguage(languageCode) {
    return String(languageCode || '').toLowerCase().split('-')[0] === 'es';
  }

  function fallbackListenText(termLanguage) {
    return isSpanishLanguage(termLanguage)
      ? t('listenVoiceSpanish', 'Escuchar (voz)')
      : t('listenVoiceDefault', 'Listen (voice)');
  }

  function fallbackListenTitle(termLanguage) {
    return isSpanishLanguage(termLanguage)
      ? t('noPronunciationTitleSpanish', 'No hay audio de pronunciación disponible; se usará la voz del navegador')
      : t('noPronunciationTitleDefault', 'No pronunciation audio available; using browser voice');
  }

  function audioListenTitle(termLanguage) {
    return isSpanishLanguage(termLanguage)
      ? t('playPronunciationTitleSpanish', 'Reproducir audio de pronunciación')
      : t('playPronunciationTitleDefault', 'Play pronunciation audio');
  }

  const isSignedAudioUrl = url => /[?&]signature=/.test(String(url || ''));

  // Reads the word's current recording from the synced vocabulary. Tapping Listen
  // never starts a full sync; only an expired signed URL asks the worker for a
  // fresh copy, and the worker throttles that to one refresh per few minutes.
  async function syncAudioUrlForWord(wordId, { refreshExpired = false } = {}) {
    const normalizedWordId = String(wordId || '').trim();
    if (!normalizedWordId) return '';

    if (refreshExpired) {
      try {
        await browser.runtime.sendMessage({ type: 'REFRESH_WORD_AUDIO', wordId: normalizedWordId });
      } catch {
        // Keep the listen action usable even if the worker is unavailable.
      }
    }

    try {
      const { vocabWords } = await browser.storage.local.get('vocabWords');
      if (!Array.isArray(vocabWords)) return '';
      const latestWord = vocabWords.find(word => String(word && word.id) === normalizedWordId);
      return String(latestWord && latestWord.pronunciation_audio ? latestWord.pronunciation_audio : '');
    } catch {
      return '';
    }
  }

  async function playAudioFromSpan(span, translation, termLanguage) {
    const state = privateData(span);
    const currentAudioUrl = String(state.audioUrl || '').trim();
    if (currentAudioUrl) {
      if (await tryPlayRecorded(currentAudioUrl)) return 'audio';
      // Cached words carry signed URLs that expire. Use the newer synced copy, or
      // ask for one refresh, before falling back to the browser voice. A lemma
      // recording must never masquerade as a different surface form.
      if (!state.grammarForm && isSignedAudioUrl(currentAudioUrl) && !state.audioRefreshTried) {
        setPrivateData(span, { audioRefreshTried: true });
        let freshUrl = await syncAudioUrlForWord(state.wordId);
        if (!freshUrl || freshUrl === currentAudioUrl) {
          freshUrl = await syncAudioUrlForWord(state.wordId, { refreshExpired: true });
        }
        if (freshUrl && freshUrl !== currentAudioUrl) {
          setPrivateData(span, { audioUrl: freshUrl });
          if (await tryPlayRecorded(freshUrl)) return 'audio';
        }
      }
      return playAudio('', translation, termLanguage);
    }
    if (state.grammarForm) return 'unavailable';

    // No recording when the page was scanned: a later background sync may have
    // added one, so check the stored words (no network) before the browser voice.
    const syncedAudioUrl = await syncAudioUrlForWord(state.wordId);
    if (syncedAudioUrl) {
      setPrivateData(span, { audioUrl: syncedAudioUrl });
      return playAudio(syncedAudioUrl, translation, termLanguage);
    }

    return playAudio('', translation, termLanguage);
  }

  function applyListenFallbackState(button, termLanguage) {
    button.classList.add('lp-popup-listen-fallback');
    setListenButtonContent(button, fallbackListenText(termLanguage));
    button.title = fallbackListenTitle(termLanguage);
  }

  function applyListenAudioState(button, termLanguage) {
    button.classList.remove('lp-popup-listen-fallback');
    setListenButtonContent(button, t('listenButton', 'Listen'));
    button.title = audioListenTitle(termLanguage);
  }

  async function applySelectedAlternative(span, alternativeId) {
    const { vocabWords } = await browser.storage.local.get('vocabWords');
    if (!Array.isArray(vocabWords)) return null;
    const selected = vocabWords.find(w => String(w.id) === String(alternativeId));
    // Chinese islands never switch to another word: only the validator chooses.
    if (!selected || !span.isConnected || isChineseLanguage(selected.term_language)) return null;

    span.textContent = selected.term;
    const previous = privateData(span);
    setPrivateData(span, {
      wordId: selected.id,
      translation: selected.term,
      baseTranslation: selected.translation || '',
      termLanguage: selected.term_language || previous.termLanguage || '',
      pos: selected.part_of_speech || '',
      hint: selected.context_hint || '',
      example: selected.example_sentence || '',
      exampleTranslation: selected.example_translation || '',
      audioUrl: selected.pronunciation_audio || '',
      hanziWriting: selected.hanzi_writing || null,
      meaningKey: selected.meaning_key || previous.meaningKey || '',
      uncertain: 'false',
    });
    span.classList.remove('lp-uncertain');
    return selected;
  }

  function parseJsonArray(raw) {
    try {
      const parsed = JSON.parse(raw || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  async function buildCorrectionOptions(span, alternatives) {
    const map = new Map();
    const state = privateData(span);
    const currentWordId = String(state.wordId || '');

    for (const alt of alternatives) {
      if (!alt || !alt.id) continue;
      const id = String(alt.id);
      if (map.has(id)) continue;
      map.set(id, {
        id,
        term: alt.term || '',
        confidence: typeof alt.confidence === 'number' ? alt.confidence : null,
      });
    }

    const candidateIds = (Array.isArray(state.disambigCandidates) ? state.disambigCandidates : []).map(String).filter(Boolean);
    if (candidateIds.length > 0) {
      try {
        const { vocabWords } = await browser.storage.local.get('vocabWords');
        if (Array.isArray(vocabWords)) {
          for (const id of candidateIds) {
            if (map.has(id)) continue;
            const word = vocabWords.find(w => String(w.id) === id);
            if (!word) continue;
            map.set(id, { id, term: word.term || '', confidence: null });
          }
        }
      } catch {
        // Best-effort fallback only.
      }
    }

    if (currentWordId && !map.has(currentWordId)) {
      map.set(currentWordId, {
        id: currentWordId,
        term: state.translation || '',
        confidence: null,
      });
    }

    return [...map.values()].filter(option => option.id && option.term);
  }

  function buildSafeCandidateIds(span, alternatives, options) {
    const state = privateData(span);
    const fromSpan = (Array.isArray(state.disambigCandidates) ? state.disambigCandidates : []).map(String).filter(Boolean);
    if (fromSpan.length >= 2) return fromSpan;

    const fromAlternatives = alternatives
      .map(alt => String(alt && alt.id ? alt.id : ''))
      .filter(Boolean);
    if (fromAlternatives.length >= 2) return [...new Set(fromAlternatives)];

    const fromOptions = options
      .map(option => String(option && option.id ? option.id : ''))
      .filter(Boolean);
    if (fromOptions.length >= 2) return [...new Set(fromOptions)];

    return [];
  }

  function sendDisambigFeedback(span, payload) {
    const state = privateData(span);
    return browser.runtime.sendMessage({
      type: 'DISAMBIG_FEEDBACK',
      sentence: String(state.disambigSentence || '').slice(0, 320),
      matched_text: state.matchedForm || state.original || '',
      match_offset: Number(state.disambigOffset) || 0,
      candidate_ids: payload.candidateIds || [],
      source_language: state.sourceLanguage || state.disambigSourceLang || '',
      target_language: state.targetLanguage || '',
      shown_word_id: payload.shownWordId || '',
      chosen_word_id: payload.chosenWordId || '',
      was_uncertain: state.uncertain === 'true',
      // The feedback API knows spacy/llm/fallback; validator results say "model:<version>".
      method_used: ['spacy', 'llm', 'fallback'].includes(state.method) ? state.method
        : String(state.method || '').startsWith('model:') ? 'llm' : 'fallback',
    }).catch(() => {});
  }

  function applyWordDatasetFromMatch(el, match) {
    const word = (match && match.word) || {};
    setPrivateData(el, {
      wordId: word.id || '',
      original: (match && match.original) || word.translation || '',
      translation: word.term || '',
      baseTranslation: word.translation || '',
      matchedForm: (match && match.matchedForm) || (match && match.original) || '',
      termLanguage: word.term_language || '',
      pos: word.part_of_speech || '',
      hint: word.context_hint || '',
      example: word.example_sentence || '',
      exampleTranslation: word.example_translation || '',
      audioUrl: word.pronunciation_audio || '',
      hanziWriting: word.hanzi_writing || null,
      sourceLanguage: word.search_language || 'en',
      targetLanguage: word.term_language || '',
      meaningKey: word.meaning_key || word._localMeaningKey || '',
      method: word._method || word._localMethod || 'local',
      disambigAlternatives: Array.isArray(word._alternatives) ? word._alternatives : [],
      disambigCandidates: Array.isArray(word._candidateIds) ? word._candidateIds : [],
    });
  }

  function reportPhraseTranslation(span, original, translated) {
    const cacheEntryId = privateData(span).cacheEntryId || '';
    browser.runtime.sendMessage({
      type: 'PHRASE_FLAG',
      cache_entry_id: cacheEntryId,
      reason: 'user_reported',
    }).catch(() => {});
  }

  async function practiceEnabled() {
    try {
      const { hanziWritingPracticeEnabled } = await browser.storage.local.get('hanziWritingPracticeEnabled');
      return hanziWritingPracticeEnabled !== false;
    } catch {
      return false;
    }
  }

  function focusWord(word) {
    if (!word || !word.isConnected || typeof word.focus !== 'function') return;
    if (!word.hasAttribute('tabindex')) word.setAttribute('tabindex', '-1');
    try { word.focus({ preventScroll: true }); } catch { /* focus is best-effort */ }
  }

  /**
   * Replace the popup body with the practice panel. The word details stay in
   * the DOM, hidden, so "Back to word" restores them exactly as they were.
   */
  function openPractice(span, anchor, reference, trigger) {
    const practice = globalThis.LangslyWritingPractice;
    if (!popupEl || practicePanel || !practice) return;
    const host = popupEl;
    const details = [...host.children];
    for (const child of details) child.hidden = true;
    host.classList.add('lp-writing-open');
    const restoreDetails = () => {
      closePractice();
      for (const child of details) child.hidden = false;
      host.classList.remove('lp-writing-open');
      if (popupEl === host && anchor.isConnected) positionPopup(anchor);
      if (trigger && typeof trigger.focus === 'function') trigger.focus();
    };
    practicePanel = practice.openPanel({
      host,
      anchor: span,
      reference,
      onBack: restoreDetails,
      onClose: ({ reason } = {}) => {
        if (popupEl !== host) return;
        hide();
        if (reason !== 'anchor_removed' && reason !== 'pagehide') focusWord(span);
      },
    });
    if (anchor.isConnected) positionPopup(anchor);
  }

  function chineseEl(tag, className, text) {
    const el = createEl(tag, className, text);
    el.setAttribute('lang', 'zh-Hans');
    return el;
  }

  function pinyinText(syllables) {
    return Array.isArray(syllables) ? syllables.join(' ') : '';
  }

  function appendReading(parent, citation, spoken) {
    parent.appendChild(createEl('span', 'lp-zh-pinyin', pinyinText(citation)));
    if (Array.isArray(spoken) && spoken.length) {
      parent.appendChild(createEl('span', 'lp-zh-said', `${t('zhSaidLabel', 'said')}: ${pinyinText(spoken)}`));
    }
  }

  /**
   * Chinese island popup (phrase-first). Every line comes from the reviewed
   * profile synced for this word: hanzi, citation and spoken pinyin, the
   * reviewed chunk directly under the word, one contrast line from another
   * reviewed row, the measure word and the usage note. Reviewed audio only;
   * never browser speech, never an alternative-word chooser.
   */
  async function showChineseWord(span, anchor = span) {
    hide();
    const expectedGeneration = popupGeneration;
    const state = privateData(span);
    const zh = state.zh || {};
    const writingEnabled = await practiceEnabled();
    if (expectedGeneration !== popupGeneration || !span.isConnected) return;

    popupEl = document.createElement('div');
    popupEl.className = 'lp-vocab-popup lp-zh-popup';
    popupEl.setAttribute(LP_PROCESSED, 'true');

    const header = createEl('div', 'lp-popup-header');
    header.appendChild(createEl('span', 'lp-popup-original', state.original || ''));
    header.appendChild(createEl('span', 'lp-popup-arrow', '→'));
    header.appendChild(chineseEl('span', 'lp-popup-translation lp-zh-term', zh.term || ''));
    if (zh.gloss) header.appendChild(createEl('span', 'lp-popup-base', `(${zh.gloss})`));
    if (posLabel(state.pos)) header.appendChild(createEl('span', 'lp-popup-pos', posLabel(state.pos)));
    popupEl.appendChild(header);

    const reading = zh.reading || {};
    const readingRow = createEl('div', 'lp-zh-reading');
    appendReading(readingRow, reading.citation, reading.spoken);
    popupEl.appendChild(readingRow);
    if (reading.tone_note) popupEl.appendChild(createEl('div', 'lp-popup-hint', reading.tone_note));

    // (v2) Phrase-first: the reviewed chunk sits directly under the word.
    const chunk = zh.chunk;
    if (chunk && chunk.zh) {
      const chunkBox = createEl('div', 'lp-zh-chunk');
      chunkBox.appendChild(chineseEl('div', 'lp-zh-chunk-text', chunk.zh));
      const chunkReading = createEl('div', 'lp-zh-reading');
      appendReading(chunkReading, chunk.citation, chunk.spoken);
      chunkBox.appendChild(chunkReading);
      if (chunk.en) chunkBox.appendChild(createEl('div', 'lp-popup-example-translation', `“${chunk.en}”`));
      popupEl.appendChild(chunkBox);
    }

    if (zh.contrast && zh.contrast.term) {
      const contrast = createEl('div', 'lp-popup-hint lp-zh-contrast');
      contrast.appendChild(chineseEl('span', '', zh.contrast.term));
      contrast.appendChild(document.createTextNode(` = ${zh.contrast.gloss || ''}`));
      popupEl.appendChild(contrast);
    }

    const measureWords = zh.measureWords || {};
    const items = Array.isArray(measureWords.items) ? measureWords.items : [];
    const preferred = measureWords.countable === true ? (items.find(item => item && item.preferred) || items[0]) : null;
    if (preferred && preferred.hanzi) {
      const line = createEl('div', 'lp-popup-hint lp-zh-measure');
      line.appendChild(createEl('span', '', `${t('zhMeasureWordLabel', 'Measure word')}: `));
      line.appendChild(chineseEl('span', 'lp-zh-term-small', preferred.hanzi));
      line.appendChild(createEl('span', 'lp-zh-pinyin', ` ${pinyinText(preferred.pinyin)}`));
      if (preferred.example) {
        line.appendChild(document.createTextNode(' · '));
        line.appendChild(chineseEl('span', '', preferred.example));
      }
      popupEl.appendChild(line);
    }

    if (zh.usageNote) popupEl.appendChild(createEl('div', 'lp-popup-hint lp-zh-usage', zh.usageNote));

    const actions = createEl('div', 'lp-popup-actions');
    const listenBtn = createEl('button', 'lp-popup-listen');
    listenBtn.type = 'button';
    const showUnavailable = (key, fallback) => {
      setListenButtonContent(listenBtn, t(key, fallback));
      listenBtn.disabled = true;
    };
    if (String(state.audioUrl || '').trim()) {
      applyListenAudioState(listenBtn, state.termLanguage);
    } else {
      showUnavailable('zhNoReviewedAudio', 'No reviewed audio yet');
    }
    listenBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (listenBtn.disabled) return;
      listenBtn.disabled = true;
      const result = await playAudioFromSpan(span, zh.term, state.termLanguage);
      if (result === 'audio') listenBtn.disabled = false;
      else showUnavailable('zhAudioUnavailable', 'Audio unavailable');
    });
    actions.appendChild(listenBtn);

    // "Wrong meaning?" only reports to the reviewer; it never swaps words.
    const wrongBtn = createEl('button', 'lp-popup-listen');
    wrongBtn.type = 'button';
    setActionButtonContent(wrongBtn, 'warning-circle', t('wrongMeaning', 'Wrong meaning?'));
    wrongBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      const shownWordId = String(state.wordId || '');
      sendDisambigFeedback(span, { candidateIds: [shownWordId], shownWordId, chosenWordId: shownWordId });
      setActionButtonContent(wrongBtn, 'check-circle', t('flagged', 'Flagged'));
      wrongBtn.disabled = true;
    });
    actions.appendChild(wrongBtn);
    popupEl.appendChild(actions);

    const writing = globalThis.LangslyWritingPractice
      ? globalThis.LangslyWritingPractice.eligibleReference(state, { enabled: writingEnabled })
      : null;
    if (writing) {
      const writingRow = createEl('div', 'lp-popup-actions lp-writing-entry');
      const practiceBtn = createEl('button', 'lp-popup-listen', t('practiceWritingButton', 'Practice writing'));
      practiceBtn.type = 'button';
      practiceBtn.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        openPractice(span, anchor || span, writing, practiceBtn);
      });
      writingRow.appendChild(practiceBtn);
      popupEl.appendChild(writingRow);
    }

    mountPopup();
    positionPopup(anchor || span);
  }


  /**
   * Show popup for a single vocabulary word span.
   */
  async function showWord(span, anchor = span) {
    if (privateData(span).zh) return showChineseWord(span, anchor);
    hide();
    const expectedGeneration = popupGeneration;

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
      uncertain,
    } = privateData(span);
    const alternatives = Array.isArray(privateData(span).disambigAlternatives) ? privateData(span).disambigAlternatives : [];
    const correctionOptions = await buildCorrectionOptions(span, alternatives);
    const writingEnabled = await practiceEnabled();
    if (expectedGeneration !== popupGeneration || !span.isConnected) return;
    const safeCandidateIds = buildSafeCandidateIds(span, alternatives, correctionOptions);

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
    if (posLabel(pos)) header.appendChild(createEl('span', 'lp-popup-pos', posLabel(pos)));
    if (uncertain === 'true') {
      header.appendChild(createEl('span', 'lp-popup-pos lp-popup-uncertain', t('uncertainBadge', 'uncertain')));
    }
    popupEl.appendChild(header);

    // Hint
    if (hint) {
      popupEl.appendChild(createEl('div', 'lp-popup-hint', hint));
    }
    for (const form of privateData(span).grammarDetails || []) {
      const featureLabels = Object.values(form.features).map(value => t(`grammarFeature_${value}`, String(value).replaceAll('_', ' ')));
      const scopeLabel = form.learningScope === 'related' ? t('grammarRelatedForm', 'Related form within taught scope')
        : form.learningScope === 'introduced' ? t('grammarIntroducedForm', 'Introduced form') : '';
      popupEl.appendChild(createEl('div', 'lp-popup-hint', [form.surface, form.lemma, ...featureLabels, scopeLabel].filter(Boolean).join(' · ')));
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

    const alsoUsedAs = correctionOptions.filter(option => String(option.id) !== String(privateData(span).wordId));
    if (alsoUsedAs.length > 0) {
      const alts = createEl('div', 'lp-popup-example');
      alts.appendChild(createEl('div', 'lp-popup-hint', t('alsoUsedAs', 'Also used as:')));
      const altText = alsoUsedAs
        .map(alt => alt.term)
        .filter(Boolean)
        .join(' · ');
      if (altText) {
        alts.appendChild(createEl('div', 'lp-popup-example-translation', altText));
      }
      popupEl.appendChild(alts);
    }

    // Listen button
    const actions = createEl('div', 'lp-popup-actions');
    const hasAudio = !!String(audioUrl || '').trim();
    const listenBtn = createEl('button', 'lp-popup-listen');
    listenBtn.type = 'button';
    if (hasAudio) {
      applyListenAudioState(listenBtn, termLanguage);
    } else if (privateData(span).grammarForm) {
      setListenButtonContent(listenBtn, t('formAudioUnavailable', 'Audio unavailable for this form'));
      listenBtn.disabled = true;
    } else {
      applyListenFallbackState(listenBtn, termLanguage);
    }
    listenBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      listenBtn.disabled = true;
      try {
        const result = await playAudioFromSpan(span, translation, termLanguage);
        if (result === 'fallback') {
          applyListenFallbackState(listenBtn, termLanguage);
        } else if (result === 'audio') {
          applyListenAudioState(listenBtn, termLanguage);
        }
      } finally {
        listenBtn.disabled = false;
      }
    });
    actions.appendChild(listenBtn);

    const wrongBtn = createEl('button', 'lp-popup-listen');
    wrongBtn.type = 'button';
    setActionButtonContent(wrongBtn, 'warning-circle', t('wrongMeaning', 'Wrong meaning?'));
    actions.appendChild(wrongBtn);
    popupEl.appendChild(actions);

    // Optional, secondary: only for eligible Chinese target words, and only on click.
    const writing = globalThis.LangslyWritingPractice
      ? globalThis.LangslyWritingPractice.eligibleReference(privateData(span), { enabled: writingEnabled })
      : null;
    if (writing) {
      const writingRow = createEl('div', 'lp-popup-actions lp-writing-entry');
      const practiceBtn = createEl('button', 'lp-popup-listen', t('practiceWritingButton', 'Practice writing'));
      practiceBtn.type = 'button';
      practiceBtn.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        openPractice(span, anchor || span, writing, practiceBtn);
      });
      writingRow.appendChild(practiceBtn);
      popupEl.appendChild(writingRow);
    }

    const chooser = createEl('div', 'lp-phrase-words');
    chooser.style.display = 'none';

    const selectableOptions = correctionOptions.filter(option => String(option.id) !== String(privateData(span).wordId));
    if (selectableOptions.length > 0) {
      for (const option of selectableOptions) {
        const row = createEl('button', 'lp-phrase-word-row');
        row.style.width = '100%';
        row.type = 'button';
        row.appendChild(createEl('span', 'lp-phrase-word-term', option.term || option.id));
        if (typeof option.confidence === 'number') {
          row.appendChild(createEl('span', 'lp-popup-pos', `${Math.round(option.confidence * 100)}%`));
        }
        row.addEventListener('click', async (e) => {
          if (!e.isTrusted) return;
          e.stopPropagation();
          const beforeWordId = privateData(span).wordId || '';
          await applySelectedAlternative(span, option.id);
          setActionButtonContent(wrongBtn, 'check-circle', t('corrected', 'Corrected'));
          wrongBtn.disabled = true;
          chooser.style.display = 'none';
          if (safeCandidateIds.length >= 2) {
            sendDisambigFeedback(span, {
              candidateIds: safeCandidateIds,
              shownWordId: beforeWordId,
              chosenWordId: String(option.id),
            });
          }
        });
        chooser.appendChild(row);
      }
    } else {
      chooser.appendChild(createEl(
        'div',
        'lp-popup-example-translation',
        t('noLearnedAlternatives', 'No learned alternatives yet. Marking this helps improve future guesses.'),
      ));
      const reportOnly = createEl('button', 'lp-popup-listen');
      reportOnly.type = 'button';
      reportOnly.disabled = safeCandidateIds.length < 2;
      setActionButtonContent(reportOnly, 'warning-circle', t('markIncorrect', 'Mark incorrect'));
      reportOnly.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        setActionButtonContent(wrongBtn, 'check-circle', t('flagged', 'Flagged'));
        wrongBtn.disabled = true;
        chooser.style.display = 'none';
        if (safeCandidateIds.length >= 2) {
          const shownWordId = privateData(span).wordId || '';
          sendDisambigFeedback(span, {
            candidateIds: safeCandidateIds,
            shownWordId,
            chosenWordId: shownWordId,
          });
        }
      });
      chooser.appendChild(reportOnly);
    }
    popupEl.appendChild(chooser);

    wrongBtn.addEventListener('click', (e) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      chooser.style.display = chooser.style.display === 'none' ? 'block' : 'none';
    });

    mountPopup();
    positionPopup(anchor || span);
  }

  /**
   * Show popup for a phrase span with component words.
   */
  function showPhrase(span, matches) {
    hide();
    if (!span.isConnected) return;

    const state = privateData(span);
    const original = state.original || '';
    const phraseType = state.phraseType || 'word-by-word';
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
    const badge = createEl('span', 'lp-popup-pos', t('phraseBadge', 'phrase'));
    header.appendChild(badge);
    popupEl.appendChild(header);

    // Component words list
    const wordsList = createEl('div', 'lp-phrase-words');
    for (const m of matches) {
      const wordRow = createEl('button', 'lp-phrase-word-row');
      wordRow.type = 'button';
      applyWordDatasetFromMatch(wordRow, m);
      wordRow.appendChild(createEl('span', 'lp-phrase-word-original', m.original));
      wordRow.appendChild(createEl('span', 'lp-popup-arrow', '\u2192'));
      wordRow.appendChild(createEl('span', 'lp-phrase-word-term', m.word.term));
      if (posLabel(m.word.part_of_speech)) {
        wordRow.appendChild(createEl('span', 'lp-popup-pos', posLabel(m.word.part_of_speech)));
      }
      wordRow.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        Promise.resolve(showWord(wordRow, span)).catch(() => {});
      });
      wordsList.appendChild(wordRow);
    }
    popupEl.appendChild(wordsList);

    // Report button for composed phrases
    if (composedText) {
      const actions = createEl('div', 'lp-popup-actions');
      const reportBtn = createEl('button', 'lp-popup-listen');
      reportBtn.type = 'button';
      setActionButtonContent(reportBtn, 'warning-circle', t('report', 'Report'));
      reportBtn.addEventListener('click', (e) => {
        if (!e.isTrusted) return;
        e.stopPropagation();
        reportPhraseTranslation(span, original, composedText);
        setActionButtonContent(reportBtn, 'check-circle', t('reported', 'Reported'));
        reportBtn.disabled = true;
      });
      actions.appendChild(reportBtn);
      popupEl.appendChild(actions);
    }

    mountPopup();
    positionPopup(span);
  }

  return { showWord, showPhrase, hide, reset };
})();
