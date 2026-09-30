# Chinese extension sync failure preservation

Date: 2026-09-28. Scope: local extension source and Chrome/Firefox build artifacts. No production vocabulary, installed browser, or store release was changed.

The previous worker kept cached words after a vocabulary request failed. For a Chinese page source, those cached Source Forms could continue matching after the server had withdrawn their review or lesson readiness. The worker now removes Chinese words, counts and last-sync time on a missing credential, network/server failure, or unreadable response, and broadcasts an empty vocabulary to active pages. The existing English/Spanish transient-failure cache behavior remains intact.

Each vocabulary request has an incrementing sync generation. A slower prior response cannot restore words after a newer failed sync, and a slower prior failure cannot erase a newer successful sync. The worker also checks generation after its tab query so a superseded broadcast cannot send stale page matches.

Five dynamic tests exercise Chinese failure clearing, English cache preservation, both out-of-order response directions, and delayed-tab broadcast suppression. The full `npm.cmd run release` passed 97 tests, built Chrome and Firefox artifacts, passed artifact checks, and reported zero Firefox lint errors, notices or warnings. The generated workers contain the new failure and generation checks. This is local package evidence; reviewed production Chinese Source Forms, provider precision evaluation, installed-browser QA, native-reviewed `zh_CN` interface copy, and store publication remain open.
