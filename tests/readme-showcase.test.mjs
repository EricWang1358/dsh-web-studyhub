import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const ASSETS_DIR = 'docs/assets/readme';
const SLOTS = ['hero', 'desk', 'reader', 'practice', 'companion', 'exam', 'explorer'];
const LANGS = ['en', 'zh'];
const THEMES = ['dark', 'light'];

const MAX_FILE_BYTES = 150 * 1024; // 150 KB per image (Issue #1119 Comment #5)
const MIN_FILE_BYTES = 5_000;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024; // 3 MB total directory budget
const MIN_WIDTH = 800;
const MIN_HEIGHT = 400;

/** Parse pixel dimensions from a RIFF/WEBP buffer (VP8, VP8L, or VP8X). */
function parseWebpDimensions(buf, label) {
  assert.ok(buf.length >= 30, `${label} is too short to be a valid WebP (${buf.length} bytes)`);
  assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', `${label} missing RIFF magic header`);
  assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP', `${label} missing WEBP signature`);
  assert.equal(buf.readUInt32LE(4), buf.length - 8, `${label} RIFF chunk size mismatch`);

  const chunk = buf.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8X') {
    const width = 1 + buf.readUIntLE(24, 3);
    const height = 1 + buf.readUIntLE(27, 3);
    return { chunk, width, height };
  }
  if (chunk === 'VP8L') {
    assert.equal(buf[20], 0x2f, `${label} VP8L signature byte mismatch`);
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { chunk, width, height };
  }
  if (chunk === 'VP8 ') {
    assert.equal(buf[23], 0x9d, `${label} VP8 frame sync byte 0 mismatch`);
    assert.equal(buf[24], 0x01, `${label} VP8 frame sync byte 1 mismatch`);
    assert.equal(buf[25], 0x2a, `${label} VP8 frame sync byte 2 mismatch`);
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    return { chunk, width, height };
  }
  assert.fail(`${label} has unsupported WebP chunk type "${chunk}"`);
}

function expectedAssetPaths() {
  const paths = [];
  for (const slot of SLOTS) {
    for (const lang of LANGS) {
      for (const theme of THEMES) {
        paths.push(`${ASSETS_DIR}/${slot}-${lang}-${theme}.webp`);
      }
    }
  }
  return paths.sort();
}

test('all 28 README WebP showcase screenshots exist, are valid non-stub WebP binaries, and stay within size budgets', async () => {
  const dirEntries = await readdir(resolve(ASSETS_DIR), { withFileTypes: true });
  const actualPaths = dirEntries
    .map((entry) => {
      assert.ok(entry.isFile(), `${ASSETS_DIR}/${entry.name} must be a regular file`);
      return `${ASSETS_DIR}/${entry.name}`;
    })
    .sort();
  const expected = expectedAssetPaths();
  assert.deepEqual(
    actualPaths,
    expected,
    `${ASSETS_DIR} must contain exactly the 28 expected WebP assets with zero missing or unreferenced files`,
  );

  let totalBytes = 0;
  for (const rel of expected) {
    const full = resolve(rel);
    const info = await stat(full);
    assert.ok(
      info.size > MIN_FILE_BYTES && info.size <= MAX_FILE_BYTES,
      `${rel} size ${info.size} bytes is outside (${MIN_FILE_BYTES}, ${MAX_FILE_BYTES}]`,
    );
    totalBytes += info.size;

    const buf = await readFile(full);
    const { width, height } = parseWebpDimensions(buf, rel);
    assert.ok(
      width >= MIN_WIDTH && height >= MIN_HEIGHT,
      `${rel} dimensions ${width}x${height} are below minimum ${MIN_WIDTH}x${MIN_HEIGHT}`,
    );
  }

  assert.ok(
    totalBytes <= MAX_TOTAL_BYTES,
    `${ASSETS_DIR} total size ${totalBytes} bytes exceeds 3 MB budget (${MAX_TOTAL_BYTES})`,
  );
});

