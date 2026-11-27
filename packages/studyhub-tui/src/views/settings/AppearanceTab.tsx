import React, { memo, useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../../components/key-dispatcher.js';
import { isPlainKey } from '../../input/global-router.js';
import type { HostClient, ThemeId, TuiPreferences, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { THEME_IDS, saveTuiPreferences } from '../../host/tui-prefs.js';
import { shouldEnableMouse } from '../../cli-args.js';
import { getColorLevel, getTheme, useTheme } from '../../theme/tokens.js';
import { Panel } from '../../components/Panel.js';
import { padDisplay, truncateDisplay } from '../../render/cjk.js';

export interface AppearanceTabProps {
  host: HostClient;
  width: number;
  height: number;
  isActive: boolean;
}

type RowKey =
  | 'theme'
  | 'language'
  | 'mathUnicode'
  | 'asciiMode'
  | 'sidebarCollapsed'
  | 'compactMode'
  | 'showKeyHints'
  | 'proactiveHints';

const ROWS: readonly RowKey[] = Object.freeze([
  'theme',
  'language',
  'mathUnicode',
  'asciiMode',
  'sidebarCollapsed',
  'compactMode',
  'showKeyHints',
  'proactiveHints',
]);

function describeColorLevel(level: ReturnType<typeof getColorLevel>): string {
  switch (level) {
    case 3:
      return 'Truecolor (L3)';
    case 2:
      return '256-color (L2)';
    case 1:
      return '16-color (L1)';
    default:
      return 'NO_COLOR (L0)';
  }
}

function resolveMouseOption(): boolean {
  for (let i = process.argv.length - 1; i >= 0; i -= 1) {
    if (process.argv[i] === '--no-mouse') return false;
    if (process.argv[i] === '--mouse') return true;
  }
  return shouldEnableMouse(process.env);
}

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

  const asciiMode = Boolean(prefs.asciiMode);

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
      if (rowKey === 'asciiMode') {
        const next = !Boolean(prefs.asciiMode);
        void persistPatch(
          { asciiMode: next },
          next
            ? t(lang, '已开启 ASCII 兼容模式', 'ASCII Safe Mode enabled')
            : t(lang, '已关闭 ASCII 兼容模式', 'ASCII Safe Mode disabled'),
        );
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
        return;
      }
      if (rowKey === 'proactiveHints') {
        const next = prefs.proactiveHints === false;
        void persistPatch(
          { proactiveHints: next },
          next ? t(lang, '已开启主动学习提示', 'Proactive hints enabled') : t(lang, '已关闭主动学习提示', 'Proactive hints disabled'),
        );
      }
    },
    [lang, persistPatch, prefs],
  );

  const claimed = useMemo(() => ['j', 'k', 'h', 'l', ' '], []);

  useKeyScope({
    id: 'settings:appearance',
    active: isActive,
    keys: claimed,
    onKey: (input, key) => {
      const plain = isPlainKey(input, key);
      if (key.upArrow || (plain && input === 'k')) {
        setCursor((c) => (c - 1 + ROWS.length) % ROWS.length);
        return true;
      }
      if (key.downArrow || (plain && input === 'j')) {
        setCursor((c) => (c + 1) % ROWS.length);
        return true;
      }
      if (key.leftArrow || (plain && input === 'h')) {
        cycleRow(ROWS[cursor], -1);
        return true;
      }
      if (key.rightArrow || (!key.ctrl && !key.meta && key.return) || (plain && (input === 'l' || input === ' '))) {
        cycleRow(ROWS[cursor], 1);
        return true;
      }
      return false;
    },
  });

  const themeSwatches = useMemo(
    () =>
      THEME_IDS.map((id: ThemeId) => {
        const tok = getTheme(id);
        const active = prefs.theme === id;
        return { id, tok, active };
      }),
    [prefs.theme],
  );

  const check = asciiMode ? '*' : '✓';
  const arrows = asciiMode ? '<-/->' : '←/→';
  const ellipsis = asciiMode ? '...' : '…';

  const rowSpecs = [
    {
      key: 'theme' as const,
      label: t(lang, '配色主题 (Theme)', 'Color Theme'),
      value: getTheme(prefs.theme).label,
      hint: t(lang, `${arrows} 切换 ${THEME_IDS.length} 套终端主题，即时生效`, `${arrows} cycle ${THEME_IDS.length} themes with live preview`),
    },
    {
      key: 'language' as const,
      label: t(lang, '界面语言 (Language)', 'UI Language'),
      value: prefs.language === 'zh' ? '简体中文 (zh)' : 'English (en)',
      hint: t(lang, `${arrows} / Enter 切换中英文`, `${arrows} / Enter toggle zh / en`),
    },
    {
      key: 'mathUnicode' as const,
      label: t(lang, 'Unicode 数学渲染', 'Unicode Math Rendering'),
      value: prefs.mathUnicode ? t(lang, `已开启 ${check}`, `Enabled ${check}`) : t(lang, '已关闭', 'Disabled'),
      hint: t(
        lang,
        asciiMode ? '将 LaTeX 公式渲染为 Unicode 符号' : '将 LaTeX 公式渲染为 ∑ ∫ √ 等 Unicode 符号',
        'Render LaTeX math as Unicode symbols',
      ),
    },
    {
      key: 'asciiMode' as const,
      label: t(lang, 'ASCII 兼容模式', 'ASCII Safe Mode'),
      value: asciiMode ? t(lang, `已开启 ${check}`, `Enabled ${check}`) : t(lang, '已关闭', 'Disabled'),
      hint: t(
        lang,
        '兼容旧版 Windows PowerShell 5.1 / 无 Unicode 字体终端',
        'For legacy Windows PowerShell 5.1 / non-Unicode terminals',
      ),
    },
    {
      key: 'sidebarCollapsed' as const,
      label: t(lang, '默认收起侧边栏', 'Sidebar Default Collapsed'),
      value: prefs.sidebarCollapsed ? t(lang, `已收起 ${check}`, `Collapsed ${check}`) : t(lang, '展开显示', 'Expanded'),
      hint: t(lang, '随时可用 \\ 键展开/收起导航栏', 'Toggle anytime with \\'),
    },
    {
      key: 'compactMode' as const,
      label: t(lang, '界面间距档位', 'Spacing Density'),
      value: prefs.compactMode ? t(lang, `紧凑 ${check}`, `Compact ${check}`) : t(lang, '宽松 (默认)', 'Relaxed (default)'),
      hint: t(lang, '宽松更耐看、紧凑可容纳更多行，切换即时生效', 'Relaxed reduces fatigue; Compact fits more rows live'),
    },
    {
      key: 'showKeyHints' as const,
      label: t(lang, '显示底部快捷键提示', 'Footer Key Hints'),
      value: prefs.showKeyHints ? t(lang, `显示 ${check}`, `Visible ${check}`) : t(lang, '隐藏', 'Hidden'),
      hint: t(lang, '控制底部导航提示条是否显示', 'Show or hide the bottom shortcut bar'),
    },
    {
      key: 'proactiveHints' as const,
      label: t(lang, '主动学习提示', 'Proactive Study Nudges'),
      value: prefs.proactiveHints !== false ? t(lang, `开启 ${check}`, `On ${check}`) : t(lang, '关闭', 'Off'),
      hint: t(lang, '20秒卡住提示 / 每日简报 / 连错3题归因（限频且不打断输入）', '20s stuck / daily brief / 3-wrong streak (rate-limited)'),
    },
  ];

  const innerW = Math.max(20, width - 4);
  const compactCols = innerW < 76;
  const labelW = compactCols ? 26 : 28;
  const valueW = compactCols ? 18 : 22;
  const hintW = Math.max(0, innerW - 2 - labelW - valueW);

  const colorLevelLabel = describeColorLevel(getColorLevel());
  const mouseEnabled = resolveMouseOption();
  const sep = asciiMode ? ' | ' : ' · ';
  const capLine1 = t(
    lang,
    `平台: ${process.platform} (${width}x${height})${sep}色彩: ${colorLevelLabel}`,
    `Platform: ${process.platform} (${width}x${height})${sep}Color: ${colorLevelLabel}`,
  );
  const capLine2 = t(
    lang,
    `渲染: ${asciiMode ? 'ASCII' : 'Unicode'}${sep}公式: ${prefs.mathUnicode ? 'Unicode' : 'LaTeX'}${sep}鼠标 SGR 1006: ${mouseEnabled ? 'On' : 'Off'}`,
    `Render: ${asciiMode ? 'ASCII' : 'Unicode'}${sep}Math: ${prefs.mathUnicode ? 'Unicode' : 'LaTeX'}${sep}Mouse SGR 1006: ${mouseEnabled ? 'On' : 'Off'}`,
  );
  const swatchGroups =
    innerW < 112
      ? [themeSwatches.slice(0, 3), themeSwatches.slice(3)]
      : [themeSwatches];

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Panel
        title={t(lang, 'TUI 外观与偏好 (自动保存至 tui.json)', 'TUI Appearance & Preferences (Auto-saved)')}
        subtitle={saving ? t(lang, `保存中${ellipsis}`, `Saving${ellipsis}`) : t(lang, '实时生效', 'Live')}
        focused={isActive}
        width={width}
        height={height}
      >
        <Box flexDirection="column" flexShrink={0} marginBottom={height < 20 ? 0 : 1}>
          {rowSpecs.map((row, idx) => {
            const selected = idx === cursor;
            const pointer = selected ? (asciiMode ? '> ' : '❯ ') : '  ';
            return (
              <Box
                key={row.key}
                flexDirection="row"
                height={1}
                backgroundColor={selected ? theme.selectionBg : undefined}
              >
                <Text color={selected ? theme.primary : theme.dim}>{pointer}</Text>
                <Text color={selected ? theme.selectionFg : theme.text} bold={selected}>
                  {padDisplay(row.label, labelW)}
                </Text>
                <Text color={selected ? theme.accent : theme.primary} bold>
                  {padDisplay(`[ ${row.value} ]`, valueW)}
                </Text>
                {hintW > 0 ? (
                  <Text color={theme.muted}>{truncateDisplay(row.hint, hintW, ellipsis)}</Text>
                ) : null}
              </Box>
            );
          })}
        </Box>

        <Box
          flexDirection="column"
          flexShrink={0}
          borderStyle={asciiMode ? 'classic' : 'single'}
          borderColor={theme.border}
          paddingX={1}
        >
          <Text color={theme.muted} bold>
            {t(lang, '主题色板实时预览', 'Theme Palette Preview')}
          </Text>
          {swatchGroups.map((group, gIdx) => (
            <Box key={`swatch-row-${gIdx}`} flexDirection="row" gap={2} marginTop={0}>
              {group.map(({ id, tok, active }) => (
                <Box key={id} flexDirection="row">
                  <Text color={active ? theme.primary : theme.muted} bold={active}>
                    {active ? (asciiMode ? '* ' : '● ') : asciiMode ? 'o ' : '○ '}
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
          ))}
        </Box>

        {height >= 20 ? (
          <Box
            flexDirection="column"
            flexShrink={0}
            borderStyle={asciiMode ? 'classic' : 'single'}
            borderColor={theme.border}
            paddingX={1}
            marginTop={1}
          >
            <Text color={theme.muted} bold>
              {truncateDisplay(
                t(lang, '终端能力与运行诊断', 'Terminal Capabilities & Diagnostics'),
                Math.max(10, innerW - 4),
                ellipsis,
              )}
            </Text>
            <Text color={theme.text}>{truncateDisplay(capLine1, Math.max(10, innerW - 4), ellipsis)}</Text>
            <Text color={theme.muted}>{truncateDisplay(capLine2, Math.max(10, innerW - 4), ellipsis)}</Text>
          </Box>
        ) : height >= 17 ? (
          <Box flexDirection="column" flexShrink={0} marginTop={height >= 18 ? 1 : 0}>
            <Text color={theme.muted}>{truncateDisplay(capLine1, innerW, ellipsis)}</Text>
            <Text color={theme.dim}>{truncateDisplay(capLine2, innerW, ellipsis)}</Text>
          </Box>
        ) : null}
      </Panel>
    </Box>
  );
});
