# Release QA matrix — 0.2.8

Version 0.2.8 is the current source candidate. These instructions do not establish a signed artifact, store submission, publication, or installed-device acceptance.

Use this as an evidence log. Do not mark a row passed without device- or browser-observed proof.

## Store listing notes

- Price disclosure (both stores, before the paywall flips). Chrome Web Store description line, matching `release/amo-listing.md`: "Vocab Pass is a paid subscription: US$5 per month, billed by Langsly through Stripe after any free trial shown at sign-up, cancel anytime from your Langsly account. Langsly lessons stay free; the extension needs a Langsly account with an active Vocab Pass subscription."

| Area | Required targets | Evidence | Status |
| --- | --- | --- | --- |
| Automated release gate | Node 24.13.1 | `npm run release` on fix/vocab-pass-0.2.8-release, 2026-10-14: build, 206 tests, `web-ext lint --warnings-as-errors` (0 errors, 0 warnings, 0 notices), artifact check; hashes below | Passed locally |
| Chrome unpacked (local QA) | Playwright Chromium 1243 (chrome-win64) | `dist/chrome` loaded with `--load-extension`, Langsly API mocked inside the worker: a `<p>` with two learner words on adjacent lines sent two single items (each inside its own sentence at its offset) and the same-line control sent one phrase; swaps rendered, no pending spans, no console errors. Evidence: `output/vocab-pass-tiering-2026-10-14/evidence-0.2.8/` (Langsly root) | Passed locally (mocked API) |
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

## Performance evidence required

- Representative article has no extension-generated long task above 50 ms.
- Initial scan completes in bounded idle slices.
- Hidden tabs cease processing.
- Mutation-heavy fixture remains scroll-responsive and the pending queue stays capped.

Record browser versions, device/emulator identifiers, artifact SHA-256 values, dates, screenshots, traces, and any residual behavior for every completed target.
