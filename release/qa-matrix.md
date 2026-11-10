# Release QA matrix — 0.2.15

Version 0.2.15 is the current source candidate: 0.2.14 plus a Simplified Chinese interface and automatic page language. The popup, options and word cards follow the browser language, now including Simplified Chinese (zh_CN, shipped on the owner's release decision in `release/zh_CN.release-policy.json` before reviewer sign-off; the copy checks still run). Page text language defaults to Automatic: learners whose course is taught in Chinese also sync a Chinese-page word list, and a page written in Simplified Chinese (its lang tag, otherwise its visible text) uses that list while every other page keeps the usual one. Traditional Chinese, Japanese and Korean pages never use it. People who picked Spanish or Chinese pages by hand keep that choice. Chromium smoke: `test/browser/zh-page-auto-chromium-smoke.cjs`. No new permissions.

Version 0.2.14: 0.2.13 with the real Langsly cat logo in the toolbar icons (16, 48, 128) and the popup, onboarding, connect and options pages, replacing a vector redraw. No code or permission changes.

Version 0.2.13: 0.2.12 plus a stronger page language check for Chinese words. The check samples only text a person can see, never page code or hidden text. While it is unsure, and for a moment after in-app navigation, Chinese words wait up to 1.5 seconds; text that loads later re-opens the question, and words already shown come off if the page turns out not to be English. Spanish and English targets are unaffected. 0.2.12 was built but never uploaded.

Version 0.2.12: 0.2.11 plus the Chinese word and reporting fixes. "Wrong meaning?" reports now reach the server, and "Flagged" shows only after one is saved. Chinese word limits apply per screenful of text and count only words pending or on show; a page sends at most 30 attempts per screenful, and limits reset on in-app navigation. Every language validates only within half a screen of the viewport, at up to 240 occurrences a minute. Possessives and hyphenated words stay in English, and Chinese words appear only on English text (the lang attribute, then the browser's language detector). Chinese page mode accepts the backend's real response and drops unusable words one by one. Writing practice packages stroke data for all 248 course characters (Chrome zip 382 KB to about 676 KB). The Chinese features stay off until the server switch is on.

Version 0.2.11: 0.2.10 plus course-change sync. The Langsly site signals a course switch through the connection bridge and the worker refetches words at once (at most one sync per 10 seconds); the popup explains an empty new course. Store artifacts for 0.2.11 are not built yet; the 0.2.10 results and hashes below stay as the last recorded release.

Version 0.2.10: 0.2.9 plus one popup fix. The page script answered the popup's `GET_PAGE_STATE` question with a plain object, which webextension-polyfill and Firefox drop (an `onMessage` reply must be a Promise), so since the UI redesign the popup said "Unavailable" with a blank word count on every site while swaps kept working. It now replies with a Promise.

Version 0.2.9 (0.2.8 was submitted to the Chrome Web Store and AMO on 2026-10-15) carries the client half of the review's retry policy: only `deadline_exceeded` / `malformed_result` keeps are asked about again, `budget_exhausted` / `validator_unavailable` wait out a cooldown (the server's `retry_after_seconds` when sent, five minutes otherwise), replacement density caps (three per word per page, one per sentence), a 402 on the validation or encounter path stops the pages at once, and an uninstall page on the Langsly site. It also stops pages losing swaps after a sync: re-signed media links no longer count as new vocabulary (every sync used to restore and rescan every open page), and a word already swapped in a block reads as its original text when the next word builds its sentence (later words in that block used to stay unswapped). Batch size and POST rate are unchanged: they move together with the server limits. These instructions do not establish a signed artifact, store submission, publication, or installed-device acceptance.

Use this as an evidence log. Do not mark a row passed without device- or browser-observed proof.

## Store listing notes

- Price disclosure (both stores, before the paywall flips). Chrome Web Store description line, matching `release/amo-listing.md`: "Vocab Pass is a paid subscription: US$5 per month, billed by Langsly through Stripe after any free trial shown at sign-up, cancel anytime from your Langsly account. Langsly lessons stay free; the extension needs a Langsly account with an active Vocab Pass subscription."

| Area | Required targets | Evidence | Status |
| --- | --- | --- | --- |
| Automated release gate | Node 24.13.1 | `npm run release` on fix/vocab-pass-0.2.8-release, 2026-10-14: build, 206 tests, `web-ext lint --warnings-as-errors` (0 errors, 0 warnings, 0 notices), artifact check; hashes below | Passed locally |
| Automated release gate (0.2.9) | Node 24.13.1 | `npm ci && npm run release` on feature/vocab-pass-0.2.9, 2026-10-15: build, 219 tests (13 new: retryable keeps, cooldowns, 402 on validate/encounter, density caps, uninstall page), `web-ext lint --warnings-as-errors` 0/0/0, artifact check | Passed locally |
| Automated release gate (0.2.9 rebuild) | Node 24.13.1 | `npm run release` on fix/vocab-pass-reswap, 2026-10-15: build, 223 tests (4 new in `test/reswap-context.test.mjs`: sentence after an inline swap, restored block re-swaps every sentence, re-signed links keep the page, worker change check), `web-ext lint --warnings-as-errors` 0/0/0, artifact check; hashes below. The Chromium unpacked run below predates this rebuild | Passed locally |
| Chrome unpacked (local QA) | Playwright Chromium 1243 (chrome-win64) | `dist/chrome` loaded with `--load-extension`, Langsly API mocked inside the worker: a `<p>` with two learner words on adjacent lines sent two single items (each inside its own sentence at its offset) and the same-line control sent one phrase; swaps rendered, no pending spans, no console errors. Evidence: `output/vocab-pass-tiering-2026-10-14/evidence-0.2.8/` (Langsly root) | Passed locally (mocked API) |
| Chrome unpacked (0.2.9, local QA) | Playwright Chromium 1243 (chrome-win64) | `dist/chrome` from feature/vocab-pass-0.2.9 (same code, built before the version bump) loaded with `--load-extension`, Langsly API mocked inside the worker: four "Hello" paragraphs swapped three times (fourth stays plain) and "Goodbye, friend; hello again." swapped once; a `keep`/`deadline_exceeded` on the goodbye item was re-sent alone on the retry and judged; a 402 `vocab_pass_subscription_required` on the validation path restored both open pages after one POST and set `subscriptionRequired`/`syncStatus` with the session kept; `chrome.runtime.setUninstallURL` present, no worker warnings, no page console errors. Evidence: `output/vocab-pass-tiering-2026-10-14/evidence-0.2.9/` (Langsly root) | Passed locally (mocked API) |
| Automated release gate (0.2.10) | Node 24.13.1 | `npm run release` on release/vocab-pass-0.2.10, 2026-10-16: build, 225 tests (1 new in `test/content-lifecycle.test.mjs`: `GET_PAGE_STATE` replies with a Promise carrying state and word count), `web-ext lint --warnings-as-errors` 0/0/0, artifact check; hashes below | Passed locally |
| Chrome unpacked popup state (0.2.10, local QA) | Playwright Chromium 1243 (chrome-win64) | `dist/chrome` loaded with `--load-extension`, Langsly API mocked inside the worker; `popup/popup.html` opened in a tab with its active-tab lookup pointed at the site tab (Playwright cannot capture the toolbar popup), then the shipped `loadActiveTab` ran. Local fixture, en.wikipedia.org/wiki/Cat, example.com, www.facebook.com: 0.2.9 said "Unavailable" / "–" on all four (empty reply) even with swaps on the page; 0.2.10 says "On" with counts 2, 3, 0, 0 matching the swaps, site switch visible. Evidence: `output/vocab-pass-tiering-2026-10-14/evidence-0.2.10/` (Langsly root) | Passed locally (mocked API) |
| Automated release gate (0.2.13) | Node 24.13.1 | `npm run release` from a clean checkout of the release commit, 2026-11-06: build, 253 tests (`test/zh-island-limits.test.mjs` adds page code, hidden text, late Spanish and English text, navigation to a Spanish page, and the order text is scanned after a wait), `web-ext lint --warnings-as-errors` 0/0/0, artifact check; hashes below | Passed locally |
| Chromium smoke (0.2.13, local QA) | Playwright Chromium 1243 (chrome-win64) | `npm run test:browser` on a temporary copy of the Chrome build that allows the local mock, adding a Spanish page behind a large English script and Spanish and English pages that fetch their text 2.5 seconds after opening. On 0.2.12 both Spanish pages showed 6 Chinese words; on this build they show none and send nothing | Passed locally; Firefox not run |
| Automated release gate (0.2.12) | Node 24.13.1 | `npm run release` from a clean checkout of the release commit, 2026-11-05: build, 245 tests (`test/zh-island-limits.test.mjs` covers reports, limits, navigation, glued words and page language), `web-ext lint --warnings-as-errors` 0/0/0, artifact check; hashes below | Passed locally |
| Chromium smoke (0.2.12, local QA) | Playwright Chromium 1243 (chrome-win64) | `npm run test:browser` on a temporary copy of the Chrome build that allows the local mock: trap sentences, popup, report payload, rejected words freeing slots, the 30-attempt cap, long-page scrolling, undeclared Spanish page, glued words, in-app navigation, stroke data with its hash check, and the Chinese-page sync recovery test | Passed locally; Firefox not run |
| Backend device flow | Test database | approval, denial, expiry, malformed code, slow polling, replay, inactive user, Android switch | Ready locally |
| Website approval | Desktop and 390x844 / tablet viewport | preserved login route, request identity, disclosure, Approve/Deny, success | Ready locally |
| Firefox Desktop | 140 minimum and current stable | fresh install, sign-in states, all parity features, logout/reconnect | Pending signed build/device run |
| Firefox Android phone | 142 minimum and current stable | full acceptance flow, screenshots, performance | Pending emulator/device |
| Firefox Android tablet | Current stable | portrait/landscape, scrolling, touch targets, full acceptance flow | Pending emulator/device |
| Physical Android device | Current stable | install, complete account flow, audio, site controls, battery/scroll behavior | Pending device |
| Chrome private build | Single owner | install 0.2.8, new login, full parity features | Pending owner test |
| Production API | Production | start/pending/approve/deny/token/replay/rate limits with Android public switch off | Pending deployment |
| AMO submission | Signed public listing | private reviewer credentials, phone/tablet screenshots, declarations, reviewer notes | Pending account/device access |
| Legacy login removal | Source inventory | no legacy routes, page, setting, callback code, or redirect permission remains | Ready locally |

## Artifact SHA-256 (0.2.8)

Built 2026-10-14 with `npm ci && npm run release` on Node 24.13.1 from branch fix/vocab-pass-0.2.8-release. Zip entries carry a fixed 1980-01-01 timestamp, so a rebuild of the same commit reproduces these values.

| Artifact | SHA-256 |
| --- | --- |
| `dist/langsly-vocab-pass-chrome-0.2.8.zip` | `365f42d64f80205adac1e6d57c675cd92c23202cc297f44f21b0f9eb4c5bc57b` |
| `dist/langsly-vocab-pass-firefox-amo-0.2.8.zip` | `0ac503c41c75652d869386336a1deb6cb238ab3c555e939bb188b3258562662a` |
| `dist/langsly-vocab-pass-amo-source-0.2.8.zip` | Recorded in the release commit message: the source archive contains this file, so writing its hash here would change it. |

## Artifact SHA-256 (0.2.13)

Built 2026-11-06 with `npm run release` on Node 24.13.1 from a clean checkout of the release commit. Zip entries carry a fixed 1980-01-01 timestamp, so a rebuild of the same commit on a checkout with the same line endings reproduces these values.

| Artifact | SHA-256 |
| --- | --- |
| `dist/langsly-vocab-pass-chrome-0.2.13.zip` | `8ca054dc3160d47e6a528ba32447bf8be794c6e09f72ca5167562f9fec3f79af` |
| `dist/langsly-vocab-pass-firefox-amo-0.2.13.zip` | `07dfed0d2f0c4c7ad8ddeb98412815cf7798cf081cb50fb01b7c86cc5c1e98d7` |
| `dist/langsly-vocab-pass-amo-source-0.2.13.zip` | Recorded in the release commit message: the source archive contains this file, so writing its hash here would change it. |

## Artifact SHA-256 (0.2.12)

Built 2026-11-05 with `npm run release` on Node 24.13.1 from a clean checkout of the release commit. Zip entries carry a fixed 1980-01-01 timestamp, so a rebuild of the same commit on a checkout with the same line endings reproduces these values.

| Artifact | SHA-256 |
| --- | --- |
| `dist/langsly-vocab-pass-chrome-0.2.12.zip` | `5edcc2545b4c22a9941685aa6cb0ea52d3ed48f7e69a76dda88024bee15344a8` |
| `dist/langsly-vocab-pass-firefox-amo-0.2.12.zip` | `349fbd765ad0f9beaceb97ea440fa20762cc8ead57383058512961c87de02f7b` |
| `dist/langsly-vocab-pass-amo-source-0.2.12.zip` | Recorded in the release commit message: the source archive contains this file, so writing its hash here would change it. |

## Artifact SHA-256 (0.2.10)

Built 2026-10-16 with `npm run release` on Node 24.13.1 from branch release/vocab-pass-0.2.10. Zip entries carry a fixed 1980-01-01 timestamp, so a rebuild of the same commit reproduces these values.

| Artifact | SHA-256 |
| --- | --- |
| `dist/langsly-vocab-pass-chrome-0.2.10.zip` | `bbd894823a447941733b16ba73b898fe424efe5dc8e11197e9f6432477c9fdff` |
| `dist/langsly-vocab-pass-firefox-amo-0.2.10.zip` | `72bfc0f8bae7bf12d079a2edbba121f744c951009a5c39f921ee7d1b16309606` |
| `dist/langsly-vocab-pass-amo-source-0.2.10.zip` | Recorded in the release commit message: the source archive contains this file, so writing its hash here would change it. |

## Artifact SHA-256 (0.2.9)

Rebuilt 2026-10-15 with `npm run release` on Node 24.13.1 from branch fix/vocab-pass-reswap (re-swap fixes; the first 0.2.9 build from feature/vocab-pass-0.2.9 was never uploaded and is superseded). Zip entries carry a fixed 1980-01-01 timestamp, so a rebuild of the same commit reproduces these values.

| Artifact | SHA-256 |
| --- | --- |
| `dist/langsly-vocab-pass-chrome-0.2.9.zip` | `2ada1b6c9a85713762f536adcedece0935070acfba7e7398f9ffb6bc34b56925` |
| `dist/langsly-vocab-pass-firefox-amo-0.2.9.zip` | `529bed1da6de0ef3a36e3cead8030179d3ac3526a1a49030cd3cc67b196db866` |
| `dist/langsly-vocab-pass-amo-source-0.2.9.zip` | Recorded in the release commit message: the source archive contains this file, so writing its hash here would change it. |

## Performance evidence required

- Representative article has no extension-generated long task above 50 ms.
- Initial scan completes in bounded idle slices.
- Hidden tabs cease processing.
- Mutation-heavy fixture remains scroll-responsive and the pending queue stays capped.

Record browser versions, device/emulator identifiers, artifact SHA-256 values, dates, screenshots, traces, and any residual behavior for every completed target.
