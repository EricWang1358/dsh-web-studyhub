import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import { StudyService } from '../lib/service.js';
import { createHostHandler } from '../lib/host.js';
import { createLibraryEventBus } from '../lib/runtime/library-watch.js';

async function withTempRoot(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'study-perf-reg-'));
  try {
    return await fn(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function seedBaguLibrary(root, { deckCount = 12, cardsPerDeck = 50, sourceCount = 30, attemptCount = 1200 } = {}) {
  const now = new Date().toISOString();
  const decks = [];
  const sources = [];
  const documents = [];
  const attempts = [];

  for (let s = 0; s < sourceCount; s++) {
    const course = `八股 / 模块${(Math.floor(s / 2) % 4) + 1}`;
    const docId = `doc-${s}`;
    const srcId = `src-${s}`;
    const rev = `rev-${s}`;
    const text = `# 专题 ${s}\n\n## 核心原理 ${s}\n\n这里详细阐述了核心原理 ${s} 的关键机制与并发控制细节。\n\n## 常见面试追问 ${s}\n\n面试常考对比项 ${s}，需要结合时间复杂度与内存开销作答。\n`;
    sources.push({
      id: srcId,
      title: `八股资料-${s}.md`,
      text,
      format: 'markdown',
      courses: [course],
      createdAt: now,
      importedAt: now,
      document: { materialId: docId, materialRevision: rev, format: 'md', filename: `bagu-${s}.md` },
    });
    documents.push({
      id: docId,
      title: `八股资料-${s}.md`,
      filename: `bagu-${s}.md`,
      format: 'md',
      currentRevision: rev,
      versions: [{ revision: rev, sourceIds: [srcId], importedAt: now, attachment: null }],
    });
  }

  for (let d = 0; d < deckCount; d++) {
    const course = `八股 / 模块${(d % 4) + 1}`;
    const cards = [];
    for (let c = 0; c < cardsPerDeck; c++) {
      const srcIdx = (d * 2 + (c % 2)) % sourceCount;
      const srcId = `src-${srcIdx}`;
      const docId = `doc-${srcIdx}`;
      const rev = `rev-${srcIdx}`;
      const quote = `这里详细阐述了核心原理 ${srcIdx} 的关键机制与并发控制细节。`;
      const start = sources[srcIdx].text.indexOf(quote);
      cards.push({
        id: `c-${d}-${c}`,
        kind: 'quiz',
        prompt: `模块 ${(d % 4) + 1} 问题 ${d}-${c}：核心原理是什么？`,
        options: [
          { id: 'A', text: '机制 A', correct: true },
          { id: 'B', text: '机制 B', correct: false },
          { id: 'C', text: '机制 C', correct: false },
          { id: 'D', text: '机制 D', correct: false },
        ],
        answer: '机制 A',
        explanation: `解析：参考核心原理 ${srcIdx}。`,
        topic: `主题 ${(c % 5) + 1}`,
        citations: [{
          sourceId: srcId,
          quote,
          selection: { documentId: docId, revision: rev, sourceId: srcId, start, end: start + quote.length, quote },
        }],
        selections: [{ documentId: docId, revision: rev, sourceId: srcId, start, end: start + quote.length, quote }],
        review: { reps: 1, stability: 4, difficulty: 5, state: 2, due: new Date(Date.now() - 3600_000).toISOString(), lastReview: now },
      });
    }
    decks.push({ id: `deck-${d}`, title: `题组-${d}`, course, cards, createdAt: now, updatedAt: now });
  }

  for (let a = 0; a < attemptCount; a++) {
    attempts.push({
      id: `att-${a}`,
      deckId: `deck-${a % deckCount}`,
      cardId: `c-${a % deckCount}-${a % cardsPerDeck}`,
      correct: true,
      grade: 4,
      at: new Date(Date.now() - (attemptCount - a) * 60_000).toISOString(),
    });
  }

  const service = new StudyService(root);
  await service.store.update(state => {
    state.sources = sources;
    state.documents = documents;
    state.decks = decks;
    state.attempts = attempts;
    state.courses = [{
      name: '八股 / 模块1',
      outline: {
        version: 1,
        generatedAt: now,
        nodes: [
          { id: 'n-1', title: '核心原理 0', level: 1, sourceIds: ['src-0'], children: [] },
        ],
      },
    }];
  });
  return service;
}

function measureClonesAndStringify(fn) {
  const origClone = globalThis.structuredClone;
  const origStringify = JSON.stringify;
  let clones = 0;
  let stringifyBytes = 0;
  globalThis.structuredClone = (...args) => { clones++; return origClone(...args); };
  JSON.stringify = (...args) => {
    const out = origStringify(...args);
    if (typeof out === 'string') stringifyBytes += out.length;
    return out;
  };
  return Promise.resolve().then(fn).then(
    result => {
      globalThis.structuredClone = origClone;
      JSON.stringify = origStringify;
      return { result, clones, stringifyBytes };
    },
    err => {
      globalThis.structuredClone = origClone;
      JSON.stringify = origStringify;
      throw err;
    },
  );
}

test('quiet local study & reading writes do not trigger self-write watcher storm, while external writes still fire', async () => {
  await withTempRoot(async root => {
    await seedBaguLibrary(root, { deckCount: 3, cardsPerDeck: 10, sourceCount: 4, attemptCount: 10 });
    const libraryEvents = createLibraryEventBus({ debounceMs: 50, pollMs: 120 });
    const cleanups = [];
    const sessions = new Map([['sess-1', { header: { cwd: root } }]]);
    const ctx = {
      sessions,
      get(name) { return name === 'sessions' ? sessions : undefined; },
      effect(setup) {
        const dispose = setup();
        if (typeof dispose === 'function') cleanups.push(dispose);
      },
    };
    const handler = createHostHandler(ctx, {}, undefined, { owner: ctx, libraryEvents });
    const invoke = (action, args) => handler('call', { action, args, sessionId: 'sess-1' });

    const events = [];
    const unsubscribe = libraryEvents.subscribe(root, event => events.push(event));
    try {
      // Wait for initial watcher baseline to settle
      await new Promise(resolve => setTimeout(resolve, 160));
      events.length = 0;

      const started = await invoke('review.start', { mode: 'quiz', deckId: 'deck-0', count: 5 });
      assert.equal(started.ok, true, `review.start failed: ${JSON.stringify(started.error)}`);
      const runId = started.value.id;
      const firstCardId = started.value.card.id;
      // Wait for review.start (not a quiet action) to settle, then clear events before testing quiet in-session actions.
      await new Promise(resolve => setTimeout(resolve, 260));
      events.length = 0;

      const answered = await invoke('review.answer', { runId, cardId: firstCardId, selected: ['A'] });
      assert.equal(answered.ok, true, `review.answer failed: ${JSON.stringify(answered.error)}`);
      assert.equal(answered.value.complete, false);

      const moved = await invoke('review.move', { runId, index: 2 });
      assert.equal(moved.ok, true, `review.move failed: ${JSON.stringify(moved.error)}`);

      const savedRead = await invoke('materials.reading.save', {
        documentId: 'doc-0', revision: 'rev-0', read: [{ id: 'ch-1', title: '核心原理 0' }],
      });
      assert.equal(savedRead.ok, true, `materials.reading.save failed: ${JSON.stringify(savedRead.error)}`);

      // Exceed both debounce (50ms) and fallback poll (120ms) windows
      await new Promise(resolve => setTimeout(resolve, 320));
      assert.equal(events.length, 0, `expected 0 self-write watcher events for quiet local mutations, got ${JSON.stringify(events)}`);

      // An external StudyService write MUST still wake subscribers within <1.2s
      const external = new StudyService(root);
      await external.call('course.save', { name: 'External Course', exam: { target: '2027-06' } });
      const deadline = Date.now() + 1200;
      while (events.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 40));
      }
      assert.ok(events.length >= 1, 'external write must still emit a watcher event');
      assert.equal(events[0].reason, 'disk');
    } finally {
      unsubscribe();
      libraryEvents.dispose();
      await Promise.allSettled(cleanups.map(fn => fn?.()));
    }
  });
});

