#!/usr/bin/env node
/* skill-forge export: PRs and issues of one repo -> <out>/raw/{prs,issues}.jsonl through `gh api graphql`.
   One request at a time, a pause between pages, resumable (raw/state.json), never a retry loop. Auth is whatever gh has. */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  appendJsonl, intOption, isMain, need, normalizeIssue, normalizePr, parseCli, readJsonl, runMain, UsageError, writeJson,
} from './forge-lib.mjs';

const execFileAsync = promisify(execFile);
const RATE_LIMIT_FLOOR = 100;
const RETRY_DELAY_MS = 30_000;
const FILES = { pr: 'prs.jsonl', issue: 'issues.jsonl' };
const NORMALIZE = { pr: normalizePr, issue: normalizeIssue };

const SOURCE = 'source{... on PullRequest{number} ... on Issue{number}}';
const COMMON = 'number title body state createdAt closedAt author{login} labels(first:20){nodes{name}} comments(first:40){nodes{author{login} body createdAt}}';
const NODE_FIELDS = {
  pr: `${COMMON} mergedAt files(first:100){nodes{path additions deletions}} reviews(first:20){nodes{state body author{login}}} `
    + 'reviewThreads(first:30){nodes{comments(first:5){nodes{body path author{login}}}}} closingIssuesReferences(first:10){nodes{number}} '
    + `timelineItems(first:30,itemTypes:[CROSS_REFERENCED_EVENT]){nodes{__typename ... on CrossReferencedEvent{${SOURCE}}}}`,
  issue: `${COMMON} stateReason timelineItems(first:50,itemTypes:[REOPENED_EVENT,CROSS_REFERENCED_EVENT,CLOSED_EVENT]){nodes{__typename `
    + `... on CrossReferencedEvent{${SOURCE}} ... on ClosedEvent{closer{... on PullRequest{number}}}}}`,
};
const CONNECTION = { pr: 'pullRequests', issue: 'issues' };

const USAGE = `Usage:
  node export-github.mjs --repo owner/name --out <workbench> [--kind pr|issue|all] [--max N] [--page-size 20] [--pause-ms 1500]

Writes <out>/raw/prs.jsonl and <out>/raw/issues.jsonl (one normalised item per line, oldest first) and <out>/raw/state.json.
A second run resumes from the saved cursors and skips numbers already written. --max caps items per kind (smoke tests).
--repo defaults to "gh repo view --json nameWithOwner". Needs an authenticated gh. When the rate limit drops under ${RATE_LIMIT_FLOOR} it waits for the reset;
when gh fails it retries once after ${RETRY_DELAY_MS / 1000} s, then stops with the error.`;

export function buildQuery(kind) {
  return `query($owner:String!,$name:String!,$first:Int!,$after:String){rateLimit{remaining resetAt cost} repository(owner:$owner,name:$name){`
    + `${CONNECTION[kind]}(first:$first,after:$after,orderBy:{field:CREATED_AT,direction:ASC}){pageInfo{hasNextPage endCursor} nodes{${NODE_FIELDS[kind]}}}}}`;
}

const realExec = (file, args) => execFileAsync(file, args, { maxBuffer: 256 * 1024 * 1024, windowsHide: true });
const realSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** One `gh` call returning parsed JSON. A failure is retried once after retryDelayMs; the second failure is thrown. */
export async function callGh(args, { exec = realExec, sleep = realSleep, retryDelayMs = RETRY_DELAY_MS, log = () => {} } = {}) {
  const attempt = async () => {
    let result;
    try { result = await exec('gh', args); } catch (err) { throw new Error(`gh failed: ${String(err.stderr || err.stdout || err.message).trim()}`); }
    let parsed;
    try { parsed = JSON.parse(result.stdout); } catch { throw new Error('gh returned something that is not JSON'); }
    if (parsed.errors && !parsed.data) throw new Error(`GraphQL error: ${parsed.errors.map(e => e.message).join('; ')}`);
    return parsed;
  };
  try {
    return await attempt();
  } catch (first) {
    log(`${first.message} -- retrying once in ${retryDelayMs / 1000} s`);
    await sleep(retryDelayMs);
    return attempt();
  }
}

