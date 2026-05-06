# Extension Theme Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the extension mirror the dashboard-selected Langsly theme and redesign onboarding/main popup with a compact theme selector.

**Architecture:** Add a small shared theme utility module for token defaults, normalization, active theme resolution, and DOM variable application. The background worker owns authenticated theme sync/apply operations and stores normalized theme state. Popup/onboarding consume stored theme tokens and render tokenized CSS.

**Tech Stack:** Manifest V3 extension, plain JavaScript, CSS custom properties, Node built-in test runner.

---

## File Structure

- Create `background/theme-utils.js`: shared browser/global utility functions for theme token defaults, normalization, resolution, and DOM application.
- Create `test/theme-utils.test.mjs`: Node tests for the shared utility behavior.
- Modify `manifest.json`: load `background/theme-utils.js` before `background/service-worker.js`.
- Modify `background/service-worker.js`: sync themes from `/api/users/current/` and `/api/users/themes/`, apply selected theme through `/api/users/themes/apply/`, expose theme messages.
- Modify `popup/popup.html`: add a compact theme selector row.
- Modify `popup/popup.js`: apply tokens, initialize theme selector, handle theme changes.
- Modify `popup/popup.css`: replace fixed palette with dashboard token variables and improve popup layout.
- Modify `popup/onboarding.html`: replace emoji/icon copy with branded structure.
- Modify `popup/onboarding.js`: apply theme tokens and sync theme after login.
- Modify `popup/onboarding.css`: redesign first-install flow with tokenized styling.

## Tasks

### Task 1: Shared Theme Utilities

**Files:**
- Create: `background/theme-utils.js`
- Test: `test/theme-utils.test.mjs`

- [ ] Write tests for normalization, active theme resolution, and CSS variable mapping.
- [ ] Run `node --test test/theme-utils.test.mjs` and confirm it fails because the module does not exist.
- [ ] Implement `background/theme-utils.js` as a global-compatible utility module.
- [ ] Run `node --test test/theme-utils.test.mjs` and confirm it passes.

### Task 2: Background Theme Sync

**Files:**
- Modify: `manifest.json`
- Modify: `background/service-worker.js`

- [ ] Wire `background/theme-utils.js` into the background service worker.
- [ ] Add `syncThemes`, `applyTheme`, `GET_THEME_STATUS`, `SYNC_THEMES`, and `APPLY_THEME`.
- [ ] Call theme sync after login, manual sync, and startup.
- [ ] Preserve existing vocabulary behavior and make theme failures non-blocking.

### Task 3: Popup Redesign

**Files:**
- Modify: `popup/popup.html`
- Modify: `popup/popup.js`
- Modify: `popup/popup.css`

- [ ] Apply stored theme tokens on popup load.
- [ ] Fetch theme state and populate a compact selector after login.
- [ ] Apply selected themes through the background worker and update UI state immediately.
- [ ] Redesign the popup with tokenized Langsly surfaces, header, stats, current-site toggle, difficulty control, and action area.

### Task 4: Onboarding Redesign

**Files:**
- Modify: `popup/onboarding.html`
- Modify: `popup/onboarding.js`
- Modify: `popup/onboarding.css`

- [ ] Apply stored/default theme tokens on onboarding load.
- [ ] Sync theme state after login without blocking success.
- [ ] Replace generic emoji/blue UI with tokenized Langsly branding.

### Task 5: Verification

**Commands:**
- `node --test test/theme-utils.test.mjs test/matcher.test.mjs`
- `powershell -ExecutionPolicy Bypass -File .\build.ps1`

- [ ] Run unit tests.
- [ ] Run extension build.
- [ ] Report any build/test failures with exact output.
