(function initSourceLanguage(global) {
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

  function isChineseVocabularyResponseReady(data) {
    if (!data || data.source_language_ready !== true || data.source_language !== 'zh'
      || !Array.isArray(data.words) || data.words.length === 0
      || !Array.isArray(data.validation_versions)
      || data.validation_versions.length !== 1 || data.validation_versions[0] !== 2) return false;

    const targets = new Set(data.words.map(word => word?.term_language));
    if (targets.size !== 1) return false;
    return data.words.every(word => word && typeof word.id === 'string' && word.id.trim()
      && typeof word.term === 'string' && word.term.trim()
      && typeof word.translation === 'string' && word.translation.trim()
      && word.search_language === 'zh'
      && ['es', 'en'].includes(word.term_language)
      && Array.isArray(word.source_forms) && word.source_forms.length > 0
      && word.source_forms.every(form => typeof form === 'string' && form.trim()
        && !/[\/／]/.test(form)));
  }

  global.LangslySourceLanguage = { resolve, isChineseVocabularyResponseReady };
})(globalThis);