export function makeFetchPage(repo, ghOptions = {}) {
  const [owner, name] = repo.split('/');
  return async ({ kind, after, first }) => {
    const args = ['api', 'graphql', '-f', `query=${buildQuery(kind)}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `first=${first}`];
    if (after) args.push('-f', `after=${after}`);
    const { data } = await callGh(args, ghOptions);
    const connection = data.repository[CONNECTION[kind]];
    return { nodes: connection.nodes, pageInfo: connection.pageInfo, rateLimit: data.rateLimit };
  };
}

const statePath = outDir => join(outDir, 'raw', 'state.json');
const readState = async outDir => (existsSync(statePath(outDir)) ? JSON.parse(await readFile(statePath(outDir), 'utf8')) : {});

async function claimWorkbench(outDir, repo) {
  const state = await readState(outDir);
  if (state.repo && state.repo !== repo) throw new Error(`${outDir} already holds an export of ${state.repo}, not ${repo}; use another --out`);
  await writeJson(statePath(outDir), { ...state, repo });
}

/** Pages through one kind, oldest first. Returns { count, done }; count is the number of distinct items now on disk. */
export async function exportKind({
  kind, fetchPage, outDir, max, pageSize = 20, pauseMs = 1500, normalize = NORMALIZE[kind], sleep = realSleep, log = console.log,
}) {
  const file = join(outDir, 'raw', FILES[kind]);
  const state = await readState(outDir);
  const seen = new Set((await readJsonl(file, { optional: true })).map(r => r.number));
  let cursor = state[kind]?.cursor ?? null;
  if (state[kind]?.done) return { count: seen.size, done: true };
  const save = done => writeJson(statePath(outDir), { ...state, [kind]: { cursor, done } });
  for (;;) {
    if (max !== undefined && seen.size >= max) return { count: seen.size, done: false };
    const first = max === undefined ? pageSize : Math.max(1, Math.min(pageSize, max - seen.size));
    const page = await fetchPage({ kind, after: cursor ?? undefined, first });
    const fresh = [];
    let truncated = false;
    for (const node of page.nodes) {
      if (max !== undefined && seen.size >= max) { truncated = true; break; }
      const item = normalize(node);
      if (seen.has(item.number)) continue;
      seen.add(item.number);
      fresh.push(item);
    }
    await appendJsonl(file, fresh);
    if (!truncated) cursor = page.pageInfo.endCursor;
    const done = !truncated && !page.pageInfo.hasNextPage;
    await save(done);
    log(`${kind}: ${seen.size} items (+${fresh.length})${done ? ', finished' : ''}`);
    if (done || truncated || (max !== undefined && seen.size >= max)) return { count: seen.size, done };
    if (page.rateLimit && page.rateLimit.remaining < RATE_LIMIT_FLOOR) {
      const wait = Math.max(0, Date.parse(page.rateLimit.resetAt) - Date.now()) + 1000;
      log(`rate limit low (${page.rateLimit.remaining} left); waiting until ${page.rateLimit.resetAt} (${Math.round(wait / 1000)} s)`);
      await sleep(wait);
    }
    if (pauseMs > 0) await sleep(pauseMs);
  }
}

async function defaultRepo() {
  try {
    const { stdout } = await realExec('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']);
    return stdout.trim();
  } catch (err) {
    throw new Error(`could not detect the repo with gh (${String(err.stderr || err.message).trim()}); pass --repo owner/name`);
  }
}

async function main() {
  const { values } = parseCli(process.argv.slice(2), {
    repo: { type: 'string' }, out: { type: 'string' }, kind: { type: 'string' }, max: { type: 'string' }, 'page-size': { type: 'string' }, 'pause-ms': { type: 'string' },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const out = need(values, 'out');
  const kind = values.kind ?? 'all';
  if (!['pr', 'issue', 'all'].includes(kind)) throw new UsageError(`--kind must be pr, issue or all, got "${kind}"`);
  const max = values.max === undefined ? undefined : intOption(values, 'max');
  const pageSize = intOption(values, 'page-size', 20);
  if (pageSize < 1 || pageSize > 50) throw new UsageError('--page-size must be between 1 and 50');
  const repo = values.repo ?? await defaultRepo();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new UsageError(`--repo must look like owner/name, got "${repo}"`);
  await claimWorkbench(out, repo);
  const fetchPage = makeFetchPage(repo, { log: console.log });
  for (const k of kind === 'all' ? ['pr', 'issue'] : [kind]) {
    const { count, done } = await exportKind({ kind: k, fetchPage, outDir: out, max, pageSize, pauseMs: intOption(values, 'pause-ms', 1500) });
    console.log(`${k}: ${count} items on disk${done ? '' : ' (stopped early)'}`);
  }
  return 0;
}

if (isMain(import.meta.url)) await runMain(main);
