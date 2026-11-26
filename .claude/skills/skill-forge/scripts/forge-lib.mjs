/* skill-forge: pure helpers shared by export-github, triage, cards and check-skills. No network, no GitHub; file helpers only read or write
   the paths they are given. Sections: CLI plumbing, JSONL, GitHub node normalising, noise + friction + index, split + sample, dossier. */
import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

/* ---------- CLI plumbing ---------- */

/** Bad command-line input: printed without a stack, exit code 2. */
export class UsageError extends Error {}

export function parseCli(argv, options) {
  try {
    return parseArgs({ args: argv, options: { help: { type: 'boolean', short: 'h' }, ...options }, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err.message);
  }
}

export function need(values, name) {
  if (values[name] === undefined || values[name] === '') throw new UsageError(`--${name} is required`);
  return values[name];
}

export function intOption(values, name, fallback) {
  if (values[name] === undefined) return fallback;
  const n = Number(values[name]);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a non-negative integer, got "${values[name]}"`);
  return n;
}

/** True when the module is the script node was started with (not when it is imported by a test). */
export function isMain(metaUrl) {
  return Boolean(process.argv[1]) && resolve(fileURLToPath(metaUrl)) === resolve(process.argv[1]);
}

export async function runMain(main) {
  try {
    process.exitCode = (await main()) ?? 0;
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`error: ${err.message}\nRun with --help for usage.`);
      process.exitCode = 2;
    } else {
      console.error(`error: ${err.message}`);
      process.exitCode = 1;
    }
  }
}

/* ---------- JSONL ---------- */

export async function readJsonl(path, { optional = false } = {}) {
  if (!existsSync(path)) {
    if (optional) return [];
    throw new Error(`file not found: ${path}`);
  }
  const text = await readFile(path, 'utf8');
  const rows = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try { rows.push(JSON.parse(line)); } catch { throw new Error(`${path}:${i + 1}: invalid JSON`); }
  });
  return rows;
}

export async function writeJsonl(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}

export async function appendJsonl(path, rows) {
  if (!rows.length) return;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

/* ---------- refs ---------- */

export const refOf = number => `#${number}`;

/** "#1, #2,3" -> ["#1", "#2", "#3"]. */
export function parseRefList(text) {
  const parts = String(text).split(/[\s,]+/).filter(Boolean);
  return parts.map(p => {
    const m = /^#?(\d+)$/.exec(p);
    if (!m) throw new UsageError(`bad ref "${p}" (expected #123)`);
    return refOf(Number(m[1]));
  });
}

/* ---------- normalising GitHub GraphQL nodes ---------- */

const list = conn => (conn?.nodes ?? []).filter(Boolean);
const login = a => a?.login ?? '';
const uniq = xs => [...new Set(xs)];

const crossRefsOf = (node, self) => uniq(
  list(node.timelineItems).filter(t => t.__typename === 'CrossReferencedEvent').map(t => t.source?.number).filter(n => Number.isInteger(n) && n !== self),
);

export function normalizePr(node) {
  return {
    kind: 'pr',
    ref: refOf(node.number),
    number: node.number,
    title: node.title ?? '',
    body: node.body ?? '',
    state: node.state ?? '',
    createdAt: node.createdAt ?? '',
    mergedAt: node.mergedAt ?? null,
    closedAt: node.closedAt ?? null,
    author: login(node.author),
    labels: list(node.labels).map(l => l.name),
    files: list(node.files).map(f => ({ path: f.path, additions: f.additions ?? 0, deletions: f.deletions ?? 0 })),
    comments: list(node.comments).map(c => ({ author: login(c.author), body: c.body ?? '', createdAt: c.createdAt ?? '' })),
    reviews: list(node.reviews).map(r => ({ state: r.state ?? '', body: r.body ?? '', author: login(r.author) })),
    threadComments: list(node.reviewThreads).flatMap(t => list(t.comments).map(c => ({ path: c.path ?? '', author: login(c.author), body: c.body ?? '' }))),
    closes: list(node.closingIssuesReferences).map(i => i.number),
    crossRefs: crossRefsOf(node, node.number),
  };
}

export function normalizeIssue(node) {
  const events = list(node.timelineItems);
  const closers = events.filter(e => e.__typename === 'ClosedEvent').map(e => e.closer?.number).filter(Number.isInteger);
  return {
    kind: 'issue',
    ref: refOf(node.number),
    number: node.number,
    title: node.title ?? '',
    body: node.body ?? '',
    state: node.state ?? '',
    stateReason: node.stateReason ?? null,
    createdAt: node.createdAt ?? '',
    closedAt: node.closedAt ?? null,
    author: login(node.author),
    labels: list(node.labels).map(l => l.name),
    comments: list(node.comments).map(c => ({ author: login(c.author), body: c.body ?? '', createdAt: c.createdAt ?? '' })),
    reopened: events.filter(e => e.__typename === 'ReopenedEvent').length,
    crossRefs: crossRefsOf(node, node.number),
    closedBy: closers.length ? closers[closers.length - 1] : null,
  };
}

/* ---------- noise, friction, index ---------- */

export const DEFAULT_NOISE_PATTERNS = ['^chore\\(release\\)', '^(build|chore)\\(deps', '\\bbump\\b'];

export const compileNoisePatterns = (patterns = DEFAULT_NOISE_PATTERNS) => patterns.map(p => new RegExp(p, 'i'));

export function noiseOf(item, patterns = compileNoisePatterns()) {
  const hit = patterns.find(re => re.test(item.title));
  return hit ? { noise: true, noiseReason: `title matches /${hit.source}/` } : { noise: false, noiseReason: '' };
}

/* Friction score = revert x 3 + followUpFix x 2 + 2 per reopen (max 3) + 0.5 per cross reference (max 6) + 0.1 per comment (max 30).
   A revert or a reopened issue is the strongest sign that the first attempt was wrong; the cross-reference and comment terms are tie-breakers. */
export const FRICTION_WEIGHTS = { revert: 3, followUpFix: 2, reopened: 2, crossRef: 0.5, comment: 0.1, reopenedMax: 3, crossRefMax: 6, commentMax: 30 };

const isRevert = item => /^revert/i.test(item.title) || item.body.includes('This reverts commit');
const mentioned = body => [...body.matchAll(/(?<![\w/])#(\d+)\b/g)].map(m => Number(m[1]));

export function frictionOf(item, mergedNumbers) {
  const w = FRICTION_WEIGHTS;
  const refs = item.kind === 'pr' ? uniq([...mentioned(item.body), ...item.crossRefs]) : [];
  const followUpFix = item.kind === 'pr' && /^fix/i.test(item.title) && refs.some(n => n < item.number && mergedNumbers.has(n));
  const reopened = item.kind === 'issue' ? item.reopened : 0;
  const crossRefs = item.crossRefs.length;
  const comments = item.comments.length + (item.threadComments?.length ?? 0);
  const revert = isRevert(item);
  const raw = (revert ? w.revert : 0) + (followUpFix ? w.followUpFix : 0) + Math.min(reopened, w.reopenedMax) * w.reopened
    + Math.min(crossRefs, w.crossRefMax) * w.crossRef + Math.min(comments, w.commentMax) * w.comment;
  return { revert, reopened, followUpFix, crossRefs, comments, score: Math.round(raw * 100) / 100 };
}

/** Top two directory segments of each changed file, deduplicated and sorted; root files are "(root)". */
export function topDirs(files) {
  return uniq(files.map(f => {
    const parts = f.path.split('/');
    return parts.length < 2 ? '(root)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
  })).sort();
}

export function buildIndex(items, { noisePatterns = compileNoisePatterns() } = {}) {
  const merged = new Set(items.filter(i => i.kind === 'pr' && i.mergedAt).map(i => i.number));
  return items.map(item => ({
    ref: item.ref,
    kind: item.kind,
    number: item.number,
    date: item.createdAt.slice(0, 10),
    month: item.createdAt.slice(0, 7),
    title: item.title,
    labels: item.labels,
    dirs: item.kind === 'pr' ? topDirs(item.files) : [],
    ...noiseOf(item, noisePatterns),
    friction: frictionOf(item, merged),
  }));
}

/* ---------- split and sample ---------- */

export function assertIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) throw new UsageError(`--holdout-after must be YYYY-MM-DD, got "${value}"`);
}

export function splitIndex(index, holdoutAfter) {
  assertIsoDate(holdoutAfter);
  const real = index.filter(e => !e.noise);
  return { holdout: real.filter(e => e.date > holdoutAfter).map(e => e.ref), train: real.filter(e => e.date <= holdoutAfter).map(e => e.ref) };
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(xs, rng) {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** Half the highest-friction items (score > 0), the rest stratified by month and kind, round-robin over shuffled strata. */
export function sampleRefs(entries, n, seed = 1) {
  const byNumber = (a, b) => a.number - b.number;
  if (n >= entries.length) return [...entries].sort(byNumber).map(e => e.ref);
  const rng = mulberry32(seed);
  const top = [...entries].filter(e => e.friction.score > 0).sort((a, b) => b.friction.score - a.friction.score || a.number - b.number).slice(0, Math.floor(n / 2));
  const taken = new Set(top.map(e => e.ref));
  const strata = new Map();
  for (const e of [...entries].sort(byNumber)) {
    if (taken.has(e.ref)) continue;
    const key = `${e.month}|${e.kind}`;
    strata.set(key, [...(strata.get(key) ?? []), e]);
  }
  for (const [key, group] of strata) strata.set(key, shuffle(group, rng));
  const picked = [...top];
  while (picked.length < n && [...strata.values()].some(g => g.length)) {
    for (const key of shuffle([...strata.keys()].sort(), rng)) {
      const group = strata.get(key);
      if (group.length && picked.length < n) picked.push(group.pop());
    }
  }
  return picked.sort(byNumber).map(e => e.ref);
}

/* ---------- dossier ---------- */

const FENCE_MAX_LINES = 30;
const FENCE_KEEP_LINES = 10;
const COMMENT_MAX_CHARS = 400;
const COMMENT_MAX_COUNT = 8;

const cut = (text, n) => (text.length <= n ? text : `${text.slice(0, Math.max(0, n - 1))}…`);
const oneLine = text => text.replace(/\s+/g, ' ').trim();

function collapseFences(text) {
  const out = [];
  let open = null;
  let buffer = [];
  const flush = () => {
    if (buffer.length > FENCE_MAX_LINES) out.push(...buffer.slice(0, FENCE_KEEP_LINES), `[… ${buffer.length - FENCE_KEEP_LINES} lines]`);
    else out.push(...buffer);
    buffer = [];
  };
  for (const line of text.split('\n')) {
    if (!open) {
      const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (m) open = m[1];
      out.push(line);
    } else if (new RegExp(`^ {0,3}${open[0]}{${open.length},}\\s*$`).test(line)) {
      flush();
      out.push(line);
      open = null;
    } else {
      buffer.push(line);
    }
  }
  if (open) flush();
  return out.join('\n');
}

/** PR/issue body with the noise taken out: HTML comments, images, long code blocks, blank-line runs. */
export function cleanBody(text) {
  const stripped = String(text ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/<img\b[^>]*>/gi, '');
  return collapseFences(stripped).replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}

const isBot = author => /\[bot\]$/i.test(author) || author.toLowerCase() === 'github-actions';

function dirCounts(files) {
  const counts = new Map();
  for (const f of files) {
    const parts = f.path.split('/');
    const dir = parts.length < 2 ? '(root)' : parts.slice(0, Math.min(2, parts.length - 1)).join('/');
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  const sorted = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const shown = sorted.slice(0, 8).map(([d, c]) => `${d} (${c})`);
  return sorted.length > 8 ? [...shown, `+${sorted.length - 8} more`].join(', ') : shown.join(', ');
}

function headerOf(item, entry) {
  const f = entry.friction;
  const flags = [f.revert && 'revert', f.followUpFix && 'followUpFix', f.reopened && `reopened x${f.reopened}`, f.crossRefs && `xref x${f.crossRefs}`].filter(Boolean);
  const labels = item.labels.slice(0, 6).map(l => cut(l, 30)).join(', ') || '-';
  return `### ${item.ref} · ${item.kind} · ${entry.date} · labels: ${labels} · friction ${f.score}${flags.length ? ` (${flags.join(', ')})` : ''}`;
}

function commentLines(item) {
  const fromComments = item.comments.filter(c => !isBot(c.author) && c.body.trim()).map(c => `- @${c.author}: ${cut(oneLine(c.body), COMMENT_MAX_CHARS)}`);
  const fromReviews = (item.reviews ?? []).filter(r => !isBot(r.author) && r.body.trim()).map(r => `- review ${r.state} @${r.author}: ${cut(oneLine(r.body), COMMENT_MAX_CHARS)}`);
  return [...fromComments, ...fromReviews].slice(0, COMMENT_MAX_COUNT);
}

function threadLines(item) {
  return (item.threadComments ?? []).filter(c => !isBot(c.author) && c.body.trim()).slice(0, COMMENT_MAX_COUNT)
    .map(c => `- ${c.path || '(no path)'} @${c.author}: ${cut(oneLine(c.body), COMMENT_MAX_CHARS)}`);
}

function linkedLine(item) {
  const parts = [];
  if (item.kind === 'pr' && item.closes.length) parts.push(`closes ${item.closes.map(refOf).join(' ')}`);
  if (item.kind === 'issue' && item.closedBy) parts.push(`closed by ${refOf(item.closedBy)}`);
  if (item.crossRefs.length) parts.push(`referenced by ${item.crossRefs.slice(0, 10).map(refOf).join(' ')}`);
  return parts.length ? `Linked: ${parts.join('; ')}` : '';
}

/** One compact block for an LLM to read. The header is never cut; body, review threads and comments share what is left of maxChars. */
export function buildDossierBlock(item, entry, maxChars = 4000) {
  const header = headerOf(item, entry);
  const files = item.kind === 'pr' && item.files.length
    ? `Files: ${dirCounts(item.files)} · +${item.files.reduce((s, f) => s + f.additions, 0)} -${item.files.reduce((s, f) => s + f.deletions, 0)}` : '';
  const fixed = [`Title: ${cut(oneLine(item.title), 200)}`, files, linkedLine(item)].filter(Boolean);
  const sections = [
    { label: 'Body:', text: cleanBody(item.body), share: 0.5 },
    { label: 'Review threads:', text: threadLines(item).join('\n'), share: 0.5 },
    { label: 'Comments:', text: commentLines(item).join('\n'), share: 1 },
  ];
  let remaining = maxChars - [header, ...fixed].join('\n').length - 1;
  const parts = [header, ...fixed];
  for (const s of sections) {
    if (!s.text) continue;
    const budget = Math.floor(remaining * s.share);
    if (budget < s.label.length + 20) continue;
    const block = cut(`${s.label}\n${s.text}`, budget);
    parts.push(block);
    remaining -= block.length + 1;
  }
  const out = parts.join('\n');
  if (out.length <= maxChars) return out;
  return header.length >= maxChars ? header : `${header}\n${out.slice(header.length + 1, maxChars)}`;
}
