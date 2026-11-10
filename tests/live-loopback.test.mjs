import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  LIVE_LOOPBACK,
  createLiveLoopbackInstaller,
  effectiveLiveLoopback,
  findWindowsCsc,
  liveLoopbackLayout,
  probeLoopbackHelper,
} from '../lib/live-loopback-install.js';
import { LIVE_LOOPBACK_JOB_TEXT, LIVE_LOOPBACK_MESSAGES, LIVE_LOOPBACK_STAGE_NAMES } from '../lib/live-loopback-install-text.js';
import { LIVE_LOOPBACK_CS_SOURCE } from '../lib/live-loopback-source.js';
import { createSystemAudioCapture, loopbackInUse, loopbackProcessRunning } from '../lib/live-loopback.js';
import { localizeAppMessage } from '../lib/application-messages.js';
import { assistantArgsRefusal, assistantRefusal } from '../lib/assistant-boundary.js';
import { writesFor } from '../lib/runtime/domain-contracts.js';
import { listSaved } from '../lib/live.js';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';

const FAKE_ENGINE = fileURLToPath(new URL('./fixtures/live-local/fake-sherpa.cjs', import.meta.url));
const han = /[\u3400-\u9fff]/;

const loudPcm = seconds => {
  const samples = Math.round(seconds * 16000);
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) buffer.writeInt16LE(i % 32 < 16 ? 7000 : -7000, i * 2);
  return buffer;
};

/** Wait until the install run is over (any status but running, within the time limit) and say how it ended when it did not complete (issue #920). */
async function installEnded(service, { timeoutMs = 20000 } = {}) {
  const until = Date.now() + timeoutMs;
  let seen = await service.call('live.loopback.status', {});
  while (seen.status === 'running') {
    assert.ok(Date.now() < until, `the install was still running after ${timeoutMs} ms (stage ${seen.stage})`);
    await new Promise(resolve => setTimeout(resolve, 20));
    seen = await service.call('live.loopback.status', {});
  }
  assert.equal(seen.status, 'complete', `the install ended as ${seen.status} (stage ${seen.stage}, error ${JSON.stringify(seen.error)}), log ${JSON.stringify(seen.log)}`);
  return seen;
}

function makeFakeHelperSpawn({ noDevice = false, crashCode = null, stateErrorOnSpawn = 0 } = {}) {
  const children = [];
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.pid = 40000 + children.length + 1;
    child.exitCode = null;
    child.killed = false;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    const closeWith = code => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    };
    child.kill = () => { child.killed = true; closeWith(0); };
    child.stdin.on('finish', () => setImmediate(() => closeWith(0)));
    setImmediate(() => {
      if (noDevice) {
        child.stderr.write('STATE:{"error":"no-device"}\n');
        closeWith(2);
        return;
      }
      const ready = 'STATE:{"ready":true,"label":"Speakers (Realtek Audio)","muted":false}\n';
      child.stderr.write(ready + (children.length === stateErrorOnSpawn ? 'STATE:{"error":"init-resume-failed"}\n' : ''));
      if (crashCode !== null) setImmediate(() => closeWith(crashCode));
    });
    child.pushPcm = buf => child.stdout.write(buf);
    child.exitWith = closeWith;
    children.push(child);
    return child;
  };
  return { spawnImpl, children };
}

test('system capture reports runtime failures once, pauses, and can resume with a fresh helper', async t => {
  for (const failure of ['no-device', 'init-0x88890008', 'exit', 'error']) {
    await t.test(failure, async () => {
      const helper = makeFakeHelperSpawn();
      const errors = [];
      const capture = createSystemAudioCapture({ resolveHelper: async () => ({ exePath: 'fake' }),
        spawnImpl: helper.spawnImpl, onPcm: () => true, onUnexpectedError: message => errors.push(message) });
      try {
        await capture.start();
        const child = helper.children[0];
        child.pushPcm(loudPcm(1));
        if (failure === 'exit') child.exitWith(4);
        else if (failure === 'error') child.emit('error', new Error('capture pipe failed'));
        else child.stderr.write(`STATE:${JSON.stringify({ error: failure })}\n`);
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(errors.length, 1, 'a failure after ready must reach the session exactly once');
        assert.equal(capture.snapshot().phase, 'paused');
        assert.equal(capture.snapshot().capturedMs, 1000);
        assert.ok(capture.snapshot().error);
        if (failure.startsWith('init-')) assert.match(errors[0], /init-0x88890008/);
        await capture.resume();
        assert.equal(helper.children.length, 2);
        assert.equal(capture.snapshot().phase, 'running');
        assert.equal(capture.snapshot().error, undefined);
        await capture.pause();
        assert.equal(errors.length, 1, 'an intentional pause is not another failure');
      } finally { await capture.stop(); }
    });
  }
});

