import React, { memo } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import { PAGE_REGISTRY, type KeyHint } from '../types/contracts.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { padDisplay, truncateDisplay } from '../render/index.js';
import { Modal } from '../components/Modal.js';

export interface HelpOverlayProps {
  isActive: boolean;
  onClose: () => void;
  /** Extra page-specific shortcuts (defaults to the current footer hints). */
  pageHints?: readonly KeyHint[];
}

export function globalShortcuts(lang: 'zh' | 'en'): KeyHint[] {
  return [
    { key: 'Ctrl+K  /', label: t(lang, '命令面板', 'Command palette') },
    { key: '?', label: t(lang, '帮助', 'Help') },
    { key: 'c', label: t(lang, '切换课程', 'Switch course') },
    { key: '1-9 0', label: t(lang, '跳转页面', 'Jump to page') },
    { key: '[  ]', label: t(lang, '上/下一页面', 'Prev / next page') },
    { key: '⌫', label: t(lang, '返回', 'Back') },
    { key: '\\', label: t(lang, '折叠侧栏', 'Toggle sidebar') },
    { key: 'Ctrl+R', label: t(lang, '刷新', 'Refresh') },
    { key: 'q', label: t(lang, '退出', 'Quit') },
    { key: 'j/k ↑↓', label: t(lang, '列表移动', 'Move in lists') },
    { key: 'g / G', label: t(lang, '顶部 / 底部', 'Top / bottom') },
    { key: 'Esc', label: t(lang, '关闭 / 取消', 'Close / cancel') },
  ];
}

export const HelpOverlay = memo(function HelpOverlay({ isActive, onClose, pageHints }: HelpOverlayProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  const lang = useTuiStore((s) => s.preferences.language);
  const footer = useTuiStore((s) => s.footerHints);
  const page = useTuiStore((s) => s.page);
  const hints = pageHints ?? footer;
  const meta = PAGE_REGISTRY.find((p) => p.id === page);

  useInput(
    (input) => {
      if (input === '?' || input === 'q') onClose();
    },
    { isActive },
  );

  const width = Math.min(96, Math.max(44, columns - 6));
  const inner = width - 6;
  const twoCol = inner >= 70;
  const colW = twoCol ? Math.floor((inner - 3) / 2) : inner;
  const keyW = 11;
  const maxRows = Math.max(4, rows - 12);

  const row = (h: KeyHint, i: number) => (
    <Box key={`${h.key}-${i}`} height={1} width={colW}>
      <Text color={theme.accent} bold>
        {padDisplay(h.key, keyW)}
      </Text>
      <Text color={theme.text}>{truncateDisplay(h.label, Math.max(1, colW - keyW - 1))}</Text>
    </Box>
  );

  const pages = PAGE_REGISTRY.map((p) => ({ key: p.shortcut, label: `${p.icon} ${t(lang, p.labelZh, p.labelEn)}` }));
  const globals = globalShortcuts(lang);

  const section = (title: string, list: readonly KeyHint[]) => (
    <Box flexDirection="column" width={colW}>
      <Text color={theme.heading} bold>
        {title}
      </Text>
      {list.slice(0, maxRows).map(row)}
    </Box>
  );

  return (
    <Modal
      title={t(lang, '快捷键', 'Keyboard Shortcuts')}
      icon="?"
      subtitle={meta ? `${meta.icon} ${t(lang, meta.labelZh, meta.labelEn)}` : undefined}
      width={width}
      onClose={onClose}
      isActive={isActive}
      hints={[{ key: 'Esc / ?', label: t(lang, '关闭', 'Close') }]}
    >
      <Box flexDirection={twoCol ? 'row' : 'column'} gap={twoCol ? 3 : 0}>
        <Box flexDirection="column" width={colW}>
          {section(t(lang, '全局', 'Global'), globals)}
          {hints.length > 0 ? <Box marginTop={1}>{section(t(lang, '当前页面', 'This page'), hints)}</Box> : null}
        </Box>
        {twoCol ? section(t(lang, '页面跳转', 'Pages'), pages) : null}
      </Box>
    </Modal>
  );
});
