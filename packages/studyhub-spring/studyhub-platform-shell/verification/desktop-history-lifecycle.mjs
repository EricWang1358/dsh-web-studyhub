// node desktop-history-lifecycle.mjs <Spring desktop exec.jar or launcher> [relay.jar]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { Store } from '../../../../lib/store.js';

const desktopArtifact = await realpath(process.argv[2]);
const relayArtifact = await realpath(process.argv[3] || desktopArtifact);
assert.equal(extname(relayArtifact), '.jar', 'Supply a relay.jar when testing a native desktop launcher');
const temporary = await realpath(tmpdir());
const root = await realpath(await mkdtemp(join(temporary, 'studyhub-history-lifecycle-')));
const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
const environment = { ...process.env, STUDYHUB_SYNC_TOKEN: randomBytes(32).toString('base64url'),
  STUDYHUB_SYNC_KEY: randomBytes(32).toString('base64'), STUDYHUB_SYNC_VAULT: randomUUID() };
const api = '/api/sync/desktop-history';
const launches = [];
let sequence = 0;

async function until(label, check, timeout = 60_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await check();
    if (result) return result;
    await wait(150);
  }
  throw new Error('Timed out waiting for ' + label);
}

async function launch(artifact, name, config, env) {
  const isJar = extname(artifact).toLowerCase() === '.jar';
  const log = join(root, name + '-' + (++sequence) + '.log');
  const args = isJar ? ['--enable-preview', '--enable-native-access=ALL-UNNAMED', '-jar', artifact] : [];
  args.push(name === 'relay' ? '--studyhub.mode=sync' : '--headless');
  const proc = spawn(isJar ? java : artifact, args, {
    env: { ...environment, ...env, SPRING_APPLICATION_JSON: JSON.stringify({ ...config, logging: { file: { name: log } } }) },
    stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
  });
  let diagnostic = '';
  proc.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2400); });
  const exited = new Promise(resolve => { proc.once('error', resolve); proc.once('exit', resolve); });
  const stop = async () => {
    if (proc.exitCode == null && !proc.signalCode) proc.kill();
    const timer = new AbortController();
    try { await Promise.race([exited, wait(15000, null, { signal: timer.signal }).then(() => { throw new Error(name + ' did not stop'); })]); }
    finally { timer.abort(); }
  };
  launches.push(stop);
  const port = await until(name + ' loopback service', async () => {
    const output = await readFile(log, 'utf8').catch(() => '');
    if (proc.exitCode != null || proc.signalCode) throw new Error(name + ' exited: ' + output.slice(-2500) + diagnostic);
    return output.match(/Tomcat started on port (\d+)/)?.[1];
  });
  return { base: 'http://127.0.0.1:' + port, port: Number(port), stop };
}

