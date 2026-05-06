# Extension Theme Redesign Design

## Context

The browser extension has three user-facing surfaces:

- `popup/onboarding.html`, shown on first install.
- `popup/popup.html`, the main extension popup.
- `popup/options.html`, the configuration page.

The current main popup already has some custom Langsly styling, but it uses fixed colors. The onboarding and options pages still use a generic blue/emoji style. The Langsly web app already supports user-selected theme packs through dashboard theme APIs and CSS token keys.

The redesign will make the extension follow the user's selected dashboard theme and improve the first-install and main popup screens so they feel like part of the same Langsly product.

## Goals

- Redesign onboarding and the main popup around the Langsly website/app theme system.
- Automatically mirror the theme selected in the user's dashboard.
- Add a compact, non-intrusive theme selector in the main popup only after login.
- Keep vocabulary sync, login, whitelist toggling, difficulty selection, and dashboard navigation behavior intact.
- Make theme failures non-blocking: the extension must remain usable with fallback tokens.

## Non-Goals

- Do not build a full theme shop inside the extension.
- Do not add theme previews, unlock flows, or XP purchase flows to the popup.
- Do not change Vocab Pass word replacement behavior.
- Do not redesign unrelated backend or dashboard screens.

## Theme Data Source

The frontend uses theme packs from:

- `GET /api/users/themes/`
- `POST /api/users/themes/apply/`
- `GET /api/users/current/`

Each theme pack includes:

- `slug`
- `name`
- `tokens`
- `is_free`
- `is_unlocked`

The extension will reuse the authenticated background fetch path already present in `background/service-worker.js`. Theme sync should run after login, during manual sync, and on startup when authenticated.

Theme sync will resolve the active dashboard theme by fetching `GET /api/users/current/` and reading `active_theme_slug`. A missing or null `active_theme_slug` means `system`.

The extension should store:

- `themePacks`: available themes returned by the API.
- `activeThemeSlug`: the selected theme slug, or `system`.
- `activeThemeName`: display name for the selected theme.
- `themeTokens`: normalized CSS token map.
- `themeSyncStatus`: `success`, `failed`, or `unknown`.

The theme list endpoint is used for available token data. The current-user endpoint is the source of truth for the dashboard-selected theme.

## Token Model

Use the same token keys as the frontend:

- `color-page-bg`
- `color-surface`
- `color-surface-elevated`
- `color-text-primary`
- `color-text-secondary`
- `color-text-muted`
- `color-border`
- `color-border-strong`
- `color-accent`
- `color-accent-hover`
- `color-accent-text`
- `color-success`
- `color-warning`
- `color-danger`
- `color-header-bg`
- `color-sidebar-bg`
- `color-sidebar-text`
- `color-button-primary-bg`
- `color-button-primary-text`

The extension CSS will expose local variables such as `--lp-page-bg`, `--lp-surface`, and `--lp-accent` by mapping from stored dashboard tokens. Missing tokens must be filled from the light/system defaults.

## Popup Design

The main popup should become a compact themed control surface:

- Top branded header with Langsly mark, `Vocab Pass`, connection status, and logout as a secondary text button.
- Summary row showing words loaded and last sync.
- Current page panel with domain and active-on-this-site toggle.
- Difficulty segmented control.
- Action section with `Sync now`, `Open Langsly dashboard`, and a compact `Theme` selector.

The theme selector should be low prominence:

- It appears only when logged in and themes have loaded.
- It uses a native select or small menu-style control to avoid adding a new screen.
- It lists only available/applicable themes returned by the dashboard API.
- On change, it calls `POST /api/users/themes/apply/`, updates storage, and reapplies CSS variables immediately.
- If applying fails, it restores the previous selected value and shows a concise inline error or status banner.

The popup must not become taller than needed for normal browser extension use. Controls should fit comfortably in the existing popup width.

## Onboarding Design

The onboarding page keeps the existing three-step flow:

1. Welcome.
2. Sign in.
3. Success.

The visual treatment changes:

- Replace emoji icons with a Langsly brand mark and simple code-native UI motifs.
- Use theme tokens for background, panels, text, borders, and buttons.
- Use default/system tokens before login.
- After login succeeds, sync vocabulary and theme data before the success step when possible.
- If theme sync fails, show success with fallback styling and do not block onboarding completion.

## Options Page

The options page is not the primary redesign target, but it should receive the same base token system if the shared CSS work is low-risk. It can remain utilitarian.

## Background Service Changes

Add theme-related helper functions:

- `normalizeThemeTokens(tokens)`
- `getDefaultThemeTokens()`
- `syncThemes()`
- `applyTheme(themeSlug)`

Add message types:

- `GET_THEME_STATUS`
- `SYNC_THEMES`
- `APPLY_THEME`

`GET_STATUS` may include minimal theme state if doing so keeps popup initialization simpler.

Theme sync errors should set `themeSyncStatus: failed` and preserve the last known good theme if one exists.

## Frontend Extension Changes

Popup and onboarding scripts should:

- Load stored theme tokens on startup.
- Apply tokens to `document.documentElement`.
- Listen for theme state responses from the background worker.
- Update the compact theme selector when theme packs are loaded.

Popup and onboarding CSS should:

- Replace fixed palette variables with dashboard-token-backed variables.
- Preserve strong contrast for text and buttons.
- Use stable sizing so selected themes do not cause layout jumps.
- Avoid decorative clutter and keep the extension ergonomic.

## Testing

Add focused tests where practical for:

- Theme token normalization and fallback.
- Selecting the correct active theme data.
- Applying a theme response updates stored slug/name/tokens.
- Failed theme sync preserves last known usable theme.

Run existing matcher tests and build/package verification after implementation.

## Risks

- The dashboard theme list endpoint may not identify the currently active theme by itself. If no user/profile endpoint is available in the extension, active theme mirroring may require adding a user status fetch or extending an existing endpoint.
- Some user-created/custom themes may have poor contrast. The extension should normalize missing tokens, but it should not silently rewrite a user's chosen colors beyond fallback defaults.
- Native extension popup dimensions are tight, so the selector must remain compact.

## Approval

The selected approach is "mirror dashboard theme plus subtle selector": the extension follows the dashboard theme automatically, and the popup includes a small non-intrusive selector for changing the applied dashboard theme.