test('review.answer bounds structuredClone and JSON.stringify to the touched deck & tail attempt chunk, while preserving prerequisite credit & undo', async () => {
  await withTempRoot(async root => {
    const service = await seedBaguLibrary(root, { deckCount: 12, cardsPerDeck: 50, sourceCount: 12, attemptCount: 1200 });
    const started = await service.call('review.start', { mode: 'quiz', deckId: 'deck-0', count: 5 });

    const { result, clones, stringifyBytes } = await measureClonesAndStringify(() =>
      service.call('review.answer', { runId: started.id, cardId: started.card.id, selected: ['A'] }));
    assert.equal(result.complete, false);
    // Previously cloned all 600+ cards (2000+ clones in 2000-card banks) and stringified all decks + full attempt chunks (>600KB).
    assert.ok(clones < 80, `expected bounded clones (<80) on review.answer, got ${clones}`);
    assert.ok(stringifyBytes < 220_000, `expected bounded stringify (<220KB) reusing untouched decks & prefix attempt chunk, got ${stringifyBytes}`);

    // Verify prerequisite credit + undo still work when card.requires crosses decks!
    const moved = await service.call('review.move', { runId: started.id, index: 1 });
    const secondCardId = moved.card.id;
    await service.store.update(state => {
      const targetDeck = state.decks.find(d => d.id === 'deck-0');
      const prereqDeck = state.decks.find(d => d.id === 'deck-1');
      const targetCard = targetDeck.cards.find(c => c.id === secondCardId);
      const prereqCard = prereqDeck.cards[0];
      prereqCard.review = { reps: 1, stability: 2, difficulty: 5, state: 2, due_at: new Date(Date.now() - 86_400_000).toISOString(), last_review: new Date(Date.now() - 172_800_000).toISOString() };
      targetCard.requires = [{ deckId: 'deck-1', cardId: prereqCard.id }];
    });
    const beforePrereq = (await service.store.read()).decks.find(d => d.id === 'deck-1').cards[0].review;
    await service.call('review.answer', { runId: started.id, cardId: secondCardId, selected: ['A'] });
    const afterPrereq = (await service.store.read()).decks.find(d => d.id === 'deck-1').cards[0].review;
    assert.notEqual(afterPrereq.last_review, beforePrereq.last_review, 'prerequisite card in another deck must still receive implicit credit');

    await service.call('review.undo', { runId: started.id });
    const undonePrereq = (await service.store.read()).decks.find(d => d.id === 'deck-1').cards[0].review;
    assert.equal(undonePrereq.last_review, beforePrereq.last_review, 'review.undo must roll back cross-deck prerequisite credit');
  });
});

