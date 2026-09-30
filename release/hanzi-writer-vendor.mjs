// Reproducible vendoring and build-time verification for character-writing practice.
//
//   npm pack hanzi-writer@3.7.3 hanzi-writer-data@2.0.1 --pack-destination <dir>
//   node release/hanzi-writer-vendor.mjs <dir>
//
// The npm tarballs are checked against pinned integrity values, then the library
// build, its notices, the pilot character files and the Arphic license are copied
// unmodified into vendor/. build.mjs refuses to package if any vendored byte differs.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const MANIFEST_PATH = 'vendor/hanzi-writing-manifest.json';

export const PINS = {
  'hanzi-writer': {
    version: '3.7.3',
    integrity: 'sha512-fdOFrb1cXWL/pV/oplJkcdziCvjJzhhf+qoIBm5IpVGxPBZEu4eLB6ZG5RJDbKXyNbNlyx8oIpa3XrcUBcSXpg==',
    license: 'MIT',
    files: {
      'package/dist/hanzi-writer.min.js': 'vendor/hanzi-writer/hanzi-writer.min.js',
      'package/LICENSE': 'vendor/hanzi-writer/LICENSE',
      'package/COPYING.md': 'vendor/hanzi-writer/COPYING.md',
    },
  },
  'hanzi-writer-data': {
    version: '2.0.1',
    integrity: 'sha512-nbQwM+MaryGoq7pBMIZLCd3lFq03nXuJuwku1+6UbjL58uU+9OULVcMkoNvNuJSoIV7f1bbPRfD4D/LQa5S7qg==',
    license: 'Arphic Public License',
    files: { 'package/ARPHICPL.TXT': 'vendor/hanzi-writer-data/ARPHICPL.TXT' },
  },
};

// Pilot set: the reviewed characters of the "Hello — 你好" lesson.
export const PILOT_CHARACTERS = ['你', '好'];

export const codepointFile = char => `${char.codePointAt(0).toString(16).padStart(4, '0')}.json`;
export const dataPath = char => `vendor/hanzi-writer-data/${PINS['hanzi-writer-data'].version}/${codepointFile(char)}`;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function untar(buffer) {
  const files = new Map();
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, length) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
    const prefix = field(345, 155);
    const name = prefix ? `${prefix}/${field(0, 100)}` : field(0, 100);
    const size = parseInt(field(124, 12).trim() || '0', 8);
    const type = field(156, 1);
    offset += 512;
    if (type === '0' || type === '') files.set(name, buffer.subarray(offset, offset + size));
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}

export function vendorFromTarballs(root, tarballDir) {
  const manifest = { manifest_schema_version: 1, stroke_order_convention: 'mainland', packages: [], files: [], characters: [] };
  for (const [name, pin] of Object.entries(PINS)) {
    const tarball = readFileSync(join(tarballDir, `${name}-${pin.version}.tgz`));
    const integrity = `sha512-${createHash('sha512').update(tarball).digest('base64')}`;
    assert.equal(integrity, pin.integrity, `${name}@${pin.version} integrity mismatch`);
    const entries = untar(gunzipSync(tarball));
    const wanted = { ...pin.files };
    if (name === 'hanzi-writer-data') {
      for (const char of PILOT_CHARACTERS) wanted[`package/${char}.json`] = dataPath(char);
    }
    for (const [source, target] of Object.entries(wanted)) {
      const bytes = entries.get(source);
      assert.ok(bytes, `${source} missing from ${name}@${pin.version}`);
      mkdirSync(join(root, dirname(target)), { recursive: true });
      writeFileSync(join(root, target), bytes);
      manifest.files.push({ path: target, upstream: `${name}@${pin.version}/${source.replace(/^package\//, '')}`, sha256: sha256(bytes) });
    }
    manifest.packages.push({ name, version: pin.version, license: pin.license, npm_integrity: pin.integrity, modified: false });
  }
  for (const char of PILOT_CHARACTERS) {
    const path = dataPath(char);
    const data = JSON.parse(readFileSync(join(root, path), 'utf8'));
    manifest.characters.push({
      character: char,
      codepoint: `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`,
      data_version: PINS['hanzi-writer-data'].version,
      path,
      sha256: manifest.files.find(file => file.path === path).sha256,
      stroke_count: data.strokes.length,
    });
  }
  writeFileSync(join(root, MANIFEST_PATH), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Build gate: every vendored file must match the manifest byte for byte. */
export function verifyHanziVendor(root) {
  const manifest = JSON.parse(readFileSync(join(root, MANIFEST_PATH), 'utf8'));
  for (const [name, pin] of Object.entries(PINS)) {
    const entry = manifest.packages.find(item => item.name === name);
    assert.ok(entry, `${name} missing from ${MANIFEST_PATH}`);
    assert.equal(entry.version, pin.version, `${name} version is not the pinned ${pin.version}`);
    assert.equal(entry.npm_integrity, pin.integrity, `${name} integrity is not the pinned value`);
  }
  for (const file of manifest.files) {
    assert.ok(existsSync(join(root, file.path)), `${file.path} is missing`);
    assert.equal(sha256(readFileSync(join(root, file.path))), file.sha256, `${file.path} differs from the vendored upstream bytes`);
  }
  return manifest.files.map(file => file.path);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const tarballDir = process.argv[2];
  if (!tarballDir) {
    console.error('Usage: node release/hanzi-writer-vendor.mjs <directory with npm pack tarballs>');
    process.exit(2);
  }
  const manifest = vendorFromTarballs(root, tarballDir);
  console.log(`Vendored ${manifest.files.length} files into vendor/ (${MANIFEST_PATH}).`);
}
