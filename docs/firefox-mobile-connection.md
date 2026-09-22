# Firefox mobile connection flow

Implemented locally on 2026-09-21. Website and extension must both be released for the complete guided flow. Existing device authorization endpoints and explicit approval remain unchanged.

## Behavior

- Connect opens a phone-first page and the Langsly sign-in/approval tab. Manual codes are under “Use another device.”
- Login, signup, verification, password recovery, and language changes retain the connection destination.
- The background owns polling and persisted pending state. Timers provide prompt completion; alarms and website status requests resume suspended background work. Poll intervals and server slow-down responses are respected.
- Approval alone does not display “Connected.” The extension must acknowledge saved credentials. Initial vocabulary synchronization may still be running.
- A verification link opened in another tab offers “Continue connection in this tab.” Expired requests can restart from the website without signing in again.
- Popup and extension options expose connect/continue/restart states. The signed-out popup also links to account settings.
- Return to browsing activates the captured original tab; if unavailable, it opens the Langsly dashboard.
- Only top-level pages on the configured Langsly origin, exact approval path, and matching request code can use the handoff. Sensitive operations require the bound approval tab, with an explicit resume action to transfer it. The bridge never exposes device secrets or account tokens and cannot approve requests.

## Verification

- Extension release build, full Node suite, and Firefox lint: passed (zero lint errors, warnings, notices).
- Eleven coordinator behavior tests cover deduplication, background recreation, throttling, offline recovery, cancellation, sender restrictions, verification-tab transfer, expiry, denial, concurrent completion, and original-tab return.
- Website typecheck, production client/SSR build, and 17 focused tests: passed.
- Local Chrome at 390 × 844: sign-in → password recovery → sign-in and signup retained the request; signup had no horizontal overflow.
- Mocked website API/extension acknowledgments: approval showed “Finishing” until confirmation, then Connected; English/Spanish switching retained the request. Screenshots are under the outer Langsly workspace's `output/playwright/firefox-connect/`.
- Mocked authenticated browser QA produced expected unavailable local social-WebSocket errors; no real Google sign-in, verification-email delivery, or production token exchange was performed.

## Remaining release gates

- No Android device was attached. Verify the signed package on Firefox Android, including the Firefox extension-details Settings entry, install/onboarding, actual Google/email login, verification in another tab, tab closure, process suspension/restart, and expired/offline recovery.
- Check an upgraded installation and desktop Chrome/Firefox extension behavior. Local browser viewport QA is not installed-extension or physical-device evidence.
- Store submission exports were prepared as version 0.2.4. No deployment, push, or AMO upload was performed by this task.
- Website-only releases continue to support older extensions with a return-to-connection-tab fallback. Extension-only releases finish in the background, but need the updated website to display acknowledged completion and direct recovery controls.
