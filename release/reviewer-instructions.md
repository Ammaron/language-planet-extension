# AMO reviewer instructions — 0.2.1

## Build

Use Node.js 24.13.1 and follow `BUILDING.md`. `npm ci` installs the pinned validation toolchain. `npm run release` creates the installable archive and runs the test suite, artifact checks, and Firefox lint with warnings treated as errors.

## Account connection

1. Install the signed 0.2.1 build.
2. Open the toolbar popup and select **Connect account**.
3. The add-on opens its full-tab connection screen and requests a short-lived device code.
4. Select **Open Langsly**. Sign in on the Langsly website if required; the `/extension-connect` route is preserved through login.
5. Confirm that the website names the requesting browser, explains the data access, and offers separate **Approve** and **Deny** actions.
6. Select **Approve**, return to the extension tab, and confirm synchronization. Repeat once with **Deny** and once after the ten-minute expiry.

The extension never authorizes automatically. The extension tab polls only while visible, retries when focused, and resumes pending authorization after popup closure or browser restart.

## Feature review

On a non-sensitive article page, verify word and phrase highlighting, contextual disambiguation, audio/speech fallback, theme and difficulty controls, site disable/re-enable, and offline cached vocabulary. Then visit a login form containing a password field and representative banking, payment, government, health, and legal URLs; the add-on must not load vocabulary, change the DOM, or send page-derived requests there. Repeat after a same-page navigation.

## Test account

Provide the AMO reviewer account through Mozilla's private reviewer-notes credential fields immediately before submission. Do not place credentials in this source archive or repository.

Submission owner checklist:

- Create a dedicated active reviewer account with representative synchronized vocabulary.
- Verify the credentials in a private browser window.
- Enter them only in AMO's non-public reviewer field.
- Revoke or rotate the account after review according to Langsly's release policy.

## Production endpoints

- Website approval route: `https://langsly.com/extension-connect`
- Device API prefix: `https://api.langsly.com/api/auth/extension-device/`
- Privacy policy: `https://langsly.com/privacy-policy`

## Kill switch

The server-side Firefox Android connection switch can stop new Android device authorizations without invalidating installed desktop sessions. Reviewers should be notified in the private notes if this emergency control is active during review.
