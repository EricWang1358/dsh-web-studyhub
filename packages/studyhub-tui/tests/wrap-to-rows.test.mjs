// wrapToRows (render/cjk.ts): clamp a message to N wrapped rows and end the last kept row with an ellipsis.
// The Import tab error (DeckOpsModal) used to cut by a character budget (rows * (width - 2)) and let Ink wrap
// the result by words; ~20% of long English errors then wrapped past the rows and lost the ellipsis line.
// node --test tests/wrap-to-rows.test.mjs
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { register } from 'tsx/esm/api';
import wrapAnsi from 'wrap-ansi';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const cjk = await import('../src/render/cjk.ts');
const { displayWidth, wrapToRows } = cjk;

/** The exact call Ink makes for <Text wrap="wrap"> (ink/build/wrap-text.js). */
const inkWrap = (text, width) => wrapAnsi(text, width, { trim: false, hard: true }).split('\n');

// Deterministic generator (LCG): no Math.random, same cases every run.
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const EN_WORDS = [
  'Import', 'refused', 'international', 'characterisation', 'requirements', 'unsatisfied', 'incompatible',
  'representations', 'encountered', 'throughout', 'the', 'deck', 'a', 'is', 'of', 'card', 'duplicate',
  'check', 'against', 'an', 'older', 'library', 'because', 'every', 'failed', 'unrecognisable',
  'cross-reference', 'path/to/some/very/long/file-name.json', 'EACCES:', 'permission', 'denied,',
];
const CJK_CHARS = Array.from('导入失败题组卡片重复校验与旧库冲突无法识别的格式请检查字段是否完整，。（）「」');

function makeText(rng, kind) {
  const n = 6 + Math.floor(rng() * 26);
  const parts = [];
  for (let i = 0; i < n; i += 1) {
    if (kind === 'en') parts.push(EN_WORDS[Math.floor(rng() * EN_WORDS.length)]);
    else parts.push(CJK_CHARS[Math.floor(rng() * CJK_CHARS.length)].repeat(1 + Math.floor(rng() * 3)));
  }
  return kind === 'en' ? parts.join(' ') : parts.join(rng() < 0.3 ? ' ' : '');
}

function cases(kind, count, seed) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push({
      text: `[X] ${makeText(rng, kind)}`,
      width: 20 + Math.floor(rng() * 40),
      rows: 1 + Math.floor(rng() * 5),
      ell: rng() < 0.5 ? '...' : '…',
    });
  }
  return out;
}

function check({ text, width, rows, ell }, label) {
  const lines = wrapToRows(text, width, rows, ell);
  const joined = lines.join('\n');
  const where = `${label} width=${width} rows=${rows}\n${JSON.stringify(text)}\n${JSON.stringify(lines)}`;
  assert.ok(lines.length >= 1 && lines.length <= rows, `at most ${rows} lines\n${where}`);
  for (const line of lines) assert.ok(displayWidth(line) <= width, `a line is wider than ${width}\n${where}`);
  // What Ink makes of the result must be the same lines: no re-wrap, so nothing is pushed past `rows`.
  assert.deepEqual(inkWrap(joined, width), lines, `Ink must not re-wrap the result\n${where}`);
  assert.ok(inkWrap(joined, width).length <= rows, `Ink wraps to at most ${rows} lines\n${where}`);
  // Cut = some of the message is not in the rows (compared without spaces, since wrapping drops them).
  const bare = (s) => s.replace(/\s+/g, '');
  const cut = bare(lines.join('')) !== bare(text);
  if (cut) assert.ok(lines[lines.length - 1].endsWith(ell), `a cut message ends with the ellipsis\n${where}`);
  return { lines, cut };
}

describe('wrapToRows', () => {
  test('English errors: at most N lines as Ink wraps them, ellipsis whenever cut, not cut when Ink fits them', () => {
    let cutCount = 0;
    const list = cases('en', 1500, 1774);
    for (const c of list) {
      const { cut } = check(c, 'en');
      if (cut) cutCount += 1;
      // Ink keeps the blank at the start of a wrapped row (trim:false), which costs it a column; wrapToRows drops it.
      // So it never needs more rows than Ink does: a message Ink fits in N rows is never cut.
      // (Only when every word fits a row: wrap-ansi starts an over-wide word on the current row and hard-breaks it
      // there, wrapToRows starts it on a fresh row. Both give rows that fit, which is all the box needs.)
      if (c.text.split(' ').some((w) => w.length > c.width)) continue;
      if (inkWrap(c.text, c.width).length <= c.rows) assert.equal(cut, false, `not cut when Ink fits it\n${JSON.stringify(c)}`);
    }
    assert.ok(cutCount > 200, `the generated cases must exercise the cut path (got ${cutCount})`);
  });

  test('CJK and mixed errors: at most N lines, never wider than the box, ellipsis whenever cut', () => {
    let cutCount = 0;
    for (const c of cases('cjk', 1500, 542)) if (check(c, 'cjk').cut) cutCount += 1;
    assert.ok(cutCount > 200, `the generated cases must exercise the cut path (got ${cutCount})`);
  });

  test('the reviewer sentence at the 60x18 Import width keeps its ellipsis', () => {
    const text = '[X] Import refused: international characterisation requirements unsatisfied; incompatible representations encountered throughout';
    for (let width = 30; width <= 58; width += 1) {
      for (let rows = 1; rows <= 4; rows += 1) check({ text, width, rows, ell: '...' }, 'reviewer');
    }
  });

  test('explicit newlines count as rows, trailing blank lines do not, one row truncates', () => {
    assert.deepEqual(wrapToRows('a\nb\nc', 20, 5, '...'), ['a', 'b', 'c']);
    assert.deepEqual(wrapToRows('a\nb\n\n', 20, 5, '...'), ['a', 'b']);
    assert.deepEqual(wrapToRows('a\nb\nc', 20, 2, '...'), ['a', 'b c...']);
    const one = wrapToRows('alpha beta gamma delta', 12, 1, '...');
    assert.equal(one.length, 1);
    assert.ok(one[0].endsWith('...') && displayWidth(one[0]) <= 12);
  });
});
