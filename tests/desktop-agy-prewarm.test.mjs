// Pre-warming the Antigravity CLI: one spare agy is started ahead of the next call, answers exactly one call, and is replaced.
// Measured on the owner's PC (agy 1.5.18, 2026-11-28): a one-word reply took about 11 s from a fresh start and about 5 s from a
// spare that was already waiting; a second question sent to the same process continued the first one's conversation, which is why
// a spare is never reused.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AGY_PREWARM_MODES,
  AGY_SPARE_KEEP_MS,
  AGY_SPARE_RENEW_MS,
  DEFAULT_AGY_PREWARM,
  agyConfigSpec,
  agyWarmPlan,
  agyWarmPlanForConfig,
  agyWarmSpec,
  canServeAgyCall,
  normalizeAgyPrewarm,
  patchAgyPrewarm,
  sameAgySource,
  withAgyPrewarm,
} from '../packages/studyhub-desktop/domain/agy-warm-policy.js';
import { applyConfigPatch, defaultDesktopConfig, normalizeDesktopConfig, redactDesktopConfig } from '../packages/studyhub-desktop/domain/config-policy.js';
import { createAgyCompleteAdapter } from '../packages/studyhub-desktop/adapters/cli/agy-adapter.mjs';
import { AGY_SPARE_TIMEOUT_MS, createAgyWarm, openAgySpare } from '../packages/studyhub-desktop/adapters/cli/agy-spare.mjs';
import { createAgyWarmPool } from '../packages/studyhub-desktop/adapters/cli/agy-warm-pool.mjs';
import { createProcessRunner, holdProcess } from '../packages/studyhub-desktop/adapters/cli/process-runner.mjs';
import { createDesktopCompletePort } from '../packages/studyhub-desktop/application/complete-port.js';
import { composeDesktopSidecar } from '../packages/studyhub-desktop/entry/sidecar.mjs';

const pause = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

async function waitFor(check, { timeoutMs = 10_000, stepMs = 25, what = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await pause(stepMs);
  }
}

const fileText = (path) => readFile(path, 'utf8').catch(() => '');
const exists = (path) => access(path).then(() => true, () => false);

