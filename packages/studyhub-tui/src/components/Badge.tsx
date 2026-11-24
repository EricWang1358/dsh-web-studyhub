import React, { memo, useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { KeyHint, ToastItem } from '../types/contracts.js';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { renderProgressBar } from '../render/charts.js';
import { useTuiStore } from '../state/store.js';

const ASCII_CHROME_MAP: Record<string, string> = {
  '…': '...',
  '↑↓': 'Up/Down',
  '↑/↓': 'Up/Down',
  '←/→': 'Left/Right',
  '←→': 'Left/Right',
  '↑': 'Up',
  '↓': 'Down',
  '←': 'Left',
  '→': 'Right',
  '›': '>',
  '▸': '>',
  '▾': 'v',
  '•': '-',
  '✓': 'OK',
  '✕': 'x',
  '★': '*',
  '◆': '*',
  '●': '*',
  '○': 'o',
  '☑': '[x]',
  '☐': '[ ]',
  '⚠': '[!]',
};

const ASCII_CHROME_RE = /↑↓|↑\/↓|←\/→|←→|[…↑↓←→›▸▾•✓✕★◆●○☑☐⚠]/g;

/** Normalize Unicode UI chrome glyphs to clean ASCII equivalents when `ascii` is true. */
export function normalizeAsciiChrome(text: string, ascii: boolean): string {
  if (!ascii || !text) return text;
  return text.replace(ASCII_CHROME_RE, (match) => ASCII_CHROME_MAP[match] ?? match);
}

/* ------------------------------------------------------------------ Badge */

export interface BadgeProps {
  label: string | number;
  tone?: Tone;
  /** solid = filled pill, soft = coloured text in brackets-free pill, outline = `[label]` */
  variant?: 'solid' | 'soft' | 'outline';
  bold?: boolean;
}

export const Badge = memo(function Badge({ label, tone = 'primary', variant = 'solid', bold = true }: BadgeProps) {
  const theme = useTheme();
  const color = toneColor(theme, tone);
  if (variant === 'solid') {
    return (
      <Text backgroundColor={color} color={theme.dark ? theme.bg : '#ffffff'} bold={bold}>
        {` ${label} `}
      </Text>
    );
  }
  if (variant === 'outline') {
    return (
      <Text color={color} bold={bold}>
        {`[${label}]`}
      </Text>
    );
  }
  return (
    <Text backgroundColor={theme.surface} color={color} bold={bold}>
      {` ${label} `}
    </Text>
  );
});

/* ------------------------------------------------------------- StatusPill */

export type PillStatus = 'ok' | 'warn' | 'error' | 'idle' | 'busy' | 'ai';

export interface StatusPillProps {
  label: string;
  status?: PillStatus;
  /** Optional icon replacing the status dot. */
  icon?: string;
  bold?: boolean;
}

const STATUS_TONE: Record<PillStatus, Tone> = {
  ok: 'success',
  warn: 'warning',
  error: 'error',
  idle: 'muted',
  busy: 'accent',
  ai: 'ai',
};

const ASCII_STATUS_ICON: Record<PillStatus, string> = {
  ok: '*',
  warn: '!',
  error: '!',
  idle: 'o',
  busy: '*',
  ai: '*',
};

export const StatusPill = memo(function StatusPill({ label, status = 'idle', icon, bold = false }: StatusPillProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const color = toneColor(theme, STATUS_TONE[status]);
  const dot = icon ?? (asciiMode ? ASCII_STATUS_ICON[status] : '●');
  return (
    <Text backgroundColor={theme.surface}>
      <Text color={color}>{` ${dot} `}</Text>
      <Text color={theme.text} bold={bold}>{`${label} `}</Text>
    </Text>
  );
});

/* ------------------------------------------------------------ ProgressBar */

export interface ProgressBarProps {
  /** 0..1 */
  ratio: number;
  width: number;
  style?: 'block' | 'line';
  showPercent?: boolean;
  label?: string;
}

export const ProgressBar = memo(function ProgressBar({ ratio, width, style = 'line', showPercent = true, label }: ProgressBarProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const labelText = label ? `${label} ` : '';
  const barWidth = Math.max(4, width - displayWidth(labelText));
  return (
    <Text>
      {labelText ? <Text color={theme.muted}>{labelText}</Text> : null}
      {renderProgressBar(ratio, barWidth, theme, { style, showPercent, ascii: asciiMode })}
    </Text>
  );
});

/* ---------------------------------------------------------------- Spinner */

export const SPINNER_FRAMES: readonly string[] = Object.freeze(['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']);
export const ASCII_SPINNER_FRAMES: readonly string[] = Object.freeze(['|', '/', '-', '\\']);

export interface SpinnerProps {
  label?: string;
  tone?: Tone;
  intervalMs?: number;
  /** Set false to freeze (no timer) — e.g. when the host view is hidden. */
  active?: boolean;
}

export const Spinner = memo(function Spinner({ label, tone = 'accent', intervalMs = 80, active = true }: SpinnerProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const frames = asciiMode ? ASCII_SPINNER_FRAMES : SPINNER_FRAMES;
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!active) return undefined;
    const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs, frames.length]);
  const normLabel = label ? normalizeAsciiChrome(label, asciiMode) : undefined;
  return (
    <Text>
      <Text color={toneColor(theme, tone)}>{frames[frame % frames.length]}</Text>
      {normLabel ? <Text color={theme.muted}>{` ${normLabel}`}</Text> : null}
    </Text>
  );
});

