/**
 * Popup UI module — handles vocabulary word and phrase popups.
 * Loaded before content.js; exposes VocabPopup on window.
 */
/* global browser */

const VocabPopup = (() => {
  const LP_PROCESSED = 'data-lp-processed';
  const LP_CLASS = 'lp-vocab-word';

  let popupEl = null;

  function createEl(tag, className, textContent) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (textContent) el.textContent = textContent;
    return el;
  }

  function handleOutsideClick(e) {
    if (popupEl && !popupEl.contains(e.target)
      && !e.target.classList.contains(LP_CLASS)
      && !e.target.classList.contains('lp-vocab-phrase')) {
      hide();
    }
  }

  function hide() {
    if (popupEl) {
      popupEl.remove();
      popupEl = null;
    }
    document.removeEventListener('click', handleOutsideClick);
  }

  function positionPopup(anchor) {
    const rect = anchor.getBoundingClientRect();
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

  async function getContentConfig() {
    const { apiBase } = await browser.storage.local.get('apiBase');
    return { apiBase: apiBase || 'http://localhost:8000/api' };
  }

  async function playAudio(audioUrl, translation, termLanguage) {
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

  function reportPhraseTranslation(span, original, translated) {
    const cacheEntryId = span.dataset.cacheEntryId || '';
    browser.runtime.sendMessage({
      type: 'PHRASE_FLAG',
      cache_entry_id: cacheEntryId,
      reason: 'user_reported',
    }).catch(() => {});
  }

  /**
   * Show popup for a single vocabulary word span.
   */
  function showWord(span) {
    hide();

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
      playAudio(audioUrl, translation, termLanguage);
    });
    actions.appendChild(listenBtn);
    popupEl.appendChild(actions);

    document.body.appendChild(popupEl);
    positionPopup(span);
  }

  /**
   * Show popup for a phrase span with component words.
   */
  function showPhrase(span, matches) {
    hide();

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
    positionPopup(span);
  }

  return { showWord, showPhrase, hide };
})();
