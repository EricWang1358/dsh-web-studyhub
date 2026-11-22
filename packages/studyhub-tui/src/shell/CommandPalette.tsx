import React, { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { PAGE_REGISTRY, type CommandPaletteItem, type StudySnapshot, type UiLanguage } from '../types/contracts.js';
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

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
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

  act('cmd:sample', '/sample', t(lang, '载入示例课程', 'Load sample course'), () => actions.loadSample(), ['示例', 'demo', 'tour']);
  act('cmd:theme', '/theme', t(lang, `切换主题 → ${nextThemeId(state.preferences.theme)}`, `Cycle theme → ${nextThemeId(state.preferences.theme)}`), () =>
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
  items.push({
    id: 'course:*',
    label: t(lang, '◎ 全部课程', '◎ All courses'),
    category: catCourse,
    keywords: ['all', '全部'],
    action: () => actions.setCourse(null),
  });
  for (const c of listCourses(snap).slice(0, MAX_ENTITY)) {
    items.push({
      id: `course:${c.key}`,
      label: `◎ ${c.label}`,
      hint: c.dueCount ? t(lang, `${c.dueCount} 待复习`, `${c.dueCount} due`) : undefined,
      category: catCourse,
      keywords: [c.key],
      action: () => actions.setCourse(c.key),
    });
  }

  const catDeck = t(lang, '题组', 'Deck');
  for (const d of (snap?.decks ?? []).filter((x) => !x.archived).slice(0, MAX_ENTITY)) {
    items.push({
      id: `deck:${d.id}`,
      label: `▦ ${str(d.title) || str(d.name) || d.id}`,
      hint: [str(d.course), d.dueCount ? t(lang, `${d.dueCount} 待复习`, `${d.dueCount} due`) : ''].filter(Boolean).join(' · ') || undefined,
      category: catDeck,
      keywords: [str(d.course)],
      action: () => state.navigate('library', { deckId: d.id, course: d.course ?? null }),
    });
  }

  const catSource = t(lang, '资料', 'Source');
  for (const s of (snap?.sources ?? []).filter((x) => !x.archived).slice(0, MAX_ENTITY)) {
    items.push({
      id: `source:${s.id}`,
      label: `▤ ${str(s.title) || str(s.name) || str(s.filename) || s.id}`,
      hint: [str(s.format || s.ext).toUpperCase(), str(s.course)].filter(Boolean).join(' · ') || undefined,
      category: catSource,
      keywords: [str(s.filename)],
      action: () => state.navigate('sources', { sourceId: s.id }),
    });
  }

  const catNote = t(lang, '笔记', 'Note');
  for (const n of (snap?.notes ?? []).slice(0, MAX_ENTITY)) {
    const id = str(n.id);
    if (!id) continue;
    items.push({
      id: `note:${id}`,
      label: `✎ ${str(n.title) || str(n.name) || id}`,
      hint: str(n.course) || undefined,
      category: catNote,
      action: () => state.navigate('notes', { noteId: id }),
    });
  }

  items.push(...extra);
  return items;
}

export interface CommandPaletteProps {
  isActive: boolean;
  onClose: () => void;
  /** Extra commands contributed by the app/views. */
  extraCommands?: readonly CommandPaletteItem[];
  /** Initial query (e.g. '/' when opened with slash). */
  initialQuery?: string;
}

export const CommandPalette = memo(function CommandPalette({ isActive, onClose, extraCommands, initialQuery = '' }: CommandPaletteProps) {
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
  const offsetRef = useRef(0);

  const items = useMemo(() => {
    const s = useTuiStore.getState();
    return buildPaletteItems({ ...s, snapshot, preferences, activeRunId }, actions, extraCommands ?? []);
  }, [snapshot, preferences, activeRunId, actions, extraCommands]);

  const results = useMemo(() => {
    const q = query.trim();
    if (!q) {
      const byId = new Map(items.map((i) => [i.id, i]));
      const recent = preferences.recentCommands.map((id) => byId.get(id)).filter((x): x is CommandPaletteItem => Boolean(x));
      const recentIds = new Set(recent.map((r) => r.id));
      const recentCat = t(lang, '最近', 'Recent');
      return [
        ...recent.map((r) => ({ ...r, category: recentCat })),
        ...items.filter((i) => !recentIds.has(i.id) && (i.id.startsWith('cmd:') ? !i.id.startsWith('cmd:theme:') : i.id.startsWith('page:'))),
      ];
    }
    const slash = q.startsWith('/');
    const pool = slash ? items.filter((i) => i.id.startsWith('cmd:') || i.label.startsWith('/')) : items;
    return fuzzyFilter(pool, q, (i) => i.label, (i) => [...(i.keywords ?? []), i.hint ?? '']).map((r) => r.item);
  }, [items, query, preferences.recentCommands, lang]);

  const width = Math.min(84, Math.max(40, columns - 8));
  const listRows = Math.max(3, Math.min(14, rows - 10));
  const sel = Math.min(cursor, Math.max(0, results.length - 1));
  const off = nextScrollOffset(sel, offsetRef.current, listRows, results.length, 1);
  offsetRef.current = off;

  const run = useCallback(
    (item: CommandPaletteItem | undefined) => {
      if (!item) return;
      const s = useTuiStore.getState();
      s.recordRecentCommand(item.id);
      s.setCommandPaletteOpen(false);
      onClose();
      Promise.resolve()
        .then(() => item.action())
        .catch((err: unknown) => s.notify(err instanceof Error ? err.message : String(err), 'error'));
    },
    [onClose],
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
      subtitle={`${results.length}`}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={[
        { key: asciiMode ? 'Up/Dn' : '↑↓', label: t(lang, '选择', 'Select') },
        { key: 'Enter', label: t(lang, '执行', 'Run') },
        { key: 'Esc', label: t(lang, '关闭', 'Close') },
      ]}
    >
      <Box height={1} marginBottom={1}>
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
      <Box flexDirection="column" height={listRows}>
        {results.length === 0 ? (
          <Text color={theme.muted}>{t(lang, '  没有匹配的结果', '  No matches')}</Text>
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