/* ------------------------------------------------------------- EmptyState */

export interface EmptyStateProps {
  title: string;
  hint?: string;
  icon?: string;
  actions?: KeyHint[];
  width?: number;
  height?: number;
}

export const EmptyState = memo(function EmptyState({ title, hint, icon, actions, width, height }: EmptyStateProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const glyph = icon ? normalizeAsciiChrome(icon, asciiMode) : (asciiMode ? 'o' : '◌');
  const normTitle = normalizeAsciiChrome(title, asciiMode);
  const normHint = hint ? normalizeAsciiChrome(hint, asciiMode) : undefined;
  return (
    <Box flexDirection="column" alignItems="center" justifyContent="center" width={width} height={height} flexGrow={height ? 0 : 1}>
      <Text color={theme.dim}>{glyph}</Text>
      <Box marginTop={1}>
        <Text color={theme.text} bold>
          {normTitle}
        </Text>
      </Box>
      {normHint ? (
        <Box marginTop={0}>
          <Text color={theme.muted}>{normHint}</Text>
        </Box>
      ) : null}
      {actions && actions.length > 0 ? (
        <Box marginTop={1} gap={2}>
          {actions.map((a) => {
            const normKey = normalizeAsciiChrome(a.key, asciiMode);
            const normActionLabel = normalizeAsciiChrome(a.label, asciiMode);
            return (
              <Text key={a.key}>
                <Text backgroundColor={theme.surface} color={theme.primary} bold>{` ${normKey} `}</Text>
                <Text color={theme.muted}>{` ${normActionLabel}`}</Text>
              </Text>
            );
          })}
        </Box>
      ) : null}
    </Box>
  );
});

/* ------------------------------------------------------------- KeyHintBar */

export interface KeyHintBarProps {
  hints: readonly KeyHint[];
  width: number;
  /** Optional right-aligned status text (e.g. "3/120"). */
  right?: string;
  /** Optional quiet contextual usage tip rendered ONLY in leftover right whitespace (#1317). */
  tip?: string;
}

const MIN_CONTEXTUAL_TIP_COLS = 24;

/** One-line footer: `␣key␣ label  ␣key␣ label …`, dropping hints that don't fit. */
export const KeyHintBar = memo(function KeyHintBar({ hints, width, right, tip }: KeyHintBarProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const rightText = right
    ? truncateDisplay(normalizeAsciiChrome(right, asciiMode), Math.max(0, Math.floor(width / 3)), ell)
    : '';
  const budget = width - (rightText ? displayWidth(rightText) + 2 : 0) - 1;
  const shown: KeyHint[] = [];
  let used = 1;
  for (const h of hints) {
    const normKey = normalizeAsciiChrome(h.key, asciiMode);
    const normLabel = normalizeAsciiChrome(h.label, asciiMode);
    const w = displayWidth(normKey) + 2 + 1 + displayWidth(normLabel) + 2;
    if (used + w > budget) break;
    used += w;
    shown.push({ ...h, key: normKey, label: normLabel });
  }
  let tipText = '';
  if (!rightText && tip) {
    const remaining = budget - used - 2;
    if (remaining >= MIN_CONTEXTUAL_TIP_COLS) {
      const prefix = asciiMode ? '* ' : '💡 ';
      const norm = normalizeAsciiChrome(`${prefix}${tip}`, asciiMode);
      tipText = truncateDisplay(norm, remaining, ell);
    }
  }
  return (
    <Box width={width} height={1} overflow="hidden">
      <Box flexGrow={1}>
        <Text> </Text>
        {shown.map((h) => (
          <Text key={`${h.key}:${h.label}`}>
            <Text backgroundColor={theme.surface} color={theme.accent} bold>{` ${h.key} `}</Text>
            <Text color={theme.muted}>{` ${h.label}  `}</Text>
          </Text>
        ))}
      </Box>
      {rightText ? (
        <Text color={theme.dim}>{`${rightText} `}</Text>
      ) : tipText ? (
        <Text color={theme.dim}>{`${tipText} `}</Text>
      ) : null}
    </Box>
  );
});

