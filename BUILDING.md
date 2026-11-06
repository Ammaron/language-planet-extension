# Building Langsly Vocab Pass 0.2.10

Use Node.js 24.13.1 and the exact dependencies in `package-lock.json`.

1. Run `npm ci`.
2. Run `npm run release`.
3. Find the Chrome directory/ZIP, combined Firefox desktop/Android directory/AMO ZIP, and reproducible AMO source archive in `dist/`.

The Windows `build.cmd`/`build.ps1` and POSIX `build.sh` wrappers all call the same `build.mjs`. ZIP entries are sorted and stamped with the ZIP epoch so identical inputs produce identical archives. `npm run release` makes tests, artifact checks, and `web-ext lint --warnings-as-errors` mandatory.

The Chinese browser smoke tests are separate because they need Playwright and Chromium. After `npm run build`, run `npm run test:browser` with `LANGSLY_PLAYWRIGHT_MODULE` set to a Playwright install and `LANGSLY_CHROMIUM_EXECUTABLE` set to Chromium. They test a temporary copy of `dist/chrome` that allows their local mock server (release builds only accept the production API), and they stop before syncing if the mock is not in use.

`vendor/browser-polyfill.js` and `vendor/browser-polyfill.min.js` are the official, unmodified Mozilla webextension-polyfill distribution files. Their upstream license is included as `vendor/LICENSE-webextension-polyfill`.

The character-writing files in `vendor/hanzi-writer/` and `vendor/hanzi-writer-data/` are unmodified files from `hanzi-writer@3.7.3` and `hanzi-writer-data@2.0.1`, listed with their npm integrity pins and SHA-256 values in `vendor/hanzi-writing-manifest.json`. To recreate them, run `npm pack hanzi-writer@3.7.3 hanzi-writer-data@2.0.1 --pack-destination <dir>` and then `node release/hanzi-writer-vendor.mjs <dir>`; the script refuses tarballs that do not match the pins. `build.mjs` refuses to package if any vendored byte differs from the manifest. `vendor/.gitattributes` stops line-ending conversion from changing those bytes on checkout.
