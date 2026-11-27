import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import { loadUi } from './helpers/ui-module.mjs';
import { loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

// #107 / #123: the live-class and audio pages speak through the catalogue (ui / uiFormat) like every other page, so the
// English is complete, one Chinese sentence has one English, and nothing keeps a private zh/en dictionary.
const m = await loadUi(`
  export { default as LiveClass, Sentence, SentenceMark } from './ui/LiveClass.jsx';
  export { default as LiveHistory } from './ui/LiveHistory.jsx';
  export { default as LiveNotes } from './ui/LiveNotes.jsx';
  export { default as LiveAudioMonitor } from './ui/LiveAudioMonitor.jsx';
  export { default as AudioReasoning } from './ui/AudioReasoning.jsx';
  export { AudioDashboardView, AudioDashboardPanel } from './ui/AudioDashboard.jsx';
  export { default as AudioSettings } from './ui/AudioSettings.jsx';
  export { default as JevSettings } from './ui/JevSettings.jsx';
  export { default as WorkflowPortal } from './ui/WorkflowPortal.jsx';
  export { default as LiveLoopbackCard } from './ui/LiveLoopbackCard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { LiveAudioHealth } from './ui/live-audio-health.js';
  export { setUiLanguage, uiCatalogue } from './ui/i18n.js';`);
const h = React.createElement;
const han = /[㐀-鿿]/;
const noop = () => {};
const render = (element, language) => { m.setUiLanguage(language); try { return renderToStaticMarkup(element); } finally { m.setUiLanguage('zh'); } };
const text = html => html.replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');

const segments = [{ id: 1, t: 1000, en: 'Hello class.', zh: '同学们好。', zhState: 'done' },
  { id: 2, t: 61000, en: 'Today we study joins.', zh: '', zhState: 'error', correctedAt: 5, originalEn: 'Today we studied joins', correctionReason: 'wording' },
  { id: 3, t: 3_725_000, en: 'Pending.', zh: '', zhState: 'pending' }];
const sessions = [{ id: 'a', title: 'Databases', elapsedMs: 125_000, segments: 12, active: false }, { id: 'b', title: 'Networks', elapsedMs: 3_661_000, segments: 4, active: true },
  { id: 'c', title: 'Archived', elapsedMs: 1000, segments: 1, archivedAt: '2026-10-01T00:00:00Z' }];
const correction = { memory: { text: 'summary', refs: [1] }, notes: [{ kind: 'amendment', text: 'note', refs: [2] }], background: { pending: 1, failed: 1, running: false,
  tasks: [{ id: 't1', status: 'failed', reason: 'ambiguity', ids: [3], error: 'busy' }, { id: 't2', status: 'queued', reason: 'x', ids: [] }] } };
const health = new m.LiveAudioHealth(() => 100_000);
health.reset('tab', 'running');
health.update({ capturedMs: 65_000, acceptedMs: 60_000, queuedBytes: 200_000, lastAckAt: 1, lastFrameAt: 99_000, label: 'Chrome tab' });
const providers = ['free', 'siliconflow', 'groq', 'paid'].map((tier, index) => ({ tier, configured: index !== 3,
  today: { requests: index + 1, limited: 0, failures: 0, audioSeconds: 600, inputTokens: 1234, outputTokens: 56, outputUnknown: 0 },
  models: [{ model: 'm-' + tier, limit: tier === 'paid' ? null : 20, remaining: 12, used: 8, source: tier === 'groq' ? 'unknown' : 'local-estimate', lastQuota: tier === 'groq' ? {} : undefined }] }));
const dashboard = { providers, timings: [], trend: [{ date: '2026-10-01', free: 1, siliconflow: 2, groq: 3, paid: 4 }, { date: '2026-10-02', free: 0, siliconflow: 0, groq: 0, paid: 0 }] };
const keys = { freeKey: { set: true, hint: '••••1' }, siliconflowKey: { set: true, hint: '••••2' }, groqKey: { set: false, hint: '' }, paidKey: { set: false, hint: '' } };
const audioSettings = { ...keys, dailyLimits: {}, transcribeModel: 'gemini-x', textModel: 'gemini-y', proofreadReasoning: 'default', translateReasoning: 'low',
  textProvider: 'auto', liveProvider: 'auto', mode: 'SMART', settingsFile: '~/.dsh/study/audio.json' };
const jevInitial = {
  settings: {
    provider: 'typesafe',
    providers: [{ id: 'typesafe', family: 'typesafe', host: 'api.typesafe.ai', model: 'jev-1.13' }],
    key: { set: true, source: 'file', hint: '••••9' },
    confirmed: true,
    enabled: false,
    threshold: 0.8,
    features: { courseSuggest: false, preReview: false, outlineNoise: false, levelCheck: false },
    replace: { cardReview: false, courseOrganize: false },
    privacyUrl: 'https://typesafe.ai/privacy',
    settingsFile: '~/.dsh/study/jev.json',
  },
  usage: {
    today: { calls: 2, inputTokens: 120, outputTokens: 10 },
    total: { calls: 5, inputTokens: 300, outputTokens: 25 },
    byFeature: { courseSuggest: { calls: 2, inputTokens: 120, outputTokens: 10 } },
  },
  failure: null,
};
const workflowInitial = {
  session: {
    id: 'wf-1',
    topic: 'Graphs',
    currentStepId: 's1',
    pickedBy: 'ai',
    course: { name: 'Algorithms' },
    template: {
      title: 'Deep Study',
      steps: [
        { id: 's1', kind: 'lesson', title: 'BFS Basics', instructions: 'Read first', content: 'Queue traversal' },
        { id: 's2', kind: 'practice', title: 'Practice' },
      ],
    },
    records: { s1: { outcome: 'done', content: 'Traversal note', output: 'My note' } },
    history: [{ stepId: 's1', outcome: 'done', at: '2026-10-01T10:00:00Z', output: 'Done' }],
  },
  resources: { readings: [], sources: [], cardCount: 3, scopeTopics: ['BFS', 'DFS'], scopeTopicCount: 2 },
};
const studyServices = {
  call: async (action) => {
    if (action === 'workflow.session.get') return workflowInitial;
    if (action === 'audio.settings.get') return audioSettings;
    if (action === 'audio.usage') return dashboard;
    if (action === 'live.list') return { sessions };
    return {};
  },
  act: async () => undefined,
  busy: false,
  notify: noop,
  askInChat: noop,
  host: {},
  openSettings: noop,
  navigate: noop,
  openModal: noop,
};
const withServices = (el) => h(m.StudyServicesContext.Provider, { value: studyServices }, el);

const loopbackFolder = 'D:\\StudyHub\\LiveLoopback';
const loopbackBase = {
  status: 'idle', stage: '', stages: ['compile', 'check'], done: [], step: 0, of: 2,
  folder: '', installedFolder: '', installed: false, ready: false, supported: true, tested: true,
  helperVersion: '1.0.0', downloadMb: 0, diskMb: 1, log: [], error: null,
};
const loopbackPlan = {
  ok: true, problems: [], warnings: [], folder: loopbackFolder, defaultFolder: loopbackFolder, defaultReason: 'largest-data-drive',
  platform: 'win32', supported: true, tested: true,
  drives: [{ root: 'D:\\', freeMb: 80_000, totalMb: 200_000, system: false, recommended: true, folder: loopbackFolder }],
  disk: { freeMb: 80_000, neededMb: 5, drive: 'D:' }, estimate: { downloadMb: 0, diskMb: 1 }, files: [],
};
const loopbackStates = {
  notInstalled: loopbackBase,
  installing: { ...loopbackBase, status: 'running', stage: 'compile', step: 1, folder: loopbackFolder, stageFraction: 0.5 },
  ready: { ...loopbackBase, status: 'complete', stage: 'done', step: 2, done: ['compile', 'check'], folder: loopbackFolder, installedFolder: loopbackFolder, installed: true, ready: true },
  failed: { ...loopbackBase, status: 'failed', stage: 'check', step: 2, done: ['compile'], folder: loopbackFolder, error: { code: 'check-failed' } },
  paused: { ...loopbackBase, status: 'cancelled', stage: 'compile', step: 1, folder: loopbackFolder, error: { code: 'cancelled' } },
  repair: { ...loopbackBase, status: 'complete', stage: 'done', step: 2, done: ['compile', 'check'], folder: loopbackFolder, needsRepair: true },
  unsupported: { ...loopbackBase, supported: false },
};

const surfaces = () => [
  { name: 'LiveClass(ready)', element: h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true } }) },
  { name: 'LiveClass(unready)', element: h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: false }, onSettings: noop }) },
  ...segments.map((segment, index) => ({ name: `Sentence[${index}]`, element: h(m.Sentence, { segment, selected: index === 0, generated: index === 0, checked: index === 2, onToggle: noop, language: 'x' }) })),
  { name: 'SentenceMark[0]', element: h(m.SentenceMark, { segment: segments[1], checked: false }) },
  { name: 'SentenceMark[1]', element: h(m.SentenceMark, { segment: segments[0], checked: true }) },
  { name: 'LiveHistory', element: h(m.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop }) },
  { name: 'LiveNotes', element: h(m.LiveNotes, { correction, onSentence: noop, onRetry: noop, disabled: false }) },
  { name: 'LiveAudioMonitor(full)', element: h(m.LiveAudioMonitor, { health, visible: true, recording: true }) },
  { name: 'LiveAudioMonitor(compact)', element: h(m.LiveAudioMonitor, { health, visible: true, recording: true, compact: true }) },
  { name: 'AudioReasoning', element: h(m.AudioReasoning, { settings: audioSettings, busy: false, onSave: noop, timings: [{ stage: 'proofread', averageMs: 4200, count: 3 }] }) },
  { name: 'AudioDashboardView', element: h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }) },
  { name: 'AudioDashboardPanel', element: h(m.AudioDashboardPanel, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }) },
  // AudioSettings legitimately reorders provider cards via providerOrder(language) without changing any copy.
  { name: 'AudioSettings', element: withServices(h(m.AudioSettings, { initialView: audioSettings })), orderAgnostic: true },
  { name: 'JevSettings', element: withServices(h(m.JevSettings, { initial: jevInitial })) },
  // WorkflowPortal formats one history timestamp with Intl.DateTimeFormat according to uiLocale().
  { name: 'WorkflowPortal', element: withServices(h(m.WorkflowPortal, { id: 'wf-1', initialResult: workflowInitial, onBack: noop })), normalizeDates: true },
  ...Object.entries(loopbackStates).map(([state, initialStatus]) => ({
    name: `LiveLoopbackCard(${state})`,
    element: withServices(h(m.LiveLoopbackCard, { call: noop, initialStatus, initialPlan: loopbackPlan, settings: true })),
  })),
];
const pages = () => surfaces().map((surface) => surface.element);

