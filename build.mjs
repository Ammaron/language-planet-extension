import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { deflateRawSync } from 'node:zlib';

const root = dirname(new URL(import.meta.url).pathname.replace(/^\/(.:)/, '$1'));
const dist = join(root, 'dist');
const chromeDir = join(dist, 'chrome');
const firefoxDir = join(dist, 'firefox');
const fixedDate = new Date('1980-01-01T00:00:00Z');

const runtimeFiles = [
  'vendor/browser-polyfill.min.js', 'shared/i18n.js',
  'background/theme-utils.js', 'background/encounter-coordinator.js', 'background/service-worker.js',
  'content/request-coordinator.js', 'content/grammar-rules.js', 'content/matcher.js', 'content/popup.js', 'content/content.js', 'content/content.css',
  'popup/popup.html', 'popup/popup.js', 'popup/popup.css',
  'popup/options.html', 'popup/options.js', 'popup/options.css',
  'popup/onboarding.html', 'popup/onboarding.js', 'popup/onboarding.css',
  'popup/connect.html', 'popup/connect.js', 'popup/connect.css',
  'icons/langsly-icon.png', 'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png',
];

async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path, base));
    else files.push(relative(base, path).split(sep).join('/'));
  }
  return files;
}

async function copy(relativePath, target) {
  const source = join(root, relativePath);
  await stat(source);
  const destination = join(target, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
}

async function copyRuntime(target) {
  for (const file of runtimeFiles) await copy(file, target);
  for (const locale of await listFiles(join(root, '_locales'))) await copy(`_locales/${locale}`, target);
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function zipTime(date) {
  const year = Math.max(1980, date.getUTCFullYear());
  return { time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | (date.getUTCSeconds() >> 1), date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate() };
}

async function createZip(sourceDirectory, outputPath) {
  const files = await listFiles(sourceDirectory);
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  const stamp = zipTime(fixedDate);
  for (const name of files) {
    const raw = await readFile(join(sourceDirectory, ...name.split('/')));
    const compressed = deflateRawSync(raw, { level: 9 });
    const filename = Buffer.from(name);
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10); local.writeUInt16LE(stamp.date, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(filename.length, 26);
    localParts.push(local, filename, compressed);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12); central.writeUInt16LE(stamp.date, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38); central.writeUInt32LE(offset, 42);
    centralParts.push(central, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  await writeFile(outputPath, Buffer.concat([...localParts, ...centralParts, end]));
}

const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'));
await rm(dist, { recursive: true, force: true });
await mkdir(chromeDir, { recursive: true });
await mkdir(firefoxDir, { recursive: true });
await copyRuntime(chromeDir); await copyRuntime(firefoxDir);
await writeFile(join(chromeDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

const firefoxManifest = structuredClone(manifest);
firefoxManifest.background = { scripts: ['vendor/browser-polyfill.min.js', 'shared/i18n.js', 'background/theme-utils.js', 'background/encounter-coordinator.js', 'background/service-worker.js'] };
firefoxManifest.browser_specific_settings = {
  gecko: {
    id: 'vocabpass@languageplanet.app',
    strict_min_version: '140.0',
    data_collection_permissions: { required: ['authenticationInfo', 'browsingActivity', 'websiteActivity', 'websiteContent'] },
  },
  gecko_android: { strict_min_version: '142.0' },
};
await writeFile(join(firefoxDir, 'manifest.json'), `${JSON.stringify(firefoxManifest, null, 2)}\n`);

const version = manifest.version;
await createZip(chromeDir, join(dist, `langsly-vocab-pass-chrome-${version}.zip`));
await createZip(firefoxDir, join(dist, `langsly-vocab-pass-firefox-amo-${version}.zip`));

const sourceDir = join(dist, 'amo-source');
await mkdir(sourceDir, { recursive: true });
const sourceFiles = [...runtimeFiles, 'manifest.json', 'build.mjs', 'build.sh', 'build.ps1', 'build.cmd', 'BUILDING.md', 'THIRD_PARTY_NOTICES.md', 'package.json', 'package-lock.json', 'vendor/browser-polyfill.js', 'vendor/LICENSE-webextension-polyfill'];
for (const file of sourceFiles) await copy(file, sourceDir);
for (const locale of await listFiles(join(root, '_locales'))) await copy(`_locales/${locale}`, sourceDir);
for (const test of await listFiles(join(root, 'test'))) await copy(`test/${test}`, sourceDir);
for (const releaseFile of await listFiles(join(root, 'release'))) await copy(`release/${releaseFile}`, sourceDir);
await createZip(sourceDir, join(dist, `langsly-vocab-pass-amo-source-${version}.zip`));
console.log(`Built Chrome and Firefox/Android ${version} artifacts in ${resolve(dist)}`);
