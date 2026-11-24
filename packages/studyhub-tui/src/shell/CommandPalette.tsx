import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useWindowSize } from 'ink';
import { useScopedInput as useInput } from '../components/key-dispatcher.js';
import { PAGE_REGISTRY, type CommandPaletteItem, type HostClient, type PageId, type StudySnapshot, type TuiPreferences, type UiLanguage } from '../types/contracts.js';
import { t, useTuiStore, type TuiStoreState } from '../state/store.js';
import { saveTuiPreferences } from '../host/tui-prefs.js';
import { listThemes, nextThemeId, useTheme } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { probeTerminalCompatMatrix } from '../render/terminal-compat.js';
import { Modal } from '../components/Modal.js';
import { TextInput } from '../components/TextInput.js';
import { nextScrollOffset, parseSgrWheelDelta, useSgrMouseWheel } from '../components/VirtualList.js';
import { fuzzyFilter } from './fuzzy.js';
import { listCourses, pageIcon } from './data.js';
import { parseAssistantIntent } from './assistant-intent.js';
import { planAssistantWorkflow } from './assistant-workflow.js';
import type { ShellActions } from './actions.js';
import { useShellActions } from './actions.js';

const MAX_ENTITY = 300;
const LIVE_DEBOUNCE_MS = 180;
const LIVE_PER_KIND_LIMIT = 6;
const LIVE_TOTAL_LIMIT = 12;

export type PaletteScope = 'all' | 'cmd' | 'card' | 'passage' | 'course' | 'page';

export interface PaletteScopeResult {
  scope: PaletteScope;
  term: string;
}

const SCOPE_PREFIX_MAP: Record<string, Exclude<PaletteScope, 'all'>> = {
  '/': 'cmd',
  '#': 'card',
  '?': 'passage',
  '@': 'course',
  ':': 'page',
};

const SCOPE_HINTS: ReadonlyArray<{
  scope: Exclude<PaletteScope, 'all'>;
  prefix: string;
  zh: string;
  en: string;
}> = [
  { scope: 'cmd', prefix: '/', zh: '命令', en: 'cmd' },
  { scope: 'card', prefix: '#', zh: '题目', en: 'card' },
  { scope: 'passage', prefix: '?', zh: '片段', en: 'passage' },
  { scope: 'course', prefix: '@', zh: '课程', en: 'course' },
  { scope: 'page', prefix: ':', zh: '页面', en: 'page' },
];

/** Parse an optional leading scope prefix (`/`, `#`, `?`, `@`, `:`) from a palette query. */
export function parsePaletteScope(raw: string): PaletteScopeResult {
  const trimmed = raw.trimStart();
  const first = trimmed[0];
  const scope = first ? SCOPE_PREFIX_MAP[first] : undefined;
  if (scope) {
    return { scope, term: trimmed.slice(1).trim() };
  }
  return { scope: 'all', term: raw.trim() };
}

/** Filter and rank palette items by parsed scope and query term (exported for unit tests). */
export function filterPaletteItems(
  items: readonly CommandPaletteItem[],
  parsed: PaletteScopeResult,
  recentCommands: readonly string[],
  lang: UiLanguage,
): CommandPaletteItem[] {
  const { scope, term } = parsed;
  if (scope === 'card' || scope === 'passage') {
    return [];
  }
  const recentCat = t(lang, '最近', 'Recent');
  const recentOrder = new Map<string, number>();
  recentCommands.forEach((id, idx) => {
    if (!recentOrder.has(id)) recentOrder.set(id, idx);
  });

  if (scope === 'all' && !term) {
    const byId = new Map(items.map((i) => [i.id, i]));
    const recent = recentCommands.map((id) => byId.get(id)).filter((x): x is CommandPaletteItem => Boolean(x));
    const recentIds = new Set(recent.map((r) => r.id));
    return [
      ...recent.map((r) => ({ ...r, category: recentCat })),
      ...items.filter(
        (i) =>
          !recentIds.has(i.id) &&
          (i.id.startsWith('cmd:') ? !i.id.startsWith('cmd:theme:') && !i.id.startsWith('cmd:page:') : i.id.startsWith('page:')),
      ),
    ];
  }
  let pool = items;
  if (scope === 'cmd') {
    pool = items.filter((i) => i.id.startsWith('cmd:') || i.label.startsWith('/'));
  } else if (scope === 'course') {
    pool = items.filter((i) => i.id.startsWith('course:'));
  } else if (scope === 'page') {
    pool = items.filter((i) => i.id.startsWith('page:'));
  }

  // Round 83 Track B2: when scoped with empty term (`/`, `:`, `@`), pin recently used matching items to the top in MRU order!
  if (!term) {
    const recentPool: CommandPaletteItem[] = [];
    const restPool: CommandPaletteItem[] = [];
    for (const item of pool) {
      if (recentOrder.has(item.id)) recentPool.push({ ...item, category: recentCat });
      else restPool.push(item);
    }
    recentPool.sort((a, b) => (recentOrder.get(a.id) ?? 999) - (recentOrder.get(b.id) ?? 999));
    return [...recentPool, ...restPool];
  }

  // When searching with a term, keep fuzzy score primary and boost recently used items on close ties
  const scored = fuzzyFilter(
    pool,
    term,
    (i) => (scope === 'cmd' && i.label.startsWith('/') ? i.label.slice(1) : i.label),
    (i) => [...(i.keywords ?? []), i.hint ?? ''],
  );
  if (recentOrder.size === 0) return scored.map((r) => r.item);
  scored.sort((a, b) => {
    const aRecent = recentOrder.has(a.item.id) ? 12 - Math.min(10, recentOrder.get(a.item.id)!) : 0;
    const bRecent = recentOrder.has(b.item.id) ? 12 - Math.min(10, recentOrder.get(b.item.id)!) : 0;
    return b.score + bRecent - (a.score + aRecent);
  });
  return scored.map((r) => r.item);
}

