# Chrome Web Store listing — Langsly Vocab Pass 0.2.6

Version 0.2.6 is the current source candidate. These notes do not establish a signed artifact, store submission, publication, or installed-device acceptance. Paste each section into the matching Chrome Web Store Developer Dashboard field. Keep it consistent with `_locales/*/messages.json`, `release/amo-listing.md` and the Firefox `data_collection_permissions` in `build.mjs`.

## Store listing

**Name** (from `extName`): English Vocabulary Builder · Langsly Vocab Pass

**Summary** (from `extDescription`, 132 characters maximum): See the English words you learn in Langsly on Spanish websites. Tap for meaning and audio. Requires a Vocab Pass subscription.

**Category:** Education

**Description:**

> Learn from the websites you already read. Langsly Vocab Pass swaps in words and phrases from your Langsly vocabulary as you browse, so you see what you are studying in real context. Tap a highlighted word for its meaning, contextual explanation and audio, and give feedback when a match looks wrong.
>
> **Requires a Langsly account with an active Vocab Pass subscription ($5/month, managed on langsly.com).** Without one, the extension shows a Subscribe on Langsly prompt and does not change any page.
>
> - Connect your Langsly account with a short-lived device code; no password is entered in the extension.
> - Your vocabulary, difficulty and theme sync from Langsly; a local cache keeps recent vocabulary available offline.
> - Pause Vocab Pass on any site from the toolbar popup.
> - Vocab Pass never runs on browser pages, Langsly's own site, pages with password fields, or sign-in, banking, payment, government, health and legal pages. These protections cannot be turned off.
>
> Vocab Pass checks visible text on the pages you read. It may send the current domain, matched phrases, or a short piece of visible sentence context to Langsly and, when translation or disambiguation needs it, OpenRouter. It never sends complete pages, form values, hidden text or full URLs. See Langsly's privacy policy: https://langsly.com/privacy-policy

**Screenshots (1280x800):** `store-assets/vocab-pass-product-1280x800.png`, `store-assets/vocab-pass-product-actual-ui-1280x800.png`.

**Small promo tile (440x280):** Needs owner. No tile exists in `store-assets/`; it is required for submission.

**Support / homepage:** https://langsly.com/vocab-pass-extension

## Privacy practices tab

### Single purpose

Langsly Vocab Pass helps a Langsly learner practise their own Langsly vocabulary while reading the web, by showing those words in context on the pages they visit, with meaning and audio on tap.

### Permission justifications

| Permission | Justification |
| --- | --- |
| `storage` | Stores the signed-in session, the synced vocabulary list, difficulty, theme, site and pinyin preferences, queued learning interactions and bounded translation caches, so the extension works across browser restarts and offline. |
| `alarms` | Schedules the periodic vocabulary sync, the 5-minute upload of queued learning interactions, and device-code sign-in polling, without keeping the service worker alive. |
| `scripting` | Injects the packaged, hash-checked Hanzi Writer library into the current page only after the learner clicks the Chinese writing-practice button. No remote or generated code is injected. |
| Host permissions (`http://*/*`, `https://*/*`) | Vocab Pass works on whatever site the learner is reading, so it needs access to ordinary web pages: `scripting.executeScript` for writing practice requires host access to the page the learner is on, and the worker uses it to message the open tabs it updates after sync, sign-out or a subscription change. API calls and audio downloads go only to the configured Langsly API origin (`https://api.langsly.com` in production). Browser, file and other non-web schemes are not requested. |
| Content scripts on all `http`/`https` sites | The content script finds the learner's vocabulary in visible page text and shows it in place with an on-tap explanation. It cannot know in advance which sites the learner reads. It stops immediately on sensitive pages (password fields, sign-in, banking, payment, government, health, legal) and idles when no vocabulary or subscription is available. A second content script runs only on `langsly.com` to complete the device-code sign-in. |

### Remote code

**No, I am not using remote code.** All JavaScript, including Hanzi Writer and its stroke data, ships in the package. The extension fetches JSON data (vocabulary, translations, audio) from the Langsly API, never executable code.

### Data usage

Tick these categories (they match the Firefox `data_collection_permissions` declaration):

| Chrome category | What is collected | Firefox declaration |
| --- | --- | --- |
| Authentication information | Short-lived device authorization and Langsly access/refresh tokens. | `authenticationInfo` |
| Web history | The hostname of pages where vocabulary is shown, and per-site enable/disable choices. Never full URLs. | `browsingActivity` |
| User activity | Taps on highlighted words, automatic highlight exposures, and match feedback, used for learning progress. | `websiteActivity` |
| Website content | Matched phrases or a short, bounded piece of visible sentence context, sent for translation and disambiguation. | `websiteContent` |

Not collected: personally identifiable information beyond the Langsly account the learner already has, health, financial or payment information, personal communications, location.

Certify all three statements:

- I do not sell or transfer user data to third parties, outside of the approved use cases. (Sentence context may be processed by OpenRouter on Langsly's behalf to provide translation and disambiguation; this must be named in the privacy policy.)
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose.
- I do not use or transfer user data to determine creditworthiness or for lending purposes.

**Privacy policy URL:** https://langsly.com/privacy-policy (must name Langsly and OpenRouter as recipients and describe automatic processing before submission).

## Distribution and testing notes

- Minimum Chrome version is 111 (CSS `color-mix()`), declared in `manifest.json`.
- After uninstall, Chrome opens `https://langsly.com/extension/uninstalled` for optional feedback. Needs owner: this page does not exist on the frontend yet.
- Test instructions for the Chrome reviewer: follow `release/reviewer-instructions.md`. The reviewer account must have an active or complimentary Vocab Pass subscription; otherwise the extension only shows the subscribe state.
