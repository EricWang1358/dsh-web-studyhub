// node desktop-lifecycle.mjs <jpackage launcher | executable Spring jar> [--editor]
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join, dirname, basename, extname } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { makeTextPdf } from '../../../../tests/helpers/text-pdf.mjs';
import { parseSseFrames } from '../../../../ui/desktop/events.js';

if (!process.argv[2]) throw new Error('Pass a jpackage launcher or Spring executable jar');
const artifact = await realpath(process.argv[2]);
const temporary = await realpath(tmpdir());
const data = await realpath(await mkdtemp(join(temporary, 'studyhub-desktop-journey-')));
const sourceSentence = 'A hash index answers equality queries by mapping keys to buckets.';
const card = { question: 'How does a hash index locate an equality match?', answer: 'It maps the key to a bucket.' };
const fullCard = { ...card, objective: 'Explain the lookup method', hint: 'Recall where entries are stored.',
  explanation: sourceSentence, misconception: 'A hash table does not scan all records.', quote: sourceSentence };
const review = { approved: true, feedback: 'The answer follows the definition in the source.' };
const calls = [];
let releaseAuthor;
const authorMayAnswer = new Promise(resolveAuthor => { releaseAuthor = resolveAuthor; });
let refused = 0;
let receivedRetry;
const resumedRequest = new Promise(resolveRetry => { receivedRetry = resolveRetry; });
let fixtureError;
const fixture = createServer(async (req, res) => {
  try {
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/v1/chat/completions');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const author = body.model === 'fixture-author';
    assert.ok(author || ['fixture-reviewer', 'fixture-reject'].includes(body.model));
    assert.match(body.messages[0].content, /A hash index answers equality queries/);
    assert.equal(body.response_format.type, 'json_schema');
    if (body.messages[1].content.includes('Console controls probe')) {
      if (refused++ < 2) { res.writeHead(429).end(); return; }
      receivedRetry();
      // The test stops this request from the ordinary task console.
      return;
    }
    if (author) await authorMayAnswer;
    else assert.ok(body.messages[1].content.includes(card.question));
    calls.push({ model: body.model, receipt: req.headers['idempotency-key'] });
    const authored = body.messages[1].content.includes('Missing citation probe') ? { ...fullCard, quote: 'A passage absent from this document.' }
      : body.response_format.json_schema.schema.properties.quote ? fullCard : card;
    const decision = body.model === 'fixture-reject' ? { approved: false, feedback: 'Revision required.' } : review;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ id: 'fixture-completion', object: 'chat.completion', model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(author ? authored : decision) } }],
      usage: { prompt_tokens: 18, completion_tokens: 12, total_tokens: 30 } }));
  } catch (error) {
    fixtureError = error;
    res.writeHead(400).end('Fixture rejected request');
  }
});
await new Promise((res, rej) => { fixture.once('error', rej); fixture.listen(0, '127.0.0.1', res); });
let child;
let exited;
let childError;
let base;
let headers;

async function launch(iteration, libraryData = data, aiEnabled = true) {
  const log = join(data, 'startup-' + iteration + '.log');
  const baseUrl = 'http://127.0.0.1:' + fixture.address().port;
  const config = {
    server: { port: 0 },
    logging: { file: { name: log } },
    studyhub: { 'data-dir': libraryData, headless: true, ai: { enabled: aiEnabled, providers: {
      author: { model: 'fixture-author', family: 'author-family', 'base-url': baseUrl, 'json-schema': true },
      reviewer: { model: 'fixture-reviewer', family: 'review-family', 'base-url': baseUrl, 'json-schema': true },
      reject: { model: 'fixture-reject', family: 'review-family', 'base-url': baseUrl, 'json-schema': true },
    } } },
  };
  const isJar = extname(artifact).toLowerCase() === '.jar';
  const java = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  childError = undefined;
  child = spawn(isJar ? java : artifact, isJar ? ['--enable-preview', '--enable-native-access=ALL-UNNAMED', '-jar', artifact] : [],
    { stdio: 'ignore', windowsHide: true, env: { ...process.env, STUDYHUB_KEYSTORE_PASSWORD: 'local-journey-only', SPRING_APPLICATION_JSON: JSON.stringify(config) } });
  exited = new Promise(done => {
    child.once('exit', (code, signal) => done({ code, signal }));
    child.once('error', error => { childError = error; done({ error }); });
  });
  const deadline = Date.now() + 90000;
  let output = '';
  while (Date.now() < deadline) {
    output = await readFile(log, 'utf8').catch(() => '');
    const port = output.match(/Tomcat started on port (\d+)/)?.[1];
    if (port) { base = 'http://127.0.0.1:' + port; break; }
    if (childError || child.exitCode !== null || child.signalCode) throw childError || Error('Launcher exited. ' + output.slice(-2500));
    await wait(100);
  }
  if (!base) throw Error('Timed out waiting for packaged server. ' + output.slice(-2500));
  const html = await (await fetch(base, { signal: AbortSignal.timeout(15000) })).text();
  const token = html.match(/window\.STUDY_TOKEN="([a-f0-9]+)"/)?.[1];
  assert.ok(token, 'browser bootstrap delivered a session token');
  headers = { 'Content-Type': 'application/json', 'X-Study-Token': token };
}