async function withHome(t) {
  const dir = await mkdtemp(join(tmpdir(), 'study-live-loopback-'));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = join(dir, 'dsh-home');
  const services = [];
  t.after(async () => {
    for (const service of services) {
      for (const item of await listSaved(service.store.root)) {
        const session = service.runtime.liveSessions.registered(service.store.root, item.id);
        if (session?.active) await session.stop();
        await session?.retirePersistence();
        service.runtime.liveSessions.unregister(service.store.root, item.id);
      }
      await service.dispose?.();
    }
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  return { dir, track: service => { services.push(service); return service; } };
}

test('hot-installer lifecycle: plan, local compile, sha256 tamper detection, repair, and clean uninstall', async t => {
  const { dir } = await withHome(t);
  const target = join(dir, 'LoopbackTarget');
  let liveBusy = false;
  const seams = {
    osPlatform: 'win32',
    arch: 'x64',
    cscPath: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    drives: async () => [{ root: 'D:\\', freeMb: 50_000, totalMb: 200_000, system: false }],
    freeMegabytes: async () => 50_000,
    liveRunning: () => liveBusy,
    async compile({ csFile, outExe }) {
      const source = await readFile(csFile, 'utf8');
      assert.ok(source.includes('StudyHub.LiveLoopback'), 'source written with UTF-8 BOM for csc.exe');
      await writeFile(outExe, Buffer.from('MZ-fake-studyhub-loopback-binary'));
      return { code: 0, stdout: '', stderr: '' };
    },
    probeHelper: async () => ({ ok: true, device: 'Speakers (Realtek Audio)' }),
  };
  const installer = createLiveLoopbackInstaller(seams);

  // Unsupported platforms and missing compilers are reported honestly in plan().
  const macPlan = await createLiveLoopbackInstaller({ ...seams, osPlatform: 'darwin' }).plan({ location: target });
  assert.equal(macPlan.ok, false);
  assert.equal(macPlan.problems[0]?.code, 'unsupported');
  const noCscPlan = await createLiveLoopbackInstaller({ ...seams, cscPath: null }).plan({ location: target });
  assert.equal(noCscPlan.ok, false);
  assert.equal(noCscPlan.problems[0]?.code, 'no-compiler');

  const plan = await installer.plan({ location: target });
  assert.equal(plan.ok, true);
  assert.equal(plan.estimate.downloadMb, 0);
  assert.equal(plan.estimate.diskMb, 1);

  await assert.rejects(installer.start({ location: target }), { code: 'need-confirm' });
  await installer.start({ confirm: true, location: target });
  await installer.idle();

  const installed = await installer.status();
  assert.equal(installed.status, 'complete');
  assert.equal(installed.ready, true);
  assert.equal(installed.needsRepair, false);
  const resolved = await effectiveLiveLoopback({ seams });
  assert.ok(resolved?.exePath.endsWith(LIVE_LOOPBACK.exeName));

  // Altering a single byte invalidates the pinned SHA-256 so the altered binary is never executed.
  const layout = liveLoopbackLayout(installed.installedFolder);
  await writeFile(layout.exePath, Buffer.from('MZ-tampered-binary!!'));
  assert.equal(await effectiveLiveLoopback({ seams }), null);
  const broken = await installer.status();
  assert.equal(broken.ready, false);
  assert.equal(broken.needsRepair, true);

  // Repair rebuilds and re-pins the SHA-256.
  await installer.start({ confirm: true, location: installed.folder });
  await installer.idle();
  assert.equal((await installer.status()).ready, true);

  // Uninstall is blocked while a live session is capturing system audio.
  liveBusy = true;
  await assert.rejects(installer.uninstall({ confirm: true }), { code: 'live-running' });
  liveBusy = false;

  const removed = await installer.uninstall({ confirm: true });
  assert.ok(removed.removed >= 1);
  assert.equal(await effectiveLiveLoopback({ seams }), null);
});

test('probeLoopbackHelper tolerates loader banners and non-JSON output, and compile classifies permissions and long paths', async t => {
  const { dir } = await withHome(t);
  if (process.platform !== 'win32') {
    const bannerScript = join(dir, 'banner-probe.sh');
    await writeFile(bannerScript, '#!/bin/sh\nprintf "CLR host warning: profile loaded\\n{\\"ok\\":true,\\"device\\":\\"USB DAC\\"}\\n"\n');
    await chmod(bannerScript, 0o755);
    assert.deepEqual(await probeLoopbackHelper({ exePath: bannerScript }), { ok: true, device: 'USB DAC' });

    const brokenJsonScript = join(dir, 'broken-json-probe.sh');
    await writeFile(brokenJsonScript, '#!/bin/sh\nprintf "{not-json\\n"\n');
    await chmod(brokenJsonScript, 0o755);
    await assert.rejects(
      probeLoopbackHelper({ exePath: brokenJsonScript }),
      err => !(err instanceof SyntaxError) && /not-json|invalid probe output/.test(err.message),
    );
  }

  const baseSeams = {
    osPlatform: 'win32',
    arch: 'x64',
    cscPath: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    drives: async () => [{ root: 'D:\\', freeMb: 50_000, totalMb: 200_000, system: false }],
    freeMegabytes: async () => 50_000,
    probeHelper: async () => ({ ok: true }),
  };
  for (const [expectedCode, expectedMessage, stderr] of [
    ['not-writable', LIVE_LOOPBACK_MESSAGES.notWritable, 'error CS0016: Access to the path \'D:\\Locked\\helper.exe\' is denied.'],
    ['path-too-long', LIVE_LOOPBACK_MESSAGES.pathTooLong, 'ENAMETOOLONG: name too long, open \'D:\\very-long\\helper.exe\''],
  ]) {
    const inst = createLiveLoopbackInstaller({ ...baseSeams, compile: async () => ({ code: 1, stdout: '', stderr }) });
    await inst.start({ confirm: true, location: join(dir, expectedCode) });
    await inst.idle();
    const view = await inst.status();
    assert.equal(view.status, 'failed');
    assert.equal(view.error?.code, expectedCode);
    assert.equal(view.error?.message, expectedMessage);
  }
});

test('all backend loopback messages and stage names localize cleanly into English', () => {
  const samples = [
    ...Object.values(LIVE_LOOPBACK_STAGE_NAMES),
    ...Object.values(LIVE_LOOPBACK_MESSAGES).filter(value => typeof value === 'string'),
    LIVE_LOOPBACK_MESSAGES.noSpace('D:', '2 MB', '5 MB'),
    LIVE_LOOPBACK_JOB_TEXT.title,
    LIVE_LOOPBACK_JOB_TEXT.stage(1, LIVE_LOOPBACK_STAGE_NAMES.compile),
    LIVE_LOOPBACK_JOB_TEXT.stage(2, LIVE_LOOPBACK_STAGE_NAMES.check),
    LIVE_LOOPBACK_JOB_TEXT.done,
    LIVE_LOOPBACK_JOB_TEXT.cancelled,
    LIVE_LOOPBACK_JOB_TEXT.failed,
    'audioSource 只能是 system',
    '电脑声音采音组件意外退出（代码 1）',
  ];
  for (const message of samples) {
    const en = localizeAppMessage(message, 'en');
    assert.doesNotMatch(en, han, `${message} -> ${en}`);
  }
});

test('assistant boundary and domain contracts protect live.loopback.* and live.start audioSource', () => {
  assert.match(assistantRefusal('live.loopback.install'), /installs or removes software/);
  assert.match(assistantRefusal('live.loopback.uninstall'), /installs or removes software/);
  assert.equal(assistantRefusal('live.loopback.status'), null);
  assert.match(assistantArgsRefusal('live.start', { audioSource: 'system' }), /audioSource.*not available to the assistant/);
  assert.equal(assistantArgsRefusal('live.start', { title: 'Algorithms' }), null);
  for (const op of ['status', 'plan', 'install', 'cancel', 'uninstall']) {
    assert.deepEqual(writesFor('audio', `live.loopback.${op}`), []);
  }
});

test('system-audio session lifecycle: zero helper process while paused or stopped, cross-library uninstall guard, and live inputAudio metrics', async t => {
  const { dir, track } = await withHome(t);
  const modelDir = join(dir, 'model');
  await mkdir(modelDir, { recursive: true });
  for (const name of ['model.int8.onnx', 'tokens.txt', 'silero_vad.onnx']) await writeFile(join(modelDir, name), 'fake');

  // Install helper once into the shared DSH_HOME via library A.
  const installTarget = join(dir, 'SharedLoopback');
  const fakeInstall = {
    osPlatform: 'win32',
    arch: 'x64',
    cscPath: 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe',
    drives: async () => [{ root: 'D:\\', freeMb: 50_000, totalMb: 200_000, system: false }],
    freeMegabytes: async () => 50_000,
    async compile({ outExe }) { await writeFile(outExe, Buffer.from('MZ-shared-loopback')); return { code: 0 }; },
    probeHelper: async () => ({ ok: true, device: 'Headphones' }),
  };
  const { spawnImpl, children } = makeFakeHelperSpawn({ stateErrorOnSpawn: 2 });
  const makeService = name => track(new StudyService(join(dir, name), {
    liveLocal: { engine: { enginePath: FAKE_ENGINE, modelDir } },
    liveLoopback: { install: fakeInstall, spawn: spawnImpl },
  }));

  const libA = makeService('lib-a');
  const libB = makeService('lib-b');

  // Before installation, audio.preflight reports supported=true, ready=false, and live.start with system audio asks to install first.
  const preBefore = await libA.call('audio.preflight', {});
  assert.deepEqual(preBefore.liveLoopback, { supported: true, ready: false });
  await assert.rejects(libA.call('live.start', { audioSource: 'system' }), { message: LIVE_LOOPBACK_MESSAGES.needsInstall });

  await libA.call('live.loopback.install', { confirm: true, location: installTarget });
  const finished = await installEnded(libA);
  assert.deepEqual((await libA.call('audio.preflight', {})).liveLoopback, { supported: true, ready: true }, `after the install ended: ${JSON.stringify({ ...finished, log: undefined })}`);
  assert.equal(loopbackProcessRunning(), false, 'zero helper process when idle after install');
  assert.equal(loopbackInUse(), false);

  // Start capturing system audio in library A.
  const started = await libA.call('live.start', { title: 'OS Lecture', audioSource: 'system' });
  assert.equal(started.audioSource, 'system');
  assert.equal(children.length, 1);
  assert.equal(loopbackProcessRunning(), true);
  assert.equal(loopbackInUse(), true);
  assert.equal(started.inputAudio?.label, 'Speakers (Realtek Audio)');

  // Library B cannot uninstall the shared helper while Library A has it open.
  await assert.rejects(libB.call('live.loopback.uninstall', { confirm: true }), { code: 'live-running' });

  // Stream 0.5 s of 16 kHz PCM from the helper and verify inputAudio metrics on live.poll.
  children[0].pushPcm(loudPcm(0.5));
  const polled = await libA.call('live.poll', { id: started.id });
  assert.equal(polled.inputAudio?.phase, 'running');
  assert.equal(polled.inputAudio?.capturedMs, 500);
  assert.equal(polled.inputAudio?.acceptedMs, 500);
  assert.ok(polled.inputAudio?.level > 40);

  children[0].stderr.write('STATE:{"error":"init-0x88890008"}\n');
  await new Promise(resolve => setImmediate(resolve));
  const failed = await libA.call('live.poll', { id: started.id });
  assert.equal(failed.status, 'paused', 'a dead capture cannot leave the class live');
  assert.equal(failed.inputAudio.phase, 'paused');
  assert.match(failed.message, /init-0x88890008/);

  // Pausing exits the helper process immediately so zero WASAPI handles remain open while paused!
  const paused = await libA.call('live.pause', { id: started.id });
  assert.equal(paused.status, 'paused');
  assert.equal(children[0].exitCode, 0, 'helper exited on pause');
  assert.equal(loopbackProcessRunning(), false, 'zero active loopback processes while paused');
  assert.equal(loopbackInUse(), true, 'session still holds logical reservation against uninstall');
  // Even while paused, the active system-audio session still guards against uninstalling out from under resume.
  await assert.rejects(libB.call('live.loopback.uninstall', { confirm: true }), { code: 'live-running' });

  // Resuming spawns a fresh helper process.
  const failedResume = await libA.call('live.resume', { id: started.id });
  assert.equal(failedResume.status, 'paused', 'ready and error in one batch cannot mark capture live');
  assert.equal(failedResume.inputAudio.phase, 'paused');
  assert.match((await libA.call('live.poll', { id: started.id })).message, /init-resume-failed/);
  assert.equal(children.length, 2, 'no unobserved automatic retry');
  const resumed = await libA.call('live.resume', { id: started.id });
  assert.equal(resumed.status, 'live');
  assert.equal((await libA.call('live.poll', { id: started.id })).message, '');
  assert.equal(children.length, 3, 'fresh helper spawned on resume');
  assert.equal(loopbackProcessRunning(), true);

  // Stopping exits the helper immediately and allows clean uninstall.
  await libA.call('live.stop', { id: started.id });
  assert.equal(children[2].exitCode, 0, 'helper exited on stop');
  assert.equal(loopbackProcessRunning(), false);
  assert.equal(loopbackInUse(), false);
  const uninstalled = await libB.call('live.loopback.uninstall', { confirm: true });
  assert.ok(uninstalled.removed >= 1);
});

test('UI: LiveClient system-audio sync and bilingual rendering of LiveLoopbackCard, LiveClass, AudioSettings, and LiveAudioMonitor', async () => {
  const uiMod = await loadUi(`
    export { default as LiveLoopbackCard } from './ui/LiveLoopbackCard.jsx';
    export { default as LiveClass, CaptureHelp, SourceHint } from './ui/LiveClass.jsx';
    export { LiveEngineChoice } from './ui/AudioSettings.jsx';
    export { default as LiveAudioMonitor } from './ui/LiveAudioMonitor.jsx';
    export { LiveClient } from './ui/live-client.js';
    export { LiveAudioHealth } from './ui/live-audio-health.js';
    export { loopbackCardState, loopbackFix, loopbackProgress, loopbackStageStates } from './ui/live-loopback-flow.js';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const h = React.createElement;
  const textOf = html => html.replace(/<[^>]*>/g, ' ').replace(/&[a-z#0-9]+;/g, ' ').replace(/\s+/g, ' ');
  const render = (el, lang = 'zh') => { uiMod.setUiLanguage(lang); try { return renderToStaticMarkup(el); } finally { uiMod.setUiLanguage('zh'); } };
  const callStub = async () => ({});

  // Static guardrail on LiveLoopbackCard.jsx matching tests/live-audio-i18n.test.mjs.
  const cardSource = await readFile(new URL('../ui/LiveLoopbackCard.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(cardSource, /const t = \(zh/);
  assert.doesNotMatch(cardSource, /language === 'en' \?|getUiLanguage\(\) === 'en'/);
  assert.doesNotMatch(cardSource, /\}\{ui\(["'` ]/);
  assert.doesNotMatch(cardSource, /setInterval\(/);

  // LiveClient with kind='system': never touches browser mediaDevices, syncs inputAudio into health without churning session reference on meter-only ticks.
  let pollStep = 0, mockStatus = 'live';
  const calls = [];
  const client = new uiMod.LiveClient(async (action, args) => {
    calls.push([action, args]);
    if (action === 'live.start') {
      mockStatus = 'live';
      return {
        id: 'sys-1', status: mockStatus, revision: 1, segments: [],
        inputAudio: { source: 'system', phase: 'running', label: 'Bluetooth Headphones', muted: false, level: 55, peak: 0.3, capturedMs: 200, acceptedMs: 200, frameAgeMs: 20, soundAgeMs: 20, ackAgeMs: 20 },
      };
    }
    if (action === 'live.poll') {
      pollStep += 1;
      return {
        id: 'sys-1', status: mockStatus, revision: 1,
        inputAudio: { source: 'system', phase: mockStatus === 'paused' ? 'paused' : 'running', label: 'Bluetooth Headphones', muted: false, level: 60 + pollStep, peak: 0.4, capturedMs: 1200, acceptedMs: 1200, frameAgeMs: 10, soundAgeMs: 10, ackAgeMs: 10 },
      };
    }
    if (action === 'live.pause') { mockStatus = 'paused'; return { id: 'sys-1', status: 'paused', revision: 2, segments: [], inputAudio: { source: 'system', phase: 'paused', label: 'Bluetooth Headphones', muted: false, level: 0, peak: 0, capturedMs: 1200, acceptedMs: 1200, frameAgeMs: null, soundAgeMs: null, ackAgeMs: 50 } }; }
    if (action === 'live.stop') { mockStatus = 'ended'; return { id: 'sys-1', status: 'ended', revision: 3, segments: [], inputAudio: { source: 'system', phase: 'stopped', label: 'Bluetooth Headphones', muted: false, level: 0, peak: 0, capturedMs: 1200, acceptedMs: 1200, frameAgeMs: null, soundAgeMs: null, ackAgeMs: 50 } }; }
    return {};
  });
  await client.start('system', { title: 'Distributed Systems' });
  assert.equal(calls[0][0], 'live.start');
  assert.equal(calls[0][1].audioSource, 'system');
  assert.equal(client.health.getSnapshot().kind, 'system');
  assert.equal(client.health.getSnapshot().label, 'Bluetooth Headphones');
  const sessionBeforePoll = client.getSnapshot().session;
  await client.poll();
  assert.equal(client.getSnapshot().session, sessionBeforePoll, 'meter-only poll does not churn session object identity');
  assert.equal(client.health.getSnapshot().level, 61);
  assert.equal(client.health.getSnapshot().capturedMs, 1200);
  await client.pause();
  assert.equal(client.health.getSnapshot().phase, 'paused');
  await client.stop();
  assert.equal(client.getSnapshot().capturing, false);

  // Card states & bilingual rendering (zero Han characters in English across all surfaces).
  const FOLDER = 'D:\\StudyHub\\LiveLoopback';
  const base = {
    status: 'idle', stage: '', stages: ['compile', 'check'], done: [], step: 0, of: 2,
    folder: '', installedFolder: '', installed: false, ready: false, supported: true, tested: true,
    helperVersion: '1.0.0', downloadMb: 0, diskMb: 1, log: [], error: null,
  };
  const states = {
    missing: base,
    installing: { ...base, status: 'running', stage: 'compile', step: 1, folder: FOLDER, stageFraction: 0.5 },
    paused: { ...base, status: 'cancelled', stage: 'compile', step: 1, folder: FOLDER, error: { code: 'cancelled', message: LIVE_LOOPBACK_MESSAGES.cancelled } },
    failed: { ...base, status: 'failed', stage: 'check', step: 2, done: ['compile'], folder: FOLDER, error: { code: 'check-failed', message: LIVE_LOOPBACK_MESSAGES.checkFailed } },
    ready: { ...base, status: 'complete', stage: 'done', step: 2, done: ['compile', 'check'], folder: FOLDER, installedFolder: FOLDER, installed: true, ready: true },
    repair: { ...base, status: 'complete', stage: 'done', step: 2, done: ['compile', 'check'], folder: FOLDER, needsRepair: true },
    unsupported: { ...base, supported: false },
  };
  const plan = {
    ok: true, problems: [], warnings: [], folder: FOLDER, defaultFolder: FOLDER, defaultReason: 'largest-data-drive',
    platform: 'win32', supported: true, tested: true,
    drives: [{ root: 'D:\\', freeMb: 80_000, totalMb: 200_000, system: false, recommended: true, folder: FOLDER }],
    disk: { freeMb: 80_000, neededMb: 5, drive: 'D:' }, estimate: { downloadMb: 0, diskMb: 1 }, files: [],
  };

  assert.equal(uiMod.loopbackCardState(states.installing).state, 'installing');
  assert.equal(uiMod.loopbackCardState(states.repair).state, 'repair');
  assert.equal(uiMod.loopbackFix('no-space').id, 'relocate');
  assert.deepEqual(uiMod.loopbackProgress(states.installing), { value: 0.5, max: 2 });
  assert.deepEqual(uiMod.loopbackStageStates(states.failed).map(s => s.state), ['done', 'failed']);

  for (const [name, st] of Object.entries(states)) {
    const zh = render(h(uiMod.LiveLoopbackCard, { call: callStub, initialStatus: st, initialPlan: plan, settings: true }), 'zh');
    assert.doesNotMatch(zh, / title="/, name);
    const en = render(h(uiMod.LiveLoopbackCard, { call: callStub, initialStatus: st, initialPlan: plan, settings: true }), 'en');
    assert.doesNotMatch(textOf(en), han, `English card (${name}): ${textOf(en)}`);
  }

  // Electron LiveClass with computer audio selected shows the inline hot-install card and only 1 primary CTA.
  const electronUninstalledZh = render(h(uiMod.LiveClass, {
    call: callStub, data: { root: 'r', focus: { courses: [] } }, visible: true,
    initialAppHost: 'electron', initialKind: 'tab',
    initialReadiness: { live: true, liveProvider: 'local', liveLocal: { supported: true, ready: true }, liveLoopback: { supported: true, ready: false } },
    initialLoopback: states.missing,
  }), 'zh');
  assert.match(textOf(electronUninstalledZh), /电脑系统声音（客户端 \/ 网课）/);
  assert.match(textOf(electronUninstalledZh), /电脑声音直采组件（热插拔）/);

  const systemHealth = new uiMod.LiveAudioHealth(() => 10_000);
  systemHealth.reset('system', 'running');
  systemHealth.update({ lastFrameAt: 9_900, lastAckAt: 9_900, level: 0, capturedMs: 5_000, acceptedMs: 5_000 });

  const enSurfaces = [
    h(uiMod.LiveClass, {
      call: callStub, data: { root: 'r', focus: { courses: [] } }, visible: true,
      initialAppHost: 'electron', initialKind: 'system',
      initialReadiness: { live: true, liveProvider: 'local', liveLocal: { supported: true, ready: true }, liveLoopback: { supported: true, ready: true } },
      initialLoopback: states.ready,
    }),
    h(uiMod.CaptureHelp, {
      kind: 'app-window', facts: { browser: 'Chrome', platform: 'windows', app: true, policy: 'unknown', elapsedMs: 8 },
      liveLoopback: { supported: true, ready: true }, onSystemAudio() {}, onMicrophone() {}, onRetry() {},
    }),
    h(uiMod.SourceHint, { kind: 'system', tabAllowed: true, loopbackReady: true }),
    h(uiMod.LiveEngineChoice, { view: { liveProvider: 'auto' }, onSave() {}, initialLocal: null, initialLoopback: states.ready }),
    h(uiMod.LiveAudioMonitor, { health: systemHealth, visible: true, recording: true }),
  ];
  for (const el of enSurfaces) {
    const html = render(el, 'en');
    assert.doesNotMatch(textOf(html), han, textOf(html));
  }
});

test('Windows integration: compiles LIVE_LOOPBACK_CS_SOURCE with real csc.exe, runs --probe, and exits cleanly on --capture stdin close', { skip: process.platform !== 'win32' }, async t => {
  const { dir } = await withHome(t);
  const csc = await findWindowsCsc();
  assert.ok(csc, 'built-in .NET Framework csc.exe exists on Windows');
  assert.ok(LIVE_LOOPBACK_CS_SOURCE.length > 1000);

  const installFolder = join(dir, 'RealWinLoopback');
  const installer = createLiveLoopbackInstaller();
  await installer.start({ confirm: true, location: installFolder });
  await installer.idle();

  const status = await installer.status();
  assert.equal(status.status, 'complete', JSON.stringify(status.error || status.log));
  assert.equal(status.ready, true);

  const helper = await effectiveLiveLoopback();
  assert.ok(helper?.exePath);
  const exeStat = await stat(helper.exePath);
  assert.ok(exeStat.size > 2048 && exeStat.size < 65536, `unexpected helper size: ${exeStat.size}`);

  const probe = await probeLoopbackHelper({ exePath: helper.exePath });
  assert.equal(probe.ok, true);

  // Verify --capture either reports no-device cleanly (exit 3 on headless VM) or streams & exits 0 within < 2s when stdin closes.
  const child = spawn(helper.exePath, ['--capture'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { try { child.kill(); } catch {} reject(new Error(`helper timed out; stderr=${stderr}`)); }, 4000);
    child.stderr.on('data', () => {
      if (stderr.includes('STATE:')) {
        try { child.stdin.end(); } catch {}
      }
    });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => { clearTimeout(timer); resolve(code); });
  });
  assert.match(stderr, /STATE:\{/);
  assert.ok(exitCode === 0 || (stderr.includes('"no-device"') && exitCode === 3), `unexpected exit ${exitCode}: ${stderr}`);
});
