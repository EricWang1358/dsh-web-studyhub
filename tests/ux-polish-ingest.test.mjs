import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseCss } from '../scripts/qa/guardrail-baseline.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { inApp } from './helpers/fake-app.mjs';
import { loadInteractiveUi, withBrowserGlobals, textOf } from './helpers/react-harness.mjs';

const m = await loadUi(`
  export { AppContext } from './ui/app/app-context.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { default as JsonImport, previewJsonImport } from './ui/JsonImport.jsx';
  export { default as Draft } from './ui/Draft.jsx';
  export { default as Manage, filterManageCards } from './ui/Manage.jsx';
  export { default as LargeDocumentCard } from './ui/LargeDocumentCard.jsx';
  export { default as Generate } from './ui/Generate.jsx';
  export { default as AudioImport } from './ui/AudioImport.jsx';
  export { default as LiveClass } from './ui/LiveClass.jsx';
  export { moreValuesOf } from './ui/generate-form.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const interactive = await loadInteractiveUi(`
  export { default as JsonImport } from './ui/JsonImport.jsx';
  export { default as TooBigChoice } from './ui/TooBigChoice.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { ToastContext } from './ui/components/index.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const hi = interactive.React.createElement;
const noop = () => {};
const HAN = /[\u3400-\u9fff]/;
const render = (element, { lang = 'zh', data = {} } = {}) => {
  m.setUiLanguage(lang);
  try {
    return renderToStaticMarkup(inApp(m, element, { data }));
  } finally {
    m.setUiLanguage('zh');
  }
};
const stripTags = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------- 1. JsonImport ---------- */

test('JsonImport: previewJsonImport parses valid deck JSON locally with zero AI calls and rejects invalid inputs', () => {
  assert.deepEqual(
    m.previewJsonImport(JSON.stringify({ title: 'OS Ch1', cards: [{ prompt: 'Q1' }, { prompt: 'Q2' }] })),
    { count: 2, title: 'OS Ch1' },
  );
  assert.deepEqual(
    m.previewJsonImport('\uFEFF```json\n{"cards":[{"prompt":"Q1"}]}\n```'),
    { count: 1, title: '' },
  );
  for (const invalid of ['', 'not json', '[]', '{"cards":[]}', 'null', '{"title":"only"}']) {
    assert.equal(m.previewJsonImport(invalid), null, invalid);
  }
});

test('JsonImport: import form comes before collapsed prompt fold, and submit arrow follows proposal state', async () => {
  const html = render(h(m.JsonImport, { data: { focus: { courses: [] }, decks: [] }, openDraft: noop }));
  const formAt = html.indexOf('<form');
  const foldAt = html.indexOf('class="json-prompt-fold"');
  assert.ok(formAt > 0 && foldAt > formAt, 'import dropzone & textarea come first above the folded prompts');
  assert.match(html, /<details class="json-prompt-fold">/, 'prompt fold starts collapsed');
  assert.doesNotMatch(html, /<details[^>]*class="json-prompt-fold"[^>]*\sopen(?:=|\s|>)/, 'prompt fold has no open attribute');
  assert.match(html.slice(foldAt), /复制提示词/);
  assert.match(html.slice(foldAt), /查看 JSON 格式示例/);

  // English stays free of stray Han characters
  const en = render(h(m.JsonImport, { data: { focus: { courses: [] }, decks: [] }, openDraft: noop }), { lang: 'en' });
  assert.doesNotMatch(stripTags(en).replace(/JSON/g, ''), HAN);

  // Interactive check: pasting JSON shows pure-local preview with 0 host calls, and submit button only shows arrow-right after proposal
  await withBrowserGlobals(async () => {
    interactive.exports.setUiLanguage('zh');
    const calls = [];
    const services = {
      call: async (action, args) => {
        calls.push([action, args]);
        if (action === 'draft.import.propose') return { title: 'Short OS', originalTitle: 'OS Ch1', course: 'OS', method: 'local' };
        return {};
      },
      act: async () => undefined,
      busy: false,
      notify: noop,
      host: {},
      openSettings: noop,
      navigate: noop,
      openModal: noop,
    };
    const toastApi = { success: noop, info: noop, warning: noop, error: noop, show: noop, dismiss: noop };
    const mounted = interactive.mount(() => hi(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      hi(
        interactive.exports.ToastContext.Provider,
        { value: toastApi },
        hi(interactive.exports.JsonImport, { data: { focus: { courses: [{ name: 'OS' }] }, decks: [] }, openDraft: noop }),
      ),
    ));
    try {
      const textarea = mounted.find((node) => node.type === 'textarea' && !node.props?.readOnly);
      assert.ok(textarea, 'JSON content textarea is mounted');
      const sample = JSON.stringify({ title: 'OS Ch1', cards: [{ prompt: 'Q1' }, { prompt: 'Q2' }] });
      await mounted.act(() => textarea.props.onChange({ target: { value: sample } }));
      assert.equal(calls.length, 0, 'live JSON preview makes zero backend/AI calls');
      assert.match(mounted.text(), /已识别「OS Ch1」共 2 道题/);
      const submitBefore = mounted.find((node) => node.type === 'button' && node.props?.type === 'submit');
      assert.ok(textOf(submitBefore).includes('检查并建议归类'));
      assert.equal(mounted.findAll((node) => node.type === 'svg', submitBefore).length, 0, 'in-place check button has no trailing arrow');
      const form = mounted.find((node) => node.type === 'form');
      await mounted.act(() => form.props.onSubmit({ preventDefault: noop }));
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], 'draft.import.propose');
      const submitAfter = mounted.find((node) => node.type === 'button' && node.props?.type === 'submit');
      assert.ok(textOf(submitAfter).includes('确认并导入草稿'));
      assert.equal(mounted.findAll((node) => node.type === 'svg', submitAfter).length, 1, 'proposal confirmation button renders arrow-right icon');
    } finally {
      mounted.unmount();
    }
  });
});

