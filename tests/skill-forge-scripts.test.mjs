/* skill-forge scripts (.claude/skills/skill-forge/scripts): the deterministic half of the skill. Pure functions are tested in-process on fake
   GraphQL nodes and fake raw JSONL; the CLIs are run on temp workbenches. Nothing here calls GitHub. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SCRIPTS = fileURLToPath(new URL('../.claude/skills/skill-forge/scripts/', import.meta.url));
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const lib = await import(new URL('../.claude/skills/skill-forge/scripts/forge-lib.mjs', import.meta.url));
const cardsMod = await import(new URL('../.claude/skills/skill-forge/scripts/cards.mjs', import.meta.url));
const skillsMod = await import(new URL('../.claude/skills/skill-forge/scripts/check-skills.mjs', import.meta.url));
const exportMod = await import(new URL('../.claude/skills/skill-forge/scripts/export-github.mjs', import.meta.url));

const tmp = () => mkdtemp(join(tmpdir(), 'skill-forge-test-'));
const run = (script, args, opts = {}) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8', ...opts });
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const writeRaw = async (wb, prs, issues = []) => {
  await mkdir(join(wb, 'raw'), { recursive: true });
  await writeFile(join(wb, 'raw', 'prs.jsonl'), jsonl(prs));
  await writeFile(join(wb, 'raw', 'issues.jsonl'), jsonl(issues));
};

function assertKnownKeys(base, over, kind) {
  for (const key of Object.keys(over)) {
    if (!Object.hasOwn(base, key)) throw new Error(`${kind} override has unknown field "${key}" not produced by forge-lib normalizer`);
  }
}
const samplePr = (number, over = {}) => {
  const base = lib.normalizePr({
    number, title: `feat: thing ${number}`, body: '', state: 'MERGED',
    createdAt: '2026-10-05T10:00:00Z', mergedAt: '2026-10-06T10:00:00Z', closedAt: '2026-10-06T10:00:00Z',
    author: { login: 'alice' },
  });
  assertKnownKeys(base, over, 'pr');
  return { ...base, ...over };
};
const sampleIssue = (number, over = {}) => {
  const base = lib.normalizeIssue({
    number, title: `bug ${number}`, body: '', state: 'CLOSED', stateReason: 'COMPLETED',
    createdAt: '2026-10-07T10:00:00Z', closedAt: '2026-10-08T10:00:00Z',
    author: { login: 'bob' },
  });
  assertKnownKeys(base, over, 'issue');
  return { ...base, ...over };
};

/* ---------- normalize ---------- */

test('normalizePr flattens a GraphQL node into plain arrays and a ref', () => {
  const node = {
    number: 1304, title: 'fix(review): x', body: 'b', state: 'MERGED', createdAt: '2026-11-20T01:00:00Z', mergedAt: '2026-11-20T02:00:00Z', closedAt: '2026-11-20T02:00:00Z',
    author: { login: 'eric' }, labels: { nodes: [{ name: 'bug' }, { name: 'ui' }] },
    files: { nodes: [{ path: 'ui/a.js', additions: 3, deletions: 1 }] },
    comments: { nodes: [{ author: { login: 'bot[bot]' }, body: 'hi', createdAt: '2026-11-20T01:30:00Z' }, { author: null, body: 'ghost', createdAt: '2026-11-20T01:31:00Z' }] },
    reviews: { nodes: [{ state: 'APPROVED', body: '', author: { login: 'carol' } }] },
    reviewThreads: { nodes: [{ comments: { nodes: [{ body: 'nit', path: 'ui/a.js', author: { login: 'carol' } }] } }] },
    closingIssuesReferences: { nodes: [{ number: 1300 }] },
    timelineItems: { nodes: [{ __typename: 'CrossReferencedEvent', source: { number: 1305 } }, { __typename: 'CrossReferencedEvent', source: { number: 1305 } }, { __typename: 'CrossReferencedEvent', source: {} }] },
  };
  const pr = lib.normalizePr(node);
  assert.equal(pr.kind, 'pr');
  assert.equal(pr.ref, '#1304');
  assert.equal(pr.author, 'eric');
  assert.deepEqual(pr.labels, ['bug', 'ui']);
  assert.deepEqual(pr.files, [{ path: 'ui/a.js', additions: 3, deletions: 1 }]);
  assert.equal(pr.comments[1].author, '', 'a deleted author becomes an empty string');
  assert.deepEqual(pr.threadComments, [{ path: 'ui/a.js', author: 'carol', body: 'nit' }]);
  assert.deepEqual(pr.closes, [1300]);
  assert.deepEqual(pr.crossRefs, [1305], 'cross references are numbers, deduplicated, empty sources dropped');
  assert.equal(pr.mergedAt, '2026-11-20T02:00:00Z');
});

test('normalizeIssue counts reopen events and finds the closing PR', () => {
  const issue = lib.normalizeIssue({
    number: 7, title: 't', body: null, state: 'CLOSED', stateReason: 'COMPLETED', createdAt: '2026-10-01T00:00:00Z', closedAt: '2026-10-03T00:00:00Z',
    author: { login: 'x' }, labels: { nodes: [{ name: 'bug' }] }, comments: { nodes: [] },
    timelineItems: { nodes: [
      { __typename: 'ReopenedEvent' }, { __typename: 'ReopenedEvent' },
      { __typename: 'CrossReferencedEvent', source: { number: 9 } },
      { __typename: 'ClosedEvent', closer: { number: 12 } }, { __typename: 'ClosedEvent', closer: null },
    ] },
  });
  assert.equal(issue.kind, 'issue');
  assert.equal(issue.ref, '#7');
  assert.equal(issue.body, '');
  assert.equal(issue.reopened, 2);
  assert.deepEqual(issue.crossRefs, [9]);
  assert.equal(issue.closedBy, 12);
  assert.deepEqual(issue.labels, ['bug']);
});

/* ---------- noise, friction, index ---------- */

