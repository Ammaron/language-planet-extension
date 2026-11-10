(function initSourceLanguage(global) {
  // CJK punctuation, kana, bopomofo, ideographs, Hangul and full-width forms,
  // including supplementary-plane ideographs.
  const CJK_TEXT = /[　-鿿가-힯豈-﫿＀-￯]|[\u{20000}-\u{3ffff}]/u;
  const HAN_TERM = /^\p{Script=Han}+$/u;

  function resolve(value) {
    const tag = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    if (!tag) return '';
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(tag)) return null;
    if (tag === 'zh') return 'zh';
    if (tag.startsWith('zh-')) {
      const subtags = tag.split('-').slice(1);
      if (subtags.some(part => ['hant', 'tw', 'hk'].includes(part))) return null;
      return subtags.some(part => ['hans', 'cn', 'sg'].includes(part)) ? 'zh' : null;
    }
    return tag.split('-')[0];
  }

  // A word a Chinese page may swap: exact reviewed Chinese forms for one English
  // or Spanish term, validated by the single-word path. Anything else is dropped;
  // one unfinished word does not take the learner's other words with it.
  function isUsableChinesePageRow(word) {
    return !!word && typeof word.id === 'string' && !!word.id.trim()
      && typeof word.term === 'string' && !!word.term.trim()
      && typeof word.translation === 'string' && !!word.translation.trim()
      && word.search_language === 'zh'
      && ['es', 'en'].includes(word.term_language)
      && word.validation_version !== 3
      && Array.isArray(word.source_forms) && word.source_forms.length > 0
      && word.source_forms.every(form => typeof form === 'string' && form.trim()
        && !/[\/／]/.test(form));
  }

  function chinesePageRows(data) {
    return data && Array.isArray(data.words) ? data.words.filter(isUsableChinesePageRow) : [];
  }

  function isChineseVocabularyResponseReady(data) {
    return !!data && data.source_language_ready === true && data.source_language === 'zh'
      && Array.isArray(data.validation_versions) && data.validation_versions.includes(2)
      && chinesePageRows(data).length > 0;
  }

  function containsCjk(text) {
    return CJK_TEXT.test(String(text || ''));
  }

  // Chinese as the learner's target (English pages). Traditional tags count
  // here too, so the readiness check below can drop them.
  function isChineseTargetWord(word) {
    const tag = String(word && word.term_language || '').trim().toLowerCase().replace(/_/g, '-');
    return tag === 'zh' || tag.startsWith('zh-');
  }

  function isSyllableList(value, length) {
    return Array.isArray(value) && value.length === length
      && value.every(syllable => typeof syllable === 'string' && /^\S+$/.test(syllable));
  }

  // A Chinese target row may reach a page only with complete reviewed data:
  // Simplified Han term, one reading syllable per character, reviewed audio
  // and exact English triggers. Anything else is dropped, never shown.
  function isReadyChineseTargetRow(row) {
    if (!row || typeof row !== 'object' || !isChineseTargetWord(row) || resolve(row.term_language) !== 'zh') return false;
    const profile = row.zh_target;
    const reading = profile && profile.reading;
    const characters = typeof row.term === 'string' && HAN_TERM.test(row.term) ? [...row.term] : [];
    return String(row.id ?? '').trim() !== ''
      && row.term_script === 'Hans'
      && characters.length > 0
      && resolve(row.search_language) === 'en'
      && !!profile && typeof profile === 'object' && profile.version === 1
      && !!reading && isSyllableList(reading.citation, characters.length)
      && (reading.spoken === null || reading.spoken === undefined || isSyllableList(reading.spoken, characters.length))
      && typeof row.pronunciation_audio === 'string' && row.pronunciation_audio.trim() !== ''
      && Array.isArray(row.source_forms) && row.source_forms.length > 0
      && row.source_forms.every(form => typeof form === 'string' && form.trim()
        && !containsCjk(form) && !/[\/／]/.test(form))
      && !!profile.review && profile.review.state === 'approved';
  }

  // Automatic page language is the default. Before the setting existed, people
  // who picked Spanish or Chinese pages by hand keep that choice.
  function isAutoPageLanguage(pageLanguageAuto, extensionSourceLanguage) {
    if (pageLanguageAuto === true || pageLanguageAuto === false) return pageLanguageAuto;
    return !['es', 'zh'].includes(resolve(extensionSourceLanguage));
  }

  global.LangslySourceLanguage = {
    resolve, isAutoPageLanguage, isChineseVocabularyResponseReady, chinesePageRows, containsCjk, isChineseTargetWord, isReadyChineseTargetRow,
  };
})(globalThis);
