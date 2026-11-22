import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { PAGE_REGISTRY, type CommandPaletteItem, type HostClient, type StudySnapshot, type UiLanguage } from '../types/contracts.js';
import { t, useTuiStore, type TuiStoreState } from '../state/store.js';
import { listThemes, nextThemeId, useTheme } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/index.js';
import { Modal } from '../components/Modal.js';
import { TextInput } from '../components/TextInput.js';
import { nextScrollOffset } from '../components/VirtualList.js';
import { fuzzyFilter } from './fuzzy.js';
import { listCourses, pageIcon } from './data.js';
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

/** Build the full command list from store state + shell actions (pure, exported for tests). */
export function buildPaletteItems(
  state: Pick<TuiStoreState, 'snapshot' | 'preferences' | 'activeRunId'> & {
    navigate: TuiStoreState['navigate'];
    setTheme: TuiStoreState['setTheme'];
    setLanguage: TuiStoreState['setLanguage'];
    toggleSidebar: TuiStoreState['toggleSidebar'];
    setHelpOpen: TuiStoreState['setHelpOpen'];
    setVoicePackOpen: TuiStoreState['setVoicePackOpen'];
    setCoursePickerOpen: TuiStoreState['setCoursePickerOpen'];
    setInboxOpen?: TuiStoreState['setInboxOpen'];
    goBack: TuiStoreState['goBack'];
  },
  actions: ShellActions,
  extra: readonly CommandPaletteItem[] = [],
): CommandPaletteItem[] {
  const lang: UiLanguage = state.preferences.language;
  const asciiMode = Boolean(state.preferences.asciiMode);
  const snap: StudySnapshot | null = state.snapshot;
  const items: CommandPaletteItem[] = [];
  const catAction = t(lang, '命令', 'Action');

  const act = (id: string, label: string, hint: string, action: () => void | Promise<void>, keywords: string[] = [], shortcut?: string) =>
    items.push({ id, label, hint, category: catAction, action, keywords, shortcut });

  const themeArrow = asciiMode ? '->' : '→';
  act('cmd:sample', '/sample', t(lang, '载入示例课程', 'Load sample course'), () => actions.loadSample(), ['示例', 'demo', 'tour']);
  act('cmd:theme', '/theme', t(lang, `切换主题 ${themeArrow} ${nextThemeId(state.preferences.theme)}`, `Cycle theme ${themeArrow} ${nextThemeId(state.preferences.theme)}`), () =>
    state.setTheme(nextThemeId(state.preferences.theme)),
  ['主题', 'color', 'palette']);
  for (const th of listThemes()) {
    act(`cmd:theme:${th.id}`, `/theme ${th.id}`, th.label, () => state.setTheme(th.id), ['主题', 'theme']);
  }
  act('cmd:lang', '/lang', lang === 'zh' ? 'Switch to English' : '切换到中文', () => state.setLanguage(lang === 'zh' ? 'en' : 'zh'), ['language', '语言', '中文', 'english']);
  act('cmd:model', '/model', t(lang, '配置模型（agy / OpenAI）', 'Configure model (agy / OpenAI)'), () => actions.openModelSettings(), ['agy', 'openai', 'deepseek', '模型', 'api key']);
  act('cmd:voicepack', '/voicepack', t(lang, '语音包', 'Voice pack'), () => state.setVoicePackOpen(true), ['voice', '语音', 'tts']);
  act('cmd:inbox', '/inbox', t(lang, '收件箱与通知', 'Notification Inbox'), () => (state.setInboxOpen ?? useTuiStore.getState().setInboxOpen)(true), ['inbox', 'mail', 'notification', '收件箱', '通知', '信箱'], 'I');
  act('cmd:refresh', '/refresh', t(lang, '刷新学习库', 'Refresh library'), () => actions.refresh(), ['reload', '刷新'], 'Ctrl+R');
  act('cmd:course', '/course', t(lang, '切换课程焦点', 'Switch course'), () => state.setCoursePickerOpen(true), ['课程', 'focus'], 'c');
  act('cmd:import', '/import', t(lang, '导入资料', 'Import source'), () => actions.importSource(), ['导入', 'pdf', 'upload']);
  act('cmd:sidebar', '/sidebar', t(lang, '折叠/展开侧栏', 'Toggle sidebar'), () => state.toggleSidebar(), ['侧栏', 'nav'], '\\');
  act('cmd:help', '/help', t(lang, '快捷键帮助', 'Keyboard help'), () => state.setHelpOpen(true), ['帮助', 'keys'], '?');
  act('cmd:back', '/back', t(lang, '返回上一页', 'Go back'), () => state.goBack(), ['返回', 'history'], asciiMode ? 'Bksp' : '⌫');
  act('cmd:quit', '/quit', t(lang, '退出 StudyHub', 'Quit StudyHub'), () => actions.quit(), ['exit', '退出'], 'q');

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
    return buildPaletteItems({ ...s, snapshot, preferences, activeRunId }, actions, extraCommands ?? []);
  }, [snapshot, preferences, activeRunId, actions, extraCommands]);

  const fuzzyResults = useMemo(() => {
    const { scope, term } = parsed;
    if (scope === 'card' || scope === 'passage') {
      return [];
    }
    if (scope === 'all' && !term) {
      const byId = new Map(items.map((i) => [i.id, i]));
      const recent = preferences.recentCommands.map((id) => byId.get(id)).filter((x): x is CommandPaletteItem => Boolean(x));
      const recentIds = new Set(recent.map((r) => r.id));
      const recentCat = t(lang, '最近', 'Recent');
      return [
        ...recent.map((r) => ({ ...r, category: recentCat })),
        ...items.filter((i) => !recentIds.has(i.id) && (i.id.startsWith('cmd:') ? !i.id.startsWith('cmd:theme:') : i.id.startsWith('page:'))),
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
    return fuzzyFilter(pool, term, (i) => i.label, (i) => [...(i.keywords ?? []), i.hint ?? '']).map((r) => r.item);
  }, [items, parsed, preferences.recentCommands, lang]);

  const results = useMemo(
    () => (liveItems.length ? [...fuzzyResults, ...liveItems] : fuzzyResults),
    [fuzzyResults, liveItems],
  );

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
        const dshHome = (host as { dshHome?: string } | undefined)?.dshHome;
        void import('../host/index.js')
          .then(({ saveTuiPreferences }) =>
            saveTuiPreferences(
              { recentCommands },
              dshHome ? { env: { DSH_HOME: dshHome } } : undefined,
            ),
          )
          .catch(() => {});
      }
      s.setCommandPaletteOpen(false);
      onClose();
      Promise.resolve()
        .then(() => item.action())
        .catch((err: unknown) => s.notify(err instanceof Error ? err.message : String(err), 'error'));
    },
    [host, onClose],
  );

  useInput(
    (input, key) => {
      if (key.downArrow || (key.ctrl && (input === 'n' || input === 'j'))) setCursor((c) => Math.min(c + 1, Math.max(0, results.length - 1)));
      else if (key.upArrow || (key.ctrl && (input === 'p' || input === 'k'))) setCursor((c) => Math.max(0, c - 1));
      else if (key.pageDown) setCursor((c) => Math.min(c + listRows, Math.max(0, results.length - 1)));
      else if (key.pageUp) setCursor((c) => Math.max(0, c - listRows));
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
