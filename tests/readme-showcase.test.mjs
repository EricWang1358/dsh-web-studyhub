import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const SLOTS = ['hero', 'desk', 'reader', 'practice', 'companion', 'exam', 'explorer'];
const LANGS = ['en', 'zh'];
const THEMES = ['dark', 'light'];

test('all 28 README WebP showcase screenshots exist, are valid WebP binaries, and stay compact', async () => {
  for (const slot of SLOTS) {
    for (const lang of LANGS) {
      for (const theme of THEMES) {
        const rel = `docs/assets/readme/${slot}-${lang}-${theme}.webp`;
        const full = resolve(rel);
        const info = await stat(full);
        assert.ok(info.size > 5_000 && info.size < 250_000, `${rel} byte size out of range: ${info.size}`);
        const buf = await readFile(full);
        assert.equal(buf.subarray(0, 4).toString('ascii'), 'RIFF', `${rel} missing RIFF header`);
        assert.equal(buf.subarray(8, 12).toString('ascii'), 'WEBP', `${rel} missing WEBP signature`);
      }
    }
  }
});

test('both READMEs embed all 7 dark/light <picture> pairs for their language and keep release archives lean', async () => {
  const manifest = JSON.parse(await readFile(resolve('package.json'), 'utf8'));
  assert.equal(
    manifest.files.some((entry) => entry === 'docs/assets/readme' || entry.startsWith('docs/assets/readme/')),
    false,
    'docs/assets/readme screenshots must not be packed into npm/plugin release tarballs',
  );

  for (const [file, lang] of [['README.md', 'en'], ['README.zh-CN.md', 'zh']]) {
    const text = await readFile(resolve(file), 'utf8');
    assert.equal(/\]\(docs\/assets\/readme\//.test(text), false, `${file} must embed readme assets with <picture>/<img>, not Markdown links`);

    for (const slot of SLOTS) {
      for (const theme of THEMES) {
        const expected = `docs/assets/readme/${slot}-${lang}-${theme}.webp`;
        assert.ok(text.includes(expected), `${file} is missing ${expected}`);
      }
    }

    for (const [, attrPath] of text.matchAll(/\b(?:src|srcset)="(docs\/assets\/[^"]+)"/g)) {
      const info = await stat(resolve(attrPath));
      assert.ok(info.isFile() && info.size > 0, `${file} references missing or empty asset ${attrPath}`);
    }
  }
});
