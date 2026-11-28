/* Regression tests for Issue #1629:
   Settings normalizers must preserve unknown future-version keys across reads,
   unrelated library commits, known-key updates, and export/restore round-trips,
   while still validating/clamping known keys, dropping intentional legacy keys,
   blocking prototype-pollution keys, and keeping redacted views secret-free. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { normalizeState } from '../lib/store.js';
import { checkSettings, LEGACY_KEYS } from '../lib/sm2.js';
import { normalizeGenerationSettings } from '../lib/generation-settings.js';
import { normalizePracticeSettings } from '../lib/practice-settings.js';
import { normalizeBookSettings } from '../lib/book-settings.js';
import { normalizeExamPrepSettings } from '../lib/exam-prep-settings.js';
import { normalizeDailyRecapSettings } from '../lib/daily-recap-settings.js';
import {
  normalizeWebGeminiSettings,
  readWebGeminiSettings,
  saveWebGeminiSettings,
  webGeminiSettingsPath,
} from '../lib/runtime/web-gemini-settings.js';
import { markerSettingsPath, readMarkerSettings, saveMarkerSettings } from '../lib/marker-settings.js';
import { readRetrievalSettings, retrievalSettingsPath, saveRetrievalSettings } from '../lib/retrieval-settings.js';
import { experimentalPath, setExperimental } from '../lib/experimental.js';
import { audioSettingsPath, readAudioSettings, saveAudioSettings } from '../lib/audio-settings.js';
import { jevSettingsPath, publicJevSettings, readJevSettings, saveJevSettings } from '../lib/jev-settings.js';
import { createCoachDaily, DAILY } from '../lib/coach-daily.js';
import { normalizeDesktopConfig, redactDesktopConfig } from '../packages/studyhub-desktop/domain/config-policy.js';
import { createConfigStore } from '../packages/studyhub-desktop/adapters/storage/config-store.mjs';

async function withTempLibrary(t, prefix = 'study-preserve-unknown-') {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const service = new StudyService(root);
  t.after(async () => {
    service.dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return { root, service };
}

async function withTempDshHome(t, prefix = 'dsh-preserve-unknown-') {
  const home = await mkdtemp(join(tmpdir(), prefix));
  const prev = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  t.after(async () => {
    if (prev === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = prev;
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  return home;
}

const FUTURE_SETTINGS_SEED = {
  futureTopFlag: true,
  futureTopMeta: { release: '5.6.0', weights: [1, 2, 3] },
  generation: {
    learnerLevel: 'zero',
    futureGenFlag: 'adaptive-v2',
    futureGenProfile: { tier: 2, hints: ['step-by-step'] },
  },
  dailyRecap: {
    automatic: true,
    tone: 'friendly',
    timeZone: 'Asia/Shanghai',
    futureRecapLayout: 'compact',
  },
  practice: {
    roundSize: 25,
    futurePracticeGoal: 30,
    futurePracticeTags: ['weak-first'],
  },
  book: {
    qaToBook: 'manual',
    futureBookColumns: 2,
  },
  examPrep: {
    language: 'zh',
    futureExamWeights: { mid: 0.4, final: 0.6 },
  },
};

test('#1629: unknown future keys in study-workspace.json survive read and unrelated library commit while legacy SM-2 keys stay dropped', async (t) => {
  const { root, service } = await withTempLibrary(t);
  // Create initial sharded manifest on disk.
  await service.call('settings', { request_retention: 0.88 });
  service.dispose();

  const manifestPath = join(root, 'study-workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const revisionBefore = manifest.revision;
  manifest.settings = {
    ...manifest.settings,
    ...structuredClone(FUTURE_SETTINGS_SEED),
    first_interval_days: 2,
    initial_ease_factor: 2.5,
    minimum_ease_factor: 1.3,
    second_interval_days: 6,
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  // Reopen with a fresh service and perform an UNRELATED write (source.add, not settings).
  const reopened = new StudyService(root);
  t.after(() => reopened.dispose());
  await reopened.call('source.add', {
    id: 'src-unrelated',
    title: 'Unrelated Note',
    text: 'This unrelated commit must not erase unknown future settings keys.',
  });

  const onDisk = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.equal(onDisk.revision, revisionBefore + 1);
  assert.equal(onDisk.settings.futureTopFlag, true);
  assert.deepEqual(onDisk.settings.futureTopMeta, { release: '5.6.0', weights: [1, 2, 3] });
  assert.equal(onDisk.settings.generation.learnerLevel, 'zero');
  assert.equal(onDisk.settings.generation.futureGenFlag, 'adaptive-v2');
  assert.deepEqual(onDisk.settings.generation.futureGenProfile, { tier: 2, hints: ['step-by-step'] });
  assert.equal(onDisk.settings.dailyRecap.futureRecapLayout, 'compact');
  assert.equal(onDisk.settings.practice.futurePracticeGoal, 30);
  assert.deepEqual(onDisk.settings.practice.futurePracticeTags, ['weak-first']);
  assert.equal(onDisk.settings.book.futureBookColumns, 2);
  assert.deepEqual(onDisk.settings.examPrep.futureExamWeights, { mid: 0.4, final: 0.6 });
  for (const legacy of LEGACY_KEYS) {
    assert.equal(Object.hasOwn(onDisk.settings, legacy), false, `legacy key ${legacy} must stay dropped`);
  }

  // Re-reading via a fresh StudyService sees every unknown key intact.
  const reader = new StudyService(root);
  t.after(() => reader.dispose());
  const snap = await reader.call('snapshot');
  assert.equal(snap.settings.futureTopFlag, true);
  assert.equal(snap.settings.generation.futureGenFlag, 'adaptive-v2');
  assert.equal(snap.settings.dailyRecap.futureRecapLayout, 'compact');
  assert.equal(snap.settings.practice.futurePracticeGoal, 30);
  assert.equal(snap.settings.book.futureBookColumns, 2);
  assert.deepEqual(snap.settings.examPrep.futureExamWeights, { mid: 0.4, final: 0.6 });
});

test('#1629: updating unrelated known settings preserves unknown sibling keys, supports full-snapshot settings save, and still rejects unknown patch keys', async (t) => {
  const { root, service } = await withTempLibrary(t);
  await service.call('settings', { request_retention: 0.9 });
  service.dispose();

  const manifestPath = join(root, 'study-workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.settings = { ...manifest.settings, ...structuredClone(FUTURE_SETTINGS_SEED) };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const svc = new StudyService(root);
  t.after(() => svc.dispose());

  // 1) Update known keys in each nested block
  await svc.call('settings', { generation: { learnerLevel: 'sprint' } });
  await svc.call('settings', { dailyRecap: { tone: 'professional' } });
  await svc.call('settings.practice.set', { patch: { roundSize: 15 } });
  await svc.call('settings.book.set', { patch: { qaToBook: 'auto' } });
  await svc.call('settings.examPrep.set', { patch: { language: 'en' } });

  // 2) Full-settings round-trip save (as settings forms do when changing one top-level key)
  const fullSnap = await svc.call('snapshot');
  await svc.call('settings', { ...fullSnap.settings, request_retention: 0.85 });

  const after = (await svc.call('snapshot')).settings;
  assert.equal(after.request_retention, 0.85);
  assert.equal(after.futureTopFlag, true);
  assert.equal(after.generation.learnerLevel, 'sprint');
  assert.equal(after.generation.futureGenFlag, 'adaptive-v2');
  assert.deepEqual(after.generation.futureGenProfile, { tier: 2, hints: ['step-by-step'] });
  assert.equal(after.dailyRecap.tone, 'professional');
  assert.equal(after.dailyRecap.futureRecapLayout, 'compact');
  assert.equal(after.practice.roundSize, 15);
  assert.equal(after.practice.futurePracticeGoal, 30);
  assert.equal(after.book.qaToBook, 'auto');
  assert.equal(after.book.futureBookColumns, 2);
  assert.equal(after.examPrep.language, 'en');
  assert.deepEqual(after.examPrep.futureExamWeights, { mid: 0.4, final: 0.6 });

  // 3) Strict explicit patches still reject genuinely new unknown keys
  await assert.rejects(svc.call('settings', { generation: { brandNewUnknownKey: 1 } }), /generation/i);
  await assert.rejects(svc.call('settings.practice.set', { patch: { brandNewUnknownKey: 1 } }), /practice/i);
  await assert.rejects(svc.call('settings.book.set', { patch: { brandNewUnknownKey: 1 } }), /book/i);
  await assert.rejects(svc.call('settings.examPrep.set', { patch: { brandNewUnknownKey: 1 } }), /exam prep/i);
});

test('#1629: invalid known keys still fall back/clamp while unknown sibling keys survive and known optional keys are not resurrected', () => {
  const gen = normalizeGenerationSettings({
    concurrency: 999,
    learnerLevel: 'bogus',
    language: 'English',
    futureGenFlag: 'keep',
  });
  assert.equal(gen.concurrency, 4);
  assert.equal(gen.learnerLevel, '');
  assert.equal(gen.language, 'English');
  assert.equal(gen.futureGenFlag, 'keep');

  const practice = normalizePracticeSettings({
    roundSize: 999,
    notesPracticeBridge: false,
    fixPhrases: 'corrupt',
    lastRounds: 'corrupt',
    futurePractice: { ok: true },
  });
  assert.equal(practice.roundSize, 20);
  assert.equal(Object.hasOwn(practice, 'notesPracticeBridge'), false, 'known optional false flag stays omitted');
  assert.equal(Object.hasOwn(practice, 'fixPhrases'), false, 'corrupt known optional fixPhrases stays omitted');
  assert.equal(Object.hasOwn(practice, 'lastRounds'), false, 'corrupt known optional lastRounds stays omitted');
  assert.deepEqual(practice.futurePractice, { ok: true });

  const book = normalizeBookSettings({
    qaToBook: 'invalid',
    pageLimit: -5,
    inlinePractice: 'yes',
    futureBook: 42,
  });
  assert.equal(book.qaToBook, 'manual');
  assert.equal(Object.hasOwn(book, 'pageLimit'), false, 'corrupt optional pageLimit stays omitted');
  assert.equal(Object.hasOwn(book, 'inlinePractice'), false, 'corrupt optional inlinePractice stays omitted');
  assert.equal(book.futureBook, 42);

  const examPrep = normalizeExamPrepSettings({
    language: 'klingon',
    autoRoles: 'yes',
    futureExam: ['a', 'b'],
  });
  assert.equal(examPrep.language, 'auto');
  assert.equal(examPrep.autoRoles, true);
  assert.deepEqual(examPrep.futureExam, ['a', 'b']);

  const recap = normalizeDailyRecapSettings({
    automatic: 'bad',
    tone: 'professional',
    timeZone: 'Not/A_Zone',
    futureRecap: { cadence: 'weekly' },
  });
  assert.equal(recap.automatic, false);
  assert.equal(recap.tone, 'professional');
  assert.equal(recap.timeZone, 'Asia/Shanghai');
  assert.deepEqual(recap.futureRecap, { cadence: 'weekly' });
});

test('#1629: full export -> restore round-trip preserves top-level and nested unknown keys', async (t) => {
  const { root: srcRoot, service: src } = await withTempLibrary(t, 'study-export-src-');
  await src.call('settings', { maximum_interval: 120 });
  src.dispose();

  const manifestPath = join(srcRoot, 'study-workspace.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.settings = { ...manifest.settings, ...structuredClone(FUTURE_SETTINGS_SEED) };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const exporter = new StudyService(srcRoot);
  t.after(() => exporter.dispose());
  const exported = await exporter.call('export');

  const { root: dstRoot, service: dst } = await withTempLibrary(t, 'study-restore-dst-');
  await dst.call('restore', { state: exported });

  const restoredDisk = JSON.parse(await readFile(join(dstRoot, 'study-workspace.json'), 'utf8'));
  assert.equal(restoredDisk.settings.futureTopFlag, true);
  assert.equal(restoredDisk.settings.generation.futureGenFlag, 'adaptive-v2');
  assert.equal(restoredDisk.settings.dailyRecap.futureRecapLayout, 'compact');
  assert.equal(restoredDisk.settings.practice.futurePracticeGoal, 30);
  assert.equal(restoredDisk.settings.book.futureBookColumns, 2);
  assert.deepEqual(restoredDisk.settings.examPrep.futureExamWeights, { mid: 0.4, final: 0.6 });
});

test('#1629: DSH home settings files and desktop.json preserve unknown keys across updates without leaking secrets into redacted views', async (t) => {
  const home = await withTempDshHome(t);
  const studyDir = join(home, 'study');
  await mkdir(studyDir, { recursive: true });

  // 1) web-gemini.json
  await writeFile(
    webGeminiSettingsPath(),
    JSON.stringify({ enabled: false, toolName: '', waitSeconds: 600, futureModelTab: 'pro' }),
    'utf8',
  );
  assert.equal((await readWebGeminiSettings()).futureModelTab, 'pro');
  await saveWebGeminiSettings({ enabled: true });
  assert.equal(JSON.parse(await readFile(webGeminiSettingsPath(), 'utf8')).futureModelTab, 'pro');

  // 2) marker.json
  await writeFile(
    markerSettingsPath(),
    JSON.stringify({ version: 1, command: '', futureDevice: 'mps' }),
    'utf8',
  );
  assert.equal((await readMarkerSettings()).futureDevice, 'mps');
  await saveMarkerSettings({ command: '' });
  assert.equal(JSON.parse(await readFile(markerSettingsPath(), 'utf8')).futureDevice, 'mps');

  // 3) retrieval.json
  await writeFile(
    retrievalSettingsPath(),
    JSON.stringify({ provider: 'service', queryArg: 'q', futureReranker: 'bge-v2' }),
    'utf8',
  );
  assert.equal((await readRetrievalSettings()).futureReranker, 'bge-v2');
  await saveRetrievalSettings({ provider: 'service', queryArg: 'query' });
  const savedRetrieval = JSON.parse(await readFile(retrievalSettingsPath(), 'utf8'));
  assert.equal(savedRetrieval.queryArg, 'query');
  assert.equal(savedRetrieval.futureReranker, 'bge-v2');

  // 4) experimental.json
  await writeFile(
    experimentalPath(),
    JSON.stringify({ version: 1, enabled: false, futureChannel: 'beta' }),
    'utf8',
  );
  await setExperimental(true);
  assert.equal(JSON.parse(await readFile(experimentalPath(), 'utf8')).futureChannel, 'beta');

  // 5) audio.json (preserves unknown key, still drops legacy audioConcurrency)
  await writeFile(
    audioSettingsPath(),
    JSON.stringify({ version: 1, mode: 'SMART', audioConcurrency: 1, futureAudioProfile: 'lecture' }),
    'utf8',
  );
  const audioBefore = await readAudioSettings();
  assert.equal(audioBefore.futureAudioProfile, 'lecture');
  assert.equal(Object.hasOwn(audioBefore, 'audioConcurrency'), false);
  await saveAudioSettings({ mode: 'VERBATIM' });
  const audioDisk = JSON.parse(await readFile(audioSettingsPath(), 'utf8'));
  assert.equal(audioDisk.futureAudioProfile, 'lecture');
  assert.equal(Object.hasOwn(audioDisk, 'audioConcurrency'), false);

  // 6) jev.json (preserves unknown key on disk, NEVER leaks it into publicJevSettings)
  await writeFile(
    jevSettingsPath(),
    JSON.stringify({ version: 1, enabled: false, futureProviderSecret: 'sk-secret-future-1234567890' }),
    'utf8',
  );
  await saveJevSettings({ threshold: 0.85 });
  assert.equal(JSON.parse(await readFile(jevSettingsPath(), 'utf8')).futureProviderSecret, 'sk-secret-future-1234567890');
  const publicJev = publicJevSettings(await readJevSettings());
  assert.equal(Object.hasOwn(publicJev, 'futureProviderSecret'), false, 'redacted Jev view must never leak unknown keys');

  // 7) coach-daily.json
  const coachRoot = await mkdtemp(join(tmpdir(), 'coach-preserve-unknown-'));
  t.after(() => rm(coachRoot, { recursive: true, force: true }));
  const coachPath = join(coachRoot, DAILY.file);
  await writeFile(
    coachPath,
    JSON.stringify({ version: 1, settings: { maxReady: 6, futureCoachMode: 'deep' }, futureLedgerFlag: true, days: {} }),
    'utf8',
  );
  const ledger = createCoachDaily(coachRoot);
  await ledger.patch({ maxBatchesPerDay: 12 });
  const coachDisk = JSON.parse(await readFile(coachPath, 'utf8'));
  assert.equal(coachDisk.settings.futureCoachMode, 'deep');
  assert.equal(coachDisk.futureLedgerFlag, true);

  // 8) desktop.json (preserves top-level and nested unknown keys, NEVER leaks secrets into redactDesktopConfig)
  const store = createConfigStore({ env: { DSH_HOME: home }, home, documentsDir: join(home, 'docs') });
  await writeFile(
    store.configPath,
    JSON.stringify({
      mode: 'openai',
      openai: { providerId: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-live-secret', futureApiSecret: 'tok-hidden' },
      agy: { executablePath: '', model: '', effort: '', futureAgyOpt: 'fast' },
      codex: { executablePath: '', model: '', effort: '', futureCodexOpt: 3 },
      libraryRoot: '',
      libraryPlaceConfirmed: false,
      reasoningEffort: '',
      futureDesktopFlag: 'keep-me',
    }),
    'utf8',
  );
  const loaded = await store.load();
  assert.equal(loaded.config.futureDesktopFlag, 'keep-me');
  assert.equal(loaded.config.openai.futureApiSecret, 'tok-hidden');
  assert.equal(loaded.config.agy.futureAgyOpt, 'fast');
  assert.equal(loaded.config.codex.futureCodexOpt, 3);

  const redacted = redactDesktopConfig(loaded.config);
  assert.equal(Object.hasOwn(redacted, 'futureDesktopFlag'), false, 'redacted desktop view must not leak unknown top-level keys');
  assert.equal(Object.hasOwn(redacted.openai, 'futureApiSecret'), false, 'redacted desktop openai view must not leak unknown secret keys');
  assert.equal(Object.hasOwn(redacted.openai, 'apiKey'), false);

  await store.confirmLibraryPlace();
  const desktopDisk = JSON.parse(await readFile(store.configPath, 'utf8'));
  assert.equal(desktopDisk.libraryPlaceConfirmed, true);
  assert.equal(desktopDisk.futureDesktopFlag, 'keep-me');
  assert.equal(desktopDisk.openai.futureApiSecret, 'tok-hidden');
  assert.equal(desktopDisk.agy.futureAgyOpt, 'fast');
  assert.equal(desktopDisk.codex.futureCodexOpt, 3);
});

test('#1629: prototype-pollution keys are blocked at every depth and preserved values are deeply cloned without mutating input', () => {
  const rawPayload = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":{"prototype":{"ctorPolluted":true}},"prototype":{"protoProp":true},"nested":{"__proto__":{"deepPolluted":true},"safe":1},"list":[1,{"__proto__":{"itemPolluted":true},"ok":true}]}',
  );

  const results = [
    normalizeGenerationSettings(rawPayload),
    normalizePracticeSettings(rawPayload),
    normalizeBookSettings(rawPayload),
    normalizeExamPrepSettings(rawPayload),
    normalizeDailyRecapSettings(rawPayload),
    normalizeWebGeminiSettings(rawPayload),
    normalizeDesktopConfig(rawPayload),
    checkSettings(rawPayload),
    normalizeState({ version: 5, settings: rawPayload }).settings,
  ];

  for (const res of results) {
    assert.equal(Object.hasOwn(res, '__proto__'), false);
    assert.equal(Object.hasOwn(res, 'constructor'), false);
    assert.equal(Object.hasOwn(res, 'prototype'), false);
    assert.equal(Object.hasOwn(res.nested, '__proto__'), false);
    assert.equal(res.nested.safe, 1);
    assert.equal(Object.hasOwn(res.list[1], '__proto__'), false);
    assert.equal(res.list[1].ok, true);
  }

  assert.equal(({}).polluted, undefined);
  assert.equal(({}).ctorPolluted, undefined);
  assert.equal(({}).deepPolluted, undefined);
  assert.equal(({}).itemPolluted, undefined);

  // Immutability: mutating normalized unknown object must not mutate input
  results[0].nested.safe = 999;
  results[0].list.push('mutated');
  assert.equal(rawPayload.nested.safe, 1);
  assert.equal(rawPayload.list.length, 2);
});

test('#1629: non-object, null, corrupt, non-JSON-safe, and cyclic inputs fall back cleanly without crashing', () => {
  for (const bad of [null, undefined, 0, 42, 'corrupt', true, ['a', 'b']]) {
    assert.equal(normalizeGenerationSettings(bad).concurrency, 4);
    assert.equal(normalizePracticeSettings(bad).roundSize, 20);
    assert.equal(normalizeBookSettings(bad).qaToBook, 'manual');
    assert.equal(normalizeExamPrepSettings(bad).language, 'auto');
    assert.equal(normalizeDailyRecapSettings(bad).timeZone, 'Asia/Shanghai');
    assert.equal(normalizeWebGeminiSettings(bad).waitSeconds, 600);
    assert.equal(normalizeDesktopConfig(bad).mode, 'openai');
  }

  const cyclic = { goodFuture: 'kept', fn: () => {}, sym: Symbol('x'), undef: undefined, nanVal: NaN, infVal: Infinity };
  cyclic.self = cyclic;
  const gen = normalizeGenerationSettings(cyclic);
  assert.equal(gen.goodFuture, 'kept');
  assert.equal(Object.hasOwn(gen, 'fn'), false);
  assert.equal(Object.hasOwn(gen, 'sym'), false);
  assert.equal(Object.hasOwn(gen, 'undef'), false);
  assert.equal(Object.hasOwn(gen, 'nanVal'), false);
  assert.equal(Object.hasOwn(gen, 'infVal'), false);
  assert.equal(Object.hasOwn(gen, 'self'), false);
});
