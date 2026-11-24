import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { PAGE_REGISTRY, type NavGroup, type PageId, type PageMeta } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { RESERVED_GLOBAL_KEY_SET, useClaimedKeys } from '../components/focus.js';
import { LAYOUT_BP, LAYOUT_CHROME } from '../components/layout-tokens.js';
import { ClickableBox } from '../components/mouse.js';
import { formatReturnHintLabel } from '../state/practice-stack.js';
import { draftCount, dueToday, pageIcon, runningJobs, wrongCount } from './data.js';

export const SIDENAV_WIDTH = LAYOUT_CHROME.SIDENAV_EXPANDED;
export const SIDENAV_COLLAPSED_WIDTH = LAYOUT_CHROME.SIDENAV_COLLAPSED;
/** Below this terminal width the rail auto-collapses to icons. */
export const SIDENAV_AUTO_COLLAPSE = LAYOUT_BP.SIDENAV_AUTO_COLLAPSE;

export function sideNavWidth(columns: number, collapsedPref: boolean): number {
  return collapsedPref || columns < SIDENAV_AUTO_COLLAPSE ? SIDENAV_COLLAPSED_WIDTH : SIDENAV_WIDTH;
}

const GROUPS: ReadonlyArray<{ id: NavGroup; zh: string; en: string }> = [
  { id: 'daily', zh: '每日', en: 'Daily' },
  { id: 'exam', zh: '考试', en: 'Exam' },
  { id: 'tools', zh: '整理', en: 'Tools' },
];

export interface SideNavProps {
  /** Total rail width including its right divider (use `sideNavWidth`). */
  width: number;
  height: number;
}

export const SideNav = memo(function SideNav({ width, height }: SideNavProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const page = useTuiStore((s) => s.page);
  const snapshot = useTuiStore((s) => s.snapshot);
  const activeRunId = useTuiStore((s) => s.activeRunId);
  const practiceStack = useTuiStore((s) => s.practiceStack);
  const claimedKeys = useClaimedKeys();
  const collapsed = width <= SIDENAV_COLLAPSED_WIDTH;
  const inner = Math.max(1, width - 1);
  const ell = asciiMode ? '...' : '…';

  const counts: Partial<Record<PageId, { n: number; color: string }>> = {
    library: { n: dueToday(snapshot), color: theme.warning },
    wrongbook: { n: wrongCount(snapshot), color: theme.error },
    tasks: { n: runningJobs(snapshot), color: theme.ai },
    generate: { n: draftCount(snapshot), color: theme.accent },
  };

  const rows: React.ReactNode[] = [];
  let used = 0;
  const push = (node: React.ReactNode) => {
    if (used < height) rows.push(node);
    used += 1;
  };

  // Resume-practice / Practice Context Stack return callout (#1319).
  const returnLabel = formatReturnHintLabel(practiceStack, lang);
  if (activeRunId || returnLabel) {
    const active = page === 'review' && !returnLabel;
    const playGlyph = asciiMode ? '>' : '▶';
    const onClickResume = () => {
      const st = useTuiStore.getState();
      if (st.practiceStack.length > 0) {
        st.returnViaPracticeStack();
        return;
      }
      if (st.page === 'review' && st.navContext.runId === activeRunId) return;
      if (activeRunId) st.navigate('review', { runId: activeRunId });
    };
    const labelText = returnLabel ?? t(lang, '继续练习', 'Resume');
    if (collapsed) {
      push(
        <ClickableBox key="resume" width={inner} height={1} onClick={onClickResume}>
          <Text color={theme.success} bold>
            {` ${playGlyph} r`}
          </Text>
        </ClickableBox>,
      );
    } else {
      push(
        <ClickableBox key="resume" width={inner} height={1} onClick={onClickResume}>
          <Text backgroundColor={active ? theme.selectionBg : theme.surface} color={theme.success} bold>
            {truncateDisplay(` ${playGlyph} ${labelText}  r`, inner, ell).padEnd(0)}
          </Text>
        </ClickableBox>,
      );
    }
    push(<Text key="resume-gap"> </Text>);
  }

  const renderItem = (p: PageMeta) => {
    const active = p.id === page;
    const c = counts[p.id];
    const badge = c && c.n > 0 ? (c.n > 99 ? '99+' : String(c.n)) : '';
    const icon = pageIcon(p.id, asciiMode, p.icon);
    const bar = active ? (asciiMode ? '>' : '▌') : ' ';
    const keyOverridden = !RESERVED_GLOBAL_KEY_SET.has(p.shortcut) && claimedKeys.has(p.shortcut);
    const onClickPage = () => {
      const st = useTuiStore.getState();
      if (p.id === 'review' && st.activeRunId) st.navigate('review', { runId: st.activeRunId });
      else st.navigate(p.id);
    };
    if (collapsed) {
      return (
        <ClickableBox key={p.id} width={inner} height={1} onClick={onClickPage}>
          <Text color={active ? theme.primary : theme.dim}>{bar}</Text>
          <Text color={active ? theme.primary : theme.muted} bold={active}>
            {icon}
          </Text>
          <Text color={badge ? c?.color : theme.dim}>
            {badge ? (asciiMode ? ' *' : ' •') : keyOverridden ? '  ' : ` ${p.shortcut}`}
          </Text>
        </ClickableBox>
      );
    }
    const label = t(lang, p.labelZh, p.labelEn);
    const shortcutCol = keyOverridden ? '   ' : ` ${p.shortcut} `;
    const badgeStr = badge ? ` ${badge} ` : '';
    const leftW = displayWidth(bar) + 2 + displayWidth(icon);
    const rightW = displayWidth(badgeStr) + displayWidth(shortcutCol);
    const avail = Math.max(1, inner - leftW - rightW);
    return (
      <ClickableBox key={p.id} width={inner} height={1} backgroundColor={active ? theme.selectionBg : undefined} onClick={onClickPage}>
        <Text color={active ? theme.primary : theme.bg}>{bar}</Text>
        <Text color={active ? theme.primary : theme.muted}>{` ${icon} `}</Text>
        <Box flexGrow={1} overflow="hidden">
          <Text color={active ? theme.selectionFg : theme.text} bold={active} wrap="truncate-end">
            {truncateDisplay(label, avail, ell)}
          </Text>
        </Box>
        {badge ? (
          <Text backgroundColor={c?.color} color={theme.dark ? theme.bg : '#ffffff'} bold>
            {badgeStr}
          </Text>
        ) : null}
        <Text color={theme.dim}>{shortcutCol}</Text>
      </ClickableBox>
    );
  };

  for (const g of GROUPS) {
    const pages = PAGE_REGISTRY.filter((p) => p.group === g.id);
    if (pages.length === 0) continue;
    if (collapsed) {
      push(
        <Text key={`g-${g.id}`} color={theme.border}>
          {' ' + (asciiMode ? '-' : '─').repeat(Math.max(0, inner - 2))}
        </Text>,
      );
    } else {
      const head = ` ${t(lang, g.zh, g.en)} ${lang === 'zh' ? g.en : ''}`.trimEnd();
      push(
        <Text key={`g-${g.id}`} color={theme.dim} bold>
          {truncateDisplay(head, inner, ell)}
        </Text>,
      );
    }
    for (const p of pages) push(renderItem(p));
    if (!collapsed) push(<Text key={`gap-${g.id}`}> </Text>);
  }

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      borderStyle={asciiMode ? 'classic' : 'single'}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      borderColor={theme.border}
      overflow="hidden"
      flexShrink={0}
    >
      {rows}
    </Box>
  );
});