const desktopRoot = device => join(root, device, 'library');
async function startRelay(port = 0) {
  return launch(relayArtifact, 'relay', { server: { address: '127.0.0.1', port }, studyhub: { mode: 'sync' } },
    { STUDYHUB_SYNC_DATA_DIR: join(root, 'relay-data') });
}
async function startDesktop(device, relay) {
  const spring = { 'data-dir': join(root, device), headless: true,
    'desktop-history': { enabled: true, library: 'shared-study-library', root: desktopRoot(device), 'interval-ms': 300 } };
  const peer = await launch(desktopArtifact, device, { server: { address: '127.0.0.1', port: 0 }, studyhub: spring },
    { STUDYHUB_SYNC_DB: join(root, device, 'mirror.db'), STUDYHUB_SYNC_URL: relay.base, STUDYHUB_SYNC_DEVICE: device });
  const html = await (await fetch(peer.base, { signal: AbortSignal.timeout(15000) })).text();
  const token = html.match(/window\.STUDY_TOKEN="([a-f0-9]+)"/)?.[1];
  assert.ok(token, 'Desktop UI delivered a session token');
  const request = async (path, body) => {
    const res = await fetch(peer.base + path, { headers: { 'X-Study-Token': token, 'Content-Type': 'application/json' },
      method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + path + ': ' + (await res.text()).slice(0, 800));
    return res.json();
  };
  return { ...peer, request, async rpc(action, args = {}) {
    const result = await request('/api/call', { action, args });
    assert.ok(result.ok, action + ' ' + JSON.stringify(result.error));
    return result.value;
  } };
}

async function seed(device) {
  const library = desktopRoot(device);
  await mkdir(library, { recursive: true });
  const store = new Store(library);
  await store.update(state => {
    const deck = { id: device, course: '课程 ' + device, title: 'FSRS ' + device, cards: [
      { id: 'same-card', kind: 'flashcard', topic: 'history', prompt: 'What persists?', answer: 'A revision' },
    ] };
    state.decks.push(deck);
    if (device === 'west') {
      const gradedAt = '2026-01-01T10:00:00.000Z';
      const card = { id: 'old-question', kind: 'open', topic: '历史', prompt: 'Define a quorum.', answer: 'A majority.' };
      state.decks.push({ id: 'old-deck', course: '历史', title: 'Archive', cards: [card] });
      state.runs.push({ id: 'legacy-run', mode: 'path', deckId: 'old-deck', index: 0,
        entries: [{ card, deckId: 'old-deck', revealed: true, feedback: { grade: 4, correct: true, gradedAt, rubric: { total: 2, max: 2 } } }] });
      state.attempts.push({ id: 'legacy 超长 ' + '甲'.repeat(300), runId: 'legacy-run', entryIndex: 0, deckId: 'old-deck', quiz_id: card.id,
        grade: 4, timestamp: gradedAt, assessment: 'rubric', assistance: { used: true, unseenStatus: 'unknown' },
        extension: { learnerEvidence: '目录\n原始证据 '.repeat(19_000) } });
      // A supported historical import may contain another row reusing the same named ID, deck and card.
      state.attempts.push({ id: state.attempts[0].id, deckId: 'old-deck', quiz_id: card.id, grade: 1, imported: 'mistake' });
    }
  });
}

async function answer(peer, deckId, grade) {
  const run = await peer.rpc('review.start', { mode: 'flashcard', deckId, fresh: true });
  await peer.rpc('review.reveal', { runId: run.id, cardId: 'same-card' });
  await peer.rpc('review.answer', { runId: run.id, cardId: 'same-card', grade });
  return run.id;
}
async function entries(peer) {
  let after = 0;
  const result = [];
  for (;;) {
    const page = await peer.request(api + '?after=' + after + '&limit=2');
    result.push(...page.entries);
    if (!page.more) return result;
    assert.ok(page.next > after, 'cursor advances even over non-history operations');
    after = page.next;
  }
}
async function count(peer, expected) {
  return until(expected + ' history revisions at ' + peer.base, async () => {
    const page = await entries(peer);
    assert.ok(page.length <= expected, 'duplicate revisions: ' + page.length + ' > ' + expected);
    return page.length === expected && page;
  });
}
function envelope(state, attempt) {
  return { attempt, course: state.decks.find(deck => deck.id === attempt.deckId)?.courseId ?? null, deck: attempt.deckId };
}
async function cycles(peer) {
  const status = () => peer.request(api + '/status');
  const first = (await status()).capture.lastSuccess;
  await until('a later successful capture', async () => {
    const value = await status();
    return !value.capture.error && value.capture.lastSuccess && value.capture.lastSuccess !== first;
  });
}

try {
  await Promise.all(['east', 'west'].map(seed));
  let relay = await startRelay();
  let [west, east] = await Promise.all(['west', 'east'].map(device => startDesktop(device, relay)));
  const firstEntries = await count(east, 2);
  const original = await west.rpc('export');
  const firstPayloads = await Promise.all(firstEntries.map(row => east.request(api + '/' + row.revision)));
  const index = firstPayloads.findIndex(row => row.attempt.assessment === 'rubric');
  assert.ok(index >= 0, 'remote initial rubric revision downloaded');
  const initial = firstEntries[index];
  assert.deepEqual(firstPayloads[index], envelope(original, original.attempts[0]));
  for (const path of [api, api + '/status', api + '/' + initial.revision]) {
    assert.equal((await fetch(east.base + path, { signal: AbortSignal.timeout(5000) })).status, 403);
  }
  await relay.stop();
  await Promise.all([west, east].map(peer => until('offline relay status with independent capture', async () => {
    const status = await peer.request(api + '/status');
    return status.relay.error && status.capture.lastSuccess && !status.capture.error;
  })));
  const [run] = await Promise.all([answer(west, 'west', 4), answer(east, 'east', 3)]);
  await Promise.all([count(west, 3), count(east, 3)]);
  const positives = await west.rpc('export');
  const positive = positives.attempts.find(item => item.runId === run);
  assert.equal(positive.grade, 4);
  await west.rpc('review.undo', { runId: run, attemptId: positive.id });
  await west.rpc('review.grade.adjust', { runId: 'legacy-run', entryIndex: 0, cardId: 'old-question', grade: 2 });
  await count(west, 5);
  const westState = await west.rpc('export');
  const eastState = await east.rpc('export');
  assert.equal(westState.attempts[0].gradeOriginal, 4);
  const voided = westState.attempts.find(item => item.id === positive.id);
  assert.ok(voided.voidedAt);
  assert.equal(eastState.attempts.length, 1);
  assert.equal(eastState.attempts[0].grade, 3);
  const expected = [envelope(original, original.attempts[0]), { ...envelope(original, original.attempts[1]), occurrence: 1 },
    envelope(positives, positive), envelope(westState, westState.attempts[0]), envelope(westState, voided),
    envelope(eastState, eastState.attempts[0])];
  await west.stop();
  west = await startDesktop('west', relay);
  await cycles(west);
  await count(west, 5);
  relay = await startRelay(relay.port);
  const [westRows, eastRows] = await Promise.all([count(west, 6), count(east, 6)]);
  assert.deepEqual(new Set(westRows.map(row => row.revision)), new Set(eastRows.map(row => row.revision)));
  for (const peer of [west, east]) {
    const rows = await entries(peer);
    const actual = await Promise.all(rows.map(row => peer.request(api + '/' + row.revision)));
    for (const wanted of expected) {
      const index = actual.findIndex(item => item.attempt.id === wanted.attempt.id && item.attempt.grade === wanted.attempt.grade
        && item.attempt.voidedAt === wanted.attempt.voidedAt);
      assert.ok(index >= 0, 'materialized exact local and remote revision');
      assert.deepEqual(actual[index], wanted);
      const entry = rows[index];
      assert.equal(entry.device, wanted.deck === 'east' ? 'east' : 'west');
      assert.ok(entry.observedMillis > 0 && entry.source);
      if (wanted.attempt.adjustedAt || wanted.attempt.voidedAt) {
        assert.ok(rows.some(other => other.revision === entry.previous && other.source === entry.source));
      } else assert.equal(entry.previous, null);
    }
    await cycles(peer);
    await count(peer, 6);
  }
  for (const [peer, owned] of [[west, westState], [east, eastState]]) {
    const local = await peer.rpc('export');
    assert.deepEqual(local.attempts, owned.attempts, 'remote revision never overwrote the local Node attempts');
    assert.deepEqual(local.decks, owned.decks, 'remote revision never overwrote the local Node cards and FSRS');
  }
  console.log('Two packaged desktops converged on six exact history revisions across a relay outage and desktop restart, including a repeated scoped ID; original Node stores and schedules verified.');
} finally {
  const stopped = await Promise.allSettled(launches.reverse().map(stop => stop()));
  if (stopped.some(item => item.status === 'rejected')) throw new AggregateError(stopped.filter(item => item.status === 'rejected').map(item => item.reason));
  if (dirname(root) === temporary && root.startsWith(join(temporary, 'studyhub-history-lifecycle-'))) {
    await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 150 });
  }
}