async function workDir(t, prefix) {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

/* ============================================================================
 * 1. The rule: which setting keeps a spare, and when
 * ============================================================================ */

const spec = (over = {}) => agyWarmSpec({ executablePath: 'C:\\agy\\agy.exe', model: 'gemini-test', effort: 'low', ...over }, over.timeoutMs ?? 600_000);

test('domain/agy-warm-policy: three settings, the middle one by default, and anything else read as the default', () => {
  assert.deepEqual([...AGY_PREWARM_MODES], ['off', 'after-use', 'always']);
  assert.equal(DEFAULT_AGY_PREWARM, 'after-use');
  for (const mode of AGY_PREWARM_MODES) assert.equal(normalizeAgyPrewarm(mode), mode);
  for (const odd of [undefined, null, '', 'ALWAYS', 'on', 1, {}]) assert.equal(normalizeAgyPrewarm(odd), 'after-use');
  assert.deepEqual(withAgyPrewarm({ executablePath: 'x', model: '', effort: '' }, { prewarm: 'always' }), { executablePath: 'x', model: '', effort: '', prewarm: 'always' });
  assert.equal(withAgyPrewarm({ executablePath: 'x' }, undefined).prewarm, 'after-use', 'a config saved before the setting existed gets the default');
  assert.ok(AGY_SPARE_KEEP_MS > 0 && AGY_SPARE_RENEW_MS >= AGY_SPARE_KEEP_MS);
});

test('domain/agy-warm-policy: a settings change is taken only when it names one of the three, and says so when it does not', () => {
  const current = { executablePath: 'x', model: 'm', effort: '', prewarm: 'after-use' };
  assert.equal(patchAgyPrewarm(current, { model: 'other' }), current, 'a change that does not mention the setting leaves it');
  assert.deepEqual(patchAgyPrewarm(current, { prewarm: 'off' }), { ...current, prewarm: 'off' });
  assert.throws(() => patchAgyPrewarm(current, { prewarm: 'sometimes' }), (error) => error.code === 'invalid-prewarm');
  assert.throws(() => patchAgyPrewarm(current, { prewarm: '' }), (error) => error.code === 'invalid-prewarm');
});

test('domain/agy-warm-policy: a spare serves a call with the same program, model and effort whose time limit it can hold', () => {
  const spare = spec();
  assert.equal(canServeAgyCall(spare, spec({ timeoutMs: 90_000 })), true, 'a shorter limit is kept by the runner, not by the flag');
  assert.equal(canServeAgyCall(spare, spec({ timeoutMs: 600_000 })), true);
  assert.equal(canServeAgyCall(spare, spec({ timeoutMs: 900_000 })), false, 'a longer limit than the spare was started with');
  assert.equal(canServeAgyCall(spare, spec({ timeoutMs: 0 })), false, 'no limit at all');
  assert.equal(canServeAgyCall(spec({ timeoutMs: 0 }), spec({ timeoutMs: 0 })), true);
  assert.equal(canServeAgyCall(spare, spec({ effort: 'high' })), false);
  assert.equal(canServeAgyCall(spare, spec({ model: 'other' })), false);
  assert.equal(canServeAgyCall(spare, spec({ executablePath: 'D:\\agy.exe' })), false);
  assert.equal(sameAgySource(spare, spec({ effort: 'high', timeoutMs: 1 })), true, 'the same program and model, whatever the call asked');
  assert.equal(sameAgySource(spare, spec({ model: 'other' })), false);
  assert.deepEqual(agyWarmSpec({ executablePath: ' a ', model: null, effort: undefined }, 5), { executablePath: 'a', model: '', effort: '', timeoutMs: 5 });
});

test('domain/agy-warm-policy: what each setting does at a call, at a settings change and when a spare has waited its limit', () => {
  const s = spec();
  const release = { action: 'release' };
  for (const trigger of ['call', 'config', 'expiry']) assert.deepEqual(agyWarmPlan('off', trigger, s), release, `off never keeps a spare (${trigger})`);

  assert.deepEqual(agyWarmPlan('after-use', 'call', s), { action: 'ensure', spec: s, idleMs: AGY_SPARE_KEEP_MS, strict: true });
  assert.deepEqual(agyWarmPlan('after-use', 'config', s), { action: 'keep' }, 'saving settings neither starts nor stops a spare');
  assert.deepEqual(agyWarmPlan('after-use', 'expiry', s), release, 'unused for the keep time: it exits and gives its memory back');

  assert.deepEqual(agyWarmPlan('always', 'call', s), { action: 'ensure', spec: s, idleMs: AGY_SPARE_RENEW_MS, strict: true });
  assert.deepEqual(agyWarmPlan('always', 'config', s), { action: 'ensure', spec: s, idleMs: AGY_SPARE_RENEW_MS, strict: false });
  assert.deepEqual(agyWarmPlan('always', 'expiry', s), { action: 'ensure', spec: s, idleMs: AGY_SPARE_RENEW_MS, strict: false }, 'an old spare is replaced by a fresh one');
  assert.deepEqual(agyWarmPlan('nonsense', 'call', s).idleMs, AGY_SPARE_KEEP_MS, 'an unknown setting acts as the default');
});

test('domain/agy-warm-policy: the saved settings ask for a spare only while agy is the model in use and its program is known', () => {
  const config = { ...defaultDesktopConfig(), mode: 'agy', reasoningEffort: 'high' };
  config.agy = { executablePath: '', model: 'gemini-test', effort: 'low', prewarm: 'always' };
  const found = agyConfigSpec(config, { executablePath: 'C:\\found\\agy.exe', timeoutMs: 600_000 });
  assert.deepEqual(found, { executablePath: 'C:\\found\\agy.exe', model: 'gemini-test', effort: 'high', timeoutMs: 600_000 }, 'the found program, and the effort calls will ask for');
  assert.equal(agyConfigSpec({ ...config, agy: { ...config.agy, executablePath: 'E:\\own.exe' } }, { executablePath: 'C:\\found\\agy.exe', timeoutMs: 1 }).executablePath, 'E:\\own.exe');
  assert.equal(agyConfigSpec({ ...config, reasoningEffort: '' }, { executablePath: 'x', timeoutMs: 1 }).effort, 'low');

  assert.equal(agyWarmPlanForConfig(config, 'config', found).action, 'ensure');
  assert.deepEqual(agyWarmPlanForConfig({ ...config, mode: 'openai' }, 'config', found), { action: 'release' }, 'another model is in use');
  assert.deepEqual(agyWarmPlanForConfig({ ...config, mode: 'codex' }, 'expiry', found), { action: 'release' });
  assert.deepEqual(agyWarmPlanForConfig(config, 'config', { ...found, executablePath: '' }), { action: 'release' }, 'no program to start');
  assert.deepEqual(agyWarmPlanForConfig(null, 'config', found), { action: 'release' });
});

test('domain/config-policy: the agy section carries the setting through default, load, save and the page view; codex has none', () => {
  assert.equal(defaultDesktopConfig().agy.prewarm, 'after-use');
  assert.equal(Object.hasOwn(defaultDesktopConfig().codex, 'prewarm'), false);
  assert.equal(normalizeDesktopConfig({ agy: { model: 'm' } }).agy.prewarm, 'after-use', 'a config file written before this setting');
  assert.equal(normalizeDesktopConfig({ agy: { prewarm: 'always' } }).agy.prewarm, 'always');
  assert.equal(normalizeDesktopConfig({ agy: { prewarm: 'bogus' } }).agy.prewarm, 'after-use');

  const saved = applyConfigPatch(defaultDesktopConfig(), { mode: 'agy', agy: { prewarm: 'off' } }).config;
  assert.equal(saved.agy.prewarm, 'off');
  assert.equal(applyConfigPatch(saved, { agy: { model: 'gemini-test' } }).config.agy.prewarm, 'off', 'saving the model keeps the setting');
  assert.equal(applyConfigPatch(saved, { codex: { model: 'x', prewarm: 'always' } }).config.codex.prewarm, undefined);
  assert.throws(() => applyConfigPatch(saved, { agy: { prewarm: 'sometimes' } }), (error) => error.code === 'invalid-prewarm');
  assert.equal(redactDesktopConfig(saved).agy.prewarm, 'off');
});

/* ============================================================================
 * 2. The runner: start a process now, ask it later
 * ============================================================================ */

async function writeScripts(dir) {
  const waiter = join(dir, 'waiter.mjs');
  // Says READY, records that it has started, then answers what arrives on stdin once stdin closes.
  await writeFile(waiter, [
    'import { writeFileSync } from "node:fs";',
    'process.stdout.write("READY\\n", () => writeFileSync(process.argv[2], String(process.pid), "utf8"));',
    'const chunks = [];',
    'for await (const c of process.stdin) chunks.push(c);',
    'console.log("GOT:" + Buffer.concat(chunks).toString("utf8").trim());',
  ].join('\n'), 'utf8');
  const hang = join(dir, 'hang.mjs');
  await writeFile(hang, 'import { writeFileSync } from "node:fs";\nwriteFileSync(process.argv[2], String(process.pid), "utf8");\nsetTimeout(() => {}, 60000);\n', 'utf8');
  const quit = join(dir, 'quit.mjs');
  await writeFile(quit, 'process.exit(3);\n', 'utf8');
  return { waiter, hang, quit };
}

test('adapters/cli/process-runner hold(): the process starts at once, waits with no time limit, and answers one turn like run()', async (t) => {
  const dir = await workDir(t, 'studyhub-hold-');
  const { waiter } = await writeScripts(dir);
  const started = join(dir, 'started.pid');

  const held = await holdProcess({ command: waiter, args: [started], cwd: dir });
  const pid = Number(await waitFor(() => fileText(started), { what: 'the held process to start' }));
  assert.equal(pid, held.pid, 'it is running before anything was asked');
  await pause(300);
  assert.ok(pidExists(pid), 'and it keeps waiting');

  const lines = [];
  const result = await held.run({ stdinText: 'hello\n', timeoutMs: 10_000, onStdoutLine: (line) => lines.push(line) });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.match(result.stdout, /READY\r?\nGOT:hello/, 'everything it wrote is in the result');
  assert.deepEqual(lines, ['GOT:hello'], 'the turn hears only what came after it was asked');
  assert.equal(await held.run({ stdinText: 'again\n' }), result, 'a second ask gets the first answer: one process, one turn');
  await held.exited;
  await held.terminate();
});

test('adapters/cli/process-runner hold(): the time limit and the abort signal count from the turn, and terminate() ends an idle process', async (t) => {
  const dir = await workDir(t, 'studyhub-hold-limits-');
  const { hang, quit } = await writeScripts(dir);

  const slowFile = join(dir, 'slow.pid');
  const slow = await holdProcess({ command: hang, args: [slowFile], cwd: dir });
  const slowPid = Number(await waitFor(() => fileText(slowFile), { what: 'the slow process to start' }));
  await pause(700);
  assert.ok(pidExists(slowPid), 'waiting longer than the coming limit does not end it');
  const timed = await slow.run({ stdinText: 'x\n', timeoutMs: 400 });
  assert.equal(timed.timedOut, true);
  assert.ok(timed.durationMs >= 350, `the limit ran from the turn (took ${timed.durationMs} ms)`);

  const abortFile = join(dir, 'abort.pid');
  const cancellable = await holdProcess({ command: hang, args: [abortFile], cwd: dir });
  await waitFor(() => fileText(abortFile), { what: 'the cancellable process to start' });
  const controller = new AbortController();
  const running = cancellable.run({ stdinText: 'x\n', timeoutMs: 30_000, signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancel')), 100);
  assert.equal((await running).aborted, true);

  const idleFile = join(dir, 'idle.pid');
  const idle = await holdProcess({ command: hang, args: [idleFile], cwd: dir });
  const idlePid = Number(await waitFor(() => fileText(idleFile), { what: 'the idle process to start' }));
  await idle.terminate();
  await idle.exited;
  await waitFor(() => !pidExists(idlePid), { what: 'the idle process to be gone' });

  const gone = await holdProcess({ command: quit, cwd: dir });
  await gone.exited;
  const late = await gone.run({ stdinText: 'too late\n', timeoutMs: 5_000 });
  assert.equal(late.code, 3, 'a process that ended while waiting answers with how it ended');
  assert.equal(late.timedOut, false);
  await gone.terminate();

  if (process.platform !== 'win32') return;
  const brokenCmd = join(dir, 'broken.cmd');
  await writeFile(brokenCmd, '@ECHO off\r\n"%_prog%" "%dp0%\\missing-target.js" %*\r\n', 'utf8');
  const broken = await holdProcess({ command: brokenCmd, cwd: dir });
  assert.equal((await broken.run({ stdinText: 'x\n' })).errorCode, 'BROKEN_SHIM');
  await broken.terminate();
});

/* ============================================================================
 * 3. The pool: one spare, used once
 * ============================================================================ */

function fakePool(expiryPlan = () => ({ action: 'release' })) {
  const opened = [];
  const timers = [];
  const pool = createAgyWarmPool({
    open(openSpec) {
      let exit;
      const spare = { spec: openSpec, closed: 0, exited: new Promise((resolve) => { exit = resolve; }), close: async () => { spare.closed += 1; }, run: async () => ({}) };
      spare.exit = exit;
      opened.push(spare);
      return spare;
    },
    planOnExpiry: (expired) => expiryPlan(expired),
    timers: {
      set(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
      clear(timer) { if (timer) timer.cleared = true; },
    },
  });
  return { pool, opened, timers };
}

const callPlan = (mode = 'after-use', over = {}) => agyWarmPlan(mode, 'call', spec(over));

test('adapters/cli/agy-warm-pool: a call takes the waiting spare and a new one starts in its place', () => {
  const { pool, opened, timers } = fakePool();
  assert.equal(pool.claim(spec({ timeoutMs: 90_000 }), callPlan()), null, 'nothing waits before the first call');
  assert.equal(opened.length, 1, 'the first call leaves a spare behind');
  assert.equal(timers[0].ms, AGY_SPARE_KEEP_MS);

  const first = pool.claim(spec({ timeoutMs: 90_000 }), callPlan());
  assert.equal(first, opened[0], 'the next call gets it');
  assert.equal(first.closed, 0, 'the pool does not close what it handed out');
  assert.equal(timers[0].cleared, true, 'and stops counting its idle time');
  assert.equal(opened.length, 2, 'while its replacement starts');

  const second = pool.claim(spec(), callPlan());
  assert.equal(second, opened[1]);
  assert.notEqual(second, first, 'no spare answers twice');
});

test('adapters/cli/agy-warm-pool: a spare that does not fit the call is not handed out', () => {
  const { pool, opened } = fakePool();
  pool.claim(spec(), callPlan());
  assert.equal(pool.claim(spec({ effort: 'high' }), callPlan('after-use', { effort: 'high' })), null, 'another effort: this call starts fresh');
  assert.equal(opened[0].closed, 1, 'the spare for the old effort is closed');
  assert.equal(opened[1].spec.effort, 'high', 'and one for the effort calls now ask for takes its place');

  assert.equal(pool.claim(spec({ effort: 'high', timeoutMs: 0 }), callPlan('after-use', { effort: 'high' })), null, 'a call with no time limit starts fresh');
  assert.equal(opened.length, 2, 'the spare stays for the calls it can serve');
  assert.equal(opened[1].closed, 0);
});

test('adapters/cli/agy-warm-pool: off releases, a settings change keeps a spare of the same program and model, another model replaces it', () => {
  const { pool, opened } = fakePool();
  pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(opened.length, 1, 'always: a spare starts without any call');
  pool.apply(agyWarmPlan('always', 'config', spec({ effort: 'high' })));
  assert.equal(opened.length, 1, 'only the effort differs: the spare stays');
  pool.apply(agyWarmPlan('after-use', 'config', spec()));
  assert.equal(opened[0].closed, 0, 'keep leaves it');
  pool.apply(agyWarmPlan('always', 'config', spec({ model: 'other' })));
  assert.equal(opened[0].closed, 1, 'another model: replaced');
  assert.equal(opened[1].spec.model, 'other');
  pool.apply(agyWarmPlan('off', 'config', spec()));
  assert.equal(opened[1].closed, 1);
  assert.equal(pool.claim(spec({ model: 'other' }), agyWarmPlan('off', 'call', spec({ model: 'other' }))), null);
  assert.equal(opened.length, 2, 'off starts nothing');
});

test('adapters/cli/agy-warm-pool: a spare that waited its limit is released or renewed, as the settings say at that moment', () => {
  let mode = 'after-use';
  const { pool, opened, timers } = fakePool((expired) => agyWarmPlan(mode, 'expiry', expired));
  pool.claim(spec(), callPlan());
  timers[0].fn();
  assert.equal(opened[0].closed, 1, 'after-use: it is closed');
  assert.equal(opened.length, 1, 'and not replaced');

  mode = 'always';
  pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(timers[1].ms, AGY_SPARE_RENEW_MS);
  timers[1].fn();
  assert.equal(opened[1].closed, 1, 'always: the old one is closed');
  assert.equal(opened.length, 3, 'and a fresh one waits');

  mode = 'off';
  timers[2].fn();
  assert.equal(opened[2].closed, 1, 'the setting was turned off meanwhile: nothing is renewed');
  assert.equal(opened.length, 3);

  mode = 'always';
  const { pool: other, opened: otherOpened, timers: otherTimers } = fakePool((expired) => agyWarmPlan(mode, 'expiry', expired));
  other.claim(spec(), callPlan('always'));
  const taken = other.claim(spec(), callPlan('always'));
  otherTimers[0].fn();
  assert.equal(taken.closed, 0, 'the timer of a spare that was handed out does nothing');
  assert.equal(otherOpened.length, 2);
});

test('adapters/cli/agy-warm-pool: after a spare dies on its own or a call fails, nothing is pre-warmed until the next call', async () => {
  const { pool, opened } = fakePool();
  pool.apply(agyWarmPlan('always', 'config', spec()));
  opened[0].exit();
  await pause(0);
  assert.equal(opened[0].closed, 1, 'its folder is cleaned up');
  pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(opened.length, 1, 'a broken agy is not restarted on every settings read');
  assert.equal(pool.claim(spec(), callPlan('always')), null);
  assert.equal(opened.length, 2, 'the next call tries again');

  pool.fault();
  assert.equal(opened[1].closed, 1, 'a failed call closes the spare: it may share the cause');
  pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(opened.length, 2);
  pool.claim(spec(), callPlan('always'));
  assert.equal(opened.length, 3);
});

test('adapters/cli/agy-warm-pool: dispose closes the spare and nothing starts afterwards', async () => {
  const { pool, opened } = fakePool();
  pool.claim(spec(), callPlan('always'));
  await pool.dispose();
  assert.equal(opened[0].closed, 1);
  assert.equal(pool.claim(spec(), callPlan('always')), null);
  pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(opened.length, 1);
  await pool.dispose();
});

test('adapters/cli/agy-warm-pool: reading the settings again does not restart the spare\'s clock', () => {
  const { pool, opened, timers } = fakePool((expired) => agyWarmPlan('always', 'expiry', expired));
  pool.apply(agyWarmPlan('always', 'config', spec()));
  for (let read = 0; read < 5; read += 1) pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(timers.length, 1, 'the page reads the backend all the time: the renewal still comes 30 minutes after the start');
  assert.equal(opened.length, 1);

  pool.claim(spec({ timeoutMs: 0 }), callPlan('always'));
  assert.equal(timers.length, 2, 'a call that leaves it waiting is a use: its clock starts again');

  const later = fakePool();
  later.pool.claim(spec(), callPlan('after-use'));
  later.pool.apply(agyWarmPlan('always', 'config', spec()));
  assert.equal(later.timers.at(-1).ms, AGY_SPARE_RENEW_MS, 'a changed setting changes how long it may wait');
  assert.equal(later.timers[0].cleared, true);
});

test('application/complete-port: the connection test asks for a fresh start, ordinary calls do not', async () => {
  const built = [];
  const config = { ...defaultDesktopConfig(), mode: 'agy' };
  const port = createDesktopCompletePort({
    getConfig: () => config,
    getAgyExecutablePath: () => 'C:\\agy.exe',
    openaiComplete: () => undefined,
    agyComplete: (section, options) => { built.push(options); return async () => 'OK'; },
  });
  assert.equal((await port.testConnection(null, 'zh')).ok, true);
  assert.equal(built.at(-1).fresh, true, 'a spare started earlier would not show whether agy can start and sign in now');
  await port.makeComplete()('s', 'p');
  assert.notEqual(built.at(-1).fresh, true);
});

/* ============================================================================
 * 4. The adapter: a spare answers when one is ready, a fresh start otherwise
 * ============================================================================ */

const okLine = (text) => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: text } });
const stepLine = (text) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: text } });
const runResult = (over = {}) => ({ code: 0, signal: null, stdout: '', stderr: '', timedOut: false, aborted: false, truncated: false, errorCode: null, errorMessage: null, durationMs: 1, ...over });

