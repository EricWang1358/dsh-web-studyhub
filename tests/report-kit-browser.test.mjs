import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDeck } from '../scripts/report/build.mjs';
import { checkNavigation, takeShots } from '../scripts/report/shots.mjs';

/* The report kit's deck in a real browser: every slide type at desktop and phone width (nothing sideways, no caption or cell squeezed
   into a sliver, no diagram text outside its picture), and the keyboard and wheel against the slide counter. */

const examples = fileURLToPath(new URL('../scripts/report/examples/', import.meta.url));

test('every slide type lays out at desktop and phone width, and the counter follows the keys and the wheel', { timeout: 600_000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'report-kit-browser-'));
  try {
    for (const name of ['all-types-deck.json', 'sample-deck.json']) {
      const html = join(dir, name.replace('.json', '.html'));
      await buildDeck(join(examples, name), html);
      const problems = (await takeShots({ deck: html, out: join(dir, `${name}-shots`), theme: 'light' })).filter((line) => !line.includes('warning: '));
      assert.deepEqual(problems, [], name);
    }
    assert.deepEqual(await checkNavigation({ deck: join(dir, 'all-types-deck.html') }), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