test('concurrent review.move + review.answer across two decks in one run keeps the target deck writable', async () => {
  await withTempRoot(async root => {
    const service = await seedBaguLibrary(root, { deckCount: 4, cardsPerDeck: 6, sourceCount: 4, attemptCount: 20 });
    const started = await service.call('review.start', {
      mode: 'path',
      scope: [{ deckId: 'deck-0' }, { deckId: 'deck-1' }],
      fresh: true,
    });
    const runState = (await service.store.read()).runs.find(r => r.id === started.id);
    const firstDeckId = runState.entries[0].deckId;
    const otherIdx = runState.entries.findIndex(e => e.deckId && e.deckId !== firstDeckId);
    assert.ok(otherIdx > 0, 'multi-deck path run must include an entry from a second deck');
    const otherEntry = runState.entries[otherIdx];
    const beforeOther = (await service.store.read()).decks
      .find(d => d.id === otherEntry.deckId).cards
      .find(c => c.id === otherEntry.card.id).review;

    // Fire review.move (to Deck B) and review.answer (for Deck B's cardId) concurrently before move commits.
    const [moved, answered] = await Promise.all([
      service.call('review.move', { runId: started.id, index: otherIdx }),
      service.call('review.answer', { runId: started.id, cardId: otherEntry.card.id, selected: ['A'] }),
    ]);
    assert.equal(moved.index, otherIdx);
    assert.equal(answered.feedback?.correct, true);
    const afterOther = (await service.store.read()).decks
      .find(d => d.id === otherEntry.deckId).cards
      .find(c => c.id === otherEntry.card.id).review;
    assert.notEqual(afterOther.last_review, beforeOther.last_review, 'target card in second deck must be updated without frozen-deck error');
  });
});