test('English: no Chinese on any live-class, audio, Jev, or workflow-portal surface', () => {
  for (const element of pages()) {
    const html = render(element, 'en').replace(/<p class="live-chinese"[^>]*>[^<]*<\/p>/g, ''); // the transcript's own Chinese translation is content
    assert.doesNotMatch(html, han, `${element.type.name || element.type.displayName || 'component'}: ${text(html).match(/[^|]*[㐀-鿿][^|]*/)?.[0]}`);
    assert.doesNotMatch(html, /\{\d+\}/, 'an English template placeholder was left unfilled');
  }
});

test('Chinese: the Chinese source copy is shown, switches cleanly with setUiLanguage, and no placeholder leaks', () => {
  for (const element of pages()) {
    const zh = render(element, 'zh');
    const en = render(element, 'en');
    assert.doesNotMatch(zh, /\{\d+\}/, 'a placeholder was left unfilled');
    assert.match(zh, han, `expected Chinese copy when language is zh: ${element.type.name || element.type.displayName || 'component'}`);
    assert.notEqual(zh, en, `expected zh and en renders to differ when toggling setUiLanguage: ${element.type.name || element.type.displayName || 'component'}`);
  }
  const live = text(render(h(m.LiveClass, { call: noop, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true } }), 'zh'));
  assert.match(live, /课堂实录/);
  assert.match(live, /开始实录/);
  const history = text(render(h(m.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop }), 'zh'));
  assert.match(history, /历史课堂 \(2\)/);
  assert.match(history, /2:05 · 12 句/);
});