interface CardSearchHit {
  deckId?: string;
  deckTitle?: string;
  course?: string;
  cardId?: string;
  topic?: string;
  prompt?: string;
}

interface CardSearchResponse {
  results?: CardSearchHit[];
}

interface ContentSearchHit {
  kind?: string;
  sourceId?: string;
  title?: string;
  course?: string;
  page?: number | null;
  snippet?: string;
}

interface ContentSearchResponse {
  results?: ContentSearchHit[];
  groups?: {
    sources?: ContentSearchHit[];
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function clipLine(v: unknown, max = 120, ell = '...'): string {
  const clean = str(v).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, Math.max(1, max - ell.length)).trimEnd()}${ell}` : clean;
}

const SLASH_PAGE_IDS: readonly PageId[] = [
  'library',
  'sources',
  'generate',
  'wrongbook',
  'exam',
  'dashboard',
  'book',
  'skeleton',
  'examcoach',
  'examprep',
  'notes',
  'board',
  'tasks',
  'audio',
  'settings',
  'review',
];

const SLASH_PAGE_LABELS: Partial<Record<PageId, string>> = {
  examcoach: '/coach',
  examprep: '/prep',
};

const SLASH_PAGE_KEYWORDS: Partial<Record<PageId, readonly string[]>> = {
  library: ['home', '主页', '库'],
  sources: ['source', 'pdf', 'docs', '讲义', '阅读'],
  generate: ['gen', 'create', 'drafts', '出题', '草稿'],
  wrongbook: ['wrong', 'mistakes', '错题'],
  exam: ['mock', '模考', '考试'],
  dashboard: ['stats', 'analytics', '统计', '仪表盘'],
  book: ['全书'],
  skeleton: ['tree', '骨架'],
  examcoach: ['coach', 'examcoach', '教练'],
  examprep: ['prep', 'examprep', '备考', '补习'],
  notes: ['note', '笔记'],
  board: ['kanban', 'todo', '看板', '待办'],
  tasks: ['jobs', '任务'],
  audio: ['voice', '音频', '录音'],
  settings: ['config', 'prefs', '设置'],
  review: ['practice', '复习', '刷题'],
};

function persistPreferencePatch(host: HostClient | undefined, patch: Partial<TuiPreferences>): void {
  const dshHome = (host as { dshHome?: string } | undefined)?.dshHome;
  void saveTuiPreferences(patch, dshHome ? { env: { DSH_HOME: dshHome } } : undefined).catch(() => {});
}

/** Build the full command list from store state + shell actions (pure, exported for tests). */
export function buildPaletteItems(
  state: Pick<TuiStoreState, 'snapshot' | 'preferences' | 'activeRunId'> & {
    page?: TuiStoreState['page'];
    navigate: TuiStoreState['navigate'];
    setTheme: TuiStoreState['setTheme'];
    setLanguage: TuiStoreState['setLanguage'];
    toggleSidebar: TuiStoreState['toggleSidebar'];
    setHelpOpen: TuiStoreState['setHelpOpen'];
    setVoicePackOpen: TuiStoreState['setVoicePackOpen'];
    setCoursePickerOpen: TuiStoreState['setCoursePickerOpen'];
    setInboxOpen?: TuiStoreState['setInboxOpen'];
    setPreferences?: TuiStoreState['setPreferences'];
    notify?: TuiStoreState['notify'];
    goBack: TuiStoreState['goBack'];
  },
  actions: ShellActions,
  extra: readonly CommandPaletteItem[] = [],
  host?: HostClient,
): CommandPaletteItem[] {
  const lang: UiLanguage = state.preferences.language;
  const asciiMode = Boolean(state.preferences.asciiMode);
  const snap: StudySnapshot | null = state.snapshot;
  const items: CommandPaletteItem[] = [];
  const catAction = t(lang, '命令', 'Action');
  const setPrefs = state.setPreferences ?? useTuiStore.getState().setPreferences;
  const notify = state.notify ?? useTuiStore.getState().notify;

  const act = (id: string, label: string, hint: string, action: () => void | Promise<void>, keywords: string[] = [], shortcut?: string) =>
    items.push({ id, label, hint, category: catAction, action, keywords, shortcut });

  const themeArrow = asciiMode ? '->' : '→';
  const applyTheme = (next: TuiPreferences['theme']) => {
    state.setTheme(next);
    persistPreferencePatch(host, { theme: next });
    notify(t(lang, `主题已切换：${next}`, `Theme: ${next}`), 'info');
  };
  act('cmd:sample', '/sample', t(lang, '载入示例课程', 'Load sample course'), () => actions.loadSample(), ['示例', 'demo', 'tour']);
  act(
    'cmd:guide',
    '/guide',
    t(lang, '打开完整使用教程（在哪、干什么、怎么用）', 'Open full StudyHub TUI usage guide'),
    () => state.setHelpOpen(true, 'guide'),
    ['guide', 'tutorial', 'docs', 'manual', '教程', '指南', '新手', '帮助'],
    '?',
  );
  act(
    'cmd:assistant',
    '/assistant',
    t(lang, '打开右侧停靠 AI 助手（不抢焦点、自然语言、OSC 52 复制）', 'Open docked AI Assistant panel'),
    () => useTuiStore.getState().openAssistant({ tab: 'assistant', focused: true }),
    ['ai', 'assistant', '助手', '自然语言', '指令'],
    'Ctrl+Space',
  );
  act(
    'cmd:guided',
    '/guided',
    t(lang, `打开统一带学与复述工作台（提问${themeArrow}作答${themeArrow}判定${themeArrow}复述${themeArrow}小结）`, 'Open Guided Study & Retell tab'),
    () => useTuiStore.getState().openAssistant({ tab: 'guided' }),
    ['guided', 'socratic', 'retell', '带学', '复述', '苏格拉底'],
    'T',
  );
  act(
    'cmd:theme',
    '/theme',
    t(lang, `切换主题 ${themeArrow} ${nextThemeId(state.preferences.theme)}`, `Cycle theme ${themeArrow} ${nextThemeId(state.preferences.theme)}`),
    () => applyTheme(nextThemeId(state.preferences.theme)),
    ['主题', 'color', 'palette'],
  );
  for (const th of listThemes()) {
    act(`cmd:theme:${th.id}`, `/theme ${th.id}`, th.label, () => applyTheme(th.id), ['主题', 'theme']);
  }
  act(
    'cmd:lang',
    '/lang',
    lang === 'zh' ? 'Switch to English' : '切换到中文',
    () => {
      const next: UiLanguage = lang === 'zh' ? 'en' : 'zh';
      state.setLanguage(next);
      (host as { setLanguage?: (l: UiLanguage) => void } | undefined)?.setLanguage?.(next);
      persistPreferencePatch(host, { language: next });
      notify(next === 'en' ? 'Language: English' : '界面语言：简体中文', 'info');
    },
    ['language', '语言', '中文', 'english'],
  );
  act(
    'cmd:due',
    '/due',
    t(lang, '立即开始今日到期复习', 'Start today\'s due review queue'),
    async () => {
      if (!host) {
        state.navigate('library');
        return;
      }
      try {
        let effectiveSnap = snap;
        if (!effectiveSnap) {
          const snapRes = await host.call<StudySnapshot>('snapshot', {});
          if (snapRes.ok && snapRes.value) effectiveSnap = snapRes.value;
        }
        const focusCourse =
          typeof (effectiveSnap?.focus as { course?: unknown } | undefined)?.course === 'string'
            ? String((effectiveSnap?.focus as { course?: string } | undefined)?.course ?? '').trim()
            : '';
        const progressMap = (effectiveSnap?.progress && typeof effectiveSnap.progress === 'object'
          ? effectiveSnap.progress
          : {}) as Record<string, { due?: number } | undefined>;
        const decks = Array.isArray(effectiveSnap?.decks) ? effectiveSnap.decks : [];
        const dueCandidates = decks
          .filter((d) => {
            if (!d || typeof d !== 'object' || d.archived) return false;
            const rec = d as Record<string, unknown>;
            if (rec.systemKind) return false;
            if (focusCourse && String(d.course ?? '').trim() !== focusCourse) return false;
            return true;
          })
          .map((d) => {
            const rec = d as Record<string, unknown>;
            const due = Number(progressMap[d.id]?.due ?? rec.due ?? d.dueCount ?? 0) || 0;
            return { id: d.id, due };
          })
          .filter((d) => d.id && d.due > 0)
          .sort((a, b) => b.due - a.due);

        const targetDeck = dueCandidates[0];
        if (!targetDeck) {
          notify(t(lang, '当前没有到期复习题', 'No due cards to review right now'), 'info');
          state.navigate('library');
          return;
        }

        const res = await host.call<{ id?: string; runId?: string }>('review.start', {
          mode: 'due',
          deckId: targetDeck.id,
        });
        const runId = res.ok ? res.value?.id || res.value?.runId : undefined;
        if (runId) {
          state.navigate('review', { runId, deckId: targetDeck.id });
        } else {
          notify(
            !res.ok
              ? res.error?.message || t(lang, '当前没有到期复习题', 'No due cards to review right now')
              : t(lang, '当前没有到期复习题', 'No due cards to review right now'),
            'info',
          );
          state.navigate('library');
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    ['due', 'review', 'queue', '到期', '今日', '复习'],
  );
  act(
    'cmd:ascii',
    '/ascii',
    t(lang, asciiMode ? '关闭 ASCII 模式（恢复图形符号）' : '开启 ASCII 纯字符模式', asciiMode ? 'Disable ASCII mode (restore Unicode)' : 'Enable ASCII pure-char mode'),
    () => {
      const next = !Boolean(state.preferences.asciiMode);
      setPrefs({ asciiMode: next });
      persistPreferencePatch(host, { asciiMode: next });
      notify(
        t(lang, next ? '已切换为 ASCII 纯字符模式' : '已恢复 Unicode 图形模式', next ? 'ASCII mode enabled' : 'Unicode chrome restored'),
        'info',
      );
    },
    ['ascii', 'unicode', 'chrome', '字符', '纯字符'],
  );
  act(
    'cmd:math',
    '/math',
    t(lang, state.preferences.mathUnicode ? '切换数学公式为原始 LaTeX' : '开启 Unicode 数学公式渲染', state.preferences.mathUnicode ? 'Switch math to raw LaTeX' : 'Enable Unicode math rendering'),
    () => {
      const next = !Boolean(state.preferences.mathUnicode);
      setPrefs({ mathUnicode: next });
      persistPreferencePatch(host, { mathUnicode: next });
      notify(
        t(lang, next ? '已开启 Unicode 数学公式渲染' : '已切换为原始 LaTeX 显示', next ? 'Unicode Math enabled' : 'Raw LaTeX mode'),
        'info',
      );
    },
    ['math', 'latex', 'unicode', 'formula', '数学', '公式'],
  );
  act(
    'cmd:density',
    '/density',
    t(
      lang,
      state.preferences.compactMode ? '切换为宽松间距（默认，抗视觉疲劳）' : '切换为紧凑间距（容纳更多行）',
      state.preferences.compactMode ? 'Switch to relaxed spacing (default)' : 'Switch to compact spacing (more rows)',
    ),
    () => {
      const next = !Boolean(state.preferences.compactMode);
      setPrefs({ compactMode: next });
      persistPreferencePatch(host, { compactMode: next });
      notify(
        t(lang, next ? '已切换为紧凑间距档位' : '已切换为宽松间距档位', next ? 'Density: Compact' : 'Density: Relaxed'),
        'info',
      );
    },
    ['density', 'compact', 'relaxed', 'spacing', '紧凑', '宽松', '间距'],
  );
  act(
    'cmd:terminal',
    '/terminal',
    t(lang, '诊断终端能力矩阵（OSC 52/8/2/9 · tmux/screen · 色彩）', 'Inspect terminal capabilities (OSC 52/8/2/9, mux, color)'),
    () => {
      const m = probeTerminalCompatMatrix({ asciiMode });
      const on = (b: boolean) => (b ? 'ON' : 'off');
      notify(
        `mux:${m.mux} L${m.colorLevel} | OSC52:${on(m.osc52Copy)} OSC8:${on(m.osc8Hyperlink)} OSC2:${on(m.osc2Title)} OSC9:${on(m.osc9Notify)}`,
        'info',
      );
    },
    ['terminal', 'osc', 'tmux', 'screen', 'doctor', '终端', '诊断', '能力'],
  );
  act(
    'cmd:pin',
    '/pin',
    t(lang, '收藏/取消收藏当前页面到快捷书签（最多 5 项）', 'Pin/unpin current page to quick bookmarks (max 5)'),
    () => {
      const activePage = state.page ?? useTuiStore.getState().page;
      const curMeta = PAGE_REGISTRY.find((p) => p.id === activePage);
      if (!curMeta) return;
      const existing = state.preferences.pinnedTargets ?? [];
      const exists = existing.some((p) => p.kind === 'page' && p.id === curMeta.id);
      const nextPins = exists
        ? existing.filter((p) => !(p.kind === 'page' && p.id === curMeta.id))
        : [{ kind: 'page' as const, id: curMeta.id, label: lang === 'en' ? curMeta.labelEn : curMeta.labelZh }, ...existing].slice(0, 5);
      setPrefs({ pinnedTargets: nextPins });
      persistPreferencePatch(host, { pinnedTargets: nextPins });
      notify(
        t(
          lang,
          exists ? `已取消书签「${curMeta.labelZh}」` : `已添加快捷书签「${curMeta.labelZh}」`,
          exists ? `Unpinned "${curMeta.labelEn}"` : `Pinned "${curMeta.labelEn}"`,
        ),
        'info',
      );
    },
    ['pin', 'bookmark', 'favorite', '书签', '收藏', '置顶'],
  );
  const pinnedList = state.preferences.pinnedTargets ?? [];
  for (const pin of pinnedList) {
    items.push({
      id: `pin:${pin.kind}:${pin.id}`,
      label: `${asciiMode ? '*' : '★'} ${pin.label}`,
      hint: t(lang, '快捷书签', 'Pinned bookmark'),
      category: t(lang, '书签', 'Pinned'),
      keywords: ['pin', 'bookmark', '书签', pin.label, pin.id],
      action: () => {
        if (pin.kind === 'page') state.navigate(pin.id as PageId);
        else if (pin.kind === 'deck') state.navigate('review', { deckId: pin.id });
        else state.navigate('sources', { sourceId: pin.id });
      },
    });
  }
  act(
    'cmd:recover',
    '/recover',
    t(lang, '恢复中断的后台任务', 'Recover interrupted background jobs'),
    async () => {
      if (!host) {
        notify(t(lang, '无法恢复中断任务：主机未就绪', 'Cannot recover jobs: host unavailable'), 'warning');
        return;
      }
      try {
        const res = await host.call<{ recovered?: number }>('coverage.recover', {});
        if (!res.ok) {
          notify(res.error?.message || t(lang, '恢复中断任务失败', 'Failed to recover interrupted jobs'), 'error');
          return;
        }
        const recovered = typeof res.value?.recovered === 'number' ? res.value.recovered : 0;
        await actions.refresh();
        if (recovered > 0) {
          notify(t(lang, `已恢复 ${recovered} 个中断任务`, `Recovered ${recovered} interrupted job(s)`), 'success');
        } else {
          notify(t(lang, '当前没有可恢复的中断任务', 'No interrupted jobs to recover'), 'info');
        }
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      }
    },
    ['recover', 'jobs', 'resume', '恢复', '中断', '任务'],
  );
  act(
    'cmd:compact',
    '/compact',
    t(
      lang,
      state.preferences.compactMode ? '关闭紧凑布局（恢复标准间距）' : '开启紧凑布局模式',
      state.preferences.compactMode ? 'Disable compact mode (standard spacing)' : 'Enable compact layout mode',
    ),
    () => {
      const next = !Boolean(state.preferences.compactMode);
      setPrefs({ compactMode: next });
      persistPreferencePatch(host, { compactMode: next });
      notify(
        t(lang, next ? '紧凑布局已开启' : '紧凑布局已关闭', next ? 'Compact mode enabled' : 'Compact mode disabled'),
        'info',
      );
    },
    ['compact', 'density', 'layout', '紧凑', '布局', '间距'],
  );
  act(
    'cmd:hints',
    '/hints',
    t(
      lang,
      state.preferences.showKeyHints ? '隐藏底部快捷键提示' : '显示底部快捷键提示',
      state.preferences.showKeyHints ? 'Hide footer key hints' : 'Show footer key hints',
    ),
    () => {
      const next = !Boolean(state.preferences.showKeyHints);
      setPrefs({ showKeyHints: next });
      persistPreferencePatch(host, { showKeyHints: next });
      notify(
        t(lang, next ? '底部快捷键提示已显示' : '底部快捷键提示已隐藏', next ? 'Footer key hints shown' : 'Footer key hints hidden'),
        'info',
      );
    },
    ['hints', 'keyhints', 'footer', 'keys', '提示', '快捷键', '底部'],
  );
  act(
    'cmd:proactive',
    '/proactive',
    t(
      lang,
      state.preferences.proactiveHints !== false ? '关闭卡住 20 秒主动学习提示' : '开启卡住 20 秒主动学习提示',
      state.preferences.proactiveHints !== false ? 'Disable proactive 20s stuck hints' : 'Enable proactive 20s stuck hints',
    ),
    () => {
      const next = state.preferences.proactiveHints === false;
      setPrefs({ proactiveHints: next });
      persistPreferencePatch(host, { proactiveHints: next });
      notify(
        t(lang, next ? '主动学习提示已开启' : '主动学习提示已关闭', next ? 'Proactive hints enabled' : 'Proactive hints disabled'),
        'info',
      );
    },
    ['proactive', 'nudge', 'stuck', '主动', '卡住', '提示'],
  );
  act('cmd:model', '/model', t(lang, '配置模型（agy / OpenAI）', 'Configure model (agy / OpenAI)'), () => actions.openModelSettings(), ['agy', 'openai', 'deepseek', '模型', 'api key']);
  act('cmd:voicepack', '/voicepack', t(lang, '语音包', 'Voice pack'), () => state.setVoicePackOpen(true), ['voice', '语音', 'tts']);
  act('cmd:inbox', '/inbox', t(lang, '收件箱与通知', 'Notification Inbox'), () => (state.setInboxOpen ?? useTuiStore.getState().setInboxOpen)(true), ['inbox', 'mail', 'notification', '收件箱', '通知', '信箱'], 'I');
  act('cmd:refresh', '/refresh', t(lang, '刷新学习库', 'Refresh library'), () => actions.refresh(), ['reload', '刷新'], 'Ctrl+R');
  act('cmd:course', '/course', t(lang, '切换课程焦点', 'Switch course'), () => state.setCoursePickerOpen(true), ['课程', 'focus'], 'c');
  act('cmd:import', '/import', t(lang, '导入资料', 'Import source'), () => actions.importSource(), ['导入', 'pdf', 'upload']);
  act(
    'cmd:sidebar',
    '/sidebar',
    t(lang, '折叠/展开侧栏', 'Toggle sidebar'),
    () => {
      const next = !Boolean(state.preferences.sidebarCollapsed);
      setPrefs({ sidebarCollapsed: next });
      persistPreferencePatch(host, { sidebarCollapsed: next });
      notify(
        t(lang, next ? '侧边栏已收起' : '侧边栏已展开', next ? 'Sidebar collapsed' : 'Sidebar expanded'),
        'info',
      );
    },
    ['sidebar', 'nav', 'collapse', '侧栏', '侧边栏'],
    '\\',
  );
  act('cmd:help', '/help', t(lang, '快捷键帮助', 'Keyboard help'), () => state.setHelpOpen(true), ['帮助', 'keys'], '?');
  act('cmd:back', '/back', t(lang, '返回上一页', 'Go back'), () => state.goBack(), ['返回', 'history'], asciiMode ? 'Bksp' : '⌫');
  act('cmd:quit', '/quit', t(lang, '退出 StudyHub', 'Quit StudyHub'), () => actions.quit(), ['exit', '退出'], 'q');

  const pageMetaMap = new Map(PAGE_REGISTRY.map((p) => [p.id, p]));
  for (const pid of SLASH_PAGE_IDS) {
    const meta = pageMetaMap.get(pid);
    if (!meta) continue;
    const slashLabel = SLASH_PAGE_LABELS[pid] ?? `/${pid}`;
    const extraKw = SLASH_PAGE_KEYWORDS[pid] ?? [];
    act(
      `cmd:page:${pid}`,
      slashLabel,
      t(lang, `前往${meta.labelZh}`, `Open ${meta.labelEn}`),
      () => (pid === 'review' && state.activeRunId ? state.navigate('review', { runId: state.activeRunId }) : state.navigate(pid)),
      [pid, slashLabel.slice(1), meta.labelZh, meta.labelEn, ...extraKw],
      meta.shortcut,
    );
  }

  const catPage = t(lang, '页面', 'Page');
  for (const p of PAGE_REGISTRY) {
    items.push({
      id: `page:${p.id}`,
      label: `${pageIcon(p.id, asciiMode, p.icon)} ${t(lang, p.labelZh, p.labelEn)}`,
      hint: t(lang, p.descriptionZh, p.descriptionEn),
      category: catPage,
      shortcut: p.shortcut,
      keywords: [p.id, p.labelZh, p.labelEn],
      action: () =>
        p.id === 'review' && state.activeRunId ? state.navigate('review', { runId: state.activeRunId }) : state.navigate(p.id),
    });
  }

  const catCourse = t(lang, '课程', 'Course');
  const courseGlyph = asciiMode ? 'o' : '◎';
  items.push({
    id: 'course:*',
    label: t(lang, `${courseGlyph} 全部课程`, `${courseGlyph} All courses`),
    category: catCourse,
    keywords: ['all', '全部'],
    action: () => actions.setCourse(null),
  });
  for (const c of listCourses(snap).slice(0, MAX_ENTITY)) {
    items.push({
      id: `course:${c.key}`,
      label: `${courseGlyph} ${c.label}`,
      hint: c.dueCount ? t(lang, `${c.dueCount} 待复习`, `${c.dueCount} due`) : undefined,
      category: catCourse,
      keywords: [c.key],
      action: () => actions.setCourse(c.key),
    });
  }

  const catDeck = t(lang, '题组', 'Deck');
  const deckGlyph = asciiMode ? '#' : '▦';
  for (const d of (snap?.decks ?? []).filter((x) => !x.archived).slice(0, MAX_ENTITY)) {
    items.push({
      id: `deck:${d.id}`,
      label: `${deckGlyph} ${str(d.title) || str(d.name) || d.id}`,
      hint: [str(d.course), d.dueCount ? t(lang, `${d.dueCount} 待复习`, `${d.dueCount} due`) : ''].filter(Boolean).join(' · ') || undefined,
      category: catDeck,
      keywords: [str(d.course)],
      action: () => state.navigate('library', { deckId: d.id, course: d.course ?? null }),
    });
  }

  const catSource = t(lang, '资料', 'Source');
  const sourceGlyph = asciiMode ? '#' : '▤';
  for (const s of (snap?.sources ?? []).filter((x) => !x.archived).slice(0, MAX_ENTITY)) {
    items.push({
      id: `source:${s.id}`,
      label: `${sourceGlyph} ${str(s.title) || str(s.name) || str(s.filename) || s.id}`,
      hint: [str(s.format || s.ext).toUpperCase(), str(s.course)].filter(Boolean).join(' · ') || undefined,
      category: catSource,
      keywords: [str(s.filename)],
      action: () => state.navigate('sources', { sourceId: s.id }),
    });
  }

  const catNote = t(lang, '笔记', 'Note');
  const noteGlyph = asciiMode ? '*' : '✎';
  for (const n of (snap?.notes ?? []).slice(0, MAX_ENTITY)) {
    const id = str(n.id);
    if (!id) continue;
    items.push({
      id: `note:${id}`,
      label: `${noteGlyph} ${str(n.title) || str(n.name) || id}`,
      hint: str(n.course) || undefined,
      category: catNote,
      action: () => state.navigate('notes', { noteId: id }),
    });
  }

  items.push(...extra);
  return items;
}

export interface CommandPaletteProps {
  host?: HostClient;
  isActive: boolean;
  onClose: () => void;
  /** Extra commands contributed by the app/views. */
  extraCommands?: readonly CommandPaletteItem[];
  /** Initial query (e.g. '/' when opened with slash). */
  initialQuery?: string;
}

/**
 * Synthesize a live Natural-Language command item for CommandPalette using the shared
 * `#1315` Assistant intent & workflow parsers (Round 89 Track B6).
 * Returns `null` for slash/scoped commands or non-actionable queries.
 */
export function buildNaturalLanguagePaletteItem(
  rawQuery: string,
  ctx: {
    snapshot: StudySnapshot | null;
    lang: UiLanguage;
    asciiMode: boolean;
    cardId?: string | null;
    deckId?: string | null;
  },
): CommandPaletteItem | null {
  const q = rawQuery.trim();
  if (q.length < 2 || q.startsWith('/') || q.startsWith(':') || q.startsWith('@') || q.startsWith('#') || q.startsWith('$')) {
    return null;
  }

  const nlIcon = ctx.asciiMode ? '*' : '✦';
  const category = t(ctx.lang, '自然语言', 'Natural Lang');

  const wf = planAssistantWorkflow(q, {
    snapshot: ctx.snapshot,
    currentCardId: ctx.cardId,
    currentDeckId: ctx.deckId,
    lang: ctx.lang,
  });
  if (wf && wf.steps.some((s) => s.intent.kind !== 'chat' && s.intent.kind !== 'unsupported')) {
    return {
      id: 'nl:workflow',
      label: `${nlIcon} ${t(ctx.lang, `多步执行 (${wf.steps.length} 步): ${q}`, `Multi-step (${wf.steps.length}): ${q}`)}`,
      hint: t(ctx.lang, '交由 AI 助手逐步确认执行', 'Hand off to AI Assistant step-by-step'),
      category,
      action: () => {
        useTuiStore.getState().openAssistant({ tab: 'assistant', focused: true });
      },
    };
  }

  const intent = parseAssistantIntent(q, {
    snapshot: ctx.snapshot,
    currentCardId: ctx.cardId,
    currentDeckId: ctx.deckId,
    lang: ctx.lang,
  });
  if (intent.kind === 'chat' || intent.kind === 'unsupported') return null;

  return {
    id: `nl:${intent.actionName}`,
    label: `${nlIcon} ${intent.paramsSummary}`,
    hint: intent.requiresConfirm
      ? t(ctx.lang, '需在 AI 助手确认后执行', 'Requires confirmation in AI Assistant')
      : t(ctx.lang, '自然语言直达', 'Natural language action'),
    category,
    action: () => {
      const s = useTuiStore.getState();
      if (intent.kind === 'navigate') {
        s.navigate(intent.page, {
          ...(intent.sourceId ? { sourceId: intent.sourceId } : {}),
          ...(intent.pageNumber ? { pageNumber: intent.pageNumber } : {}),
        });
        return;
      }
      if (intent.kind === 'enter_guided') {
        s.openAssistant({ tab: 'guided', stage: intent.stage ?? 'question', focused: true });
        return;
      }
      if (intent.kind === 'set_preference') {
        s.setPreferences(intent.patch);
        persistPreferencePatch(undefined, intent.patch);
        s.notify(t(ctx.lang, `已切换：${intent.paramsSummary}`, `Updated: ${intent.paramsSummary}`), 'success');
        return;
      }
      if (intent.kind === 'readonly_stats') {
        s.navigate('dashboard');
        return;
      }
      s.openAssistant({ tab: 'assistant', focused: true });
    },
  };
}

export const CommandPalette = memo(function CommandPalette({
  host,
  isActive,
  onClose,
  extraCommands,
  initialQuery = '',
}: CommandPaletteProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const actions = useShellActions();
  const snapshot = useTuiStore((s) => s.snapshot);
  const preferences = useTuiStore((s) => s.preferences);
  const activeRunId = useTuiStore((s) => s.activeRunId);
  const lang = preferences.language;
  const asciiMode = Boolean(preferences.asciiMode);
  const ell = asciiMode ? '...' : '…';
  const [query, setQuery] = useState(initialQuery);
  const [cursor, setCursor] = useState(0);
  const [liveItems, setLiveItems] = useState<CommandPaletteItem[]>([]);
  const [searching, setSearching] = useState(false);
  const offsetRef = useRef(0);
  const seqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      seqRef.current += 1;
    };
  }, []);

  const parsed = useMemo(() => parsePaletteScope(query), [query]);

  useEffect(() => {
    const { scope, term } = parsed;
    const seq = ++seqRef.current;

    const wantsCards = scope === 'all' || scope === 'card';
    const wantsPassages = scope === 'all' || scope === 'passage';

    if (!isActive || !host || term.length < 2 || (!wantsCards && !wantsPassages)) {
      setLiveItems((prev) => (prev.length ? [] : prev));
      setSearching(false);
      return;
    }

    setLiveItems((prev) => (prev.length ? [] : prev));
    setSearching(true);

    const limit = scope === 'all' ? LIVE_PER_KIND_LIMIT : LIVE_TOTAL_LIMIT;
    const timer = setTimeout(() => {
      Promise.all([
        wantsCards
          ? host.call<CardSearchResponse>('card.search', { query: term, limit }).catch(() => null)
          : Promise.resolve(null),
        wantsPassages
          ? host.call<ContentSearchResponse>('search.content', { query: term, limit, includeSample: true }).catch(() => null)
          : Promise.resolve(null),
      ])
        .then(([cardRes, contentRes]) => {
          if (!mountedRef.current || seqRef.current !== seq) return;

          const cardHits = cardRes?.ok && Array.isArray(cardRes.value?.results) ? cardRes.value.results : [];
          const rawContentHits =
            contentRes?.ok && Array.isArray(contentRes.value?.groups?.sources)
              ? contentRes.value.groups.sources
              : contentRes?.ok && Array.isArray(contentRes.value?.results)
                ? contentRes.value.results.filter((item) => item?.kind === 'source')
                : [];

          const next: CommandPaletteItem[] = [];
          const cardCat = t(lang, '题库', 'Card');
          const contentCat = t(lang, '原文', 'Passage');
          const cardIcon = asciiMode ? '*' : '❖';
          const contentIcon = asciiMode ? '#' : '¶';

          for (const hit of cardHits) {
            if (next.length >= LIVE_TOTAL_LIMIT) break;
            const deckId = str(hit?.deckId);
            const cardId = str(hit?.cardId);
            if (!deckId || !cardId) continue;
            const promptText = clipLine(hit.prompt, 120, ell) || clipLine(hit.topic, 120, ell) || cardId;
            const hint = [clipLine(hit.topic, 40, ell), clipLine(hit.deckTitle, 40, ell), clipLine(hit.course, 32, ell)]
              .filter(Boolean)
              .join(' · ');
            next.push({
              id: `live:card:${deckId}:${cardId}`,
              label: `${cardIcon} ${promptText}`,
              hint: hint || undefined,
              category: cardCat,
              action: async () => {
                const res = await host.call<{ id?: string }>('review.start', {
                  mode: 'path',
                  scope: [{ deckId, cardId }],
                  fresh: true,
                });
                if (res.ok && res.value?.id) {
                  useTuiStore.getState().navigate('review', { runId: res.value.id });
                  return;
                }
                useTuiStore
                  .getState()
                  .notify(res.error?.message || t(lang, '无法启动题目练习', 'Failed to start practice'), 'error');
              },
            });
          }

          rawContentHits.forEach((hit, idx) => {
            if (next.length >= LIVE_TOTAL_LIMIT) return;
            const sourceId = str(hit?.sourceId);
            if (!sourceId) return;
            const pageNum = typeof hit.page === 'number' && Number.isFinite(hit.page) && hit.page >= 1 ? Math.trunc(hit.page) : undefined;
            const titleText = clipLine(hit.title, 80, ell) || sourceId;
            const pageTag = pageNum !== undefined ? ` (p.${pageNum})` : '';
            const hint = clipLine(hit.snippet, 120, ell) || clipLine(hit.course, 40, ell) || undefined;
            next.push({
              id: `live:source:${sourceId}:${pageNum ?? 0}:${idx}`,
              label: `${contentIcon} ${titleText}${pageTag}`,
              hint,
              category: contentCat,
              action: () => {
                useTuiStore.getState().navigate('sources', pageNum !== undefined ? { sourceId, pageNumber: pageNum } : { sourceId });
              },
            });
          });

          setLiveItems(next.slice(0, LIVE_TOTAL_LIMIT));
          setSearching(false);
        })
        .catch(() => {
          if (!mountedRef.current || seqRef.current !== seq) return;
          setSearching(false);
        });
    }, LIVE_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      seqRef.current += 1;
    };
  }, [parsed, isActive, host, lang, asciiMode, ell]);

  const items = useMemo(() => {
    const s = useTuiStore.getState();
    return buildPaletteItems({ ...s, snapshot, preferences, activeRunId }, actions, extraCommands ?? [], host);
  }, [snapshot, preferences, activeRunId, actions, extraCommands, host]);

  const fuzzyResults = useMemo(
    () => filterPaletteItems(items, parsed, preferences.recentCommands, lang),
    [items, parsed, preferences.recentCommands, lang],
  );

  const assistantCardContext = useTuiStore((s) => s.assistantCardContext);
  const nlItem = useMemo(
    () =>
      buildNaturalLanguagePaletteItem(query, {
        snapshot,
        lang,
        asciiMode,
        cardId: assistantCardContext?.cardId,
        deckId: assistantCardContext?.deckId,
      }),
    [query, snapshot, lang, asciiMode, assistantCardContext?.cardId, assistantCardContext?.deckId],
  );

  const results = useMemo(() => {
    const base = liveItems.length ? [...fuzzyResults, ...liveItems] : fuzzyResults;
    if (!nlItem) return base;
    return base.length > 0 ? [...base, nlItem] : [nlItem];
  }, [fuzzyResults, liveItems, nlItem]);

  const width = Math.min(84, Math.max(40, columns - 8));
  const listRows = Math.max(3, Math.min(13, rows - 11));
  const sel = Math.min(cursor, Math.max(0, results.length - 1));
  const off = nextScrollOffset(sel, offsetRef.current, listRows, results.length, 1);
  offsetRef.current = off;

  const run = useCallback(
    (item: CommandPaletteItem | undefined) => {
      if (!item) return;
      const s = useTuiStore.getState();
      if (!item.id.startsWith('live:')) {
        s.recordRecentCommand(item.id);
        const recentCommands = useTuiStore.getState().preferences.recentCommands;
        persistPreferencePatch(host, { recentCommands });
      }
      s.setCommandPaletteOpen(false);
      onClose();
      Promise.resolve()
        .then(() => item.action())
        .catch((err: unknown) => s.notify(err instanceof Error ? err.message : String(err), 'error'));
    },
    [host, onClose],
  );

  const moveCursor = useCallback(
    (delta: number) => {
      if (results.length === 0) return;
      const maxIndex = results.length - 1;
      setCursor((c) => Math.max(0, Math.min(Math.min(c, maxIndex) + delta, maxIndex)));
    },
    [results.length],
  );

  useSgrMouseWheel(isActive, moveCursor);

  useInput(
    (input, key) => {
      const wheelDelta = parseSgrWheelDelta(input);
      if (wheelDelta !== 0) {
        moveCursor(wheelDelta);
        return;
      }
      if (key.downArrow || (key.ctrl && (input === 'n' || input === 'j'))) moveCursor(1);
      else if (key.upArrow || (key.ctrl && (input === 'p' || input === 'k'))) moveCursor(-1);
      else if (key.pageDown) moveCursor(listRows);
      else if (key.pageUp) moveCursor(-listRows);
    },
    { isActive },
  );

  const inner = width - 6;
  const visible = results.slice(off, off + listRows);
  return (
    <Modal
      title={t(lang, '命令面板', 'Command Palette')}
      icon={asciiMode ? '>' : '⌘'}
      subtitle={searching ? `${results.length} · ${t(lang, `正在全文检索${ell}`, `Searching${ell}`)}` : `${results.length}`}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={[
        { key: asciiMode ? 'Up/Dn' : '↑↓', label: t(lang, '选择', 'Select') },
        { key: 'Enter', label: t(lang, '执行', 'Run') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ]}
    >
      <Box height={1}>
        <TextInput
          value={query}
          onChange={(v) => {
            setQuery(v);
            setCursor(0);
          }}
          onSubmit={() => run(results[sel])}
          onCancel={onClose}
          isActive={isActive}
          prompt={asciiMode ? '>' : '›'}
          width={inner - 2}
          placeholder={t(
            lang,
            `搜索页面、课程、题组、资料、笔记，或输入 / 命令${ell}`,
            `Search pages, courses, decks, sources, notes, or / commands${ell}`,
          )}
        />
      </Box>
      <Box height={1} width={inner} overflow="hidden" marginBottom={1}>
        <Text wrap="truncate-end">
          {SCOPE_HINTS.map((chip, idx) => {
            const active = parsed.scope === chip.scope;
            const label = `${chip.prefix} ${t(lang, chip.zh, chip.en)}`;
            return (
              <Text key={chip.scope}>
                {idx > 0 ? <Text color={theme.dim}>{'  '}</Text> : null}
                <Text color={active ? theme.accent : theme.muted} bold={active}>
                  {label}
                </Text>
              </Text>
            );
          })}
        </Text>
      </Box>
      <Box flexDirection="column" height={listRows}>
        {results.length === 0 ? (
          <Box height={1} width={inner} overflow="hidden">
            <Text color={theme.muted} wrap="truncate-end">
              {(parsed.scope === 'card' || parsed.scope === 'passage') && parsed.term.length < 2
                ? parsed.scope === 'card'
                  ? t(lang, `  输入至少 2 个字符以搜索题目${ell}`, `  Type at least 2 chars to search cards${ell}`)
                  : t(lang, `  输入至少 2 个字符以搜索片段${ell}`, `  Type at least 2 chars to search passages${ell}`)
                : searching
                  ? t(lang, `  正在全文检索${ell}`, `  Searching${ell}`)
                  : t(lang, '  没有匹配的结果', '  No matches')}
            </Text>
          </Box>
        ) : (
          visible.map((item, i) => {
            const idx = off + i;
            const active = idx === sel;
            const cat = ` ${item.category} `;
            const sc = item.shortcut ? ` ${item.shortcut}` : '';
            const right = displayWidth(cat) + displayWidth(sc) + 1;
            const labelW = Math.max(6, Math.min(displayWidth(item.label), Math.floor((inner - right) * 0.55)));
            const label = truncateDisplay(item.label, labelW, ell);
            const hint = item.hint ? truncateDisplay(`  ${item.hint}`, Math.max(0, inner - right - displayWidth(label) - 2), ell) : '';
            return (
              <Box key={item.id} height={1} width={inner} backgroundColor={active ? theme.selectionBg : undefined}>
                <Text color={active ? theme.primary : theme.dim}>{active ? (asciiMode ? '> ' : '❯ ') : '  '}</Text>
                <Box flexGrow={1} overflow="hidden">
                  <Text wrap="truncate-end">
                    <Text color={active ? theme.selectionFg : theme.text} bold={active}>
                      {label}
                    </Text>
                    <Text color={theme.muted}>{hint}</Text>
                  </Text>
                </Box>
                <Text color={theme.dim}>{sc}</Text>
                <Text> </Text>
                <Text color={theme.accent} backgroundColor={theme.bg}>
                  {cat}
                </Text>
              </Box>
            );
          })
        )}
      </Box>
    </Modal>
  );
});
