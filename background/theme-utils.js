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
    'color-page-bg': '#eef4ff',
    'color-surface': '#ffffff',
    'color-surface-elevated': '#eef2ff',
    'color-text-primary': '#0f172a',
    'color-text-secondary': '#334155',
    'color-text-muted': '#64748b',
    'color-border': '#e2e8f0',
    'color-border-strong': '#cbd5e1',
    'color-accent': '#2563eb',
    'color-accent-hover': '#1d4ed8',
    'color-accent-text': '#ffffff',
    'color-success': '#10b981',
    'color-warning': '#f59e0b',
    'color-danger': '#ef4444',
    'color-header-bg': '#ffffff',
    'color-sidebar-bg': '#ffffff',
    'color-sidebar-text': '#334155',
    'color-button-primary-bg': '#2563eb',
    'color-button-primary-text': '#ffffff',
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
      name: systemTheme && systemTheme.name ? systemTheme.name : 'System',
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
