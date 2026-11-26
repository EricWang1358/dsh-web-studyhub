import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewElement } from './helpers/review-render.mjs';
import { withBrowserGlobals } from './helpers/react-harness.mjs';

const mod = await loadUi(`
  export * from './ui/seal-press/palette.js';
  export * from './ui/seal-press/seal-generator.js';
  export * from './ui/seal-press/confetti-burst.js';
  export * from './ui/seal-press/postcard-svg.js';
  export * from './ui/seal-press/seal-storage.js';
  export { default as FlowSealCue } from './ui/seal-press/FlowSealCue.jsx';
  export { default as RoundSealSection } from './ui/seal-press/RoundSealSection.jsx';
  export { default as PostcardStudioDialog } from './ui/seal-press/PostcardStudioDialog.jsx';
  export { default as InkMark } from './ui/seal-press/InkMark.jsx';
  export { default as Review } from './ui/Review.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

test('computeFlowStreak recognizes 3+, 5+, 8+ streaks and disappears silently on miss or exam mode', () => {
  const navOf = (bools) => bools.map((passed, index) => ({ index, answered: true, passed }));
  assert.equal(mod.computeFlowStreak({ mode: 'path', index: 1, navigation: navOf([true, true]) }), null);

  const s3 = mod.computeFlowStreak({ mode: 'path', index: 2, navigation: navOf([true, true, true]) });
  assert.equal(s3?.tier, 1);
  assert.equal(s3?.streak, 3);
  assert.equal(s3?.labelKey, '连对 {0} · 手感渐稳');
  assert.equal(s3?.isMilestone, true);

  const s5 = mod.computeFlowStreak({ mode: 'path', index: 4, navigation: navOf([true, true, true, true, true]) });
  assert.equal(s5?.tier, 2);
  assert.equal(s5?.streak, 5);
  assert.equal(s5?.labelKey, '连对 {0} · 渐入佳境');

  const s8 = mod.computeFlowStreak({ mode: 'path', index: 7, navigation: navOf(Array(8).fill(true)) });
  assert.equal(s8?.tier, 3);
  assert.equal(s8?.streak, 8);
  assert.equal(s8?.labelKey, '连对 {0} · 如鱼得水');

  // Zero guilt on miss: resets quietly to null
  assert.equal(mod.computeFlowStreak({ mode: 'path', index: 5, navigation: navOf([true, true, true, true, true, false]) }), null);
  assert.equal(mod.computeFlowStreak({
    mode: 'path',
    index: 3,
    navigation: navOf([true, true, true]),
    feedback: { correct: false, grade: 1 },
  }), null);

  // Suppressed in exam mode
  assert.equal(mod.computeFlowStreak({ mode: 'exam', index: 4, navigation: navOf(Array(5).fill(true)) }), null);
});

test('isLeechConquered fires on passing stubborn/leech cards and tracks conquered count per run', () => {
  mod.resetConqueredLeechesForTests();
  assert.equal(mod.isLeechConquered({
    mode: 'path',
    complete: false,
    feedback: { correct: true, grade: 4 },
    stubborn: { missCount: 3, priorMisses: 3, isLeech: true },
  }), true);

  // Also honors a card that just graduated out of isLeech on this passing attempt (priorMisses >= 2)
  assert.equal(mod.isLeechConquered({
    mode: 'path',
    complete: false,
    feedback: { correct: true, grade: 4 },
    stubborn: { missCount: 2, priorMisses: 2, isLeech: false },
  }), true);

  // Does not fire on miss, self-report, or exam
  assert.equal(mod.isLeechConquered({
    mode: 'path',
    complete: false,
    feedback: { correct: false, grade: 1 },
    stubborn: { missCount: 4, priorMisses: 3, isLeech: true },
  }), false);
  assert.equal(mod.isLeechConquered({
    mode: 'path',
    complete: false,
    feedback: { selfReported: true },
    stubborn: { missCount: 3, priorMisses: 3, isLeech: true },
  }), false);
  assert.equal(mod.isLeechConquered({
    mode: 'exam',
    complete: false,
    feedback: { correct: true, grade: 4 },
    stubborn: { missCount: 3, priorMisses: 3, isLeech: true },
  }), false);

  assert.equal(mod.recordConqueredLeech('run-1', 'c-1'), 1);
  assert.equal(mod.recordConqueredLeech('run-1', 'c-1'), 1, 'deduplicates same card');
  assert.equal(mod.recordConqueredLeech('run-1', 'c-2'), 2);
  assert.equal(mod.getConqueredLeechCount('run-1'), 2);
  mod.resetConqueredLeechesForTests();
});

test('deriveRoundSeal chooses honest procedural seals from real session facts', () => {
  const sweep = mod.deriveRoundSeal({ id: 'r1', questions: 5, answered: 5, correct: 5 }, { hour: 14 });
  assert.equal(sweep.id, 'clean-sweep');
  assert.deepEqual(sweep.chars, ['全', '胜']);

  const leech = mod.deriveRoundSeal(
    { id: 'r2', questions: 5, answered: 5, correct: 4 },
    { hour: 14, conqueredLeechCount: 1 },
  );
  assert.equal(leech.id, 'leech-cleared');
  assert.deepEqual(leech.chars, ['破', '顽']);

  const night = mod.deriveRoundSeal({ id: 'r3', questions: 5, answered: 5, correct: 3 }, { hour: 23 });
  assert.equal(night.id, 'night-study');
  assert.deepEqual(night.chars, ['夜', '读']);

  const earlyMorning = mod.deriveRoundSeal({ id: 'r3b', questions: 4, answered: 4, correct: 2 }, { hour: 2 });
  assert.equal(earlyMorning.id, 'night-study');

  const rise = mod.deriveRoundSeal(
    { id: 'r4', questions: 5, answered: 5, correct: 4, mastery: { before: { percent: 40 }, after: { percent: 55 } } },
    { hour: 15 },
  );
  assert.equal(rise.id, 'steady-rise');
  assert.deepEqual(rise.chars, ['精', '进']);
  assert.equal(rise.stats.masteryDelta, 15);

  const steady = mod.deriveRoundSeal({ id: 'r5', questions: 5, answered: 5, correct: 2 }, { hour: 15 });
  assert.equal(steady.id, 'round-done');
  assert.deepEqual(steady.chars, ['笃', '行']);
});

test('buildSealSvg produces deterministic yang (朱文) and yin (白文) carved SVG chops', () => {
  const seal = mod.deriveRoundSeal({ id: 'r-svg', questions: 4, answered: 4, correct: 4 }, { hour: 11 });
  const yangA = mod.buildSealSvg(seal, { style: 'yang', ink: '#c93d22', paper: '#ece4d6' });
  const yangB = mod.buildSealSvg(seal, { style: 'yang', ink: '#c93d22', paper: '#ece4d6' });
  const yin = mod.buildSealSvg(seal, { style: 'yin', ink: '#1e724d', paper: '#fffdf8' });

  assert.equal(yangA, yangB, 'same seed yields deterministic carved edges');
  assert.match(yangA, /data-seal-style="yang"/);
  assert.match(yangA, /全/);
  assert.match(yangA, /胜/);
  assert.match(yin, /data-seal-style="yin"/);
  assert.match(yin, /#1e724d/);
  assert.notEqual(yangA, yin);
});

test('confetti runtime enforces worker-free cannon, disableForReducedMotion, theme hex palette, and reduced-motion / hidden-tab gates', async () => {
  assert.equal(mod.cssColorToHex('rgb(201, 61, 34)'), '#c93d22');
  assert.equal(mod.cssColorToHex('#abc'), '#aabbcc');
  assert.equal(mod.cssColorToHex('#5fb58a80'), '#5fb58a');

  const opts = mod.buildConfettiOptions({
    palette: { accent: 'rgb(201, 61, 34)', ok: 'rgb(95, 181, 138)', warn: '#d9a441', paper: '#ece4d6' },
    reducedMotion: false,
    variant: 'clean-sweep',
  });
  assert.equal(opts.useWorker, false);
  assert.equal(opts.disableForReducedMotion, true);
  assert.deepEqual(opts.colors, ['#c93d22', '#5fb58a', '#d9a441', '#ece4d6']);
  assert.equal(mod.buildConfettiOptions({ reducedMotion: true }), null);

  // Bundle confetti-burst.js with a virtual canvas-confetti stub so fireSealConfetti() runs end-to-end.
  const createCalls = [];
  const fireCalls = [];
  let resetCalls = 0;
  let defaultExportCalled = 0;
  const cannonFn = (options) => { fireCalls.push(options); };
  cannonFn.reset = () => { resetCalls += 1; };
  const confettiStub = Object.assign(() => { defaultExportCalled += 1; }, {
    create(canvas, config) {
      createCalls.push({ canvas, config });
      return cannonFn;
    },
  });

  const compiled = await build({
    stdin: { contents: `export * from './ui/seal-press/confetti-burst.js';`, resolveDir: resolve(process.cwd()) },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
    plugins: [{
      name: 'stub-canvas-confetti',
      setup(builder) {
        builder.onResolve({ filter: /^canvas-confetti$/ }, () => ({ path: 'canvas-confetti', namespace: 'stub-confetti' }));
        builder.onLoad({ filter: /.*/, namespace: 'stub-confetti' }, () => ({
          contents: 'export default __confettiStub; export const create = __confettiStub.create;',
          loader: 'js',
        }));
      },
    }],
  });
  const runtimeMod = { exports: {} };
  new Function('require', 'module', 'exports', '__confettiStub', compiled.outputFiles[0].text)(
    createRequire(import.meta.url),
    runtimeMod,
    runtimeMod.exports,
    confettiStub,
  );
  const { fireSealConfetti, resetConfettiForTests } = runtimeMod.exports;

  const cssVars = {
    '--accent': 'rgb(201, 61, 34)',
    '--ok': 'rgb(95, 181, 138)',
    '--warn': '#d9a441',
    '--paper': '#ece4d6',
  };
  let motionAttr = null;
  let osReducedMotion = false;

  await withBrowserGlobals(async () => {
    try {
      // 1) Hidden tab suppresses confetti before touching canvas-confetti
      globalThis.document.hidden = true;
      assert.equal(await fireSealConfetti({ variant: 'clean-sweep' }), false);
      assert.equal(createCalls.length, 0);
      assert.equal(fireCalls.length, 0);
      globalThis.document.hidden = false;

      // 2) OS prefers-reduced-motion suppresses confetti
      osReducedMotion = true;
      assert.equal(await fireSealConfetti({ variant: 'stamp' }), false);
      assert.equal(createCalls.length, 0);
      osReducedMotion = false;

      // 3) StudyHub [data-motion="reduced"|"off"] suppresses confetti
      motionAttr = 'reduced';
      assert.equal(await fireSealConfetti({ variant: 'stamp' }), false);
      motionAttr = 'off';
      assert.equal(await fireSealConfetti({ variant: 'stamp' }), false);
      assert.equal(createCalls.length, 0);
      motionAttr = null;

      // 4) Normal visible tab fires through a dedicated worker-free cannon (never default export)
      const fired = await fireSealConfetti({ variant: 'clean-sweep', origin: { x: 0.3, y: 0.4 } });
      assert.equal(fired, true);
      assert.equal(defaultExportCalled, 0, 'must never invoke canvas-confetti default worker-enabled export');
      assert.deepEqual(createCalls, [{
        canvas: null,
        config: { useWorker: false, resize: true, disableForReducedMotion: true },
      }]);
      assert.equal(fireCalls.length, 1);
      assert.equal(fireCalls[0].useWorker, false);
      assert.equal(fireCalls[0].disableForReducedMotion, true);
      assert.equal(fireCalls[0].particleCount, 34);
      assert.deepEqual(fireCalls[0].colors, ['#c93d22', '#5fb58a', '#d9a441', '#ece4d6']);
      assert.deepEqual(fireCalls[0].origin, { x: 0.3, y: 0.4 });

      // 5) Second burst reuses the cached worker-free cannon; reset clears and resets it
      assert.equal(await fireSealConfetti({ variant: 'stamp' }), true);
      assert.equal(createCalls.length, 1, 'reuses cached worker-free cannon');
      assert.equal(fireCalls.length, 2);
      assert.equal(fireCalls[1].particleCount, 24);

      resetConfettiForTests();
      assert.equal(resetCalls, 1);
    } finally {
      resetConfettiForTests();
    }
  }, {
    document: {
      hidden: false,
      documentElement: {
        style: {},
        dataset: {},
        getAttribute: (name) => (name === 'data-motion' ? motionAttr : null),
      },
      querySelector: () => null,
    },
    window: {
      matchMedia: () => ({ matches: osReducedMotion, addEventListener() {}, removeEventListener() {} }),
      getComputedStyle: () => ({ getPropertyValue: (name) => cssVars[name] || '' }),
    },
  });
});

test('buildPostcardSvg generates all 3 fine-print editions with escaped session content', () => {
  const baseEntry = {
    title: 'Distributed Systems <Raft & Paxos>',
    course: 'CS5223',
    dateLabel: '2026.11.21',
    answered: 6,
    total: 6,
    correct: 6,
    accuracy: 100,
    sealId: 'clean-sweep',
    sealChars: ['全', '胜'],
    sealStyle: 'yang',
    seed: 12345,
    note: 'Quorum > N/2 & log matching',
    masteryDelta: 12,
  };
  for (const edition of mod.POSTCARD_EDITIONS) {
    const out = mod.buildPostcardSvg({ ...baseEntry, edition: edition.id }, {
      labels: {
        ariaLabel: `${baseEntry.title} · ${edition.id}`,
        sealTitle: 'Clean Sweep Seal',
        sealReason: 'All 6 questions passed',
        sealEmblem: 'CLEAN SWEEP',
        scoreCaption: 'Round score',
        accuracyCaption: 'Accuracy',
      },
    });
    assert.equal(out.width, edition.width);
    assert.equal(out.height, edition.height);
    assert.match(out.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(out.svg, /100%/);
    assert.match(out.svg, /&lt;Raft &amp; Paxos&gt;/, 'XML-escapes titles safely');
    assert.match(out.svg, /Quorum &gt; N\/2 &amp;/, 'XML-escapes learner notes safely');
    assert.doesNotMatch(out.svg, /mat<\/text><text[^>]*>ching/, 'wraps English words cleanly on word boundaries');
    assert.match(out.svg, /data-seal-id="clean-sweep"/);
  }
});

test('accuracyInkColor and postcard score denominator stay semantically honest across all 3 editions', () => {
  const palette = {
    paper: '#ece4d6',
    paperInk: '#201b15',
    paperDim: '#5d5448',
    paperRule: '#cfc5b4',
    accent: '#c93d22',
    ok: '#5fb58a',
    warn: '#d9a441',
    info: '#86a9c6',
  };
  assert.equal(mod.accuracyInkColor(100, { ok: '#5fb58a', warn: '#d9a441', dim: '#5d5448' }), '#5fb58a');
  assert.equal(mod.accuracyInkColor(80, { ok: '#5fb58a', warn: '#d9a441', dim: '#5d5448' }), '#5fb58a');
  assert.equal(mod.accuracyInkColor(65, { ok: '#5fb58a', warn: '#d9a441', dim: '#5d5448' }), '#d9a441');
  assert.equal(mod.accuracyInkColor(50, { ok: '#5fb58a', warn: '#d9a441', dim: '#5d5448' }), '#d9a441');
  assert.equal(mod.accuracyInkColor(0, { ok: '#5fb58a', warn: '#d9a441', dim: '#5d5448' }), '#5d5448');

  const earlyStop = {
    title: 'Design patterns',
    course: 'CS',
    dateLabel: '2026.11.21',
    answered: 1,
    total: 2,
    correct: 0,
    accuracy: 0,
    sealId: 'round-done',
    sealChars: ['笃', '行'],
    sealStyle: 'yin',
    seed: 2814,
  };
  for (const edition of mod.POSTCARD_EDITIONS) {
    const { svg } = mod.buildPostcardSvg({ ...earlyStop, edition: edition.id }, { palette });
    assert.match(svg, /fill="#5d5448"[^>]*>0%<\/text>/, `${edition.id}: 0% uses calm neutral ink, never emerald green`);
    assert.doesNotMatch(svg, /fill="#5fb58a"[^>]*>0%<\/text>/);
    const expectedScore = edition.id === 'risograph' ? '>0/1<' : '>0 / 1<';
    assert.ok(svg.includes(expectedScore), `${edition.id}: denominator uses answered (1), not total (2)`);
    assert.ok(!svg.includes('>0 / 2<') && !svg.includes('>0/2<'), `${edition.id}: does not mismatch answered count`);
  }

  const midRound = { ...earlyStop, answered: 4, total: 4, correct: 2, accuracy: 50 };
  const midSvg = mod.buildPostcardSvg({ ...midRound, edition: 'letterpress' }, { palette }).svg;
  assert.match(midSvg, /fill="#d9a441"[^>]*>50%<\/text>/, '50-79% uses warm ochre ink');
});

test('local Seal Album persists newest-first, removes entries, and caps cleanly at 60', () => {
  const storage = makeMemoryStorage();
  assert.deepEqual(mod.loadSealAlbum(storage), []);

  for (let i = 1; i <= 65; i += 1) {
    mod.saveSealAlbumEntry({
      id: `entry-${i}`,
      runId: `run-${i}`,
      title: `Deck ${i}`,
      answered: 5,
      total: 5,
      correct: 5,
      accuracy: 100,
      sealId: 'clean-sweep',
      sealChars: ['全', '胜'],
      sealStyle: 'yang',
      edition: i % 3 === 0 ? 'archival-slip' : i % 2 === 0 ? 'risograph' : 'letterpress',
      dateLabel: '2026.11.21',
    }, storage);
  }
  const loaded = mod.loadSealAlbum(storage);
  assert.equal(loaded.length, mod.MAX_ALBUM_ENTRIES);
  assert.equal(loaded[0].id, 'entry-65', 'newest entry comes first');
  assert.equal(loaded.at(-1).id, 'entry-6', 'oldest entries trimmed beyond 60');

  const afterRemove = mod.removeSealAlbumEntry('entry-65', storage);
  assert.equal(afterRemove.length, 59);
  assert.equal(afterRemove[0].id, 'entry-64');

  // Corrupt JSON does not throw
  storage.setItem(mod.SEAL_ALBUM_KEY, '{bad-json');
  assert.deepEqual(mod.loadSealAlbum(storage), []);
});

test('SSR rendering of FlowSealCue, RoundSealSection, PostcardStudioDialog and Review mount works in zh and en', () => {
  const noop = () => {};
  const nav5 = Array.from({ length: 5 }, (_, index) => ({ index, answered: true, passed: true }));

  mod.setUiLanguage('zh');
  try {
    const flowHeader = renderToStaticMarkup(React.createElement(mod.FlowSealCue, {
      run: { id: 'r-flow', mode: 'path', index: 4, complete: false, navigation: nav5 },
      variant: 'header',
    }));
    assert.match(flowHeader, /连对 5 · 渐入佳境/);

    const leechVerdict = renderToStaticMarkup(React.createElement(mod.FlowSealCue, {
      run: {
        id: 'r-leech',
        mode: 'path',
        index: 0,
        complete: false,
        card: { id: 'c-leech' },
        feedback: { correct: true, grade: 4 },
        stubborn: { missCount: 3, priorMisses: 3, isLeech: true },
      },
      variant: 'verdict',
    }));
    assert.match(leechVerdict, /data-testid="leech-conquered-seal"/);
    assert.match(leechVerdict, /破顽/);

    const reviewCompleteZh = renderToStaticMarkup(reviewElement(mod.Review, mod.StudyServicesContext, {
      run: {
        id: 'r-done-zh',
        mode: 'path',
        complete: true,
        index: 5,
        total: 5,
        questions: 5,
        answered: 5,
        correct: 5,
        weakTopics: [],
        scope: [],
        card: { id: 'q', kind: 'quiz', topic: 'T', prompt: 'Q?', options: [] },
      },
      data: { sources: [] },
      host: {},
      choice: true,
      isCloze: false,
      selected: [],
      clozeValues: {},
      shellTitle: '分布式系统',
      busy: false,
      act: noop,
      enterRun: noop,
      setPage: noop,
      askInChat: noop,
    }));
    assert.match(reviewCompleteZh, /data-testid="result-all-correct"/);
    assert.match(reviewCompleteZh, /sh-ink-mark-host/);

    const roundSealHtml = renderToStaticMarkup(React.createElement(mod.RoundSealSection, {
      run: {
        id: 'r-done-zh',
        mode: 'path',
        complete: true,
        index: 5,
        total: 5,
        questions: 5,
        answered: 5,
        correct: 5,
      },
      title: '分布式系统',
      course: 'CS',
      allCorrect: true,
    }));
    assert.match(roundSealHtml, /data-testid="round-seal-section"/);
    assert.match(roundSealHtml, /全胜印/);
    assert.match(roundSealHtml, /制作藏书明信片/);

    const roundSealExam = renderToStaticMarkup(React.createElement(mod.RoundSealSection, {
      run: { id: 'r-exam', mode: 'exam', complete: true, total: 5, questions: 5, answered: 5, correct: 5 },
      title: 'Exam',
      allCorrect: true,
    }));
    assert.equal(roundSealExam, '', 'RoundSealSection stays hidden on mock exams');

    mod.setUiLanguage('en');
    const flowHeaderEn = renderToStaticMarkup(React.createElement(mod.FlowSealCue, {
      run: { id: 'r-flow', mode: 'path', index: 4, complete: false, navigation: nav5 },
      variant: 'header',
    }));
    assert.match(flowHeaderEn, /5 in a row · Finding flow/);
    assert.doesNotMatch(flowHeaderEn, /[\u3400-\u9fff]/);

    const sealEn = mod.deriveRoundSeal({ id: 'r-done-en', questions: 4, answered: 4, correct: 4 }, { hour: 12 });
    const prevStorage = globalThis.localStorage;
    const mem = makeMemoryStorage();
    globalThis.localStorage = mem;
    mod.saveSealAlbumEntry({
      id: 'tab-check-1',
      runId: 'r-done-en',
      title: 'Systems',
      answered: 4,
      total: 4,
      correct: 4,
      accuracy: 100,
      sealId: 'clean-sweep',
      sealChars: ['全', '胜'],
      sealStyle: 'yang',
      edition: 'letterpress',
      dateLabel: '2026.11.21',
    }, mem);
    const studioEn = renderToStaticMarkup(React.createElement(mod.PostcardStudioDialog, {
      run: { id: 'r-done-en', title: 'Systems' },
      title: 'Systems',
      course: 'CS',
      seal: sealEn,
      onClose: noop,
    }));
    globalThis.localStorage = prevStorage;
    assert.match(studioEn, /Ex-Libris Postcard Studio &amp; Seal Album/);
    assert.match(studioEn, /Seal Album \(1\)/, 'renders single-line inline album count in tab');
    assert.doesNotMatch(studioEn, /sh-tabs__note/, 'no two-line wrapped tab note');
    assert.match(studioEn, /Letterpress Ex-Libris/);
    assert.match(studioEn, /Risograph Print/);
    assert.match(studioEn, /Archival Slip/);
    assert.match(studioEn, /Save to Seal Album/);
    assert.match(studioEn, /Export SVG/);
    assert.match(studioEn, /Export 2x PNG/);
  } finally {
    mod.setUiLanguage('zh');
  }
});