test('card.place reuses cached course document index across review.answer turns and stays accurate & fast', async () => {
  await withTempRoot(async root => {
    const service = await seedBaguLibrary(root, { deckCount: 15, cardsPerDeck: 50, sourceCount: 30, attemptCount: 100 });
    const started = await service.call('review.start', { mode: 'quiz', deckId: 'deck-0', count: 5 });

    const p1 = await service.call('card.place', { deckId: 'deck-0', cardId: 'c-0-0' });
    assert.equal(p1.document?.title, '八股资料-0.md');

    // Answering increments library revision and replaces decks, but sources/documents/courses stay frozen!
    await service.call('review.answer', { runId: started.id, cardId: started.card.id, selected: ['A'] });
    // Deterministic clone budget on the first post-answer lookup (also warms JIT / post-answer state).
    const { result: p2, clones } = await measureClonesAndStringify(() =>
      service.call('card.place', { deckId: 'deck-0', cardId: 'c-0-1' }));

    assert.equal(p2.document?.title, '八股资料-1.md');
    assert.ok(clones <= 5, `expected minimal clones on card.place, got ${clones}`);

    // Median CPU time across 7 cached lookups filters out parallel CI disk/scheduler jitter while catching O(N) rebuild regressions.
    const cpuSamples = [];
    for (let i = 0; i < 7; i += 1) {
      const cpuBefore = process.cpuUsage();
      const placed = await service.call('card.place', { deckId: 'deck-0', cardId: `c-0-${i + 1}` });
      const cpuUsed = process.cpuUsage(cpuBefore);
      assert.equal(placed.document?.title, `八股资料-${(i + 1) % 2}.md`);
      cpuSamples.push((cpuUsed.user + cpuUsed.system) / 1000);
    }
    cpuSamples.sort((a, b) => a - b);
    const medianCpuMs = cpuSamples[3];
    assert.ok(medianCpuMs < 30, `expected cached single-card card.place median < 30ms CPU, took ${medianCpuMs.toFixed(1)}ms CPU`);
  });
});

test('read-only materials endpoints do not clone the whole library and return complete views', async () => {
  await withTempRoot(async root => {
    const service = await seedBaguLibrary(root, { deckCount: 12, cardsPerDeck: 50, sourceCount: 40, attemptCount: 200 });

    const checks = [
      ['materials.document.get', { documentId: 'doc-0' }, 5],
      ['materials.annotation.list', { documentId: 'doc-0', revision: 'rev-0' }, 5],
      ['materials.marks.list', { documentId: 'doc-0', revision: 'rev-0' }, 5],
      ['materials.pages.cards', { documentId: 'doc-0' }, 5],
      ['coverage.get', { documentId: 'doc-0' }, 5],
      ['materials.reading.get', { documentId: 'doc-0', revision: 'rev-0' }, 5],
    ];

    for (const [action, args, maxClones] of checks) {
      const { result, clones } = await measureClonesAndStringify(() => service.call(action, args));
      assert.ok(result, `${action} must return a result`);
      assert.ok(clones <= maxClones, `${action} cloned ${clones} times (budget <= ${maxClones})`);
      if (action === 'materials.pages.cards') {
        assert.equal(result.status, 'ok');
        assert.ok(result.cards.length > 0, 'materials.pages.cards must find linked cards for doc-0');
      }
      if (action === 'coverage.get') {
        assert.equal(result.status, 'ok');
        assert.ok(result.coverage.leaves > 0, 'coverage.get must compute sections');
      }
    }

    const linksRun = await measureClonesAndStringify(() =>
      service.call('materials.links.list', { documentId: 'doc-0' }));
    assert.ok(linksRun.result.links.length > 0, 'materials.links.list must find links');
    // Previously cloned the document + selection for every link (2x link count); now at most ~1 clone per link for the selection DTO.
    assert.ok(linksRun.clones <= linksRun.result.links.length + 4, `materials.links.list cloned ${linksRun.clones} times for ${linksRun.result.links.length} links`);
  });
});

