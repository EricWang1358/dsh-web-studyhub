import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/* #1080: a thick coloured edge on a card (a "side stripe") is the look of template UI, and a box inside a box inside a card is clutter. A quotation
   may keep a neutral rule beside it, with no box: that is typography, and it has ONE width, 2px. What this test counts is a left/start edge of 2px or
   more that is in a tone (ok, warn, bad, info, accent, hue), sits on a box (the same rule draws a border or a background), or is a neutral rule wider
   than the quotation's 2px (an edge bar on a block of text, such as the answer card's definition, was 3px and passed as a quotation). Per-file ratchet. */
const QUOTE_RULE = 2;

const root = fileURLToPath(new URL('..', import.meta.url));
const TONE = /var\(--(?:ok|warn|bad|info|accent|hue|sh-tone)[a-z-]*\)/;
const EDGE = /border-(?:left|inline-start)(?:-width)?\s*:\s*([2-9])px[^;]*;?/g;
// The same stripe drawn as a shadow: an inset edge of 2px or more in a tone (the toast had one beside its tone icon).
const INSET = /box-shadow\s*:\s*inset\s+([2-9])px\s+0\s+0\s+(var\([^)]*\))/g;

async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await cssFiles(path));
    else if (entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

/** The declarations of the innermost block around `index` (nested CSS: stop at the nearest braces). */
function blockAround(text, index) {
  const open = text.lastIndexOf('{', index);
  const close = text.indexOf('}', index);
  return text.slice(open + 1, close);
}

export async function sideStripes() {
  const counts = {};
  for (const file of await cssFiles(join(root, 'ui'))) {
    const text = (await readFile(file, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
    let n = 0;
    for (const match of text.matchAll(EDGE)) {
      const block = blockAround(text, match.index);
      const boxed = /(?:^|[;{\s])border\s*:\s*[^;]*\d/.test(block) || /(?:^|[;{\s])background(?:-color)?\s*:/.test(block);
      if (TONE.test(match[0]) || boxed || Number(match[1]) > QUOTE_RULE) n += 1;
    }
    for (const match of text.matchAll(INSET)) if (TONE.test(match[2])) n += 1;
    if (n) counts[relative(root, file).replaceAll('\\', '/')] = n;
  }
  return counts;
}

/* Today's count, file by file. Lower a number when you remove a stripe; never raise one. The one that is left is in a file an open PR owns. */
const BASELINE = {
  'ui/generation-transparency.css': 1,
};

test('no new side stripes; the files of #1080 have none', async () => {
  const counts = await sideStripes();
  for (const [file, n] of Object.entries(counts)) {
    assert.ok(n <= (BASELINE[file] ?? 0), `${file}: ${n} side stripe(s), baseline ${BASELINE[file] ?? 0}. Use a hairline row, a badge or the meter colour instead (ui/DESIGN.md › Restraint).`);
  }
  for (const file of ['ui/case-result.css', 'ui/wrongbook.css', 'ui/blog-notes.css', 'ui/answer-card.css', 'ui/DailyRecap.css', 'ui/components/components.css']) {
    assert.equal(counts[file] ?? 0, 0, `${file} was cleaned in #1080`);
  }
});

test('a rubric meter says strong, middle or weak without the cinnabar of the primary action (#1080)', async () => {
  const source = await readFile(join(root, 'ui/CaseResult.jsx'), 'utf8');
  const bar = source.slice(source.indexOf('function Bar('), source.indexOf('function Bar(') + 400);
  assert.match(bar, /"success"/);
  assert.match(bar, /"warning"/);
  assert.doesNotMatch(bar, /"accent"/, 'a middle score is ink, not the cinnabar kept for the one primary action');
});
