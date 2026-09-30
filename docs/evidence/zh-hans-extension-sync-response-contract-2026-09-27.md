# Simplified Chinese extension sync response contract

Date: 2026-09-27. Scope: local Chrome/Firefox extension source and packages; no store or production change.

When the selected page text language is Simplified Chinese, `syncVocabulary` now accepts the backend's `source_language_ready` flag only if the complete response also has source language `zh`, validation version 2 only, and at least one word. Every word must have a nonempty ID, target term and Chinese meaning, `search_language: zh`, one consistent Spanish or English learning target, and explicit nonempty Chinese Source Forms without slash-separated alternatives. An invalid response yields `source_unavailable`, stores no words, and broadcasts an empty vocabulary set. English and Spanish sync behavior is unchanged.

This is a structural defense against an outdated or inconsistent server response. It cannot prove that Source Forms or translations were reviewed; the backend review gate remains authoritative. Real production data, Chinese occurrence-provider precision, installed-browser matching, native copy review, and store publication remain open.

Local evidence: `node --test test/source-language.test.mjs test/matcher.test.mjs` passed 16 tests; `npm.cmd run release` built Chrome and Firefox packages, passed all 90 tests, reported zero Firefox lint errors/warnings, and passed artifact-content validation. `node --check shared/source-language.js` and edited-file `git diff --check` passed. No package was installed or published.
