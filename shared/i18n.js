(function initLangslyI18n(global) {
  function getApi() {
    if (global.chrome && global.chrome.i18n && typeof global.chrome.i18n.getMessage === 'function') {
      return global.chrome.i18n;
    }
    if (global.browser && global.browser.i18n && typeof global.browser.i18n.getMessage === 'function') {
      return global.browser.i18n;
    }
    return null;
  }

  function normalizeSubstitutions(substitutions) {
    if (substitutions === undefined || substitutions === null) return undefined;
    if (Array.isArray(substitutions)) return substitutions.map(value => String(value));
    return String(substitutions);
  }

  function interpolateFallback(fallback, substitutions) {
    if (!fallback) return '';
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return String(fallback).replace(/\$(\d+)/g, (match, index) => {
      const value = values[Number(index) - 1];
      return value === undefined || value === null ? match : String(value);
    });
  }

  function t(key, substitutions, fallback) {
    let messageSubstitutions = substitutions;
    let fallbackText = fallback;

    if (fallbackText === undefined && typeof substitutions === 'string') {
      fallbackText = substitutions;
      messageSubstitutions = undefined;
    }

    const api = getApi();
    if (api) {
      try {
        const message = api.getMessage(key, normalizeSubstitutions(messageSubstitutions));
        if (message) return message;
      } catch {
        // Fall back below so tests and non-extension previews keep rendering.
      }
    }

    return interpolateFallback(fallbackText || key, messageSubstitutions);
  }

  function applyMessage(element, key, setter) {
    if (!element || !key) return;
    const message = t(key, element.getAttribute('data-i18n-fallback') || '');
    if (message) setter(message);
  }

  function apply(root) {
    const doc = global.document;
    const scope = root || doc;
    if (!doc || !scope || typeof scope.querySelectorAll !== 'function') return;

    if (doc.documentElement) {
      const locale = t('@@ui_locale', 'en');
      const direction = t('@@bidi_dir', 'ltr');
      doc.documentElement.lang = locale || 'en';
      doc.documentElement.dir = direction || 'ltr';
    }

    scope.querySelectorAll('[data-i18n]').forEach((element) => {
      applyMessage(element, element.getAttribute('data-i18n'), message => {
        element.textContent = message;
      });
    });

    scope.querySelectorAll('[data-i18n-placeholder]').forEach((element) => {
      applyMessage(element, element.getAttribute('data-i18n-placeholder'), message => {
        element.setAttribute('placeholder', message);
      });
    });

    scope.querySelectorAll('[data-i18n-title]').forEach((element) => {
      applyMessage(element, element.getAttribute('data-i18n-title'), message => {
        element.setAttribute('title', message);
      });
    });

    scope.querySelectorAll('[data-i18n-aria-label]').forEach((element) => {
      applyMessage(element, element.getAttribute('data-i18n-aria-label'), message => {
        element.setAttribute('aria-label', message);
      });
    });
  }

  function isExtensionPage() {
    const protocol = global.location && global.location.protocol;
    return protocol === 'chrome-extension:' || protocol === 'moz-extension:';
  }

  global.LangslyI18n = { t, apply };

  if (isExtensionPage() && global.document) {
    if (global.document.readyState === 'loading') {
      global.document.addEventListener('DOMContentLoaded', () => apply(global.document));
    } else {
      apply(global.document);
    }
  }
})(globalThis);
