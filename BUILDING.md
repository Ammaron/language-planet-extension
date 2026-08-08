# Building Langsly Vocab Pass 0.2.0

Use Node.js 24.13.1 and the exact dependencies in `package-lock.json`.

1. Run `npm ci`.
2. Run `npm run release`.
3. Find the Chrome directory/ZIP, combined Firefox desktop/Android directory/AMO ZIP, and reproducible AMO source archive in `dist/`.

The Windows `build.cmd`/`build.ps1` and POSIX `build.sh` wrappers all call the same `build.mjs`. ZIP entries are sorted and stamped with the ZIP epoch so identical inputs produce identical archives. `npm run release` makes tests, artifact checks, and `web-ext lint --warnings-as-errors` mandatory.

`vendor/browser-polyfill.js` and `vendor/browser-polyfill.min.js` are the official, unmodified Mozilla webextension-polyfill distribution files. Their upstream license is included as `vendor/LICENSE-webextension-polyfill`.