test('noise: release and dependency chores are noise by default, patterns can be overridden', () => {
  const pats = lib.compileNoisePatterns();
  assert.equal(lib.noiseOf(samplePr(1, { title: 'chore(release): 5.3.3 (#1287)' }), pats).noise, true);
  assert.equal(lib.noiseOf(samplePr(2, { title: 'build(deps-dev): bump vite from 5 to 6' }), pats).noise, true);
  assert.equal(lib.noiseOf(samplePr(3, { title: 'chore(deps): update x' }), pats).noise, true);
  assert.equal(lib.noiseOf(samplePr(4, { title: 'Bump actions/checkout' }), pats).noise, true);
  const real = lib.noiseOf(samplePr(5, { title: 'fix(review): stop restyling' }), pats);
  assert.equal(real.noise, false);
  assert.equal(real.noiseReason, '');
  const reason = lib.noiseOf(samplePr(1, { title: 'chore(release): 5.3.3' }), pats).noiseReason;
  assert.match(reason, /release/);
  const custom = lib.compileNoisePatterns(['^docs:']);
  assert.equal(lib.noiseOf(samplePr(6, { title: 'docs: typo' }), custom).noise, true);
  assert.equal(lib.noiseOf(samplePr(7, { title: 'chore(release): 1' }), custom).noise, false, 'overriding replaces the defaults');
});

test('friction: revert, reopened, follow-up fix, cross refs, comments and the weighted score', () => {
  const items = [
    samplePr(10, { title: 'feat: a' }),
    samplePr(11, { title: 'Revert "feat: a"', body: 'This reverts commit abc.' }),
    samplePr(12, { title: 'x', body: 'This reverts commit def.' }),
    samplePr(20, { title: 'fix(ui): broke it', body: 'Follow-up to #10, which missed the case.' }),
    samplePr(21, { title: 'fix: via xref', crossRefs: [10] }),
    samplePr(22, { title: 'feat: mentions merged', body: 'see #10' }),
    samplePr(5, { title: 'fix: mentions a later PR', body: 'see #10' }),
    samplePr(30, { title: 'fix: mentions unmerged', body: 'see #31' }),
    samplePr(31, { title: 'wip', state: 'CLOSED', mergedAt: null }),
    sampleIssue(40, { reopened: 2, crossRefs: [1, 2], comments: [{}, {}, {}] }),
  ];
  const idx = lib.buildIndex(items);
  const by = Object.fromEntries(idx.map(e => [e.number, e]));
  assert.equal(by[11].friction.revert, true);
  assert.equal(by[12].friction.revert, true, 'body marker counts');
  assert.equal(by[10].friction.revert, false);
  assert.equal(by[20].friction.followUpFix, true);
  assert.equal(by[21].friction.followUpFix, true, 'a cross reference to an earlier merged PR counts');
  assert.equal(by[22].friction.followUpFix, false, 'only fix titles');
  assert.equal(by[5].friction.followUpFix, false, 'only earlier PRs');
  assert.equal(by[30].friction.followUpFix, false, 'only merged PRs');
  assert.equal(by[40].friction.reopened, 2);
  assert.equal(by[40].friction.crossRefs, 2);
  assert.equal(by[40].friction.comments, 3);
  const w = lib.FRICTION_WEIGHTS;
  assert.equal(by[11].friction.score, w.revert);
  assert.equal(by[20].friction.score, w.followUpFix);
  assert.equal(by[10].friction.score, 0);
  assert.equal(by[40].friction.score, Math.round((2 * w.reopened + 2 * w.crossRef + 3 * w.comment) * 100) / 100);
});

test('index entry fields: date, month, dirs from the top two path segments, labels', () => {
  const [e] = lib.buildIndex([samplePr(9, {
    createdAt: '2026-11-03T23:59:00Z', labels: ['bug'],
    files: [{ path: 'lib/contexts/a/x.js' }, { path: 'lib/contexts/b/y.js' }, { path: 'ui/z.css' }, { path: 'README.md' }, { path: 'tests/a.test.mjs' }],
  })]);
  assert.equal(e.ref, '#9');
  assert.equal(e.kind, 'pr');
  assert.equal(e.date, '2026-11-03');
  assert.equal(e.month, '2026-11');
  assert.deepEqual(e.dirs, ['(root)', 'lib/contexts', 'tests', 'ui']);
  assert.deepEqual(e.labels, ['bug']);
  assert.equal(e.noise, false);
  const [i] = lib.buildIndex([sampleIssue(3)]);
  assert.deepEqual(i.dirs, []);
});

/* ---------- split, sample ---------- */

const pool = () => {
  const items = [];
  for (let n = 1; n <= 60; n += 1) {
    const month = 1 + (n % 4);
    const rev = n % 11 === 0;
    items.push(n % 5 === 0
      ? sampleIssue(n, { createdAt: `2026-0${month}-15T00:00:00Z`, reopened: n % 10 === 0 ? 1 : 0 })
      : samplePr(n, { createdAt: `2026-0${month}-15T00:00:00Z`, title: rev ? 'Revert "x"' : `feat: n${n}` }));
  }
  items.push(samplePr(100, { title: 'chore(release): 1.0.0', createdAt: '2026-01-02T00:00:00Z' }));
  return lib.buildIndex(items);
};

test('splitIndex: holdout is non-noise items created after the date, train is the rest of the non-noise', () => {
  const idx = pool();
  const { holdout, train } = lib.splitIndex(idx, '2026-03-15');
  assert.ok(holdout.length > 0 && train.length > 0);
  assert.equal(holdout.length + train.length, idx.filter(e => !e.noise).length);
  assert.ok(!holdout.includes('#100') && !train.includes('#100'));
  const byRef = Object.fromEntries(idx.map(e => [e.ref, e]));
  assert.ok(holdout.every(r => byRef[r].date > '2026-03-15'));
  assert.ok(train.every(r => byRef[r].date <= '2026-03-15'));
  assert.throws(() => lib.splitIndex(idx, 'March'), /YYYY-MM-DD/);
});

test('sampleRefs is deterministic per seed, has no duplicates, and takes the highest-friction items first', () => {
  const idx = pool().filter(e => !e.noise);
  const a = lib.sampleRefs(idx, 12, 1);
  const b = lib.sampleRefs(idx, 12, 1);
  const c = lib.sampleRefs(idx, 12, 2);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
  assert.equal(a.length, 12);
  assert.equal(new Set(a).size, 12);
  const top = [...idx].sort((x, y) => y.friction.score - x.friction.score || x.number - y.number).slice(0, 6).map(e => e.ref);
  for (const ref of top) assert.ok(a.includes(ref), `${ref} is among the top-friction half`);
  const months = new Set(a.map(r => idx.find(e => e.ref === r).month));
  assert.ok(months.size >= 3, 'the random half spreads over months');
  assert.equal(lib.sampleRefs(idx.slice(0, 5), 12, 1).length, 5, 'a small pool is returned whole');
  assert.equal(lib.mulberry32(5)(), lib.mulberry32(5)());
});