/* ---------- 2. Draft ---------- */

test('Draft: blocker summary jumps to flagged card when indices exist, falls back to details otherwise, and folds extra card fields', async () => {
  const card = { id: 'c1', kind: 'flashcard', topic: 'T1', objective: 'O1', prompt: 'Q1', answer: 'A1', hint: 'H1', explanation: 'E1', misconception: 'M1', citations: [] };
  const flaggedDraft = {
    id: 'd1', title: 'Draft', draftVersion: 1, cards: [card],
    editorial: { rejectedIssues: { c1: ['Citation missing'] } },
  };
  const unindexedDraft = {
    id: 'd2', title: 'Draft 2', draftVersion: 1, cards: [card],
    quality: { errors: ['General deck quality issue'] },
  };
  const renderDraft = (draftObj, lang = 'zh') => render(h(m.Draft, {
    data: { root: 'r', revision: 1, sources: [{ id: 's1', title: 'S1' }], decks: [], drafts: [draftObj], jobs: [], modelReady: true, runs: [] },
    draft: draftObj, draftLoaded: JSON.stringify(draftObj), setDraft: noop, draftText: '', setDraftText: noop,
    jsonMode: false, setJsonMode: noop, openDraft: noop, topUpDraft: noop, openSourceAt: noop,
    onOpenPublished: noop, onStartPublished: noop, clearRecovery: noop, setPage: noop, setModal: noop,
    blankCard: () => card, patchCard: noop, parseDraft: JSON.parse,
  }), { lang });

  const flaggedHtml = renderDraft(flaggedDraft);
  const blockerSection = flaggedHtml.slice(flaggedHtml.indexOf('draft-blocker-summary'), flaggedHtml.indexOf('draft-edit-heading'));
  assert.ok(blockerSection.length > 0, 'blocker summary is rendered');
  assert.match(blockerSection, /定位待处理题/, 'primary action jumps directly to flagged question');
  assert.match(flaggedHtml, /<details class="draft-more-fields"><summary>更多字段<\/summary>/, 'low-frequency fields are folded inside card');

  const unindexedHtml = renderDraft(unindexedDraft);
  const fallbackSection = unindexedHtml.slice(unindexedHtml.indexOf('draft-blocker-summary'), unindexedHtml.indexOf('draft-edit-heading'));
  assert.ok(fallbackSection.length > 0);
  assert.match(fallbackSection, /查看详情/, 'fallback action opens bottom generation details when no card index is flagged');

  const enHtml = renderDraft(flaggedDraft, 'en');
  assert.match(enHtml, /Jump to flagged question/);
  assert.match(enHtml, /More fields/);

  const draftCss = parseCss(await readFile(new URL('../ui/draft.css', import.meta.url), 'utf8'));
  const hidesStatus = draftCss.declarations.some(
    (d) => d.ctx.at(-1)?.includes('.sticky-actions__status') && d.prop === 'display' && d.value === 'none',
  );
  assert.equal(hidesStatus, false, 'card count must never be hidden with display: none on narrow panes');
  const narrowStatusDecls = draftCss.declarations.filter(
    (d) => d.ctx.some((c) => /^@container\b/.test(c)) && d.ctx.at(-1) === '.draft-page .sticky-actions__status',
  );
  assert.ok(narrowStatusDecls.some((d) => d.prop === 'text-overflow' && d.value === 'ellipsis'), 'narrow pane keeps status visible as one ellipsized line');
});

