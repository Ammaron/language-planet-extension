# Release QA matrix — 0.2.9

Version 0.2.9 is the current source candidate (0.2.8 was submitted to the Chrome Web Store and AMO on 2026-10-15). It carries the client half of the review's retry policy: only `deadline_exceeded` / `malformed_result` keeps are asked about again, `budget_exhausted` / `validator_unavailable` wait out a cooldown (the server's `retry_after_seconds` when sent, five minutes otherwise), replacement density caps (three per word per page, one per sentence), a 402 on the validation or encounter path stops the pages at once, and an uninstall page on the Langsly site. Batch size and POST rate are unchanged: they move together with the server limits. These instructions do not establish a signed artifact, store submission, publication, or installed-device acceptance.

Use this as an evidence log. Do not mark a row passed without device- or browser-observed proof.

## Store listing notes

- Price disclosure (both stores, before the paywall flips). Chrome Web Store description line, matching `release/amo-listing.md`: "Vocab Pass is a paid subscription: US$5 per month, billed by Langsly through Stripe after any free trial shown at sign-up, cancel anytime from your Langsly account. Langsly lessons stay free; the extension needs a Langsly account with an active Vocab Pass subscription."

| Area | Required targets | Evidence | Status |
| --- | --- | --- | --- |
| Automated release gate | Node 24.13.1 | `npm run release` on fix/vocab-pass-0.2.8-release, 2026-10-14: build, 206 tests, `web-ext lint --warnings-as-errors` (0 errors, 0 warnings, 0 notices), artifact check; hashes below | Passed locally |
| Automated release gate (0.2.9) | Node 24.13.1 | `npm ci && npm run release` on feature/vocab-pass-0.2.9, 2026-10-15: build, 219 tests (13 new: retryable keeps, cooldowns, 402 on validate/encounter, density caps, uninstall page), `web-ext lint --warnings-as-errors` 0/0/0, artifact check; hashes below | Passed locally |
| Chrome unpacked (local QA) | Playwright Chromium 1243 (chrome-win64) | `dist/chrome` loaded with `--load-extension`, Langsly API mocked inside the worker: a `<p>` with two learner words on adjacent lines sent two single items (each inside its own sentence at its offset) and the same-line control sent one phrase; swaps rendered, no pending spans, no console errors. Evidence: `output/vocab-pass-tiering-2026-10-14/evidence-0.2.8/` (Langsly root) | Passed locally (mocked API) |
| Chrome unpacked (0.2.9, local QA) | Playwright Chromium 1243 (chrome-win64) | `dist/chrome` from feature/vocab-pass-0.2.9 (same code, built before the version bump) loaded with `--load-extension`, Langsly API mocked inside the worker: four "Hello" paragraphs swapped three times (fourth stays plain) and "Goodbye, friend; hello again." swapped once; a `keep`/`deadline_exceeded` on the goodbye item was re-sent alone on the retry and judged; a 402 `vocab_pass_subscription_required` on the validation path restored both open pages after one POST and set `subscriptionRequired`/`syncStatus` with the session kept; `chrome.runtime.setUninstallURL` present, no worker warnings, no page console errors. Evidence: `output/vocab-pass-tiering-2026-10-14/evidence-0.2.9/` (Langsly root) | Passed locally (mocked API) |
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

## Artifact SHA-256 (0.2.9)

Built 2026-10-15 with `npm ci && npm run release` on Node 24.13.1 from branch feature/vocab-pass-0.2.9. Zip entries carry a fixed 1980-01-01 timestamp, so a rebuild of the same commit reproduces these values.

| Artifact | SHA-256 |
| --- | --- |
| `dist/langsly-vocab-pass-chrome-0.2.9.zip` | `6bf5136c44f3c067e49fcd3dca0a2cf77f6b7aedc088f3fb4f1d61b530e59789` |
| `dist/langsly-vocab-pass-firefox-amo-0.2.9.zip` | `3420e97391978a9dd18278ea6d81218091eadc376de70523cd466488174e99b8` |
| `dist/langsly-vocab-pass-amo-source-0.2.9.zip` | Recorded in the release commit message: the source archive contains this file, so writing its hash here would change it. |

## Performance evidence required

- Representative article has no extension-generated long task above 50 ms.
- Initial scan completes in bounded idle slices.
- Hidden tabs cease processing.
- Mutation-heavy fixture remains scroll-responsive and the pending queue stays capped.

Record browser versions, device/emulator identifiers, artifact SHA-256 values, dates, screenshots, traces, and any residual behavior for every completed target.
