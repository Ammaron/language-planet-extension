# Simplified Chinese Vocab Pass interface copy review

**Status:** Unreviewed draft, outside `_locales`. Chrome and Firefox builds still contain only English and Spanish interface resources.

The [draft](zh_CN.messages.draft.json) covers all 171 current English message keys, including extension metadata, login and device connection, page text language, status and errors, grammar labels, and the privacy disclosure. The [binding metadata](zh_CN.messages.draft.meta.json) records exact English source and Chinese draft SHA-256 hashes. `node --test test/zh-locale-draft.test.mjs` checks ordered key parity, nonempty values, Chrome `$NAME$` placeholders, protected product/provider names, and stale-source changes. It is a structural check, not native-language or legal approval.

Native Simplified Chinese and product reviewers should inspect popup, onboarding, options, device connection, grammar details, and errors in both installed browsers at narrow widths and with screen readers. Spanish and English educators should review grammar labels and the explanation of target language versus page text language. Privacy/legal review must compare `connectPrivacyBody` and sensitive-site claims with actual extension behavior and the published policy. Confirm whether extension metadata and store descriptions use the same approved wording, and capture screenshots from the actual release packages.

After exact-content review, convert the approved draft to Chrome/Firefox `_locales/zh_CN/messages.json` entries with the existing placeholder definitions and source descriptions, then add package, installed-browser, and store checks. The present draft does not expose Chinese UI or establish reviewed Chinese vocabulary source forms.