function fakeWarm(spare = null) {
  const calls = { claims: [], faults: 0 };
  return {
    calls,
    claim(callSpec, plan) { calls.claims.push({ callSpec, plan }); return spare; },
    fault() { calls.faults += 1; },
  };
}

function fakeSpare(lines, over = {}) {
  const spare = {
    turns: [],
    async run(turn) {
      spare.turns.push(turn);
      for (const line of lines) turn.onStdoutLine?.(line);
      return runResult({ stdout: lines.join('\n'), ...over });
    },
  };
  return spare;
}

function coldRunner(stdout = okLine('COLD')) {
  const runs = [];
  return { runs, run: async (request) => { runs.push(request); return runResult({ stdout }); } };
}

const agyConfig = (over = {}) => ({ executablePath: 'fake-agy', model: 'gemini-test', effort: 'low', prewarm: 'after-use', ...over });

test('adapters/cli/agy-adapter: with a spare ready the call goes to it and no fresh process starts', async () => {
  const spare = fakeSpare([JSON.stringify({ event: 'init' }), stepLine('WARM '), stepLine('ANSWER'), okLine('WARM ANSWER')]);
  const warm = fakeWarm(spare);
  const runner = coldRunner();
  const complete = createAgyCompleteAdapter(agyConfig(), { runner, warm, report: null, timeoutMs: 90_000 });
  const chunks = [];
  const controller = new AbortController();
  assert.equal(await complete('System', 'Question', { onOutput: (chunk) => chunks.push(chunk), signal: controller.signal }), 'WARM ANSWER');
  assert.equal(runner.runs.length, 0);
  assert.deepEqual(chunks, ['WARM ', 'ANSWER'], 'the answer streams as it does from a fresh start');

  const [{ callSpec, plan }] = warm.calls.claims;
  assert.deepEqual(callSpec, { executablePath: 'fake-agy', model: 'gemini-test', effort: 'low', timeoutMs: 90_000 }, 'the call says what it needs');
  assert.equal(plan.action, 'ensure');
  assert.equal(plan.spec.timeoutMs, AGY_SPARE_TIMEOUT_MS, 'the next spare is started with the longest limit a call asks for');
  const [turn] = spare.turns;
  assert.equal(turn.timeoutMs, 90_000, 'the runner keeps this call\'s own limit');
  assert.equal(turn.signal, controller.signal);
  assert.match(turn.stdinText, /Question/);
  assert.equal(warm.calls.faults, 0);
});