async function stop() {
  base = null;
  if (!child) return;
  if (!childError && child.exitCode === null && !child.signalCode) child.kill();
  const timeout = new AbortController();
  try {
    await Promise.race([exited, wait(15000, null, { signal: timeout.signal }).then(() => { throw Error('Launcher did not exit'); })]);
  } finally { timeout.abort(); child = null; }
}

async function request(path, payload) {
  const res = await fetch(base + path, { method: payload === undefined ? 'GET' : 'POST', headers,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), signal: AbortSignal.timeout(30000) });
  const body = await res.text();
  assert.ok(res.ok, path + ' HTTP ' + res.status + ': ' + body.slice(0, 600));
  return JSON.parse(body);
}

async function rpc(action, args = {}) {
  const body = await request('/api/call', { action, args });
  assert.ok(body.ok, action + ': ' + JSON.stringify(body).slice(0, 600));
  return body.value;
}

async function untilJob(id, status) {
  const deadline = Date.now() + 20000;
  let state;
  while (Date.now() < deadline) {
    state = await request('/api/ai/jobs/' + id);
    if (state.status === status) return state;
    await wait(100);
  }
  throw Error('Expected ' + status + ', got ' + state?.status);
}

async function progress(id) {
  const res = await fetch(base + '/api/ai/jobs/' + id + '/events', { headers, signal: AbortSignal.timeout(30000) });
  assert.ok(res.ok);
  const events = [];
  const decoder = new TextDecoder();
  let pending = '';
  for await (const chunk of res.body) {
    pending = parseSseFrames(pending + decoder.decode(chunk, { stream: true }), frame => {
      if (frame.event !== 'progress') return;
      events.push(JSON.parse(frame.data));
      releaseAuthor();
    });
  }
  assert.ok(events.some(e => ['QUEUED', 'RUNNING'].includes(e.status)), 'observed live workflow progress');
  assert.equal(events.at(-1)?.status, 'SUCCEEDED', fixtureError?.message || JSON.stringify(events.at(-1)));
  return events.at(-1);
}

