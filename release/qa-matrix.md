# Release QA matrix — 0.2.0

Use this as an evidence log. Do not mark a row passed without device- or browser-observed proof.

| Area | Required targets | Evidence | Status |
| --- | --- | --- | --- |
| Automated release gate | Node 24.13.1 | `npm run release`; archive hashes | Ready locally |
| Backend device flow | Test database | approval, denial, expiry, malformed code, slow polling, replay, inactive user, Android switch | Ready locally |
| Website approval | Desktop and 390x844 / tablet viewport | preserved login route, request identity, disclosure, Approve/Deny, success | Ready locally |
| Firefox Desktop | 140 minimum and current stable | fresh install, sign-in states, all parity features, logout/reconnect | Pending signed build/device run |
| Firefox Android phone | 142 minimum and current stable | full acceptance flow, screenshots, performance | Pending emulator/device |
| Firefox Android tablet | Current stable | portrait/landscape, scrolling, touch targets, full acceptance flow | Pending emulator/device |
| Physical Android device | Current stable | install, complete account flow, audio, site controls, battery/scroll behavior | Pending device |
| Chrome private build | Single owner | install 0.2.0, new login, full parity features | Pending owner test |
| Production API | Production | start/pending/approve/deny/token/replay/rate limits with Android public switch off | Pending deployment |
| AMO submission | Signed public listing | private reviewer credentials, phone/tablet screenshots, declarations, reviewer notes | Pending account/device access |
| Legacy login removal | Source inventory | no legacy routes, page, setting, callback code, or redirect permission remains | Ready locally |

## Performance evidence required

- Representative article has no extension-generated long task above 50 ms.
- Initial scan completes in bounded idle slices.
- Hidden tabs cease processing.
- Mutation-heavy fixture remains scroll-responsive and the pending queue stays capped.

Record browser versions, device/emulator identifiers, artifact SHA-256 values, dates, screenshots, traces, and any residual behavior for every completed target.
