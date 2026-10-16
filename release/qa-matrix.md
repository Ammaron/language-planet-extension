# Release QA matrix — 0.2.10

Version 0.2.10 is the current source candidate: 0.2.9 plus one popup fix. The page script answered the popup's `GET_PAGE_STATE` question with a plain object, which webextension-polyfill and Firefox drop (an `onMessage` reply must be a Promise), so since the UI redesign the popup said "Unavailable" with a blank word count on every site while swaps kept working. It now replies with a Promise.

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