test('package.json files whitelist excludes docs/assets/readme', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  const files = Array.isArray(manifest.files) ? manifest.files : [];
  assert.ok(files.length > 0, 'package.json must declare a files whitelist');

  const leakingEntries = files.filter((entry) => {
    const normalized = String(entry).replaceAll('\\', '/').replace(/\/+$/, '');
    return (
      normalized === 'docs'
      || normalized === 'docs/assets'
      || normalized === ASSETS_DIR
      || normalized.startsWith(`${ASSETS_DIR}/`)
    );
  });
  assert.deepEqual(
    leakingEntries,
    [],
    `docs/assets/readme must not be packed into npm/plugin release archives (matched: ${leakingEntries.join(', ')})`,
  );
});

test('README.md and README.zh-CN.md pair all 7 dark/light <picture> slots per language with zero broken or orphan assets', async () => {
  const referencedByReadmes = new Set();

  for (const [readmeFile, lang] of [['README.md', 'en'], ['README.zh-CN.md', 'zh']]) {
    const otherLang = lang === 'en' ? 'zh' : 'en';
    const text = await readFile(resolve(readmeFile), 'utf8');

    assert.equal(
      /\]\(docs\/assets\/readme\//.test(text),
      false,
      `${readmeFile} must embed readme assets with <picture>/<img>, not Markdown image links`,
    );
    assert.equal(
      new RegExp(`${ASSETS_DIR}/[a-z]+-${otherLang}-(?:dark|light)\\.webp`).test(text),
      false,
      `${readmeFile} must not reference -${otherLang}- showcase screenshots`,
    );

    const pictures = [...text.matchAll(/<picture>([\s\S]*?)<\/picture>/g)];
    const coveredSlots = [];

    for (const [, inner] of pictures) {
      if (!inner.includes(`${ASSETS_DIR}/`)) continue;

      const darkMatch = /<source\s+[^>]*media="\(prefers-color-scheme:\s*dark\)"[^>]*srcset="([^"]+)"/.exec(inner);
      assert.ok(darkMatch, `${readmeFile} <picture> block is missing dark <source media="(prefers-color-scheme: dark)" srcset="...">`);
      const darkPath = darkMatch[1];

      const imgMatch = /<img\s+[^>]*src="([^"]+)"[^>]*>/.exec(inner);
      assert.ok(imgMatch, `${readmeFile} <picture> block is missing fallback <img src="...">`);
      const lightPath = imgMatch[1];
      const altMatch = /\balt="([^"]+)"/.exec(imgMatch[0]);
      assert.ok(altMatch && altMatch[1].trim().length > 0, `${readmeFile} <img> for ${lightPath} must have non-empty alt text`);

      const darkParts = new RegExp(`^${ASSETS_DIR}/([a-z]+)-(${lang})-dark\\.webp$`).exec(darkPath);
      const lightParts = new RegExp(`^${ASSETS_DIR}/([a-z]+)-(${lang})-light\\.webp$`).exec(lightPath);
      assert.ok(darkParts, `${readmeFile} dark srcset "${darkPath}" does not match ${ASSETS_DIR}/<slot>-${lang}-dark.webp`);
      assert.ok(lightParts, `${readmeFile} fallback img src "${lightPath}" does not match ${ASSETS_DIR}/<slot>-${lang}-light.webp`);
      assert.equal(darkParts[1], lightParts[1], `${readmeFile} dark/light slot mismatch: ${darkPath} vs ${lightPath}`);

      coveredSlots.push(darkParts[1]);
      referencedByReadmes.add(darkPath);
      referencedByReadmes.add(lightPath);
    }

    assert.deepEqual(
      [...coveredSlots].sort(),
      [...SLOTS].sort(),
      `${readmeFile} must embed each of the 7 showcase slots exactly once`,
    );

    for (const [, attrPath] of text.matchAll(/\b(?:src|srcset)="(docs\/assets\/readme\/[^"]+)"/g)) {
      const info = await stat(resolve(attrPath));
      assert.ok(info.isFile() && info.size > 0, `${readmeFile} references missing or empty asset ${attrPath}`);
      referencedByReadmes.add(attrPath);
    }
  }

  assert.deepEqual(
    [...referencedByReadmes].sort(),
    expectedAssetPaths(),
    'the union of assets referenced by README.md and README.zh-CN.md must equal all 28 files in docs/assets/readme',
  );
});