/* ---------- dossier ---------- */

test('cleanBody strips HTML comments and images, collapses long fenced blocks, keeps short ones', () => {
  const long = Array.from({ length: 40 }, (_, i) => `line${i + 1}`).join('\n');
  const short = Array.from({ length: 20 }, (_, i) => `s${i + 1}`).join('\n');
  const out = lib.cleanBody(`Intro <!-- hidden\nmulti-line -->text ![shot](http://x/y.png) <img src="a.png"> end\n\n\`\`\`js\n${long}\n\`\`\`\n\n\`\`\`\n${short}\n\`\`\`\nTail`);
  assert.ok(!out.includes('hidden') && !out.includes('![') && !out.includes('<img'));
  assert.ok(out.includes('line10') && !out.includes('line11'));
  assert.ok(out.includes('[… 30 lines]'));
  assert.ok(out.includes('s20'), 'a 20-line block is kept whole');
  assert.ok(out.endsWith('Tail'));
});

test('buildDossierBlock: header first, bots skipped, comments cut, hard cap, files collapsed to directory counts', () => {
  const pr = samplePr(77, {
    title: 'fix(ui): the thing', labels: ['bug'], body: 'Body text. '.repeat(2000), crossRefs: [78], closes: [70],
    files: [{ path: 'ui/a.js', additions: 1, deletions: 0 }, { path: 'ui/b.js', additions: 1, deletions: 0 }, { path: 'lib/x/y.js', additions: 1, deletions: 0 }],
    comments: [
      { author: 'github-actions', body: 'CI report', createdAt: '' }, { author: 'dependabot[bot]', body: 'bump', createdAt: '' },
      { author: 'dana', body: 'z'.repeat(1000), createdAt: '' },
    ],
    threadComments: [{ path: 'ui/a.js', author: 'carol', body: 'rename this' }],
  });
  const [entry] = lib.buildIndex([pr]);
  const big = lib.buildDossierBlock(pr, entry, 100000);
  assert.ok(big.startsWith('### #77'));
  assert.match(big.split('\n')[0], /pr/);
  assert.match(big.split('\n')[0], /2026-10-05/);
  assert.ok(!big.includes('CI report') && !big.includes('dependabot'));
  assert.ok(big.includes('ui (2)') && big.includes('lib/x (1)'));
  assert.ok(big.includes('rename this') && big.includes('ui/a.js'), 'review thread comment carries its path');
  assert.match(big, /#70/);
  assert.match(big, /#78/);
  const dana = big.split('\n').find(l => l.includes('dana'));
  assert.ok(dana.length <= 420, `comment cut to about 400, was ${dana.length}`);
  for (const cap of [1500, 700, 300]) {
    const small = lib.buildDossierBlock(pr, entry, cap);
    assert.ok(small.length <= cap, `cap ${cap}, got ${small.length}`);
    assert.equal(small.split('\n')[0], big.split('\n')[0], 'the header is never cut');
  }
});

test('parseRefList accepts #1,#2 and bare numbers and rejects junk', () => {
  assert.deepEqual(lib.parseRefList('#1, #2,3'), ['#1', '#2', '#3']);
  assert.throws(() => lib.parseRefList('#1,abc'), /abc/);
});

/* ---------- cards ---------- */

const TAXONOMY = '# Taxonomy\n\n## C01 Stale state\nx\n\n## C07 Shared contract drift\ny\n\n### not a class\n';
const goodCard = (over = {}) => ({
  ref: '#1304', kind: 'pr', surface: 'review page', mechanism: 'restyle on every answer', mistake: 'treated a hot path as cold',
  layer: 'logic', moment: 'implement', class: 'C07', catch: 'profile the hot path', home: 'check', evidence: ['#1305'], confidence: 0.8, noise: false, ...over,
});

test('parseTaxonomy reads class ids and titles from ## C<digits> headings only', () => {
  const t = cardsMod.parseTaxonomy(TAXONOMY);
  assert.deepEqual([...t.keys()], ['C01', 'C07']);
  assert.equal(t.get('C07'), 'Shared contract drift');
});

test('validateCard accepts a good card and names each kind of problem', () => {
  const ids = new Set(['C01', 'C07']);
  assert.deepEqual(cardsMod.validateCard(goodCard(), ids), []);
  assert.deepEqual(cardsMod.validateCard(goodCard({ class: 'new', proposed_class: 'Hot path mistaken for cold' }), ids), []);
  const msgs = (over, ids2 = ids) => cardsMod.validateCard(goodCard(over), ids2).join(' | ');
  assert.match(msgs({ layer: 'vibes' }), /layer/);
  assert.match(msgs({ moment: 'someday' }), /moment/);
  assert.match(msgs({ home: 'elsewhere' }), /home/);
  assert.match(msgs({ kind: 'commit' }), /kind/);
  assert.match(msgs({ class: 'C99' }), /C99/);
  assert.match(msgs({ class: 'new' }), /proposed_class/);
  assert.match(msgs({ class: 'new', proposed_class: '  ' }), /proposed_class/);
  assert.match(msgs({ confidence: 1.5 }), /confidence/);
  assert.match(msgs({ confidence: 'high' }), /confidence/);
  assert.match(msgs({ ref: '1304' }), /ref/);
  assert.match(msgs({ catch: '' }), /catch/);
  assert.match(msgs({ surface: undefined }), /surface/);
  assert.match(msgs({ evidence: ['PR 5'] }), /evidence/);
  assert.match(msgs({ noise: 'no' }), /noise/);
  assert.match(cardsMod.validateCard('nope', ids).join(), /object/);
});

const setupCards = async (files) => {
  const wb = await tmp();
  await mkdir(join(wb, 'cards'), { recursive: true });
  for (const [name, rows] of Object.entries(files)) await writeFile(join(wb, 'cards', name), typeof rows === 'string' ? rows : jsonl(rows));
  const tax = join(wb, 'taxonomy.md');
  await writeFile(tax, TAXONOMY);
  return { wb, tax };
};

test('cards check: prints file:line messages, flags duplicates and bad JSON, exits 1; clean cards exit 0', async () => {
  const { wb, tax } = await setupCards({
    'a.jsonl': [goodCard(), goodCard({ ref: '#2', layer: 'bad' }), goodCard({ ref: '#3', class: 'C42' })],
    'b.jsonl': `${JSON.stringify(goodCard({ ref: '#1304' }))}\n{broken\n${JSON.stringify(goodCard({ ref: '#4', class: 'new' }))}\n`,
  });
  const bad = run('cards.mjs', ['check', '--workbench', wb, '--taxonomy', tax]);
  assert.equal(bad.status, 1, bad.stderr);
  assert.match(bad.stdout, /a\.jsonl:2: .*layer/);
  assert.match(bad.stdout, /a\.jsonl:3: .*C42/);
  assert.match(bad.stdout, /b\.jsonl:1: .*duplicate.*#1304/);
  assert.match(bad.stdout, /b\.jsonl:2: .*JSON/);
  assert.match(bad.stdout, /b\.jsonl:3: .*proposed_class/);
  const ok = await setupCards({ 'a.jsonl': [goodCard(), goodCard({ ref: '#2', class: 'new', proposed_class: 'x' })] });
  const good = run('cards.mjs', ['check', '--workbench', ok.wb, '--taxonomy', ok.tax]);
  assert.equal(good.status, 0, good.stdout + good.stderr);
  await rm(wb, { recursive: true, force: true });
  await rm(ok.wb, { recursive: true, force: true });
});

test('computeStats marks recurring (>=3 cards, >=2 surfaces) and costly (one costly item) classes and groups new proposals', () => {
  const tax = cardsMod.parseTaxonomy(TAXONOMY);
  const mk = (n, over = {}) => goodCard({ ref: `#${n}`, ...over });
  const cards = [
    mk(1), mk(2), mk(3, { moment: 'verify' }),
    mk(4, { class: 'C01' }), mk(5, { class: 'C01' }), mk(6, { class: 'C01' }),
    mk(7, { class: 'new', proposed_class: 'Hot path mistaken for cold' }), mk(8, { class: 'new', proposed_class: 'hot path mistaken for cold ' }),
    mk(9, { noise: true }),
  ];
  const entry = (n, dirs, friction) => ({ ref: `#${n}`, month: '2026-10', dirs, friction });
  const index = new Map([
    entry(1, ['ui/a'], { score: 5 }), entry(2, ['lib/b'], { score: 5 }), entry(3, ['lib/b'], { score: 0 }),
    entry(4, ['ui/a'], { score: 3, revert: true }), entry(5, ['ui/a'], { score: 0 }), entry(6, ['ui/a'], { score: 0 }),
    entry(7, [], { score: 0 }), entry(8, [], { score: 0 }), entry(9, ['ui/a'], { score: 50, revert: true }),
  ].map(e => [e.ref, e]));
  const stats = cardsMod.computeStats(cards, index, tax);
  const c07 = stats.classes.find(c => c.id === 'C07');
  const c01 = stats.classes.find(c => c.id === 'C01');
  assert.equal(c07.count, 3);
  assert.equal(c07.surfaces, 2);
  assert.equal(c07.recurring, true);
  assert.equal(c07.costly, false, 'a high friction sum without a costly item is not costly');
  assert.deepEqual(c07.moments, { implement: 2, verify: 1 });
  assert.equal(c01.count, 3);
  assert.equal(c01.surfaces, 1);
  assert.equal(c01.recurring, false, 'three cards on one surface is not recurring');
  assert.equal(c01.costly, true, 'one reverted item makes the class costly');
  assert.equal(c01.friction, 3);
  // Issues change no files, so the card's own `area` counts as its surface when present.
  const byArea = cardsMod.computeStats([
    mk(21, { class: 'C01', area: 'reader' }), mk(22, { class: 'C01', area: 'jobs' }), mk(23, { class: 'C01', area: 'reader', costly_reason: 'owner correction' }),
  ], new Map(), tax).classes[0];
  assert.equal(byArea.surfaces, 2);
  assert.equal(byArea.recurring, true);
  assert.equal(byArea.costly, true, 'costly_reason on a card marks the class costly');
  assert.equal(stats.noiseCards, 1);
  assert.equal(stats.proposals.length, 1);
  assert.equal(stats.proposals[0].count, 2);
  const md = cardsMod.renderStats(stats);
  assert.match(md, /recurring/);
  assert.match(md, /costly/);
  assert.match(md, /Hot path mistaken for cold/i);
});

test('cards stats writes stats.md in the workbench', async () => {
  const { wb, tax } = await setupCards({ 'a.jsonl': [goodCard(), goodCard({ ref: '#2' })] });
  await writeFile(join(wb, 'index.jsonl'), jsonl([{ ref: '#1304', month: '2026-11', dirs: ['ui/a'], friction: { score: 1 } }, { ref: '#2', month: '2026-10', dirs: ['lib/b'], friction: { score: 2 } }]));
  const r = run('cards.mjs', ['stats', '--workbench', wb, '--taxonomy', tax]);
  assert.equal(r.status, 0, r.stderr);
  const md = await readFile(join(wb, 'stats.md'), 'utf8');
  assert.match(md, /C07/);
  assert.equal(md.trim(), r.stdout.trim());
  await rm(wb, { recursive: true, force: true });
});

/* ---------- triage CLI ---------- */

test('triage index, split, sample, dossier run end to end on a fake workbench and are repeatable', async () => {
  const wb = await tmp();
  const prs = [];
  for (let n = 1; n <= 30; n += 1) {
    prs.push(samplePr(n, {
      createdAt: `2026-1${n % 2}-${String(1 + (n % 27)).padStart(2, '0')}T00:00:00Z`, title: n % 7 === 0 ? 'Revert "x"' : `feat: n${n}`,
      files: [{ path: `ui/f${n}.js`, additions: 1, deletions: 1 }], body: `body ${n}\n<!-- hidden -->`,
      comments: [{ author: 'dana', body: `comment ${n}`, createdAt: '' }],
    }));
  }
  prs.push(samplePr(99, { title: 'chore(release): 9.9.9' }));
  await writeRaw(wb, prs, [sampleIssue(50), sampleIssue(51, { reopened: 1 })]);
  const idx = run('triage.mjs', ['index', '--workbench', wb]);
  assert.equal(idx.status, 0, idx.stderr);
  const rows = (await readFile(join(wb, 'index.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows.length, 33);
  assert.equal(rows.find(r => r.ref === '#99').noise, true);
  await writeFile(join(wb, 'profile.json'), JSON.stringify({ noisePatterns: ['^feat: n1$'] }));
  run('triage.mjs', ['index', '--workbench', wb]);
  const rows2 = (await readFile(join(wb, 'index.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l));
  assert.equal(rows2.find(r => r.ref === '#1').noise, true, 'profile.json noisePatterns override the defaults');
  assert.equal(rows2.find(r => r.ref === '#99').noise, false);
  await rm(join(wb, 'profile.json'));
  run('triage.mjs', ['index', '--workbench', wb]);

  const split = run('triage.mjs', ['split', '--workbench', wb, '--holdout-after', '2026-11-15']);
  assert.equal(split.status, 0, split.stderr);
  const holdout = JSON.parse(await readFile(join(wb, 'holdout.json'), 'utf8'));
  const train = JSON.parse(await readFile(join(wb, 'train.json'), 'utf8'));
  assert.ok(holdout.length > 0 && train.length > 0);
  assert.equal(holdout.length + train.length, 32);

  const s1 = run('triage.mjs', ['sample', '--workbench', wb, '--n', '6', '--seed', '3']);
  assert.equal(s1.status, 0, s1.stderr);
  const sample1 = await readFile(join(wb, 'samples', 'calib-6.json'), 'utf8');
  run('triage.mjs', ['sample', '--workbench', wb, '--n', '6', '--seed', '3']);
  assert.equal(await readFile(join(wb, 'samples', 'calib-6.json'), 'utf8'), sample1);
  const refs = JSON.parse(sample1);
  assert.equal(refs.length, 6);
  assert.ok(refs.every(r => train.includes(r)));

  const d = run('triage.mjs', ['dossier', '--workbench', wb, '--refs', join(wb, 'samples', 'calib-6.json'), '--per-batch', '4', '--max-chars', '600']);
  assert.equal(d.status, 0, d.stderr);
  const batches = (await readdir(join(wb, 'batches'))).sort();
  assert.deepEqual(batches, ['calib-001.md', 'calib-002.md']);
  const b1 = await readFile(join(wb, 'batches', 'calib-001.md'), 'utf8');
  assert.equal(b1.match(/^### #/gm).length, 4);
  assert.ok(!b1.includes('hidden'));
  const inline = run('triage.mjs', ['dossier', '--workbench', wb, '--refs', '#2,#3', '--name', 'pick']);
  assert.equal(inline.status, 0, inline.stderr);
  assert.ok(existsSync(join(wb, 'batches', 'pick-001.md')));
  const missing = run('triage.mjs', ['dossier', '--workbench', wb, '--refs', '#9999']);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /#9999/);
  await rm(wb, { recursive: true, force: true });
});

test('every CLI answers --help with a usage and exits 0; bad input exits non-zero with a message', async () => {
  for (const script of ['export-github.mjs', 'triage.mjs', 'cards.mjs', 'check-skills.mjs']) {
    const r = run(script, ['--help']);
    assert.equal(r.status, 0, `${script}: ${r.stderr}`);
    assert.match(r.stdout, /Usage/i, script);
  }
  const wb = await tmp();
  for (const [script, args, pattern] of [
    ['triage.mjs', ['frobnicate'], /unknown|subcommand/i],
    ['triage.mjs', ['index'], /--workbench/],
    ['triage.mjs', ['index', '--workbench', join(wb, 'nope')], /raw|prs\.jsonl|not found/i],
    ['triage.mjs', ['split', '--workbench', wb, '--holdout-after', 'soon'], /YYYY-MM-DD/],
    ['cards.mjs', ['check'], /--workbench/],
    ['cards.mjs', ['check', '--workbench', join(wb, 'none')], /cards/i],
    ['check-skills.mjs', ['--root', join(wb, 'none')], /not found|does not exist/i],
    ['check-skills.mjs', ['--bogus'], /bogus/],
    ['export-github.mjs', ['--out', wb, '--repo', 'a/b', '--kind', 'commit'], /kind/],
    ['export-github.mjs', ['--repo', 'a/b'], /--out/],
  ]) {
    const r = run(script, args);
    assert.notEqual(r.status, 0, `${script} ${args.join(' ')}`);
    assert.match(r.stderr, pattern, `${script} ${args.join(' ')}`);
  }
  await rm(wb, { recursive: true, force: true });
});

/* ---------- export-github ---------- */

test('exportKind pages one at a time, pauses between pages, resumes from the saved cursor and dedupes', async () => {
  const out = await tmp();
  const pages = [
    { nodes: [{ number: 1 }, { number: 2 }], pageInfo: { hasNextPage: true, endCursor: 'c1' }, rateLimit: { remaining: 4000, resetAt: '2099-01-01T00:00:00Z', cost: 1 } },
    { nodes: [{ number: 2 }, { number: 3 }], pageInfo: { hasNextPage: true, endCursor: 'c2' }, rateLimit: { remaining: 3999, resetAt: '2099-01-01T00:00:00Z', cost: 1 } },
    { nodes: [{ number: 4 }], pageInfo: { hasNextPage: false, endCursor: 'c3' }, rateLimit: { remaining: 3998, resetAt: '2099-01-01T00:00:00Z', cost: 1 } },
  ];
  const calls = [];
  const sleeps = [];
  let inFlight = 0;
  const fetchPage = async ({ kind, after }) => {
    inFlight += 1;
    assert.equal(inFlight, 1, 'never two requests at once');
    calls.push({ kind, after });
    await Promise.resolve();
    inFlight -= 1;
    return pages[calls.length - 1];
  };
  const base = { kind: 'pr', outDir: out, normalize: n => ({ number: n.number }), pauseMs: 1500, sleep: async ms => { sleeps.push(ms); }, log: () => {}, fetchPage };
  const first = await exportMod.exportKind({ ...base, max: 3 });
  assert.equal(first.count, 3);
  assert.equal(first.done, false);
  const state = JSON.parse(await readFile(join(out, 'raw', 'state.json'), 'utf8'));
  assert.equal(state.pr.done, false);
  const second = await exportMod.exportKind({ ...base });
  assert.equal(second.done, true);
  assert.equal(second.count, 4);
  const nums = (await readFile(join(out, 'raw', 'prs.jsonl'), 'utf8')).trim().split('\n').map(l => JSON.parse(l).number);
  assert.deepEqual(nums.sort(), [1, 2, 3, 4], 'no duplicates after resume');
  assert.deepEqual(calls.map(c => c.after), [undefined, 'c1', 'c2'], 'the second run resumes from the saved cursor');
  assert.ok(sleeps.filter(ms => ms === 1500).length >= 1, 'pause between pages');
  const third = await exportMod.exportKind({ ...base });
  assert.equal(third.done, true);
  assert.equal(calls.length, 3, 'a finished kind makes no more calls');
  await rm(out, { recursive: true, force: true });
});

test('exportKind waits until resetAt when the rate limit is nearly spent', async () => {
  const out = await tmp();
  const resetAt = new Date(Date.now() + 60_000).toISOString();
  const logs = [];
  const sleeps = [];
  let n = 0;
  await exportMod.exportKind({
    kind: 'issue', outDir: out, normalize: x => ({ number: x.number }), pauseMs: 0, log: m => logs.push(m), sleep: async ms => { sleeps.push(ms); },
    fetchPage: async () => { n += 1; return { nodes: [{ number: n }], pageInfo: { hasNextPage: n < 2, endCursor: `c${n}` }, rateLimit: { remaining: 50, resetAt, cost: 1 } }; },
  });
  assert.ok(sleeps.some(ms => ms > 50_000 && ms < 70_000), `waited for the reset, slept ${sleeps}`);
  assert.ok(logs.some(m => m.includes(resetAt)));
  await rm(out, { recursive: true, force: true });
});

test('callGh retries once after the delay and then stops with the error', async () => {
  const sleeps = [];
  let calls = 0;
  const okResult = { stdout: JSON.stringify({ data: { x: 1 } }) };
  const flaky = async () => { calls += 1; if (calls === 1) { const e = new Error('boom'); e.stderr = 'HTTP 502'; throw e; } return okResult; };
  assert.deepEqual(await exportMod.callGh(['api'], { exec: flaky, sleep: async ms => { sleeps.push(ms); }, retryDelayMs: 30000 }), { data: { x: 1 } });
  assert.deepEqual(sleeps, [30000]);
  calls = 0;
  const dead = async () => { calls += 1; const e = new Error('nope'); e.stderr = 'HTTP 403'; throw e; };
  await assert.rejects(exportMod.callGh(['api'], { exec: dead, sleep: async () => {}, retryDelayMs: 1 }), /403/);
  assert.equal(calls, 2, 'one retry, no loop');
});

test('buildQuery asks for the spec fields and an ascending creation order', () => {
  const pr = exportMod.buildQuery('pr');
  for (const piece of ['CREATED_AT', 'ASC', 'rateLimit', 'reviewThreads', 'closingIssuesReferences', 'CROSS_REFERENCED_EVENT', 'files(first:100)', 'mergedAt']) assert.ok(pr.includes(piece), piece);
  const issue = exportMod.buildQuery('issue');
  for (const piece of ['REOPENED_EVENT', 'CLOSED_EVENT', 'stateReason', 'closer', 'rateLimit']) assert.ok(issue.includes(piece), piece);
});

/* ---------- check-skills ---------- */

const GOOD_SKILL = '---\nname: demo\ndescription: Use when demonstrating a good skill.\n---\n\n# Demo\n\nSee references/guide.md for more.\n';
const makeSkill = async (root, name, { skill = GOOD_SKILL, refs = { 'guide.md': '# Guide\n\nShort.\n' }, extra = [] } = {}) => {
  const dir = join(root, name);
  await mkdir(join(dir, 'references'), { recursive: true });
  if (skill !== null) await writeFile(join(dir, 'SKILL.md'), skill);
  for (const [f, text] of Object.entries(refs)) await writeFile(join(dir, 'references', f), text);
  for (const f of extra) await writeFile(join(dir, f), 'x');
  return dir;
};
const issuesOf = async (root, limits) => (await skillsMod.checkSkills(root, limits)).issues;
const has = (issues, level, pattern) => issues.some(i => i.level === level && pattern.test(i.message));

test('checkSkills: a good skill has no issues and reports bytes and an estimated token count', async () => {
  const root = await tmp();
  await makeSkill(root, 'demo');
  const result = await skillsMod.checkSkills(root);
  assert.deepEqual(result.issues, []);
  const file = result.files.find(f => f.path.endsWith('SKILL.md'));
  assert.equal(file.bytes, Buffer.byteLength(GOOD_SKILL));
  assert.ok(file.tokens > 0);
  assert.equal(skillsMod.estimateTokens('abcdefgh'), 2);
  assert.equal(skillsMod.estimateTokens('漢字'), 2);
  assert.equal(skillsMod.estimateTokens('ab漢字'), 3);
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: frontmatter name and description rules', async () => {
  const root = await tmp();
  await makeSkill(root, 'noskill', { skill: null, refs: {} });
  await makeSkill(root, 'mismatch', { skill: '---\nname: other\ndescription: d\n---\n' , refs: {} });
  await makeSkill(root, 'Bad_Name', { skill: '---\nname: Bad_Name\ndescription: d\n---\n', refs: {} });
  await makeSkill(root, 'nodesc', { skill: '---\nname: nodesc\ndescription:\n---\n', refs: {} });
  await makeSkill(root, 'nofront', { skill: '# no frontmatter\n', refs: {} });
  await makeSkill(root, 'longdesc', { skill: `---\nname: longdesc\ndescription: ${'a'.repeat(1100)}\n---\n`, refs: {} });
  await makeSkill(root, 'warndesc', { skill: `---\nname: warndesc\ndescription: ${'a'.repeat(450)}\n---\n`, refs: {} });
  const issues = await issuesOf(root);
  const of = name => issues.filter(i => i.path.includes(name));
  assert.ok(has(of('noskill'), 'error', /SKILL\.md.*(missing|exist)/i));
  assert.ok(has(of('mismatch'), 'error', /name.*other.*mismatch|name must equal/i));
  assert.ok(has(of('Bad_Name'), 'error', /name.*\[a-z0-9-\]/));
  assert.ok(has(of('nodesc'), 'error', /description.*empty|description.*missing/i));
  assert.ok(has(of('nofront'), 'error', /frontmatter/i));
  assert.ok(has(of('longdesc'), 'error', /description.*1100.*1024/));
  assert.ok(has(of('warndesc'), 'warn', /description.*450.*400/));
  assert.ok(!of('warndesc').some(i => i.level === 'error'));
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: multi-line and quoted descriptions are parsed', async () => {
  const root = await tmp();
  await makeSkill(root, 'folded', { skill: '---\nname: folded\ndescription: >\n  first line\n  second line\n---\n', refs: {} });
  await makeSkill(root, 'quoted', { skill: '---\nname: "quoted"\ndescription: "a: b"\n---\n', refs: {} });
  assert.deepEqual(await issuesOf(root), []);
  assert.equal(skillsMod.parseFrontmatter('---\nname: x\ndescription: >\n  one\n  two\n---\nbody').data.description, 'one two');
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: SKILL.md size thresholds and overridable limits', async () => {
  const root = await tmp();
  const pad = n => `---\nname: big\ndescription: d\n---\n${'x'.repeat(n)}\n`;
  await makeSkill(root, 'big', { skill: pad(6500), refs: {} });
  assert.ok(has(await issuesOf(root), 'warn', /SKILL\.md.*6000/));
  await writeFile(join(root, 'big', 'SKILL.md'), pad(8100));
  assert.ok(has(await issuesOf(root), 'error', /SKILL\.md.*8000/));
  assert.ok(!has(await issuesOf(root, { maxSkillBytes: 9000, warnSkillBytes: 8500 }), 'error', /SKILL\.md/), 'limits are overridable');
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: only SKILL.md, scripts, references, assets at the top level', async () => {
  const root = await tmp();
  await makeSkill(root, 'demo', { extra: ['README.md'] });
  await mkdir(join(root, 'demo', 'scripts'));
  await mkdir(join(root, 'demo', 'assets'));
  const issues = await issuesOf(root);
  assert.ok(has(issues, 'error', /README\.md/));
  assert.equal(issues.filter(i => i.level === 'error').length, 1);
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: references must be linked from SKILL.md and linked references must exist', async () => {
  const root = await tmp();
  await makeSkill(root, 'orphan', { skill: '---\nname: orphan\ndescription: d\n---\nNo links.\n', refs: { 'lonely.md': '# x\n' } });
  await makeSkill(root, 'dangling', { skill: '---\nname: dangling\ndescription: d\n---\nRead `references/gone.md`, and (references/here.md).\n', refs: { 'here.md': '# x\n' } });
  const issues = await issuesOf(root);
  assert.ok(has(issues.filter(i => i.path.includes('orphan')), 'error', /references\/lonely\.md.*not (mentioned|linked)/i));
  assert.ok(has(issues.filter(i => i.path.includes('dangling')), 'error', /references\/gone\.md.*(missing|exist)/i));
  assert.ok(!issues.some(i => i.path.includes('dangling') && /here\.md/.test(i.message)));
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: a reference over 100 lines needs a Contents heading near the top; size warning at 12000 bytes', async () => {
  const root = await tmp();
  const lines = n => Array.from({ length: n }, (_, i) => `line ${i}`).join('\n');
  await makeSkill(root, 'refs', {
    skill: '---\nname: refs\ndescription: d\n---\nSee references/long.md, references/toc.md, references/huge.md.\n',
    refs: { 'long.md': `# Long\n\n${lines(120)}\n`, 'toc.md': `# Toc\n\n## Contents\n- a\n\n${lines(120)}\n`, 'huge.md': `# Huge\n## Contents\n${'y'.repeat(12500)}\n` },
  });
  const issues = await issuesOf(root);
  assert.ok(has(issues.filter(i => i.path.includes('long.md')), 'error', /Contents/));
  assert.ok(!issues.some(i => i.path.includes('toc.md')));
  assert.ok(has(issues.filter(i => i.path.includes('huge.md')), 'warn', /12000/));
  await rm(root, { recursive: true, force: true });
});

test('checkSkills: the sum of descriptions across skills is capped', async () => {
  const root = await tmp();
  for (const n of ['a', 'b', 'c', 'd']) await makeSkill(root, n, { skill: `---\nname: ${n}\ndescription: ${'q'.repeat(900)}\n---\n`, refs: {} });
  const issues = await issuesOf(root);
  assert.ok(has(issues, 'error', /3600.*3000/));
  assert.ok(!has(await issuesOf(root, { maxTotalDescription: 4000 }), 'error', /3000|total/i));
  await rm(root, { recursive: true, force: true });
});

test('check-skills CLI: exit 1 on errors only, --json is parseable, the estimate is labelled', async () => {
  const root = await tmp();
  await makeSkill(root, 'demo', { skill: `---\nname: demo\ndescription: ${'a'.repeat(450)}\n---\nSee references/guide.md\n` });
  const warnOnly = run('check-skills.mjs', ['--root', root]);
  assert.equal(warnOnly.status, 0, warnOnly.stdout + warnOnly.stderr);
  assert.match(warnOnly.stdout, /estimate/i);
  assert.match(warnOnly.stdout, /warn/i);
  const json = run('check-skills.mjs', ['--root', root, '--json']);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.estimate, true);
  assert.ok(Array.isArray(parsed.issues) && Array.isArray(parsed.files));
  await makeSkill(root, 'broken', { skill: null, refs: {} });
  const bad = run('check-skills.mjs', ['--root', root]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /error/i);
  await rm(root, { recursive: true, force: true });
});

test('the real .claude/skills pass the budget check', () => {
  assert.ok(existsSync(join(REPO_ROOT, '.claude/skills/skill-forge/SKILL.md')), '.claude/skills/skill-forge/SKILL.md must exist');
  const r = run('check-skills.mjs', ['--root', join(REPO_ROOT, '.claude/skills')]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('checkSkills: a [Cnn] question must equal that class\'s Catch line in the taxonomy', async () => {
  const root = await tmp();
  const tax = join(root, 'taxonomy.md');
  await writeFile(tax, '# Taxonomy\n\n## C01 One path\n- Catch: Which other paths carry this?\n- Home: x\n\n## C02 Rebuilt\n- Catch: Who owns this already?\n');
  const q = lines => `---\nname: moment\ndescription: Use when testing.\n---\n\n# Moment\n\n## Questions\n\n${lines}\n`;
  await makeSkill(root, 'moment', { skill: q('- [C01] Which other paths carry this?\n- [C02] Who else owns it?\n- [C09] Unknown class?'), refs: {} });
  const issues = await issuesOf(root, { taxonomy: tax });
  assert.ok(!issues.some(i => /C01/.test(i.message)), JSON.stringify(issues));
  assert.ok(has(issues, 'error', /C02.*differs from the taxonomy Catch/));
  assert.ok(has(issues, 'error', /C09.*not in the taxonomy/));
  assert.deepEqual(await issuesOf(root, { taxonomy: join(root, 'missing.md') }), [], 'no taxonomy file, no catch check');
  await rm(root, { recursive: true, force: true });
});

test('skill-moment hook: every moment names a skill that has questions, and settings.json runs the hook for each moment', async () => {
  const hook = await import(new URL('../.claude/hooks/skill-moment.mjs', import.meta.url));
  const { moments } = JSON.parse(await readFile(join(REPO_ROOT, '.claude/hooks/skill-moments.json'), 'utf8'));
  const settings = JSON.parse(await readFile(join(REPO_ROOT, '.claude/settings.json'), 'utf8'));
  const ifs = settings.hooks.PreToolUse.flatMap(g => g.hooks).filter(h => /skill-moment\.mjs/.test(h.command)).map(h => h.if);
  for (const m of moments) {
    const text = await readFile(join(REPO_ROOT, '.claude/skills', m.skill, 'SKILL.md'), 'utf8');
    const qs = hook.questionsFor(text, m.classes);
    assert.ok(qs.length > 0, `${m.name}: ${m.skill} has no [Cnn] questions`);
    if (m.classes) assert.equal(qs.length, m.classes.length, `${m.name}: some of ${m.classes} are not in ${m.skill}`);
  }
  const entries = settings.hooks.PreToolUse.flatMap(g => g.hooks).filter(h => /skill-moment\.mjs/.test(h.command));
  for (const [cmd, name] of [['gh pr create', 'declare-done'], ['gh release create', 'release'], ['npm run release:pack', 'release']]) {
    assert.ok(ifs.some(f => f === `Bash(${cmd}*)`), `settings.json has no hook for ${cmd}`);
    assert.ok(entries.some(h => h.if === `Bash(${cmd}*)` && h.command.endsWith(` ${name}`)), `the ${cmd} hook does not pass moment ${name}`);
    assert.ok(moments.some(m => m.name === name), `no moment named ${name}`);
  }
});

test('skill-moment hook: matches the command at a command start only, and injects context without a permission decision', async () => {
  const hook = await import(new URL('../.claude/hooks/skill-moment.mjs', import.meta.url));
  const moments = [{ name: 'd', pattern: '(^|[;&|(]\\s*)gh\\s+pr\\s+create\\b', skill: 's', lead: 'L' }, { name: 'r', pattern: '(^|[;&|(]\\s*)rel\\b', skill: 's', classes: ['C02'], lead: 'R' }];
  const skill = '# x\n- [C01] one?\n- [C02] two?\nnot a question\n';
  const ctx = (c, only) => hook.contextFor(c, moments, () => skill, only);
  assert.match(ctx('git add . && gh pr create -F b.md'), /^L\n- \[C01\] one\?\n- \[C02\] two\?/);
  assert.match(ctx('cd x\ngh pr create'), /^L\n/, 'a later line is a command start');
  assert.equal(ctx('echo gh pr create'), '');
  assert.equal(ctx('ls'), '');
  // Quoted strings and heredoc bodies are data, not commands: writing a test that mentions the command must not fire.
  assert.equal(ctx('node -e "x && gh pr create"'), '');
  assert.equal(ctx("grep '; gh pr create' f"), '');
  assert.equal(ctx("cat >> t.mjs <<'EOF'\nctx('a && gh pr create');\nrel now\nEOF\nnode --test t.mjs"), '');
  assert.match(ctx("cat > b.md <<EOF\nbody\nEOF\ngh pr create -F b.md"), /^L\n/, 'the command after the heredoc still counts');
  assert.match(ctx('rel now'), /^R\n- \[C02\] two\?\n\(From/);
  // Each hook entry passes its moment name, so one command matched by several `if` filters is not answered twice.
  assert.equal(ctx('gh pr create; rel now', 'r').match(/^R$/m)?.length, 1);
  assert.doesNotMatch(ctx('gh pr create; rel now', 'r'), /^L$/m);
  const out = spawnSync(process.execPath, [join(REPO_ROOT, '.claude/hooks/skill-moment.mjs'), 'declare-done'], { input: JSON.stringify({ tool_input: { command: 'gh pr create' } }), encoding: 'utf8' });
  assert.equal(out.status, 0);
  const parsed = JSON.parse(out.stdout).hookSpecificOutput;
  assert.equal(parsed.hookEventName, 'PreToolUse');
  assert.equal(parsed.permissionDecision, undefined);
  const bad = spawnSync(process.execPath, [join(REPO_ROOT, '.claude/hooks/skill-moment.mjs')], { input: 'not json', encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, '');
});

test('the Codex and Antigravity hook command finds the script from the repo root, from .agents/ and from a subfolder, and allows outside the repo', async () => {
  // Antigravity runs workspace hooks in .agents/; neither agent documents the directory, so run the real command through the shell.
  const { command } = JSON.parse(await readFile(join(REPO_ROOT, '.agents/hooks.json'), 'utf8'))['skill-moments'].PreToolUse[0].hooks[0];
  const agy = JSON.stringify({ toolCall: { name: 'run_command', args: { CommandLine: 'git switch main' } } });
  const codex = JSON.stringify({ tool_input: { command: 'git switch main' } });
  const hook = (cwd, input) => {
    const out = spawnSync(command, { cwd, input, shell: true, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout;
  };
  for (const cwd of [REPO_ROOT, join(REPO_ROOT, '.agents'), join(REPO_ROOT, 'tests')]) {
    const answer = JSON.parse(hook(cwd, '﻿' + agy)); // Windows PowerShell 5.1 pipes text with a BOM
    assert.equal(answer.decision, 'ask', cwd);
    assert.match(answer.reason, /\[C22\]/);
    assert.match(JSON.parse(hook(cwd, codex)).hookSpecificOutput.additionalContext, /\[C22\]/, cwd);
  }
  const outside = await tmp();
  try {
    assert.deepEqual(JSON.parse(hook(outside, agy)), { decision: 'allow' }, 'Antigravity needs a decision even when the script is missing');
    assert.equal(hook(outside, codex), '');
  } finally {
    await rm(outside, { recursive: true, force: true });
  }
});