test('English wording keeps the meaning the inline dictionaries gave it', () => {
  const history = text(render(h(m.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop }), 'en'));
  assert.match(history, /Previous classes \(2\)/);
  assert.match(history, /2:05 · 12 sentences/);
  assert.match(history, /1:01:01 · 4 sentences · Recording/, 'clocks go to h:mm:ss after an hour');
  const notes = text(render(h(m.LiveNotes, { correction, onSentence: noop, onRetry: noop, disabled: false }), 'en'));
  assert.match(notes, /View class notes · 1 entries/);
  assert.match(notes, /1 pending · 1 incomplete|Pending 1 · Incomplete 1/i);
  const monitor = text(render(h(m.LiveAudioMonitor, { health, visible: true, recording: true }), 'en'));
  assert.match(monitor, /Computer heard 1 min 5 sec/);
  const sentence = text(render(h(m.Sentence, { segment: segments[2], selected: false, generated: false, checked: false, onToggle: noop, language: 'en' }), 'en'));
  assert.match(sentence, /1:02:05/);
  assert.match(render(h(m.Sentence, { segment: segments[0], selected: false, generated: false, checked: false, onToggle: noop, language: 'en' }), 'en'), /aria-label="Select sentence 1"/);
});

test('the dashboard names providers once, translated, in request order', () => {
  const zh = text(render(h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'zh'));
  const en = text(render(h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'en'));
  for (const [chinese, english] of [['Gemini 免费', 'Gemini Free'], ['硅基流动', 'SiliconFlow'], ['Groq', 'Groq'], ['Gemini 付费', 'Gemini Paid']]) {
    assert.ok(zh.includes(chinese), chinese);
    assert.ok(en.includes(english), english);
  }
  assert.ok(en.indexOf('Gemini Free') < en.indexOf('SiliconFlow') && en.indexOf('SiliconFlow') < en.indexOf('Groq') && en.indexOf('Groq') < en.indexOf('Gemini Paid'));
  const links = render(h(m.AudioDashboardView, { data: dashboard, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'en').match(/href="https:[^"]+"/g);
  assert.deepEqual(links, ['href="https://aistudio.google.com/usage"', 'href="https://cloud.siliconflow.cn"', 'href="https://console.groq.com/settings/limits"']);
});

test('dashboard numbers follow the interface language', () => {
  const big = { ...dashboard, providers: dashboard.providers.map(provider => ({ ...provider, today: { ...provider.today, inputTokens: 1234567, requests: 1234 } })) };
  const en = text(render(h(m.AudioDashboardView, { data: big, settings: audioSettings, busy: false, refresh: noop, save: noop, error: '' }), 'en'));
  assert.match(en, /\|4,938,268\|/);
  assert.match(en, /\|1,234\|calls\|/);
});

test('live, audio, Jev, and workflow-portal surfaces register zero private setInterval timers when mounted', async () => {
  const ui = await loadInteractiveUi(`
    export { default as LiveClass } from './ui/LiveClass.jsx';
    export { default as LiveHistory } from './ui/LiveHistory.jsx';
    export { default as LiveNotes } from './ui/LiveNotes.jsx';
    export { default as LiveAudioMonitor } from './ui/LiveAudioMonitor.jsx';
    export { default as AudioDashboard } from './ui/AudioDashboard.jsx';
    export { default as AudioReasoning } from './ui/AudioReasoning.jsx';
    export { default as AudioSettings } from './ui/AudioSettings.jsx';
    export { default as JevSettings } from './ui/JevSettings.jsx';
    export { default as WorkflowPortal } from './ui/WorkflowPortal.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { LiveAudioHealth } from './ui/live-audio-health.js';
  `);
  const r = ui.React.createElement;
  const wrap = (el) => r(ui.exports.StudyServicesContext.Provider, { value: studyServices }, el);

  await withBrowserGlobals(async () => {
    const origSetInterval = globalThis.setInterval;
    const origClearInterval = globalThis.clearInterval;
    const intervalCalls = [];
    const clearedIntervals = [];
    globalThis.setInterval = (...args) => {
      const id = origSetInterval(...args);
      id?.unref?.();
      intervalCalls.push({ id, ms: args[1] });
      return id;
    };
    globalThis.clearInterval = (id) => {
      clearedIntervals.push(id);
      return origClearInterval(id);
    };
    const mounts = [];
    try {
      const pausedHealth = new ui.exports.LiveAudioHealth(() => 100_000);
      pausedHealth.reset('tab', 'paused');
      pausedHealth.update({ capturedMs: 1000, acceptedMs: 1000, lastFrameAt: 99_000, lastAckAt: 99_000 });

      mounts.push(
        ui.mount(() => wrap(r(ui.exports.LiveClass, { call: studyServices.call, data: { root: 'r', focus: { courses: [] } }, visible: true, initialReadiness: { live: true } }))),
        ui.mount(() => r(ui.exports.LiveHistory, { sessions, disabled: false, capturing: false, onOpen: noop, onArchive: noop, onDelete: noop })),
        ui.mount(() => r(ui.exports.LiveNotes, { correction, onSentence: noop, onRetry: noop, disabled: false })),
        ui.mount(() => r(ui.exports.LiveAudioMonitor, { health: pausedHealth, visible: true, recording: false })),
        ui.mount(() => wrap(r(ui.exports.AudioDashboard, {}))),
        ui.mount(() => r(ui.exports.AudioReasoning, { settings: audioSettings, busy: false, onSave: noop, timings: [{ stage: 'proofread', averageMs: 4200, count: 3 }] })),
        ui.mount(() => wrap(r(ui.exports.AudioSettings, { initialView: audioSettings }))),
        ui.mount(() => wrap(r(ui.exports.JevSettings, { initial: jevInitial }))),
        ui.mount(() => wrap(r(ui.exports.WorkflowPortal, { id: 'wf-1', initialResult: workflowInitial, onBack: noop }))),
      );
      for (const mounted of mounts) await mounted.flush();
      assert.equal(intervalCalls.length, 0, `expected 0 private setInterval registrations across mounted surfaces, saw ${JSON.stringify(intervalCalls)}`);

      // LiveAudioMonitor while running subscribes to the shared useNow clock (1 shared timer even across 2 mounts, never a per-instance setInterval).
      const activeHealth = new ui.exports.LiveAudioHealth(() => 100_000);
      activeHealth.reset('tab', 'running');
      activeHealth.update({ capturedMs: 1000, acceptedMs: 1000, lastFrameAt: 99_000, lastAckAt: 99_000 });
      // Both monitors live in one tree at the same time (two mounts of one harness would share one root, so the second would only re-render the first).
      const both = ui.mount(() => r(ui.React.Fragment, null,
        r(ui.exports.LiveAudioMonitor, { key: 'a', health: activeHealth, visible: true, recording: true }),
        r(ui.exports.LiveAudioMonitor, { key: 'b', health: activeHealth, visible: true, recording: true, compact: true })));
      mounts.push(both);
      await both.flush();
      assert.equal(intervalCalls.length, 1, 'two active LiveAudioMonitors must share the single useNow clock');
      both.unmount();
      assert.equal(clearedIntervals.length, 1, 'shared useNow clock must stop once the last subscriber unmounts');
    } finally {
      for (const mounted of mounts) mounted.unmount();
      globalThis.setInterval = origSetInterval;
      globalThis.clearInterval = origClearInterval;
    }
  });
});

function withCatalogue(mutate, fn) {
  const cat = m.uiCatalogue();
  const backup = Object.entries(cat);
  try {
    mutate(cat, backup);
    return fn();
  } finally {
    for (const key of Object.keys(cat)) delete cat[key];
    for (const [key, value] of backup) cat[key] = value;
    m.setUiLanguage('zh');
  }
}

const copyTokens = (html) => {
  const tokens = [];
  for (const part of html.split(/<[^>]+>/)) {
    const trimmed = part.trim();
    if (trimmed) tokens.push(trimmed);
  }
  for (const match of html.matchAll(/\b(?:aria-label|placeholder|title|alt)="([^"]*)"/g)) {
    const trimmed = match[1].trim();
    if (trimmed) tokens.push(trimmed);
  }
  return tokens.sort();
};

const normalizeStamp = (html) => html.replace(/\b\d{1,2}\/\d{1,2},?\s+\d{1,2}:\d{2}(?:\s*[AP]M)?\b/g, '<STAMP>');

// Shared <HandOff> tooltip (ui/hand-off/use-hand-off.js joinSentences) joins two complete sentences with ". " in en vs "。" in zh.
const HAND_OFF_TOOLTIP = /(<span class="sh-popover-anchor sh-handoff__tip">[\s\S]*?<span [^>]*role="tooltip"[^>]*>)([\s\S]*?)(<\/span>)/g;
const normalizeHandOffJoin = (html) => html.replace(HAND_OFF_TOOLTIP, (_, open, body, close) => `${open}${body.replace(/\. /g, '。')}${close}`);
const splitHandOffSentences = (html) => html.replace(HAND_OFF_TOOLTIP, (_, open, body, close) => `${open}${body.replace(/⟫\. ⟪/g, '⟫\n⟪')}${close}`);

// Detect glued copy fragments inside one sentinel-wrapped text/attribute piece (`⟪...⟫`).
// Allows nested catalogue calls (`⟪Computer heard ⟪1 min 5 sec⟫⟫`) and `uiRich` spans split across inline tags (`<strong>`),
// while rejecting two top-level catalogue calls (`⟫...⟪`) or non-whitespace glued before opening `⟪` / after closing `⟫`.
function isGluedFragment(piece) {
  let depth = 0;
  let closedTop = false;
  for (let i = 0; i < piece.length; i++) {
    const ch = piece[i];
    if (ch === '⟪') {
      if (closedTop) return true;
      if (depth === 0 && piece.slice(0, i).trim()) return true;
      depth += 1;
    } else if (ch === '⟫') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0) closedTop = true;
      } else {
        // Closing tail of a uiRich sentence split across an inline formatting tag.
        closedTop = true;
      }
    } else if (closedTop && !/\s/.test(ch)) {
      return true;
    }
  }
  return false;
}

