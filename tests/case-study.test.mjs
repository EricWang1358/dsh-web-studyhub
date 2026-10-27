import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { computeFacts } from '../scripts/case-study/facts.mjs';
import { buildHtml } from '../scripts/case-study/content.mjs';
import { SNAPSHOT, snapshotText } from '../scripts/case-study/snapshot.mjs';
import * as draw from '../scripts/case-study/draw.mjs';

/* docs/case-study: the architecture case study of StudyHub. Its numbers are read from the code when it is built, so the document cannot quote a limit that the code no longer
   has. This test does two things: it checks that the build still reads every fact and renders it, and it compares the structural facts with the committed snapshot, so a change to
   a quoted limit, count or default asks for `npm run case-study` (which also rewrites the PDF) in the same pull request. */
const facts = await computeFacts();
const S = facts.structural;

test('every fact is read from the code and has a usable value', () => {
  const walk = (value, path) => {
    if (value && typeof value === 'object') return Object.entries(value).forEach(([key, inner]) => walk(inner, `${path}.${key}`));
    assert.ok(value !== undefined && value !== null && !Number.isNaN(value), `${path} is empty: the code changed shape, update scripts/case-study/facts.mjs`);
  };
  walk(S, 'structural');
  assert.equal(S.contextCount, S.contextIds.length);
  assert.equal(S.jobStates, S.jobStatesList.length);
  assert.ok(S.toolNames.includes('study_capabilities') && S.toolNames.includes('study_workspace'));
  assert.ok(S.generation.parallelParts >= 1 && S.generation.partSize >= 1);
});

test('the document renders the facts it quotes, in prose and in the figures, and nothing is left unfilled', () => {
  const html = buildHtml(facts);
  for (const quoted of [`${S.contextCount} contexts`, `${S.migrationSwitches} default-off switches`, `${S.generation.parallelParts} parts run in parallel`, `${S.deferredViews} lazily loaded views`,
    `store version ${S.storeVersion}`, `${S.generation.reviewReasks} times`, `newest ${S.jobArchive.maxRecords} records of the last ${S.jobArchive.maxDays} days`, `${S.taskHistory} tasks`])
    assert.ok(html.includes(quoted), `the document should say "${quoted}"`);
  assert.doesNotMatch(html, /undefined|NaN|\[object|\$\{/, 'a placeholder was left in the text');
  assert.equal((html.match(/<svg /g) || []).length, (html.match(/<\/svg>/g) || []).length);
  assert.equal((html.match(/<svg /g) || []).length, 8, 'eight figures: A1 to A5 and B1 to B3');
  for (const name of S.toolNames) assert.ok(html.includes(name), `${name} is named`);
  assert.ok(html.includes(`${S.contextCount} contexts with versioned APIs`), 'the figures carry the context count too');
  assert.ok(html.includes(`start job (queue, ${S.generation.jobMinutes} min budget)`), 'the sequence figure carries the job budget');
});

test('the figures are drawn from plain data: every figure function returns one svg with boxes', () => {
  const figures = [draw.figureStudyContext(), draw.figureLayersReal(S), draw.figureContainersReal(S), draw.figureDomainReal(), draw.figureGenerateSequence(S), draw.figureJobRecovery(), draw.figureLiveCapture(S), draw.figurePackagingGenerate(S)];
  for (const svg of figures) { assert.match(svg, /^<svg [^>]*viewBox="0 0 \d+ [\d.]+"/); assert.match(svg, /<\/svg>$/); assert.ok(svg.includes('<text'), 'a figure has labels'); }
});

test('the committed snapshot of the structural facts matches the code: run `npm run case-study` after changing a quoted limit, count or default', async () => {
  const committed = await readFile(SNAPSHOT, 'utf8').catch(() => '');
  assert.equal(committed.replace(/\r\n/g, '\n'), snapshotText(facts),
    'docs/case-study/facts.snapshot.json is out of date. A number that docs/case-study quotes changed in the code. Run `npm run case-study` (rebuilds the PDF and the snapshot), read the diff of the document, and commit both. If only the snapshot must move and Chromium is not available, run `node scripts/case-study/build.mjs --facts-only` and rebuild the PDF later.');
});