test('adapters/cli/agy-adapter: the setting decides the plan, and without a pool nothing changes', async () => {
  const offWarm = fakeWarm(null);
  const runner = coldRunner();
  assert.equal(await createAgyCompleteAdapter(agyConfig({ prewarm: 'off' }), { runner, warm: offWarm, report: null })('S', 'P'), 'COLD');
  assert.deepEqual(offWarm.calls.claims[0].plan, { action: 'release' });
  const alwaysWarm = fakeWarm(null);
  await createAgyCompleteAdapter(agyConfig({ prewarm: 'always', effort: '' }), { runner, warm: alwaysWarm, report: null })('S', 'P', { reasoningEffort: 'high' });
  assert.equal(alwaysWarm.calls.claims[0].plan.idleMs, AGY_SPARE_RENEW_MS);
  assert.equal(alwaysWarm.calls.claims[0].callSpec.effort, 'high', 'the effort of this call, not the saved one');
  assert.equal(await createAgyCompleteAdapter(agyConfig(), { runner, report: null })('S', 'P'), 'COLD', 'no pool: every call starts fresh, as before');
  assert.equal(runner.runs.length, 3);
});

test('adapters/cli/agy-adapter: a spare that ended before the model said anything hands the call to a fresh start', async () => {
  for (const dead of [fakeSpare([], { code: 1 }), fakeSpare([JSON.stringify({ event: 'init' })], { code: 0 }), fakeSpare([], { code: null, errorCode: 'ENOENT' })]) {
    const warm = fakeWarm(dead);
    const runner = coldRunner();
    assert.equal(await createAgyCompleteAdapter(agyConfig(), { runner, warm, report: null })('S', 'P'), 'COLD');
    assert.equal(runner.runs.length, 1, 'the user gets an answer, a few seconds later');
    assert.equal(warm.calls.faults, 0, 'the fresh start worked: nothing is wrong with agy');
  }
});

