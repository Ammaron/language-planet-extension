# Simplified Chinese extension packaging review gate

The current 171-key Chinese message draft remains under `docs/evidence`, outside `_locales`. Chrome/Firefox runtime artifacts contain only en/es; no store upload or installed-browser acceptance occurred.

`build.mjs` now calls `verifyChineseLocaleForBuild` from `release/chinese-locale-review.mjs` before deleting/rebuilding `dist`. Builds without Chinese remain permitted. A Chinese folder requires exactly `_locales/zh_CN/messages.json` and `release/zh_CN.review.json`; other Chinese regional/script folders are rejected by this release contract.

The review document requires `locale: zh-Hans`, `extension_locale: zh_CN`, `status: approved`, exact-byte `source_sha256` and `runtime_sha256`, and `native_reviewer`, `product_reviewer`, `privacy_reviewer`, `legal_reviewer`. Each attestation needs a real verified reviewer ID, ISO timestamp with timezone and both current hashes. Native/product reviews must be independent. The release owner must verify reviewer qualifications; fixture IDs are not valid human approval evidence.

The runtime catalog must contain every current English key, nonblank messages, exact non-message structure and placeholder definitions, unchanged named/numeric substitution tokens and protected product/provider names. Untranslated English messages are rejected except explicitly permitted brand, URL and email-placeholder values. Draft or stale review blocks packaging.

AMO source now includes the two separate draft JSON test inputs and the review-gate module so source tests can be reproduced. This is source-review material only: `dist/chrome` and `dist/firefox` do not contain the draft directory. The built-artifact regression compares their en/es locale JSON with source and verifies the source/archive boundary.

Local validation: `node build.mjs`, `npm.cmd test` (102 tests) and Firefox lint all pass. Run lint with `NO_UPDATE_NOTIFIER=1` in a restricted environment to disable the unrelated update check. Firefox lint reports zero errors, warnings and notices.

Remaining gates: qualified native/product/privacy/legal review of all 171 messages, including browsing-data permission and disclosure copy; complete approved runtime artifact; installed Chrome/Firefox and Firefox Android connection, logout, site-access, popup/options/onboarding and failure-recovery QA; reviewed store listing/screenshots and explicit publication. No vocabulary, source forms, course text or audio was edited here.
