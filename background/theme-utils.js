(function initLangslyTheme(globalScope) {
  const THEME_TOKEN_KEYS = [
    'color-page-bg',
    'color-surface',
    'color-surface-elevated',
    'color-text-primary',
    'color-text-secondary',
    'color-text-muted',
    'color-border',
    'color-border-strong',
    'color-accent',
    'color-accent-hover',
    'color-accent-text',
    'color-success',
    'color-warning',
    'color-danger',
    'color-header-bg',
    'color-sidebar-bg',
    'color-sidebar-text',
    'color-button-primary-bg',
    'color-button-primary-text',
  ];

  const SYSTEM_THEME_TOKENS = {
    'color-page-bg': '#F7F6F2',
    'color-surface': '#FFFFFF',
    'color-surface-elevated': '#F0F1EC',
    'color-text-primary': '#141C1A',
    'color-text-secondary': '#4F5D59',
    'color-text-muted': '#7B8782',
    'color-border': '#DCDDD6',
    'color-border-strong': '#C7C9C0',
    'color-accent': '#C98B2C',
    'color-accent-hover': '#A97220',
    'color-accent-text': '#2B1E08',
    'color-success': '#4E873E',
    'color-warning': '#C98B2C',
    'color-danger': '#C84A58',
    'color-header-bg': '#FFFFFF',
    'color-sidebar-bg': '#FFFFFF',
    'color-sidebar-text': '#4F5D59',
    'color-button-primary-bg': '#B73A48',
    'color-button-primary-text': '#FFFFFF',
  };

  const CSS_VAR_MAP = {
    'color-page-bg': '--lp-page-bg',
    'color-surface': '--lp-surface',
    'color-surface-elevated': '--lp-surface-elevated',
    'color-text-primary': '--lp-text-primary',
    'color-text-secondary': '--lp-text-secondary',
    'color-text-muted': '--lp-text-muted',
    'color-border': '--lp-border',
    'color-border-strong': '--lp-border-strong',
    'color-accent': '--lp-accent',
    'color-accent-hover': '--lp-accent-hover',
    'color-accent-text': '--lp-accent-text',
    'color-success': '--lp-success',
    'color-warning': '--lp-warning',
    'color-danger': '--lp-danger',
    'color-header-bg': '--lp-header-bg',
    'color-sidebar-bg': '--lp-sidebar-bg',
    'color-sidebar-text': '--lp-sidebar-text',
    'color-button-primary-bg': '--lp-button-primary-bg',
    'color-button-primary-text': '--lp-button-primary-text',
  };

  function t(key, fallback) {
    if (globalScope.LangslyI18n) return globalScope.LangslyI18n.t(key, fallback);
    return fallback || key;
  }

  function normalizeThemeTokens(tokens) {
    const source = tokens && typeof tokens === 'object' ? tokens : {};
    return THEME_TOKEN_KEYS.reduce((normalized, tokenKey) => {
      normalized[tokenKey] = source[tokenKey] || SYSTEM_THEME_TOKENS[tokenKey];
      return normalized;
    }, {});
  }

  function getDefaultThemeTokens() {
    return normalizeThemeTokens(SYSTEM_THEME_TOKENS);
  }

  function toCssVariables(tokens) {
    const normalized = normalizeThemeTokens(tokens);
    return THEME_TOKEN_KEYS.reduce((cssVars, tokenKey) => {
      cssVars[CSS_VAR_MAP[tokenKey]] = normalized[tokenKey];
      return cssVars;
    }, {});
  }

  function findThemeBySlug(themePacks, slug) {
    if (!Array.isArray(themePacks) || !slug) return null;
    return themePacks.find((theme) => theme && theme.slug === slug) || null;
  }

  function resolveActiveTheme({ currentUser, themePacks, fallbackSlug } = {}) {
    const activeSlug = currentUser && currentUser.active_theme_slug
      ? currentUser.active_theme_slug
      : (fallbackSlug || 'system');
    const selectedTheme = findThemeBySlug(themePacks, activeSlug);

    if (selectedTheme) {
      return {
        slug: selectedTheme.slug,
        name: selectedTheme.name || selectedTheme.slug,
        tokens: normalizeThemeTokens(selectedTheme.tokens),
      };
    }

    const systemTheme = findThemeBySlug(themePacks, 'system');
    return {
      slug: 'system',
      name: systemTheme && systemTheme.name ? systemTheme.name : t('systemThemeName', 'System'),
      tokens: normalizeThemeTokens(systemTheme && systemTheme.tokens),
    };
  }

  function applyThemeTokensToDocument(root, tokens) {
    if (!root || !root.style) return;
    const cssVars = toCssVariables(tokens);
    Object.keys(cssVars).forEach((cssVar) => {
      root.style.setProperty(cssVar, cssVars[cssVar]);
    });
  }

  globalScope.LangslyTheme = {
    THEME_TOKEN_KEYS,
    SYSTEM_THEME_TOKENS,
    normalizeThemeTokens,
    getDefaultThemeTokens,
    toCssVariables,
    resolveActiveTheme,
    applyThemeTokensToDocument,
  };
})(typeof globalThis !== 'undefined' ? globalThis : self);
