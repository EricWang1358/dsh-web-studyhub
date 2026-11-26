import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';
import { nativeSelects } from './helpers/native-selects.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

const mod = await loadUi(`
  export * from './ui/seal-press/seal-generator.js';
  export * from './ui/seal-press/seal-storage.js';
  export * from './ui/seal-press/postcard-svg.js';
  export { default as SealAlbumDialog } from './ui/seal-press/SealAlbumDialog.jsx';
  export { default as LazySealAlbumTrigger } from './ui/seal-press/LazySealAlbumTrigger.jsx';
  export { default as WrongBookClearStamp } from './ui/seal-press/WrongBookClearStamp.jsx';
  export { default as LazyWrongBookClearStamp } from './ui/seal-press/LazyWrongBookClearStamp.jsx';
  export { default as Dashboard } from './ui/Dashboard.jsx';
  export { DailyRecapPanel } from './ui/DailyRecap.jsx';
  export { WrongBookView } from './ui/WrongBook.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

const HAN = /[\u3400-\u9fff]/;
const textOf = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function makeMemoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    clear: () => { map.clear(); },
  };
}

function makeEntry(overrides = {}) {
  return {
    id: `entry-${Math.random().toString(36).slice(2, 8)}`,
    runId: 'run-1',
    savedAt: '2026-11-21T08:00:00Z',
    dateLabel: '2026.11.21',
    title: 'Distributed Systems',
    course: 'CS5223',
    answered: 5,
    total: 5,
    correct: 5,
    accuracy: 100,
    sealId: 'clean-sweep',
    sealChars: ['全', '胜'],
    sealStyle: 'yang',
    seed: 12345,
    edition: 'letterpress',
    note: '',
    masteryDelta: null,
    ...overrides,
  };
}

test('deriveWrongBookClearSeal builds a 4-character carved seal preserved in storage and all 3 postcard editions', () => {
  const seal = mod.deriveWrongBookClearSeal({ clearedCount: 9, course: 'CS5223' });
  assert.equal(seal.id, 'wrongbook-cleared');
  assert.deepEqual(seal.chars, ['错', '题', '清', '零']);
  assert.equal(seal.stats.answered, 9);
  assert.equal(seal.stats.total, 9);
  assert.equal(seal.stats.correct, 9);
  assert.equal(seal.stats.accuracy, 100);

  const svgYang = mod.buildSealSvg(seal, { style: 'yang', ink: '#c93d22', paper: '#ece4d6' });
  const svgYin = mod.buildSealSvg(seal, { style: 'yin', ink: '#c93d22', paper: '#ece4d6' });
  for (const ch of ['错', '题', '清', '零']) {
    assert.ok(svgYang.includes(ch), `yang SVG contains ${ch}`);
    assert.ok(svgYin.includes(ch), `yin SVG contains ${ch}`);
  }
  assert.match(svgYang, /data-seal-id="wrongbook-cleared"/);
  assert.match(svgYang, /x1="22" y1="60" x2="98" y2="60"/, '4-char square seal draws cross hairline');

  const storage = makeMemoryStorage();
  const saved = mod.saveSealAlbumEntry(makeEntry({
    id: 'wb-clear-1',
    title: 'CS5223 · 错题清零纪念',
    answered: 9,
    total: 9,
    correct: 9,
    sealId: 'wrongbook-cleared',
    sealChars: ['错', '题', '清', '零'],
  }), storage);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].sealId, 'wrongbook-cleared');
  assert.deepEqual(saved[0].sealChars, ['错', '题', '清', '零']);

  for (const edition of mod.POSTCARD_EDITIONS) {
    const out = mod.buildPostcardSvg({ ...saved[0], edition: edition.id });
    assert.match(out.svg, /data-seal-id="wrongbook-cleared"/);
    assert.match(out.svg, /错/);
    assert.match(out.svg, /零/);
  }
});

test('SealAlbumDialog renders the 5-Seal Specimen Shelf, filter chips, and zero-guilt copy in zh and en', () => {
  const noop = () => {};
  const entries = [
    makeEntry({ id: 'e1', sealId: 'clean-sweep', sealChars: ['全', '胜'] }),
    makeEntry({ id: 'e2', sealId: 'clean-sweep', sealChars: ['全', '胜'], edition: 'risograph' }),
    makeEntry({ id: 'e3', sealId: 'night-study', sealChars: ['夜', '读'], edition: 'archival-slip' }),
    makeEntry({ id: 'e4', sealId: 'wrongbook-cleared', sealChars: ['错', '题', '清', '零'], title: 'Systems Keepsake' }),
  ];

  mod.setUiLanguage('zh');
  try {
    const htmlZh = renderToStaticMarkup(React.createElement(mod.SealAlbumDialog, { entries, onClose: noop }));
    assert.match(htmlZh, /data-testid="seal-album-dialog"/);
    assert.match(htmlZh, /data-testid="seal-specimen-shelf"/);
    assert.match(htmlZh, /data-testid="seal-album-filters"/);
    assert.match(htmlZh, /data-seal-specimen="clean-sweep"[^>]*data-earned="true"/);
    assert.match(htmlZh, /data-seal-specimen="night-study"[^>]*data-earned="true"/);
    assert.match(htmlZh, /data-seal-specimen="leech-cleared"[^>]*data-earned="false"/);
    assert.match(htmlZh, /data-seal-specimen="steady-rise"[^>]*data-earned="false"/);
    assert.match(htmlZh, /data-seal-specimen="round-done"[^>]*data-earned="false"/);
    assert.match(textOf(htmlZh), /已集齐 2 \/ 5 方/);
    assert.match(textOf(htmlZh), /2 张/);
    assert.match(textOf(htmlZh), /全部收藏 \(4\)/);
    assert.match(textOf(htmlZh), /错题清零印 \(1\)/);
    assert.match(textOf(htmlZh), /单轮正确率达八成以上/);
    assert.doesNotMatch(textOf(htmlZh), /单轮正确率达到八成以上/);
    assert.doesNotMatch(htmlZh, /掌握度/, 'zero 掌握度 substring in SealAlbumDialog');

    const emptyZh = renderToStaticMarkup(React.createElement(mod.SealAlbumDialog, { entries: [], onClose: noop }));
    assert.match(emptyZh, /data-testid="seal-gallery-empty"/);
    assert.match(textOf(emptyZh), /已集齐 0 \/ 5 方/);
    assert.match(textOf(emptyZh), /深夜或凌晨完成一轮/);
    assert.doesNotMatch(textOf(emptyZh), /深夜或凌晨完成一轮练习/);

    // Verify early-stopped entry shows answered count (0/1), not total (0/2), in album toolbar
    const earlyEntry = makeEntry({ id: 'e-early', answered: 1, total: 2, correct: 0, accuracy: 0, sealId: 'round-done', sealChars: ['笃', '行'] });
    const earlyAlbum = renderToStaticMarkup(React.createElement(mod.SealAlbumDialog, { entries: [earlyEntry], onClose: noop }));
    assert.match(textOf(earlyAlbum), /0\/1/);
    assert.doesNotMatch(textOf(earlyAlbum), /0\/2/);

    mod.setUiLanguage('en');
    const htmlEn = renderToStaticMarkup(React.createElement(mod.SealAlbumDialog, { entries, onClose: noop }));
    assert.match(textOf(htmlEn), /Seal Album Gallery/);
    assert.match(textOf(htmlEn), /Five Traditional Seals/);
    assert.match(textOf(htmlEn), /2 \/ 5 seals collected/);
    assert.match(textOf(htmlEn), /2 cards/);
    assert.match(textOf(htmlEn), /1 card/);
    assert.match(textOf(htmlEn), /All \(4\)/);
    assert.doesNotMatch(textOf(htmlEn), HAN, 'zero Han leaked into English SealAlbumDialog text');
  } finally {
    mod.setUiLanguage('zh');
  }
});

async function inspectCodeSplit(entryPoint) {
  const result = await build({
    entryPoints: [resolve(process.cwd(), entryPoint)],
    bundle: true,
    splitting: true,
    format: 'esm',
    write: false,
    metafile: true,
    outdir: 'out',
    external: [
      'react', 'react-dom', 'react/*', 'react-dom/*',
      '@base-ui/*', 'canvas-confetti', 'rough-notation', 'roughjs',
    ],
    plugins: [nativeSelects],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const outputs = Object.entries(result.metafile.outputs);
  const entry = outputs.find(([, meta]) => meta.entryPoint === entryPoint);
  const dynamicChunks = outputs.filter(([, meta]) => meta.entryPoint && meta.entryPoint !== entryPoint);
  return {
    entryInputs: Object.keys(entry?.[1]?.inputs || {}),
    dynamicEntryPoints: dynamicChunks.map(([, meta]) => meta.entryPoint),
    dynamicImports: (entry?.[1]?.imports || []).filter((imp) => imp.kind === 'dynamic-import').map((imp) => imp.path),
  };
}

test('LazySealAlbumTrigger stays closure-light, mounts on Dashboard always and DailyRecap only when non-empty', async () => {
  // Real bundler code-split verification: entry chunk never pulls seal SVG, storage, dialog, or CSS; SealAlbumDialog splits into an async chunk.
  const split = await inspectCodeSplit('ui/seal-press/LazySealAlbumTrigger.jsx');
  for (const heavy of ['seal-generator.js', 'postcard-svg.js', 'SealAlbumView', 'SealAlbumDialog.jsx', 'seal-storage.js']) {
    assert.equal(split.entryInputs.some((f) => f.includes(heavy)), false, `entry chunk must not statically import ${heavy}`);
  }
  assert.equal(split.entryInputs.some((f) => f.endsWith('.css')), false, 'entry chunk must not statically import CSS');
  assert.equal(split.dynamicEntryPoints.includes('ui/seal-press/SealAlbumDialog.jsx'), true, 'SealAlbumDialog.jsx must be dynamically code-split');
  assert.ok(split.dynamicImports.some((p) => p.includes('SealAlbumDialog')), 'entry chunk must load SealAlbumDialog via dynamic import()');

  const prevStorage = globalThis.localStorage;
  const mem = makeMemoryStorage();
  globalThis.localStorage = mem;
  mod.setUiLanguage('zh');
  try {
    // Empty album: Dashboard trigger visible, DailyRecap trigger hidden
    const dashEmpty = renderToStaticMarkup(React.createElement(mod.Dashboard, {
      data: { root: 'r', decks: [], focus: { course: '*', courses: [{ name: 'CS' }] } },
      onStartScope: () => {},
    }));
    assert.match(dashEmpty, /data-testid="seal-album-trigger"/);
    assert.match(textOf(dashEmpty), /藏书印谱/);
    assert.doesNotMatch(dashEmpty, /掌握度/);

    const recapEmpty = renderToStaticMarkup(React.createElement(
      mod.StudyServicesContext.Provider,
      { value: { call: async () => ({ groups: [] }), busy: false } },
      React.createElement(mod.DailyRecapPanel, { root: 'r', onSettings: () => {} }),
    ));
    assert.doesNotMatch(recapEmpty, /data-testid="seal-album-trigger"/);

    // Populate 2 album entries -> both triggers render with count (2)
    mod.saveSealAlbumEntry(makeEntry({ id: 'a1' }), mem);
    mod.saveSealAlbumEntry(makeEntry({ id: 'a2', sealId: 'night-study', sealChars: ['夜', '读'] }), mem);

    const recapNonEmpty = renderToStaticMarkup(React.createElement(
      mod.StudyServicesContext.Provider,
      { value: { call: async () => ({ groups: [] }), busy: false } },
      React.createElement(mod.DailyRecapPanel, { root: 'r', onSettings: () => {} }),
    ));
    assert.match(recapNonEmpty, /data-testid="seal-album-trigger"/);
    assert.match(textOf(recapNonEmpty), /藏书印谱 \(2\)/);

    mod.setUiLanguage('en');
    const triggerEn = renderToStaticMarkup(React.createElement(mod.LazySealAlbumTrigger, { onlyWhenNonEmpty: true }));
    assert.match(textOf(triggerEn), /Seal Album \(2\)/);
    assert.doesNotMatch(textOf(triggerEn), HAN);

    // Interactive behavior: loads SealAlbumDialog dynamically on click without React.lazy suspension
    await withBrowserGlobals(async () => {
      const ui = await loadInteractiveUi(`
        export { default as LazySealAlbumTrigger } from './ui/seal-press/LazySealAlbumTrigger.jsx';
      `);
      const mounted = ui.mount(() => ui.React.createElement(ui.exports.LazySealAlbumTrigger, { onlyWhenNonEmpty: true }));
      try {
        assert.equal(mounted.find((n) => n.props?.['data-testid'] === 'seal-album-dialog'), null, 'dialog stays unmounted before click');
        const btn = mounted.find((n) => n.props?.['data-testid'] === 'seal-album-trigger' && typeof n.props?.onClick === 'function');
        assert.ok(btn, 'trigger button renders synchronously');
        await mounted.act(() => click(btn));
        await mounted.flush(5);
        assert.ok(mounted.find((n) => n.props?.['data-testid'] === 'seal-album-dialog'), 'clicking trigger dynamically imports and mounts SealAlbumDialog');
      } finally {
        mounted.unmount();
      }
    });
  } finally {
    mod.setUiLanguage('zh');
    globalThis.localStorage = prevStorage;
  }
});

test('WrongBookClearStamp & LazyWrongBookClearStamp enforce lazy boundary, full-motion confetti guard, and zh/en SSR', async () => {
  // Real bundler code-split verification for LazyWrongBookClearStamp -> WrongBookClearStamp
  const split = await inspectCodeSplit('ui/seal-press/LazyWrongBookClearStamp.jsx');
  assert.equal(split.entryInputs.some((f) => f.endsWith('/WrongBookClearStamp.jsx')), false, 'LazyWrongBookClearStamp must not statically import WrongBookClearStamp');
  assert.equal(split.entryInputs.some((f) => f.endsWith('.css')), false, 'LazyWrongBookClearStamp must not statically import CSS');
  assert.equal(split.dynamicEntryPoints.includes('ui/seal-press/WrongBookClearStamp.jsx'), true, 'WrongBookClearStamp.jsx must be dynamically code-split');
  assert.ok(split.dynamicImports.some((p) => p.includes('WrongBookClearStamp')), 'entry chunk must load WrongBookClearStamp via dynamic import()');

  // Interactive runtime check: LazyWrongBookClearStamp loads on demand when clearedCount > 0, and WrongBookClearStamp fires confetti ONLY under data-motion="full"
  const confettiCalls = [];
  const confettiSpyPlugin = {
    name: 'spy-seal-confetti',
    setup(builder) {
      builder.onResolve({ filter: /\.\/confetti-burst\.js$/ }, () => ({ path: 'confetti-burst', namespace: 'spy-confetti' }));
      builder.onLoad({ filter: /.*/, namespace: 'spy-confetti' }, () => ({
        contents: `export const fireSealConfetti = (opts) => { globalThis.__WB_CONFETTI_CALLS__.push(opts); return Promise.resolve(); };`,
        loader: 'js',
      }));
    },
  };
  globalThis.__WB_CONFETTI_CALLS__ = confettiCalls;
  try {
    let motionAttr = 'reduced';
    let reducedMedia = false;
    await withBrowserGlobals(async () => {
      const lazyUi = await loadInteractiveUi(`
        export { default as LazyWrongBookClearStamp } from './ui/seal-press/LazyWrongBookClearStamp.jsx';
      `, { plugins: [confettiSpyPlugin] });

      const inactive = lazyUi.mount(() => lazyUi.React.createElement(lazyUi.exports.LazyWrongBookClearStamp, { clearedCount: 0, course: 'CS5223' }));
      await inactive.flush(5);
      assert.equal(inactive.find((n) => n.props?.['data-testid'] === 'wb-clear-stamp'), null, 'clearedCount=0 stays unmounted');
      inactive.unmount();

      const active = lazyUi.mount(() => lazyUi.React.createElement(lazyUi.exports.LazyWrongBookClearStamp, { clearedCount: 4, course: 'CS5223' }));
      await active.flush(5);
      assert.ok(active.find((n) => n.props?.['data-testid'] === 'wb-clear-stamp'), 'clearedCount>0 dynamically loads WrongBookClearStamp');
      assert.equal(confettiCalls.length, 0, 'data-motion="reduced" must never fire confetti');
      active.unmount();

      // Switch to data-motion="full" with OS reduced-motion off -> arrival + click both fire confetti
      motionAttr = 'full';
      reducedMedia = false;
      const fullUi = await loadInteractiveUi(`
        export { default as WrongBookClearStamp } from './ui/seal-press/WrongBookClearStamp.jsx';
      `, { plugins: [confettiSpyPlugin] });
      const fullMount = fullUi.mount(() => fullUi.React.createElement(fullUi.exports.WrongBookClearStamp, { clearedCount: 6, course: 'CS5223' }));
      try {
        await fullMount.flush(3);
        assert.equal(confettiCalls.length, 1, 'arrival under data-motion="full" fires one clean-sweep confetti burst');
        assert.equal(confettiCalls[0].variant, 'clean-sweep');

        const sealBtn = fullMount.find((n) => typeof n.props?.className === 'string' && n.props.className.includes('sh-wb-clear__trigger') && typeof n.props?.onClick === 'function');
        assert.ok(sealBtn, 'seal trigger button exists');
        await fullMount.act(() => click(sealBtn));
        assert.equal(confettiCalls.length, 2, 'pressing the seal under data-motion="full" fires stamp confetti');
        assert.equal(confettiCalls[1].variant, 'stamp');

        // Switching to data-motion="off" or OS prefers-reduced-motion suppresses subsequent seal press confetti
        motionAttr = 'off';
        await fullMount.act(() => click(sealBtn));
        assert.equal(confettiCalls.length, 2, 'data-motion="off" suppresses confetti on seal press');

        motionAttr = null;
        reducedMedia = true;
        await fullMount.act(() => click(sealBtn));
        assert.equal(confettiCalls.length, 2, 'OS prefers-reduced-motion without explicit data-motion="full" suppresses confetti');

        // Clicking album button dynamically loads SealAlbumDialog via useLiveEffect
        const albumBtn = fullMount.find((n) => n.props?.['data-testid'] === 'wb-clear-album-btn' && typeof n.props?.onClick === 'function');
        assert.ok(albumBtn);
        await fullMount.act(() => click(albumBtn));
        await fullMount.flush(5);
        assert.ok(fullMount.find((n) => n.props?.['data-testid'] === 'seal-album-dialog'), 'clicking album button loads SealAlbumDialog');
      } finally {
        fullMount.unmount();
      }
    }, {
      document: {
        querySelector: (sel) => (sel.includes('.study-app') ? { getAttribute: (name) => (name === 'data-motion' ? motionAttr : null) } : null),
      },
      window: {
        matchMedia: () => ({ matches: reducedMedia, addEventListener() {}, removeEventListener() {} }),
      },
    });
  } finally {
    delete globalThis.__WB_CONFETTI_CALLS__;
  }

  mod.setUiLanguage('zh');
  try {
    assert.equal(
      renderToStaticMarkup(React.createElement(mod.WrongBookClearStamp, { clearedCount: 0 })),
      '',
      'stays hidden when nothing has been cleared',
    );

    const stampZh = renderToStaticMarkup(React.createElement(mod.WrongBookClearStamp, { clearedCount: 6, course: 'CS5223' }));
    assert.match(stampZh, /data-testid="wb-clear-stamp"/);
    assert.match(stampZh, /data-seal-id="wrongbook-cleared"/);
    assert.match(stampZh, /sh-ink-mark-host/);
    assert.match(stampZh, /data-testid="wb-clear-postcard-btn"/);
    assert.match(stampZh, /data-testid="wb-clear-album-btn"/);
    assert.match(textOf(stampZh), /错题清零/);
    assert.match(textOf(stampZh), /生成清零纪念明信片/);
    assert.match(textOf(stampZh), /藏书印谱馆/);

    mod.setUiLanguage('en');
    const stampEn = renderToStaticMarkup(React.createElement(mod.WrongBookClearStamp, { clearedCount: 1, course: 'CS5223' }));
    assert.match(textOf(stampEn), /Mistakes Cleared/);
    assert.match(textOf(stampEn), /You have cleared 1 mistake so far/);
    assert.match(textOf(stampEn), /Create clearance postcard/);
    assert.match(textOf(stampEn), /Seal Album Gallery/);
    assert.doesNotMatch(textOf(stampEn), HAN, 'zero Han in English WrongBookClearStamp text');
  } finally {
    mod.setUiLanguage('zh');
  }
});
