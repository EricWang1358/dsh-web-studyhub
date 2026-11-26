import React, { memo } from 'react';
import { Box, Text } from 'ink';
import { useKeyScope } from '../components/key-dispatcher.js';
import { isPlainKey } from '../input/global-router.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme, type ThemeTokens } from '../theme/tokens.js';
import { truncateDisplay } from '../render/cjk.js';
import { glyph } from '../render/glyphs.js';
import { Spinner } from '../components/Badge.js';
import { LAYOUT_BP } from '../components/layout-tokens.js';
import { detectAgy, modelInfo } from './data.js';
import { useShellActions } from './actions.js';
import { formatGlobalKeyHint } from './global-keymap.js';

/** 3-row half-block pixel font for the header. */
const GLYPHS: Record<string, readonly [string, string, string]> = {
  S: ['█▀▀', '▀▀█', '▀▀▀'],
  T: ['▀█▀', ' █ ', ' ▀ '],
  U: ['█ █', '█ █', '▀▀▀'],
  D: ['█▀▄', '█ █', '▀▀ '],
  Y: ['█ █', '▀█▀', ' ▀ '],
  H: ['█ █', '█▀█', '▀ ▀'],
  B: ['█▀▄', '█▀▄', '▀▀ '],
  ' ': ['  ', '  ', '  '],
};

export function pixelBanner(text: string): string[][] {
  // returns per-letter columns for colouring: rows[r][letterIndex]
  const letters = Array.from(text.toUpperCase()).map((c) => GLYPHS[c] ?? GLYPHS[' ']);
  return [0, 1, 2].map((r) => letters.map((g) => g[r]));
}

function gradient(theme: ThemeTokens, i: number, n: number): string {
  const stops = [theme.primary, theme.accent, theme.ai];
  return stops[Math.min(stops.length - 1, Math.floor((i / Math.max(1, n)) * stops.length))];
}

export interface LaunchpadProps {
  width: number;
  height: number;
  isActive: boolean;
}