try {
  await launch(1);
  const pdf = await makeTextPdf([['Database index structures', sourceSentence]]);
  const imported = await rpc('materials.document.import', { filename: 'index-notes.pdf', dataBase64: pdf.toString('base64') });
  assert.equal(imported.sourceIds.length, 1);
  const library = await rpc('export');
  const source = library.sources.find(item => item.id === imported.sourceIds[0]);
  assert.ok(source?.text.includes(sourceSentence), 'PDF text extracted by the installed engine');
  const routes = '/api/ai/reviewed-drafts';
  const command = { id: 'packaged-lifecycle', sourceId: source.id, title: 'Database indexes',
    topics: ['Equality queries'], author: 'author', reviewer: 'reviewer' };
  const before = await rpc('snapshot');
  const binding = await request(routes, command);
  const { jobId: requestId, draftId: deckId } = binding;
  assert.deepEqual(await request(routes, command), binding);
  await assert.rejects(rpc('draft.publish.quick', { id: deckId }), /pending or incomplete/);
  const running = await rpc('snapshot', { since: before.fingerprint, partial: true });
  const consoleId = 'spring-workflow:' + requestId;
  const current = running.jobs.find(j => j.id === consoleId);
  assert.ok(current?.contract.actions.cancel.available, 'shared task console exposes cancellation');
  assert.ok((await rpc('job.live.list')).jobs.some(j => j.id === consoleId));
  const done = await progress(requestId);
  const finalConsole = await rpc('job.status', { jobId: consoleId });
  assert.equal(finalConsole.contract.status, 'complete');
  assert.equal(finalConsole.contract.usage.tokens, 60);
  assert.ok(!(await rpc('snapshot', { since: running.fingerprint, partial: true })).jobs.some(j => j.id === consoleId));
  assert.deepEqual(calls.map(c => c.receipt), done.stages.map(s => s.receipt));
  assert.deepEqual(JSON.parse(done.stages[0].result), fullCard);
  assert.deepEqual(JSON.parse(done.stages[1].result), review);
  const draft = await request(routes + '/' + deckId + '/prepare', {});
  assert.equal(draft.cards[0].citations[0].sourceId, source.id);
  assert.equal(draft.cards[0].prompt, fullCard.question);
  const cardId = draft.cards[0].id;
  assert.deepEqual(await rpc('draft.save', { deck: draft }), draft, 'the editor saves before quick publication');
  const [receipt, replay] = await Promise.all([
    rpc('draft.publish', { id: draft.id, draftVersion: draft.draftVersion }),
    request(routes + '/' + deckId + '/publish', {}),
  ]);
  assert.equal(receipt.deckId, deckId);
  assert.deepEqual(replay, receipt);
  const run = await rpc('review.start', { deckId, mode: 'flashcard' });
  assert.equal(run.card.id, cardId);
  await rpc('review.reveal', { runId: run.id, cardId });
  const answered = await rpc('review.answer', { runId: run.id, cardId, grade: 4 });
  assert.ok(Date.parse(answered.feedback.nextDue) > 0);
  const reviewed = await rpc('export');
  const memory = reviewed.decks.find(d => d.id === deckId).cards.find(c => c.id === cardId).review;
  assert.equal(memory.algorithm, 'fsrs-6');
  const attempt = reviewed.attempts.find(a => a.quiz_id === cardId && a.deckId === deckId && a.runId === run.id);
  assert.ok(attempt?.id, 'review wrote a uniquely identified attempt');
  await stop();
  // Recreate the specific crash window after Node committed, before Java recorded the final receipt.
  const journalFile = join(data, 'workflows', 'reviewed-drafts.sqlite');
  const unlockBy = Date.now() + 15000;
  for (;;) {
    const journal = new DatabaseSync(journalFile);
    try {
      journal.exec('PRAGMA busy_timeout=1000');
      assert.equal(journal.prepare("UPDATE draft SET document=json_set(document,'$.receipt',null) WHERE draft_id=?").run(deckId).changes, 1);
      break;
    } catch (error) {
      // Windows can still have a file mapping on the abruptly stopped launcher's WAL during truncation.
      if (![5, 6, 1546].includes(error.errcode) || Date.now() >= unlockBy) throw error;
    } finally { journal.close(); }
    await wait(200);
  }
  await launch(2);
  const restored = await rpc('export');
  assert.deepEqual(restored.attempts.find(a => a.id === attempt.id), attempt);
  assert.deepEqual(restored.decks.find(d => d.id === deckId).cards.find(c => c.id === cardId).review, memory);
  assert.deepEqual(await request('/api/ai/jobs/' + requestId), done);
  assert.deepEqual(await request(routes, command), binding);
  assert.deepEqual(await request(routes + '/' + deckId + '/publish', {}), receipt);
  assert.equal(restored.decks.filter(deck => deck.id === deckId).length, 1);
  assert.equal(calls.length, 2, 'restart and replay never resubmitted the fixture requests');

  const rejected = await request(routes, { ...command, id: 'negative', reviewer: 'reject' });
  await untilJob(rejected.jobId, 'SUCCEEDED');
  const rejectedDraft = await request(routes + '/' + rejected.draftId + '/prepare', {});
  if (process.argv.includes('--editor')) {
    const { launchChromium } = await import('../../../../scripts/qa/browser.mjs');
    const { openPage } = await import('../../../../scripts/qa/layout-late.mjs');
    const browser = await launchChromium();
    try {
      const { page } = await openPage(browser, null, { lang: 'zh', theme: 'light', width: 1280 });
      await page.goto(base);
      await page.locator('.draft-open').filter({ hasText: rejectedDraft.title }).click();
      const result = page.waitForResponse(response => response.url().endsWith('/api/call')
        && response.request().postDataJSON()?.action === 'draft.publish.quick');
      const [response] = await Promise.all([
        result,
        page.getByRole('button', { name: '发布并开始练', exact: true }).click(),
      ]);
      const refusal = await response.json();
      assert.equal(refusal.ok, false);
      assert.match(refusal.error, /reviewer rejected/);
      await page.getByText(refusal.error, { exact: false }).first().waitFor();
      assert.ok(await page.getByRole('button', { name: '发布并开始练', exact: true }).isVisible());
    } finally {
      await browser.close();
    }
  }
  for (const action of ['draft.publish', 'draft.publish.quick', 'draft.publish.start', 'draft.publish.plan'])
    await assert.rejects(rpc(action, { id: rejected.draftId, planned: true, allowIssues: true }), /reviewer rejected/);
  await assert.rejects(request(routes + '/' + rejected.draftId + '/publish', {}), /409.*reviewer rejected/);
  const duplicateKeys = '{"action":"snapshot","args":{},"action":"draft.publish.quick","args":' + JSON.stringify({ id: rejected.draftId }) + '}';
  const disambiguated = await fetch(base + '/api/call', { method: 'POST', headers, body: duplicateKeys });
  const refusal = await disambiguated.json();
  assert.equal(refusal.ok, false);
  assert.match(refusal.error, /reviewer rejected/);
  const manual = await rpc('draft.save', { deck: { id: 'manual-identical', title: rejectedDraft.title, cards: rejectedDraft.cards } });
  assert.equal((await rpc('draft.publish', { id: manual.id, draftVersion: manual.draftVersion })).deckId, manual.id);

  const edited = await request(routes, { ...command, id: 'edited' });
  await untilJob(edited.jobId, 'SUCCEEDED');
  const editedDraft = await request(routes + '/' + edited.draftId + '/prepare', {});
  editedDraft.cards[0].answer = 'An answer that the reviewer never saw.';
  delete editedDraft.editorial.nativeReview;
  const newVersion = await rpc('draft.save', { deck: editedDraft });
  assert.ok(newVersion.draftVersion > editedDraft.draftVersion);
  await assert.rejects(rpc('draft.publish.quick', { id: edited.draftId, draftVersion: newVersion.draftVersion }), /differs|changed/);
  await assert.rejects(request(routes + '/' + edited.draftId + '/publish', {}), /409.*changed/);
  const invalid = await request(routes, { ...command, id: 'invalid-citation', topics: ['Missing citation probe'] });
  await untilJob(invalid.jobId, 'SUCCEEDED');
  const unchecked = await request(routes + '/' + invalid.draftId + '/prepare', {});
  assert.equal(unchecked.editorial.nativeReview.approved, true);
  await assert.rejects(request(routes + '/' + invalid.draftId + '/publish', {}), /409.*Canonical deck validation rejected/);
  const after = await rpc('export');
  assert.ok(!after.decks.some(item => [edited.draftId, rejected.draftId].includes(item.id)));

  const probeId = 'console-controls';
  const probeRow = 'spring-workflow:' + probeId;
  await request('/api/ai/jobs', { source: source.text, author: 'author', reviewer: 'reviewer', id: probeId, topics: ['Console controls probe'] });
  await untilJob(probeId, 'PAUSED');
  const paused = await rpc('job.status', { jobId: probeRow });
  assert.equal(paused.contract.actions.resume.available, true);
  await rpc('job.control', { jobId: probeRow, action: 'resume' });
  const timer = new AbortController();
  try {
    await Promise.race([resumedRequest, wait(15000, null, { signal: timer.signal }).then(() => { throw Error('Resume did not dispatch'); })]);
  } finally { timer.abort(); }
  await rpc('job.control', { jobId: probeRow, action: 'cancel' });
  await untilJob(probeId, 'CANCELLED');
  assert.equal(refused, 3, 'two definitive rate rejections, then one interrupted request');
  await stop();
  const otherLibrary = join(data, 'isolated-second-install');
  await mkdir(otherLibrary);
  await launch(3, otherLibrary, false);
  await rpc('restore', { state: after });
  assert.equal((await rpc('draft.get', { id: rejected.draftId })).id, rejected.draftId);
  await assert.rejects(rpc('draft.publish.quick', { id: rejected.draftId }), /current library/);
  await assert.rejects(request(routes + '/' + edited.draftId + '/publish', {}), /409.*current library/);
  const importedState = await rpc('export');
  assert.ok(!importedState.decks.some(d => [edited.draftId, rejected.draftId].includes(d.id)));
  console.log(JSON.stringify({ artifact: basename(artifact), pdfPages: 1, model: 'loopback HTTP fixture',
    stages: done.stages.map(s => s.key), algorithm: memory.algorithm, persistedAttempts: 1, generationCalls: calls.length,
    publication: ['pending', 'concurrent-approved', 'recover-node-commit', 'rejected', 'edited', 'identical-manual', 'canonical-citation', 'foreign-library-ai-off'],
    console: ['snapshot', 'job.live.list', 'job.status', 'resume', 'cancel'] }));
} finally {
  releaseAuthor();
  try { await stop(); } finally {
    fixture.closeAllConnections();
    await new Promise(done => fixture.close(done));
    const owned = await realpath(data);
    assert.equal(dirname(owned), temporary);
    assert.ok(basename(owned).startsWith('studyhub-desktop-journey-'));
    await rm(owned, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
  }
}
