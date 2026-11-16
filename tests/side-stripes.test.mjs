import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/* #1080: a thick coloured edge on a card (a "side stripe") is the look of template UI, and a box inside a box inside a card is clutter. A quotation
   may keep a neutral rule beside it, with no box: that is typography. What this test counts is a left/start edge of 2px or more that is either in
   a tone (ok, warn, bad, info, accent, hue) or sits on a box (the same rule draws a border or a background). Per-file ratchet: numbers may only fall. */

const root = fileURLToPath(new URL('..', import.meta.url));
const TONE = /var\(--(?:ok|warn|bad|info|accent|hue)[a-z-]*\)/;
const EDGE = /border-(?:left|inline-start)(?:-width)?\s*:\s*([2-9])px[^;]*;?/g;

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
      if (TONE.test(match[0]) || boxed) n += 1;
    }
    if (n) counts[relative(root, file).replaceAll('\\', '/')] = n;
  }
  return counts;
}

/* Today's count, file by file. Lower a number when you remove a stripe; never raise one. */
const BASELINE = {
  'ui/book/book-kit.css': 1,
  'ui/book/book.css': 1,
  'ui/companions/companions.css': 1,
  'ui/document-preview/practice/practice.css': 1,
  'ui/document-preview/translation/translation.css': 2,
  'ui/generation-path.css': 1,
  'ui/generation-transparency.css': 1,
  'ui/guided-study/guided-study.css': 1,
  'ui/large-documents.css': 1,
  'ui/mineru.css': 2,
  'ui/oral-exam.css': 1,
  'ui/outline/outline.css': 1,
  'ui/review/learning-loop.css': 1,
  'ui/review/question.css': 3,
  'ui/setup-checklist.css': 1,
  'ui/skeleton.css': 1,
  'ui/sources-page.css': 1,
  'ui/study-map/catalog.css': 1,
  'ui/workflow-scope.css': 1,
};

test('no new side stripes; the files of #1080 have none', async () => {
  const counts = await sideStripes();
  for (const [file, n] of Object.entries(counts)) {
    assert.ok(n <= (BASELINE[file] ?? 0), `${file}: ${n} side stripe(s), baseline ${BASELINE[file] ?? 0}. Use a hairline row, a badge or the meter colour instead (ui/DESIGN.md › Restraint).`);
  }
  for (const file of ['ui/case-result.css', 'ui/wrongbook.css', 'ui/blog-notes.css', 'ui/answer-card.css', 'ui/DailyRecap.css']) {
    assert.equal(counts[file] ?? 0, 0, `${file} was cleaned in #1080`);
  }
});