export const Launchpad = memo(function Launchpad({ width, height, isActive }: LaunchpadProps) {
  const theme = useTheme();
  const actions = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const cfg = useTuiStore((s) => s.desktopConfig);
  const binding = useTuiStore((s) => s.binding);
  const snapshot = useTuiStore((s) => s.snapshot);
  const root = binding?.root ?? snapshot?.root ?? cfg?.libraryRoot ?? '';
  const agy = detectAgy(cfg);
  const model = modelInfo(cfg, binding, snapshot, asciiMode);
  const envKey = process.env.DEEPSEEK_API_KEY ? 'DEEPSEEK_API_KEY' : process.env.OPENAI_API_KEY ? 'OPENAI_API_KEY' : null;

  useKeyScope({
    id: 'Launchpad',
    active: isActive,
    keys: ['s', 'i', 'm'],
    onKey: (input, key) => {
      if (key.return && !key.meta && !key.ctrl) {
        useTuiStore.getState().setShowLaunchpad(false);
        return true;
      }
      if (!isPlainKey(input, key)) return false;
      if (input === 's') {
        void actions.loadSample();
        return true;
      }
      if (input === 'i') {
        useTuiStore.getState().setShowLaunchpad(false);
        actions.importSource();
        return true;
      }
      if (input === 'm') {
        useTuiStore.getState().setShowLaunchpad(false);
        actions.openModelSettings();
        return true;
      }
      return false;
    },
  });

  const banner = pixelBanner('STUDY HUB');
  const compact = height < 22 || width < LAYOUT_BP.MIN_VIEWPORT_COLS;
  const cardW = Math.min(64, width - 4);
  const ell = glyph('ellipsis', asciiMode);
  const dotSep = ` ${glyph('middot', asciiMode)} `;
  const mIcon = asciiMode
    ? model.mode === 'agy'
      ? '*'
      : model.mode === 'codex'
        ? '>'
        : model.mode === 'openai'
          ? '@'
          : 'o'
    : model.icon;

  const agyLine = (() => {
    switch (agy.state) {
      case 'probing':
        return <Spinner label={t(lang, `正在探测本机 agy CLI${ell}`, `Probing local agy CLI${ell}`)} />;
      case 'ready':
        return (
          <Text>
            <Text color={theme.success}>{asciiMode ? '* ' : '● '}</Text>
            <Text color={theme.text}>{t(lang, 'agy CLI 已就绪', 'agy CLI ready')}</Text>
            <Text color={theme.muted}>
              {truncateDisplay(
                `  ${agy.version ? `v${agy.version}` : ''}${agy.modelCount ? `${dotSep}${agy.modelCount} ${t(lang, '个模型', 'models')}` : ''}`,
                Math.max(0, cardW - 20),
                ell,
              )}
            </Text>
          </Text>
        );
      case 'unauthenticated':
        return (
          <Text>
            <Text color={theme.warning}>{asciiMode ? '! ' : '▲ '}</Text>
            <Text color={theme.text}>{t(lang, 'agy 已安装但未登录 — 运行 agy login', 'agy found but not signed in — run agy login')}</Text>
          </Text>
        );
      default:
        return (
          <Text>
            <Text color={theme.dim}>{asciiMode ? 'o ' : '○ '}</Text>
            <Text color={theme.muted}>
              {envKey
                ? t(lang, `未检测到 agy${dotSep}已发现 ${envKey}，可用 OpenAI 兼容接口`, `agy not found${dotSep}${envKey} detected for OpenAI-compatible`)
                : t(lang, `未检测到 agy CLI${dotSep}可按 m 配置 OpenAI 兼容接口`, `agy CLI not found${dotSep}press m to configure OpenAI-compatible`)}
            </Text>
          </Text>
        );
    }
  })();

  const action = (k: string, zh: string, en: string, primary = false) => (
    <Box key={k} height={1}>
      <Text backgroundColor={primary ? theme.primary : theme.surface} color={primary ? (theme.dark ? theme.bg : '#ffffff') : theme.accent} bold>
        {` ${k} `}
      </Text>
      <Text color={primary ? theme.text : theme.text} bold={primary}>{`  ${t(lang, zh, en)}`}</Text>
    </Box>
  );

  const cmdHint = formatGlobalKeyHint('command-palette', lang, asciiMode, true);
  const helpHint = formatGlobalKeyHint('help', lang, asciiMode);
  const quitHint = formatGlobalKeyHint('quit', lang, asciiMode);
  const launchpadFooterLine = `${cmdHint.key} ${cmdHint.label}${dotSep}${helpHint.key} ${helpHint.label}${dotSep}${quitHint.key} ${quitHint.label}`;

  return (
    <Box width={width} height={height} flexDirection="column" alignItems="center" justifyContent="center">
      {asciiMode ? (
        <Text color={theme.primary} bold>
          [SH] STUDY HUB
        </Text>
      ) : !compact ? (
        <Box flexDirection="column" marginBottom={1}>
          {banner.map((row, r) => (
            <Text key={r}>
              {row.map((seg, i) => (
                <Text key={i} color={gradient(theme, i, row.length)}>
                  {seg + ' '}
                </Text>
              ))}
            </Text>
          ))}
        </Box>
      ) : (
        <Text color={theme.primary} bold>
          ▙▟ StudyHub
        </Text>
      )}
      <Text color={theme.muted}>
        {asciiMode
          ? t(lang, '把资料变成真正会的知识 - 终端版', 'Turn materials into knowledge you own - terminal edition')
          : t(lang, '把资料变成真正会的知识 · 终端版', 'Turn materials into knowledge you own · terminal edition')}
      </Text>

      <Box marginTop={1} flexDirection="column" width={cardW} borderStyle={asciiMode ? 'classic' : 'round'} borderColor={theme.border} paddingX={2} paddingY={compact ? 0 : 1}>
        {agyLine}
        <Text>
          <Text color={model.ready ? theme.success : theme.warning}>{model.ready ? (asciiMode ? '* ' : '● ') : (asciiMode ? 'o ' : '○ ')}</Text>
          <Text color={theme.muted}>{t(lang, '当前模型  ', 'Model  ')}</Text>
          <Text color={theme.text}>{truncateDisplay(`${mIcon} ${model.provider}${model.model ? `${dotSep}${model.model}` : ''}`, Math.max(4, cardW - 18), ell)}</Text>
        </Text>
        {root ? (
          <Text>
            <Text color={theme.dim}>{asciiMode ? '# ' : '▤ '}</Text>
            <Text color={theme.muted}>{t(lang, '学习库  ', 'Library  ')}</Text>
            <Text color={theme.dim}>{truncateDisplay(root, Math.max(4, cardW - 18), ell)}</Text>
          </Text>
        ) : null}
        <Box marginTop={1} flexDirection="column">
          {action('s', '载入示例课程体验', 'Load the sample course', true)}
          {action('i', '导入第一份资料', 'Import your first material')}
          {action('m', '配置模型 (agy / OpenAI)', 'Configure model (agy / OpenAI)')}
          {action('Enter', '进入学习库', 'Enter library')}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.dim}>{launchpadFooterLine}</Text>
      </Box>
    </Box>
  );
});
