import React, { memo, useCallback, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { HostClient, ThemeId, TuiPreferences, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { THEME_IDS, saveTuiPreferences } from '../../host/index.js';
import { Panel, getTheme, useClaimKeys, useTheme } from '../../components/index.js';
import { padDisplay } from '../../render/index.js';

export interface AppearanceTabProps {
  host: HostClient;
  width: number;
  height: number;
  isActive: boolean;
}

type RowKey = 'theme' | 'language' | 'mathUnicode' | 'sidebarCollapsed' | 'compactMode' | 'showKeyHints';

const ROWS: readonly RowKey[] = Object.freeze([
  'theme',
  'language',
  'mathUnicode',
  'sidebarCollapsed',
  'compactMode',
  'showKeyHints',
]);

export const AppearanceTab: React.FC<AppearanceTabProps> = memo(function AppearanceTab({
  host,
  width,
  height,
  isActive,
}) {
  const theme = useTheme();
  const prefs = useTuiStore((s) => s.preferences);
  const setPreferences = useTuiStore((s) => s.setPreferences);
  const notify = useTuiStore((s) => s.notify);
  const lang = prefs.language;

  const [cursor, setCursor] = useState(0);
  const [saving, setSaving] = useState(false);

  const persistPatch = useCallback(
    async (patch: Partial<TuiPreferences>, feedback?: string) => {
      setPreferences(patch);
      if (patch.language && 'setLanguage' in host && typeof (host as { setLanguage?: (l: UiLanguage) => void }).setLanguage === 'function') {
        (host as { setLanguage: (l: UiLanguage) => void }).setLanguage(patch.language);
      }
      setSaving(true);
      try {
        const dshHome = (host as { dshHome?: string }).dshHome;
        await saveTuiPreferences(patch, dshHome ? { env: { DSH_HOME: dshHome } } : undefined);
        if (feedback) notify(feedback, 'success');
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err), 'error');
      } finally {
        setSaving(false);
      }
    },
    [host, notify, setPreferences],
  );

  const cycleRow = useCallback(
    (rowKey: RowKey, dir: 1 | -1) => {
      if (rowKey === 'theme') {
        const idx = THEME_IDS.indexOf(prefs.theme);
        const nextTheme = THEME_IDS[(Math.max(0, idx) + dir + THEME_IDS.length) % THEME_IDS.length];
        const nextTok = getTheme(nextTheme);
        void persistPatch({ theme: nextTheme }, t(lang, `主题已切换为 ${nextTok.label}`, `Theme switched to ${nextTok.label}`));
        return;
      }
      if (rowKey === 'language') {
        const nextLang: UiLanguage = prefs.language === 'zh' ? 'en' : 'zh';
        void persistPatch({ language: nextLang }, nextLang === 'en' ? 'UI language switched to English' : '界面语言已切换为中文');
        return;
      }
      if (rowKey === 'mathUnicode') {
        void persistPatch({ mathUnicode: !prefs.mathUnicode });
        return;
      }
      if (rowKey === 'sidebarCollapsed') {
        void persistPatch({ sidebarCollapsed: !prefs.sidebarCollapsed });
        return;
      }
      if (rowKey === 'compactMode') {
        void persistPatch({ compactMode: !prefs.compactMode });
        return;
      }
      if (rowKey === 'showKeyHints') {
        void persistPatch({ showKeyHints: !prefs.showKeyHints });
      }
    },
    [lang, persistPatch, prefs],
  );

  const claimed = useMemo(() => ['j', 'k', 'h', 'l', ' '], []);
  useClaimKeys(claimed, isActive);

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') {
        setCursor((c) => (c - 1 + ROWS.length) % ROWS.length);
        return;
      }
      if (key.downArrow || input === 'j') {
        setCursor((c) => (c + 1) % ROWS.length);
        return;
      }
      if (key.leftArrow || input === 'h') {
        cycleRow(ROWS[cursor], -1);
        return;
      }
      if (key.rightArrow || input === 'l' || key.return || input === ' ') {
        cycleRow(ROWS[cursor], 1);
      }
    },
    { isActive },
  );

  const themeSwatches = useMemo(
    () =>
      THEME_IDS.map((id: ThemeId) => {
        const tok = getTheme(id);
        const active = prefs.theme === id;
        return { id, tok, active };
      }),
    [prefs.theme],
  );

  const rowSpecs = [
    {
      key: 'theme' as const,
      label: t(lang, '配色主题 (Theme)', 'Color Theme'),
      value: getTheme(prefs.theme).label,
      hint: t(lang, '←/→ 切换 4 套终端主题，即时生效', '←/→ cycle 4 themes with live preview'),
    },
    {
      key: 'language' as const,
      label: t(lang, '界面语言 (Language)', 'UI Language'),
      value: prefs.language === 'zh' ? '简体中文 (zh)' : 'English (en)',
      hint: t(lang, '←/→ / Enter 切换中英文', '←/→ / Enter toggle zh / en'),
    },
    {
      key: 'mathUnicode' as const,
      label: t(lang, 'Unicode 数学渲染', 'Unicode Math Rendering'),
      value: prefs.mathUnicode ? t(lang, '已开启 ✓', 'Enabled ✓') : t(lang, '已关闭', 'Disabled'),
      hint: t(lang, '将 LaTeX 公式渲染为 ∑ ∫ √ 等 Unicode 符号', 'Render LaTeX math as Unicode symbols'),
    },
    {
      key: 'sidebarCollapsed' as const,
      label: t(lang, '默认收起侧边栏', 'Sidebar Default Collapsed'),
      value: prefs.sidebarCollapsed ? t(lang, '已收起 ✓', 'Collapsed ✓') : t(lang, '展开显示', 'Expanded'),
      hint: t(lang, '随时可用 \\ 键展开/收起导航栏', 'Toggle anytime with \\'),
    },
    {
      key: 'compactMode' as const,
      label: t(lang, '紧凑布局模式', 'Compact Mode'),
      value: prefs.compactMode ? t(lang, '紧凑 ✓', 'Compact ✓') : t(lang, '标准', 'Standard'),
      hint: t(lang, '减少卡片边距以在矮终端显示更多内容', 'Reduce padding for smaller terminals'),
    },
    {
      key: 'showKeyHints' as const,
      label: t(lang, '显示底部快捷键提示', 'Footer Key Hints'),
      value: prefs.showKeyHints ? t(lang, '显示 ✓', 'Visible ✓') : t(lang, '隐藏', 'Hidden'),
      hint: t(lang, '控制底部导航提示条是否显示', 'Show or hide the bottom shortcut bar'),
    },
  ];

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Panel
        title={t(lang, 'TUI 外观与偏好 (自动保存至 tui.json)', 'TUI Appearance & Preferences (Auto-saved)')}
        subtitle={saving ? t(lang, '保存中…', 'Saving…') : t(lang, '实时生效', 'Live')}
        focused={isActive}
        width={width}
      >
        <Box flexDirection="column" marginBottom={1}>
          {rowSpecs.map((row, idx) => {
            const selected = idx === cursor;
            return (
              <Box
                key={row.key}
                flexDirection="row"
                height={1}
                backgroundColor={selected ? theme.selectionBg : undefined}
              >
                <Text color={selected ? theme.primary : theme.dim}>{selected ? '❯ ' : '  '}</Text>
                <Text color={selected ? theme.selectionFg : theme.text} bold={selected}>
                  {padDisplay(row.label, 28)}
                </Text>
                <Text color={selected ? theme.accent : theme.primary} bold>
                  {padDisplay(`[ ${row.value} ]`, 22)}
                </Text>
                <Text color={theme.muted}>{row.hint}</Text>
              </Box>
            );
          })}
        </Box>

        <Box flexDirection="column" borderStyle="single" borderColor={theme.border} paddingX={1}>
          <Text color={theme.muted} bold>
            {t(lang, '主题色板实时预览', 'Theme Palette Preview')}
          </Text>
          <Box flexDirection="row" flexWrap="wrap" gap={2} marginTop={0}>
            {themeSwatches.map(({ id, tok, active }) => (
              <Box key={id} flexDirection="row">
                <Text color={active ? theme.primary : theme.muted} bold={active}>
                  {active ? '● ' : '○ '}
                  {tok.label}
                  {' '}
                </Text>
                <Text backgroundColor={tok.primary} color={tok.bg}>{'  '}</Text>
                <Text backgroundColor={tok.success} color={tok.bg}>{'  '}</Text>
                <Text backgroundColor={tok.warning} color={tok.bg}>{'  '}</Text>
                <Text backgroundColor={tok.error} color={tok.bg}>{'  '}</Text>
                <Text backgroundColor={tok.ai} color={tok.bg}>{'  '}</Text>
              </Box>
            ))}
          </Box>
        </Box>
      </Panel>
    </Box>
  );
});