/* ---------- 3. Manage ---------- */

test('Manage: filterManageCards filters by keyword and status, and Manage folds organise forms above search bar', () => {
  const cards = [
    { id: 'c1', kind: 'flashcard', topic: 'Paging', prompt: 'What is a TLB?', answer: 'Translation lookaside buffer', flag: 'Check formula', suspended: false },
    { id: 'c2', kind: 'flashcard', topic: 'Locks', prompt: 'Explain mutex ownership', answer: 'Locking thread unlocks', flag: '', suspended: true },
    { id: 'c3', kind: 'flashcard', topic: 'Scheduling', prompt: 'Compare RR and SJF', answer: 'Quantum vs burst', flag: '', suspended: false },
  ];
  assert.deepEqual(m.filterManageCards(cards, { query: 'tlb' }).map((c) => c.id), ['c1']);
  assert.deepEqual(m.filterManageCards(cards, { query: 'locks' }).map((c) => c.id), ['c2']);
  assert.deepEqual(m.filterManageCards(cards, { filter: 'flagged' }).map((c) => c.id), ['c1']);
  assert.deepEqual(m.filterManageCards(cards, { filter: 'suspended' }).map((c) => c.id), ['c2']);
  assert.deepEqual(m.filterManageCards(cards, { query: 'formula', filter: 'flagged' }).map((c) => c.id), ['c1']);
  assert.deepEqual(m.filterManageCards(cards, { query: 'mutex', filter: 'flagged' }), []);

  const deck = { id: 'd1', title: 'OS Deck', course: 'OS', folder: '', cards };
  const html = render(h(m.Manage, {
    openDraft: noop, setPage: noop, managedDeck: deck, decks: [deck], sources: [],
    setManagedDeck: noop, folderDraft: 'OS', setFolderDraft: noop, onRemoveDeck: noop,
  }));
  assert.match(html, /<details class="manage-organize-fold">(?!.*open)/, 'organize forms are folded by default');
  assert.match(html, /data-manage-filter/, 'search and filter toolbar appears above cards');
  assert.match(html, /class="manage-search"/);
  assert.match(html, /已标记 \(1\)/);
  assert.match(html, /已暂停 \(1\)/);
  assert.ok(html.indexOf('manage-organize-fold') < html.indexOf('data-manage-filter') && html.indexOf('data-manage-filter') < html.indexOf('manage-cards'));

  // Clean deck without flagged/suspended cards omits status filter pills while keeping search
  const cleanDeck = { id: 'd2', title: 'Clean Deck', course: 'OS', folder: '', cards: [cards[2]] };
  const cleanHtml = render(h(m.Manage, {
    openDraft: noop, setPage: noop, managedDeck: cleanDeck, decks: [cleanDeck], sources: [],
    setManagedDeck: noop, folderDraft: 'OS', setFolderDraft: noop, onRemoveDeck: noop,
  }));
  assert.match(cleanHtml, /class="manage-search"/);
  assert.doesNotMatch(cleanHtml, /class="[^"]*manage-status-filter/);

  // English stays free of Han
  const en = render(h(m.Manage, {
    openDraft: noop, setPage: noop, managedDeck: deck, decks: [deck], sources: [],
    setManagedDeck: noop, folderDraft: 'OS', setFolderDraft: noop, onRemoveDeck: noop,
  }), { lang: 'en' });
  assert.doesNotMatch(stripTags(en), HAN);
});