test('every live, audio, Jev, workflow-portal, and loopback surface speaks solely through uiCatalogue (no private t(zh, en) or language ternary)', () => {
  const all = surfaces();
  withCatalogue((cat, backup) => {
    for (const [key] of backup) {
      // Keep #one singular keys mapped to their Chinese base template so the WeakMap singulars cache in ui/i18n.js falls back to the Chinese source string.
      if (/#one(?::\d+(?:,\d+)*)?$/.test(key)) cat[key] = key.replace(/#one(?::\d+(?:,\d+)*)?$/, '');
      else delete cat[key];
    }
  }, () => {
    for (const { name, element, orderAgnostic, normalizeDates } of all) {
      const zh = normalizeHandOffJoin(render(element, 'zh'));
      const enEmpty = normalizeHandOffJoin(render(element, 'en'));
      if (orderAgnostic) {
        assert.deepEqual(copyTokens(enEmpty), copyTokens(zh), `${name}: emitted non-catalogue copy when language=en with an empty catalogue`);
      } else if (normalizeDates) {
        assert.equal(normalizeStamp(enEmpty), normalizeStamp(zh), `${name}: emitted non-catalogue copy when language=en with an empty catalogue`);
      } else {
        assert.equal(enEmpty, zh, `${name}: emitted non-catalogue copy when language=en with an empty catalogue`);
      }
    }
  });
});

test('no live, audio, Jev, workflow-portal, or loopback surface glues a sentence from separate catalogue fragments', () => {
  const all = surfaces();
  withCatalogue((cat, backup) => {
    for (const [key, value] of backup) cat[key] = `⟪${value}⟫`;
  }, () => {
    for (const { name, element } of all) {
      const html = splitHandOffSentences(render(element, 'en'));
      const pieces = [];
      for (const segment of html.split(/<[^>]+>/)) pieces.push(...segment.split(/\n|\s*·\s*/));
      for (const match of html.matchAll(/\b(?:aria-label|placeholder|alt)="([^"]*)"/g)) {
        // Skip AudioDashboard's daily trend series label ("YYYY-MM-DD: Provider1 N, Provider2 M, ...").
        if (/^\d{4}-\d{2}-\d{2}:/.test(match[1])) continue;
        pieces.push(...match[1].split(/\n|\s*·\s*/));
      }
      for (const piece of pieces) {
        if (!piece.includes('⟪') && !piece.includes('⟫')) continue;
        assert.equal(isGluedFragment(piece), false, `${name}: glued sentence fragment in ${JSON.stringify(piece)}`);
      }
    }
  });
});

