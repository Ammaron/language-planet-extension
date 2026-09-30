# Chinese page sentence boundaries and match grouping

Date: 2026-09-28. Scope: local extension matching; no installed browser or production vocabulary changed.

The extension now treats `。`, `！` and `？` as sentence endings when it extracts context for occurrence validation. A Chinese match no longer carries text from an adjacent sentence into the validation request. Chinese matches with individually authored Source Forms also stay as separate occurrences even when adjacent. The English/Spanish phrase builder cannot combine them into an unreviewed Chinese phrase; an explicitly authored whole-phrase Source Form can still win the existing longest-match rule.

Focused tests cover adjacent Chinese forms and a match within Chinese punctuation. The full release command built Chrome and Firefox artifacts, passed 92 tests and artifact checks, and reported zero Firefox lint errors or warnings. This is local structural evidence. Reviewed production Source Forms, real occurrence-provider decisions, installed-browser behavior, Chinese interface copy, and store publication remain open.