/* ---------- 4. LargeDocumentCard ---------- */

test('LargeDocumentCard: shows 1 primary recommended path and folds secondary alternatives into 其他导入方式', () => {
  const none = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [] };
  const html = render(h(m.LargeDocumentCard, { reason: 'pdf-size', detail: { name: 'book.pdf' }, retrieval: none }));
  const primaryAt = html.indexOf('方案一：本机一键解析');
  const altFoldAt = html.indexOf('large-doc__alternatives');
  const onlineAt = html.indexOf('方案二：PaddleOCR 在线解析');
  const advancedAt = html.indexOf('large-doc__advanced');
  assert.ok(primaryAt > 0 && altFoldAt > primaryAt, 'primary local conversion sits above folded alternatives');
  assert.ok(onlineAt > altFoldAt && advancedAt > onlineAt, 'online parsing and advanced tools sit inside the single 其他导入方式 disclosure');
  assert.match(html, /其他导入方式/);

  const en = render(h(m.LargeDocumentCard, { reason: 'pdf-size', detail: { name: 'book.pdf' }, retrieval: none }), { lang: 'en' });
  assert.match(en, /Other import options/);
  assert.doesNotMatch(stripTags(en), HAN);
});

/* ---------- 5. TooBigChoice + Generate + moreValuesOf ---------- */

test('TooBigChoice & Generate: retrieval mode shows inline topic input synced with gen.focus without forcing 更多选项 open', async () => {
  const big = [
    { id: 'b1', title: 'Book · p.1', chars: 400000, courses: ['DB'] },
    { id: 'b2', title: 'Book · p.2', chars: 400000, courses: ['DB'] },
  ];
  const ready = {
    selected: 'mcp:mcp__rag__q', effective: 'mcp:mcp__rag__q', hostCanSearch: true, otherTools: [],
    providers: [{ id: 'mcp:mcp__rag__q', kind: 'mcp', label: 'query_documents', server: 'rag', tool: 'mcp__rag__q' }],
  };
  const gen = { kind: 'quiz', kinds: ['quiz'], count: 10, coverageLevel: 'standard', customCount: '', difficulty: 'mixed', language: '中文', focus: '', role: '', notation: 'auto' };
  const html = render(h(m.Generate, {
    data: { root: 'lib', decks: [], drafts: [], jobs: [], sources: big, modelReady: true, focus: { course: 'DB', courses: [{ name: 'DB' }] } },
    busy: false, running: false, act: noop, call: noop, openDraft: noop, setPage: noop,
    genSource: 'files', setGenSource: noop, gen, setGen: noop, selectedSources: ['b1', 'b2'],
    setSelectedSources: noop, setModal: noop, openModelSettings: noop, initialRetrieval: ready, initialGenerationMode: 'retrieval',
  }));
  assert.match(html, /data-too-big-focus/, 'inline focus input appears directly in TooBigChoice when retrieval mode is active');
  const foldTag = /<details class="sh-disclosure generate-more[^>]*>/.exec(html)?.[0] || '';
  assert.ok(foldTag, '更多选项 disclosure exists');
  assert.doesNotMatch(foldTag, /\sopen(?:=|\s|>)/, 'retrieval mode no longer forces all 5 groups of 更多选项 open');

  // moreValuesOf stays false when autoComplete matches saved default boolean, and true when it differs
  assert.equal(m.moreValuesOf({ ...gen, autoComplete: true }, { ...gen, autoComplete: true }), false);
  assert.equal(m.moreValuesOf({ ...gen, autoComplete: false }, { ...gen, autoComplete: true }), true);
  assert.equal(m.moreValuesOf({ ...gen, autoComplete: false }, gen), true);

  // Two-way sync check on TooBigChoice
  await withBrowserGlobals(async () => {
    interactive.exports.setUiLanguage('zh');
    const seen = [];
    const mounted = interactive.mount(() => hi(interactive.exports.TooBigChoice, {
      advice: { tooBig: true, chars: 700000, needsTopic: true },
      stats: { pages: 30 },
      modes: ['path', 'retrieval'],
      mode: 'retrieval',
      onMode: noop,
      focus: '死锁',
      onFocusChange: (val) => seen.push(val),
    }));
    try {
      const input = mounted.find((node) => node.type === 'input' && node.props?.className === 'too-big__focus-input');
      assert.ok(input);
      assert.equal(input.props.value, '死锁');
      await mounted.act(() => input.props.onChange({ target: { value: '索引失效' } }));
      assert.deepEqual(seen, ['索引失效']);
    } finally {
      mounted.unmount();
    }
  });
});

