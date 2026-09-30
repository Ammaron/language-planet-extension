# Third-party notices

The packaged extension includes Mozilla's unmodified `webextension-polyfill` 0.12.0 distribution in `vendor/browser-polyfill.js` and `vendor/browser-polyfill.min.js`. Its Mozilla Public License 2.0 text is included at `vendor/LICENSE-webextension-polyfill`.

The packaged extension also includes, for optional character-writing practice:

- **Hanzi Writer 3.7.3** (MIT License), the unmodified `dist/hanzi-writer.min.js` build at `vendor/hanzi-writer/hanzi-writer.min.js`. The full MIT notice is at `vendor/hanzi-writer/LICENSE` and the upstream copying notice at `vendor/hanzi-writer/COPYING.md`.
- **hanzi-writer-data 2.0.1** (Arphic Public License), the unmodified stroke-data files for the pilot characters 你 (`vendor/hanzi-writer-data/2.0.1/4f60.json`) and 好 (`vendor/hanzi-writer-data/2.0.1/597d.json`). The unaltered Arphic Public License text is at `vendor/hanzi-writer-data/ARPHICPL.TXT`. The data was derived by the hanzi-writer-data project from Make Me a Hanzi (copyright 2016 Shaunak Kishore), which is derived from Arphic PL KaitiM GB and UKai (copyright 1999 Arphic Technology Co., Ltd.). It follows mainland stroke-order conventions only.

Every vendored file, with its upstream path, npm integrity pin and SHA-256, is listed in `vendor/hanzi-writing-manifest.json`. `release/hanzi-writer-vendor.mjs` recreates the files from the pinned npm tarballs (`npm pack hanzi-writer@3.7.3 hanzi-writer-data@2.0.1`), and `build.mjs` refuses to package if any byte differs. All notices are shown in full in the extension at **Options → About → Open-source licenses** (`popup/licenses.html`).

Build and validation dependencies are pinned in `package-lock.json`; they are not included in the installable extension archive. Their package metadata and license identifiers can be inspected after `npm ci` with `npm query .license`.