test('adapters/cli/agy-adapter: once the model has answered or the call was cut off, there is no second call', async () => {
  const cases = [
    { spare: fakeSpare([stepLine('partial')], { code: 1, stderr: 'boom' }), faults: 1, what: 'failed after the model started answering' },
    { spare: fakeSpare([JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota' } })], { code: 1 }), faults: 1, what: 'agy itself reported an error' },
    { spare: fakeSpare([], { code: null, timedOut: true }), faults: 1, what: 'ran out of time' },
  ];
  for (const { spare, faults, what } of cases) {
    const warm = fakeWarm(spare);
    const runner = coldRunner();
    await assert.rejects(() => createAgyCompleteAdapter(agyConfig(), { runner, warm, report: null })('S', 'P'), undefined, what);
    assert.equal(runner.runs.length, 0, `${what}: the model is not asked twice`);
    assert.equal(warm.calls.faults, faults, `${what}: the next call starts fresh`);
  }

  const controller = new AbortController();
  controller.abort(new Error('stopped by the user'));
  const warm = fakeWarm(fakeSpare([], { code: null, aborted: true }));
  const runner = coldRunner();
  await assert.rejects(() => createAgyCompleteAdapter(agyConfig(), { runner, warm, report: null })('S', 'P', { signal: controller.signal }), /stopped by the user/);
  assert.equal(runner.runs.length, 0);
  assert.equal(warm.calls.faults, 0, 'stopping a call says nothing about agy: the spare for the next call stays');

  const failing = { run: async () => runResult({ code: 1, stderr: 'not signed in' }) };
  const coldWarm = fakeWarm(null);
  await assert.rejects(() => createAgyCompleteAdapter(agyConfig(), { runner: failing, warm: coldWarm, report: null })('S', 'P'));
  assert.equal(coldWarm.calls.faults, 1, 'a failed fresh start also closes the spare that was just started');
});

/* ============================================================================
 * 5. End to end with real processes: a stand-in agy that says which process answered and how many questions it was sent
 * ============================================================================ */

async function writeFakeAgy(dir, log) {
  const script = join(dir, 'fake-agy.mjs');
  await writeFile(script, [
    'import { appendFileSync } from "node:fs";',
    'const argv = process.argv.slice(2);',
    'if (argv[0] === "--version") { console.log("1.5.18"); process.exit(0); }',
    'if (argv[0] === "models") { console.log("gemini-test\\tGemini Test"); process.exit(0); }',
    `const log = (entry) => appendFileSync(${JSON.stringify(log)}, JSON.stringify({ pid: process.pid, ...entry }) + "\\n", "utf8");`,
    'log({ at: "start", cwd: process.cwd(), args: process.argv.slice(2) });',
    'console.log(JSON.stringify({ event: "init", conversation_id: "c-" + process.pid }));',
    'const chunks = [];',
    'for await (const c of process.stdin) chunks.push(c);',
    'const asked = Buffer.concat(chunks).toString("utf8").split("\\n").filter(Boolean);',
    'log({ at: "asked", count: asked.length });',
    'if (!asked.length) process.exit(0);',
    'console.log(JSON.stringify({ event: "step_update", step_update: { step_type: "agent_response", text_delta: "pid " } }));',
    'console.log(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: `pid ${process.pid} asked ${asked.length}` } }));',
  ].join('\n'), 'utf8');
  return script;
}

const readLog = async (log) => (await fileText(log)).split('\n').filter(Boolean).map((line) => JSON.parse(line));
const startsIn = async (log) => (await readLog(log)).filter((entry) => entry.at === 'start');

test('pre-warm end to end: each call is answered by a process that was already waiting, asked once, and cleaned up', async (t) => {
  const dir = await workDir(t, 'studyhub-agy-warm-');
  const log = join(dir, 'agy.log');
  const fakeAgy = await writeFakeAgy(dir, log);
  const runner = createProcessRunner();
  const config = { ...defaultDesktopConfig(), mode: 'agy', agy: { executablePath: fakeAgy, model: 'gemini-test', effort: 'low', prewarm: 'always' } };
  let current = config;
  const warm = createAgyWarm({ runner, getConfig: () => current, findExecutablePath: () => '' });
  t.after(() => warm.dispose());

  warm.sync();
  const [first] = await waitFor(async () => { const starts = await startsIn(log); return starts.length === 1 ? starts : null; }, { what: 'the first spare to start' });
  assert.ok(first.cwd.includes('studyhub-agy-'), 'a spare waits in its own empty folder');
  assert.deepEqual(first.args.slice(0, 5), ['--input-format', 'stream-json', '--output-format', 'stream-json', '--disable-slash-commands']);
  assert.ok(first.args.includes('gemini-test') && first.args.includes('low'));
  warm.sync();
  await pause(150);
  assert.equal((await startsIn(log)).length, 1, 'reading the settings again starts nothing more');

  const complete = () => createAgyCompleteAdapter(current.agy, { runner, warm: warm.pool, report: null, timeoutMs: 20_000 });
  const answerOne = await complete()('System', 'One', {});
  assert.equal(answerOne, `pid ${first.pid} asked 1`, 'the waiting process answered, and it was asked exactly one question');
  const starts = await waitFor(async () => { const all = await startsIn(log); return all.length === 2 ? all : null; }, { what: 'the replacement to start' });
  await waitFor(async () => !(await exists(first.cwd)), { what: 'the used spare\'s folder to be removed' });

  const answerTwo = await complete()('System', 'Two', {});
  assert.equal(answerTwo, `pid ${starts[1].pid} asked 1`, 'the next call gets the replacement, not the same conversation');

  // Turning the setting off stops the spare that is waiting; later calls start fresh and leave nothing behind.
  const third = (await waitFor(async () => { const all = await startsIn(log); return all.length === 3 ? all : null; }, { what: 'the third spare to start' }))[2];
  current = { ...config, agy: { ...config.agy, prewarm: 'off' } };
  warm.sync();
  await waitFor(() => !pidExists(third.pid), { what: 'the spare to stop when the setting is turned off' });
  await waitFor(async () => !(await exists(third.cwd)), { what: 'its folder to be removed' });
  const answerThree = await complete()('System', 'Three', {});
  const all = await startsIn(log);
  assert.equal(all.length, 4, 'off: one fresh process for the call and no spare');
  assert.equal(answerThree, `pid ${all[3].pid} asked 1`);

  // Back on: dispose (the app closing) stops the spare.
  current = config;
  warm.sync();
  const last = (await waitFor(async () => { const again = await startsIn(log); return again.length === 5 ? again : null; }, { what: 'a spare after turning it back on' }))[4];
  await warm.dispose();
  await waitFor(() => !pidExists(last.pid), { what: 'the spare to stop when the app closes' });
  assert.equal(await exists(last.cwd), false);
  const neverAsked = (await readLog(log)).filter((entry) => entry.at === 'asked' && entry.count > 1);
  assert.deepEqual(neverAsked, [], 'no process was ever sent a second question');
});

test('pre-warm end to end: openAgySpare reports a program that cannot start as a failed turn, not an exception', async (t) => {
  const dir = await workDir(t, 'studyhub-agy-missing-');
  const spare = openAgySpare(createProcessRunner(), spec({ executablePath: join(dir, 'no-such-agy.exe') }));
  await spare.exited;
  const result = await spare.run({ stdinText: 'x\n', timeoutMs: 5_000 });
  assert.notEqual(result.code, 0);
  assert.ok(result.errorCode, 'the runner says why it could not start');
  await spare.close();
});

test('pre-warm in the running desktop backend: starts with the setting, leaves the connection test alone, stops with the setting and on exit', async (t) => {
  const dir = await workDir(t, 'studyhub-agy-sidecar-');
  const log = join(dir, 'agy.log');
  const fakeAgy = await writeFakeAgy(dir, log);
  const dshHome = await workDir(t, 'studyhub-agy-home-');
  const library = await workDir(t, 'studyhub-agy-lib-');
  const token = 'prewarm-test-token-0123456789';
  const sidecar = await composeDesktopSidecar({ token, env: { ...process.env, DSH_HOME: dshHome, STUDYHUB_LIBRARY: library } });
  t.after(() => sidecar.shutdown());
  const call = async (action, args) => {
    const response = await fetch(`${sidecar.baseUrl}/api/call`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-study-token': token },
      body: JSON.stringify({ action, args }),
    });
    const answer = await response.json();
    assert.equal(answer.ok, true, `${action}: ${answer.error || ''}`);
    return answer.value;
  };
  const startsAfter = (count) => waitFor(async () => { const all = await startsIn(log); return all.length === count ? all : null; }, { timeoutMs: 20_000, what: `${count} agy starts` });

  assert.deepEqual(await startsIn(log), [], 'agy is not the model in use yet');
  const saved = await call('desktop.config.save', { mode: 'agy', agy: { executablePath: fakeAgy, model: 'gemini-test', prewarm: 'always' } });
  assert.equal(saved.agy.prewarm, 'always');
  const [spare] = await startsAfter(1);
  for (let read = 0; read < 3; read += 1) await call('desktop.config.get', {});

  const tested = await call('desktop.config.test', { mode: 'agy', agy: { executablePath: fakeAgy, model: 'gemini-test', effort: '' } });
  assert.equal(tested.ok, true, tested.message);
  const afterTest = await startsAfter(2);
  assert.doesNotMatch(tested.message, new RegExp(`pid ${spare.pid}\\b`), 'the test started its own agy');
  assert.match(tested.message, new RegExp(`pid ${afterTest[1].pid}\\b`));
  assert.ok(pidExists(spare.pid), 'and the spare is still waiting for a real call');

  await call('desktop.config.save', { agy: { prewarm: 'off' } });
  await waitFor(() => !pidExists(spare.pid), { what: 'the spare to stop when pre-warm is turned off' });
  assert.equal((await startsIn(log)).length, 2, 'off starts nothing');

  await call('desktop.config.save', { agy: { prewarm: 'always' } });
  const again = (await startsAfter(3))[2];
  await sidecar.shutdown();
  await waitFor(() => !pidExists(again.pid), { what: 'the spare to stop when the backend shuts down' });
  await waitFor(async () => !(await exists(again.cwd)), { what: 'its folder to be removed' });
});