/* ---------- 6. AudioImport + LiveClass ---------- */

test('AudioImport: secondary ways render as a single inline bar', async () => {
  const html = render(h(m.AudioImport, { data: { decks: [], jobs: [] }, busy: false, act: noop }));
  assert.match(html, /class="audio-ways" data-audio-ways="inline"/);
  const audioCss = parseCss(await readFile(new URL('../ui/audio-import.css', import.meta.url), 'utf8'));
  const waysDecls = audioCss.declarations.filter((d) => d.ctx.at(-1) === '.audio-ways');
  assert.ok(waysDecls.some((d) => d.prop === 'display' && d.value === 'flex'), '.audio-ways uses flex layout');
  assert.ok(waysDecls.some((d) => d.prop === 'flex-wrap' && d.value === 'wrap'), '.audio-ways wraps cleanly on narrow panes');
});

test('LiveClass: hides $0 paid estimate in local/free mode, folds secondary save option, and adds 2-dot legend in live-feed-head', () => {
  const seg = { id: 1, t: 1000, en: 'Partitions reduce scanned rows.', zh: '分区减少扫描行数。', zhState: 'done', correctedAt: '2026-11-28T00:00:00Z' };
  const baseSession = {
    id: 'live-1', title: 'DB Class', course: 'DB', status: 'ended', revision: 2, total: 1, elapsedMs: 60_000,
    interim: '', translating: 0, generatedIds: [], warnings: [], segments: [seg],
    correction: { enabled: true, running: false, covered: 1, coveredThrough: 1, pending: 0, skipped: 0, skippedItems: [], calls: 1, cacheHits: 0, error: '', warnings: [], memory: { text: '', refs: [] }, notes: [], background: { running: false, pending: 0, failed: 0, tasks: [] } },
  };
  const renderLive = (sessionPatch, lang = 'zh') => render(h(m.LiveClass, {
    data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true },
    initialSession: { ...baseSession, ...sessionPatch },
  }), { lang });

  // Local mode hides $0 cost line
  const localHtml = renderLive({ engine: 'local', tier: 'local', usage: { estimatedPaidUsd: 0 } });
  assert.doesNotMatch(localHtml, /付费转写估算/);

  // Free mode with $0 hides cost line
  const freeHtml = renderLive({ engine: 'gemini', tier: 'free', usage: { estimatedPaidUsd: 0 } });
  assert.doesNotMatch(freeHtml, /付费转写估算/);

  // Paid mode or nonzero estimate still displays cost line
  const paidHtml = renderLive({ engine: 'gemini', tier: 'paid', usage: { estimatedPaidUsd: 0.12 } });
  assert.match(paidHtml, /付费转写估算 \$0\.12/);

  // Feed head displays minimal 2-dot legend
  const feedHead = localHtml.match(/<div class="live-feed-head">[\s\S]*?<\/div><div class="live-feed"/)[0];
  assert.match(feedHead, /class="live-feed-legend"/);
  assert.match(feedHead, /class="live-dot polished"[^>]*><\/i>AI 润色/);
  assert.match(feedHead, /class="live-dot checked"[^>]*><\/i>已检查/);

  // Footer keeps 保存为资料 directly visible and folds 校对后保存 behind 其他保存方式
  const footer = localHtml.match(/<footer class="live-footer">[\s\S]*?<\/footer>/)[0];
  assert.match(footer, />保存为资料</);
  assert.match(footer, /<details class="live-save-more"><summary>其他保存方式<\/summary>[\s\S]*>校对后保存</);

  // English stays free of Han in chrome
  const enHtml = renderLive({ engine: 'local', tier: 'local', usage: { estimatedPaidUsd: 0 } }, 'en')
    .replace(/<p class="live-chinese"[^>]*>[^<]*<\/p>/g, '');
  assert.doesNotMatch(stripTags(enHtml), HAN);
});