function findPrivateI18nInJsx(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
  const violations = [];
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
  const isLanguageRead = (node) => (ts.isIdentifier(node) && node.text === 'language')
    || (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && (node.expression.text === 'getUiLanguage' || node.expression.text === 'useUiLanguage'));
  const isLocaleLiteral = (node) => ts.isStringLiteralLike(node) && (node.text === 'en' || node.text === 'zh');
  const isEqualityOp = (kind) => kind === ts.SyntaxKind.EqualsEqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsEqualsToken
    || kind === ts.SyntaxKind.EqualsEqualsToken
    || kind === ts.SyntaxKind.ExclamationEqualsToken;
  const checkBilingualParams = (fnName, params, node) => {
    const first = params[0] && ts.isIdentifier(params[0].name) ? params[0].name.text : '';
    const second = params[1] && ts.isIdentifier(params[1].name) ? params[1].name.text : '';
    if ((fnName === 't' && /^zh/i.test(first)) || (first === 'zh' && second === 'en') || (first === 'en' && second === 'zh')) {
      violations.push(`${fileName}:${lineOf(node)}: private bilingual helper ${fnName || '<anonymous>'}(${first}${second ? `, ${second}` : ''})`);
    }
  };
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node)) {
      checkBilingualParams(node.name?.text || '', node.parameters, node);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      checkBilingualParams(node.name.text, node.initializer.parameters, node);
    } else if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && !ts.isVariableDeclaration(node.parent)) {
      checkBilingualParams('', node.parameters, node);
    } else if (ts.isBinaryExpression(node) && isEqualityOp(node.operatorToken.kind)
      && ((isLanguageRead(node.left) && isLocaleLiteral(node.right)) || (isLocaleLiteral(node.left) && isLanguageRead(node.right)))) {
      violations.push(`${fileName}:${lineOf(node)}: direct UI language comparison (${node.getText(sf)})`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return violations;
}

// The catalogue test above sees only copy a page renders. A toast shown after an action (电脑声音直采组件可以用了。, 已取消安装。) is never
// rendered there, so a private t(zh, en) or a language branch used only for it passes every rendering test (checked in the review of #1610).
// Parse each JSX module with TypeScript's AST so comments never false-positive and formatting/quote/function-declaration variants are still caught.
test('no live or audio page keeps a private zh/en dictionary or reads the language to pick copy', async () => {
  const violations = [];
  for (const file of ['LiveClass', 'LiveHistory', 'LiveNotes', 'LiveAudioMonitor', 'AudioDashboard', 'AudioReasoning', 'AudioSettings', 'JevSettings', 'WorkflowPortal', 'LiveLoopbackCard']) {
    const source = await readFile(new URL(`../ui/${file}.jsx`, import.meta.url), 'utf8');
    violations.push(...findPrivateI18nInJsx(`${file}.jsx`, source));
  }
  assert.deepEqual(violations, []);
});