/* -------------------------------------------------------------- ToastStack */

export interface ToastStackProps {
  toasts: readonly ToastItem[];
  onDismiss: (id: string) => void;
  width?: number;
  /** Auto-dismiss timeout (errors stay 2× longer). 0 disables. */
  autoDismissMs?: number;
}

const TOAST_ICON: Record<ToastItem['tone'], string> = { info: 'ℹ', success: '✔', warning: '▲', error: '✖' };
const ASCII_TOAST_ICON: Record<ToastItem['tone'], string> = { info: 'i', success: '+', warning: '!', error: 'x' };

const ToastRow = memo(function ToastRow({
  toast,
  onDismiss,
  width,
  autoDismissMs,
}: {
  toast: ToastItem;
  onDismiss: (id: string) => void;
  width: number;
  autoDismissMs: number;
}) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  useEffect(() => {
    if (autoDismissMs <= 0) return undefined;
    const ttl = toast.tone === 'error' ? autoDismissMs * 2 : autoDismissMs;
    const remaining = Math.max(250, ttl - (Date.now() - toast.createdAt));
    const timer = setTimeout(() => onDismiss(toast.id), remaining);
    return () => clearTimeout(timer);
  }, [toast.id, toast.tone, toast.createdAt, autoDismissMs, onDismiss]);
  const color = toneColor(theme, toast.tone);
  const normalizedText = normalizeAsciiChrome(toast.text, asciiMode).replace(/\s+/g, ' ');
  const text = truncateDisplay(normalizedText, Math.max(4, width - 6), asciiMode ? '...' : '…');
  const bar = asciiMode ? '|' : '▎';
  const icon = (asciiMode ? ASCII_TOAST_ICON : TOAST_ICON)[toast.tone];
  return (
    <Box height={1} overflow="hidden">
      <Text backgroundColor={theme.surface} wrap={asciiMode ? undefined : 'truncate-end'}>
        <Text color={color} bold>{`${bar} ${icon} `}</Text>
        <Text color={theme.text}>{`${text} `}</Text>
      </Text>
    </Box>
  );
});

export const ToastStack = memo(function ToastStack({ toasts, onDismiss, width = 44, autoDismissMs = 4000 }: ToastStackProps) {
  if (toasts.length === 0) return null;
  const visible = toasts.slice(-2);
  return (
    <Box flexDirection="column" alignItems="flex-end">
      {visible.map((t) => (
        <ToastRow key={t.id} toast={t} onDismiss={onDismiss} width={width} autoDismissMs={autoDismissMs} />
      ))}
    </Box>
  );
});

/* ---------------------------------------------------------------- Divider */

export interface DividerProps {
  width: number;
  label?: string;
  char?: string;
}

export const Divider = memo(function Divider({ width, label, char }: DividerProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const lineChar = char ?? (asciiMode ? '-' : '─');
  if (!label) return <Text color={theme.border}>{lineChar.repeat(Math.max(0, width))}</Text>;
  const l = truncateDisplay(label, Math.max(0, width - 6), asciiMode ? '...' : '…');
  const rest = Math.max(0, width - displayWidth(l) - 4);
  return (
    <Text>
      <Text color={theme.border}>{`${lineChar}${lineChar} `}</Text>
      <Text color={theme.muted}>{l}</Text>
      <Text color={theme.border}>{` ${lineChar.repeat(rest)}`}</Text>
    </Text>
  );
});
