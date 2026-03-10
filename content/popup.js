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

  async function applySelectedAlternative(span, alternativeId) {
    const { vocabWords } = await browser.storage.local.get('vocabWords');
    if (!Array.isArray(vocabWords)) return null;
    const selected = vocabWords.find(w => String(w.id) === String(alternativeId));
    if (!selected || !span.isConnected) return null;

    span.textContent = selected.term;
    span.dataset.wordId = selected.id;
    span.dataset.translation = selected.term;
    span.dataset.baseTranslation = selected.translation || '';
    span.dataset.termLanguage = selected.term_language || span.dataset.termLanguage || 'es';
    span.dataset.pos = selected.part_of_speech || '';
    span.dataset.hint = selected.context_hint || '';
    span.dataset.example = selected.example_sentence || '';
    span.dataset.exampleTranslation = selected.example_translation || '';
    span.dataset.audioUrl = selected.pronunciation_audio || '';
    span.dataset.meaningKey = selected.meaning_key || span.dataset.meaningKey || '';
    span.dataset.uncertain = 'false';
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
    const currentWordId = String(span.dataset.wordId || '');

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

    const candidateIds = parseJsonArray(span.dataset.disambigCandidates).map(String).filter(Boolean);
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
        term: span.dataset.translation || '',
        confidence: null,
      });
    }

    return [...map.values()].filter(option => option.id && option.term);
  }

  function buildSafeCandidateIds(span, alternatives, options) {
    const fromSpan = parseJsonArray(span.dataset.disambigCandidates).map(String).filter(Boolean);
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
    return browser.runtime.sendMessage({
      type: 'DISAMBIG_FEEDBACK',
      sentence: span.dataset.disambigSentence || '',
      matched_text: span.dataset.matchedForm || span.dataset.original || '',
      match_offset: parseInt(span.dataset.disambigOffset || '0', 10) || 0,
      candidate_ids: payload.candidateIds || [],
      source_language: span.dataset.sourceLanguage || span.dataset.disambigSourceLang || 'en',
      target_language: span.dataset.targetLanguage || 'es',
      shown_word_id: payload.shownWordId || '',
      chosen_word_id: payload.chosenWordId || '',
      was_uncertain: span.dataset.uncertain === 'true',
      method_used: span.dataset.method || 'spacy',
    }).catch(() => {});
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
  async function showWord(span) {
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
      uncertain,
    } = span.dataset;
    const alternatives = parseJsonArray(span.dataset.disambigAlternatives);
    const correctionOptions = await buildCorrectionOptions(span, alternatives);
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
    if (pos) header.appendChild(createEl('span', 'lp-popup-pos', pos));
    if (uncertain === 'true') {
      header.appendChild(createEl('span', 'lp-popup-pos lp-popup-uncertain', 'uncertain'));
    }
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

    const alsoUsedAs = correctionOptions.filter(option => String(option.id) !== String(span.dataset.wordId));
    if (alsoUsedAs.length > 0) {
      const alts = createEl('div', 'lp-popup-example');
      alts.appendChild(createEl('div', 'lp-popup-hint', 'Also used as:'));
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
    const listenBtn = createEl('button', 'lp-popup-listen', '\uD83D\uDD0A Listen');
    listenBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      playAudio(audioUrl, translation, termLanguage);
    });
    actions.appendChild(listenBtn);

    const wrongBtn = createEl('button', 'lp-popup-listen', '\u26A0 Wrong meaning?');
    actions.appendChild(wrongBtn);
    popupEl.appendChild(actions);

    const chooser = createEl('div', 'lp-phrase-words');
    chooser.style.display = 'none';

    const selectableOptions = correctionOptions.filter(option => String(option.id) !== String(span.dataset.wordId));
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
          e.stopPropagation();
          const beforeWordId = span.dataset.wordId || '';
          await applySelectedAlternative(span, option.id);
          wrongBtn.textContent = '\u2713 Corrected';
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
        'No learned alternatives yet. Marking this helps improve future guesses.',
      ));
      const reportOnly = createEl('button', 'lp-popup-listen', '\u2713 Mark incorrect');
      reportOnly.type = 'button';
      reportOnly.disabled = safeCandidateIds.length < 2;
      reportOnly.addEventListener('click', (e) => {
        e.stopPropagation();
        wrongBtn.textContent = '\u2713 Flagged';
        wrongBtn.disabled = true;
        chooser.style.display = 'none';
        if (safeCandidateIds.length >= 2) {
          const shownWordId = span.dataset.wordId || '';
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
      e.stopPropagation();
      chooser.style.display = chooser.style.display === 'none' ? 'block' : 'none';
    });

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