test('formulaViewHtml caches repeated KaTeX renders and useReadingPosition onProgress avoids scroll re-renders', async () => {
  // 1. Verify formulaViewHtml LRU cache avoids re-invoking renderStudyFormula for repeated formulas
  const formulaBuild = await build({
    stdin: {
      contents: `export { formulaViewHtml } from './ui/document-preview/reader/formula.js';`,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    plugins: [{
      name: 'spy-formula',
      setup(b) {
        b.onResolve({ filter: /study-math-render\.js$/ }, () => ({ path: 'spy-math', namespace: 'spy' }));
        b.onLoad({ filter: /.*/, namespace: 'spy' }, () => ({
          contents: `export function renderStudyFormula(src, display) {
            globalThis.__FORMULA_CALLS__ = (globalThis.__FORMULA_CALLS__ || 0) + 1;
            return '<math data-d="' + (display ? 1 : 0) + '">' + src + '</math>';
          }`,
          loader: 'js',
        }));
      },
    }],
  });
  globalThis.__FORMULA_CALLS__ = 0;
  const formulaMod = { exports: {} };
  new Function('module', 'exports', formulaBuild.outputFiles[0].text)(formulaMod, formulaMod.exports);
  const { formulaViewHtml } = formulaMod.exports;

  const samples = [
    { source: 'O(n \\log n)', display: false, raw: '$O(n \\log n)$' },
    { source: 'E = mc^2', display: true, raw: '$$E = mc^2$$' },
    { source: 'P(A|B)', display: false, raw: '$P(A|B)$', label: '1' },
  ];
  for (let i = 0; i < 60; i++) {
    const html = formulaViewHtml(samples[i % samples.length]);
    assert.ok(html.includes('<math'));
  }
  assert.equal(globalThis.__FORMULA_CALLS__, 3, `expected 3 KaTeX renders for 60 calls across 3 unique formulas, got ${globalThis.__FORMULA_CALLS__}`);
  delete globalThis.__FORMULA_CALLS__;

  // 2. Verify useReadingPosition with { onProgress } triggers 0 React re-renders during scroll progress updates between headings
  const hookRuntime = {
    slots: [],
    effects: [],
    cursor: 0,
    renders: 0,
    rerender: null,
    sameDeps(a, b) {
      if (!a || !b || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
      return true;
    },
    makeReact() {
      const rt = this;
      const useState = (init) => {
        const idx = rt.cursor++;
        if (rt.slots.length <= idx) rt.slots[idx] = typeof init === 'function' ? init() : init;
        const setState = (next) => {
          const prev = rt.slots[idx];
          const val = typeof next === 'function' ? next(prev) : next;
          if (!Object.is(prev, val)) {
            rt.slots[idx] = val;
            rt.rerender?.();
          }
        };
        return [rt.slots[idx], setState];
      };
      const useRef = (init) => {
        const idx = rt.cursor++;
        if (rt.slots.length <= idx) rt.slots[idx] = { current: init };
        return rt.slots[idx];
      };
      const useCallback = (fn, deps) => {
        const idx = rt.cursor++;
        const prev = rt.slots[idx];
        if (!prev || !rt.sameDeps(prev.deps, deps)) rt.slots[idx] = { fn, deps };
        return rt.slots[idx].fn;
      };
      const useEffect = (fn, deps) => {
        const idx = rt.cursor++;
        const prev = rt.slots[idx];
        if (!prev || !rt.sameDeps(prev.deps, deps)) {
          rt._pendingEffects.push(() => {
            if (typeof prev?.cleanup === 'function') prev.cleanup();
            const cleanup = fn();
            rt.slots[idx] = { deps, cleanup };
            rt.effects[idx] = rt.slots[idx];
          });
        }
      };
      return { useState, useRef, useCallback, useEffect };
    },
    run(fn) {
      let out;
      let dirty = true;
      let guard = 0;
      while (dirty) {
        if (++guard > 10) throw new Error('Too many renders');
        dirty = false;
        this.renders++;
        this.cursor = 0;
        this._pendingEffects = [];
        this.rerender = () => { dirty = true; };
        out = fn();
        for (const eff of this._pendingEffects) eff();
        this.rerender = null;
      }
      return out;
    },
    cleanup() {
      for (const eff of this.effects) if (typeof eff?.cleanup === 'function') eff.cleanup();
    },
  };

  const posBuild = await build({
    stdin: {
      contents: `export { useReadingPosition } from './ui/document-preview/reader/useReadingPosition.js';`,
      resolveDir: process.cwd(),
      loader: 'js',
    },
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    plugins: [{
      name: 'mock-react',
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'mock-react' }));
        b.onLoad({ filter: /.*/, namespace: 'mock-react' }, () => ({
          contents: `module.exports = globalThis.__TEST_HOOK_REACT__;`,
          loader: 'js',
        }));
      },
    }],
  });

  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  const origIO = globalThis.IntersectionObserver;
  const origRO = globalThis.ResizeObserver;
  const rafQueue = [];
  globalThis.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
  globalThis.cancelAnimationFrame = () => {};
  delete globalThis.IntersectionObserver;
  delete globalThis.ResizeObserver;
  globalThis.__TEST_HOOK_REACT__ = hookRuntime.makeReact();

  try {
    const posMod = { exports: {} };
    new Function('module', 'exports', posBuild.outputFiles[0].text)(posMod, posMod.exports);
    const { useReadingPosition } = posMod.exports;

    const listeners = {};
    const h1 = { getAttribute: attr => (attr === 'data-outline-id' ? 'h1' : null), getBoundingClientRect: () => ({ top: -100 }) };
    const h2 = { getAttribute: attr => (attr === 'data-outline-id' ? 'h2' : null), getBoundingClientRect: () => ({ top: 800 }) };
    const element = {
      scrollTop: 0,
      scrollHeight: 5000,
      clientHeight: 1000,
      getBoundingClientRect: () => ({ top: 0 }),
      querySelectorAll: () => [h1, h2],
      addEventListener: (type, cb) => { listeners[type] = cb; },
      removeEventListener: (type) => { delete listeners[type]; },
    };
    const scroller = { current: element };
    const items = [{ id: 'h1' }, { id: 'h2' }];
    const reportedProgress = [];

    const renderComponent = () => hookRuntime.run(() =>
      useReadingPosition(scroller, items, 'v1', { onProgress: p => reportedProgress.push(p) }));

    renderComponent();
    const rendersAfterMount = hookRuntime.renders;
    assert.equal(reportedProgress.length, 1);
    assert.equal(reportedProgress[0], 0);

    // Simulate 25 scroll ticks staying within heading h1 (h2 stays below fold)
    hookRuntime.rerender = () => { renderComponent(); };
    for (let step = 1; step <= 25; step++) {
      element.scrollTop = step * 100;
      listeners.scroll();
      while (rafQueue.length) rafQueue.shift()();
    }
    assert.equal(hookRuntime.renders, rendersAfterMount, 'scrolling within a heading must trigger 0 React re-renders when onProgress is supplied');
    assert.equal(reportedProgress.length, 26, 'onProgress must receive every scroll progress update');
    assert.ok(reportedProgress.at(-1) > 0.6, `expected final progress > 0.6, got ${reportedProgress.at(-1)}`);

    // Now cross heading h2: MUST re-render once to update activeId
    h2.getBoundingClientRect = () => ({ top: 10 });
    element.scrollTop = 3000;
    listeners.scroll();
    while (rafQueue.length) rafQueue.shift()();
    assert.equal(hookRuntime.renders, rendersAfterMount + 1, 'crossing a heading must trigger exactly 1 React re-render');
  } finally {
    hookRuntime.cleanup();
    delete globalThis.__TEST_HOOK_REACT__;
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
    if (origIO !== undefined) globalThis.IntersectionObserver = origIO;
    if (origRO !== undefined) globalThis.ResizeObserver = origRO;
  }
});
