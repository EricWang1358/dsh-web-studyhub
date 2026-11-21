import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

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
    assert.doesNotMatch(htmlZh, /掌握度/, 'zero 掌握度 substring in SealAlbumDialog');

    const emptyZh = renderToStaticMarkup(React.createElement(mod.SealAlbumDialog, { entries: [], onClose: noop }));
    assert.match(emptyZh, /data-testid="seal-gallery-empty"/);
    assert.match(textOf(emptyZh), /已集齐 0 \/ 5 方/);

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

test('LazySealAlbumTrigger stays closure-light, mounts on Dashboard always and DailyRecap only when non-empty', () => {
  const triggerSrc = readFileSync('ui/seal-press/LazySealAlbumTrigger.jsx', 'utf8');
  assert.doesNotMatch(triggerSrc, /React\.lazy/);
  assert.doesNotMatch(triggerSrc, /from '\.\/(?:seal-generator|postcard-svg|SealAlbumView|SealAlbumDialog|seal-storage)/);
  assert.doesNotMatch(triggerSrc, /\.css['"]/);
  assert.match(triggerSrc, /useLiveEffect/);
  assert.match(triggerSrc, /import\('\.\/SealAlbumDialog\.jsx'\)/);

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
  } finally {
    mod.setUiLanguage('zh');
    globalThis.localStorage = prevStorage;
  }
});

test('WrongBookClearStamp & LazyWrongBookClearStamp enforce lazy boundary, full-motion confetti guard, and zh/en SSR', () => {
  const lazySrc = readFileSync('ui/seal-press/LazyWrongBookClearStamp.jsx', 'utf8');
  assert.doesNotMatch(lazySrc, /React\.lazy/);
  assert.match(lazySrc, /useLiveEffect/);
  assert.match(lazySrc, /import\('\.\/WrongBookClearStamp\.jsx'\)/);

  const stampSrc = readFileSync('ui/seal-press/WrongBookClearStamp.jsx', 'utf8');
  assert.doesNotMatch(stampSrc, /React\.lazy/);
  assert.match(stampSrc, /data-motion.*full|=== 'full'/);
  assert.match(stampSrc, /useLiveEffect/);

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
