# Third-party notices

The packaged extension includes Mozilla's unmodified `webextension-polyfill` 0.12.0 distribution in `vendor/browser-polyfill.js` and `vendor/browser-polyfill.min.js`. Its Mozilla Public License 2.0 text is included at `vendor/LICENSE-webextension-polyfill`.

Build and validation dependencies are pinned in `package-lock.json`; they are not included in the installable extension archive. Their package metadata and license identifiers can be inspected after `npm ci` with `npm query .license`.
