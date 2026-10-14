// Builds content/content-styles.js from content/content.css. The popover's closed
// shadow root adopts this text as a constructed stylesheet, so content.css never
// has to be web-accessible (any site could otherwise fetch it to detect installs).
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function contentStylesModule(cssText) {
  const css = String(cssText).replace(/\r\n/g, '\n');
  return '// Generated from content/content.css by build.mjs (release/content-styles.mjs). Do not edit.\n'
    + `globalThis.LangslyContentStyles = ${JSON.stringify(css)};\n`;
}

export async function writeContentStyles(root) {
  const css = await readFile(join(root, 'content/content.css'), 'utf8');
  const next = contentStylesModule(css);
  const target = join(root, 'content/content-styles.js');
  const current = await readFile(target, 'utf8').catch(() => '');
  if (current.replace(/\r\n/g, '\n') !== next) await writeFile(target, next);
}
