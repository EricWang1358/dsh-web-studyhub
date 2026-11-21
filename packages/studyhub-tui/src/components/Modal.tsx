import React, { memo, type ReactNode } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { KeyHint } from '../types/contracts.js';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/index.js';
import { useInputCapture } from './focus.js';

export interface ModalProps {
  title: string;
  /** Dim text on the right of the title row. */
  subtitle?: string;
  icon?: string;
  tone?: Tone;
  /** Frame width (default min(72, cols-4)). */
  width?: number;
  /** Fixed frame height (default: content height). */
  height?: number;
  /** Esc closes. */
  onClose?: () => void;
  /** Keyboard focus for Esc handling + global capture (default true). */
  isActive?: boolean;
  /** Footer key hints. */
  hints?: readonly KeyHint[];
  /**
   * Render centered over the whole screen (absolute overlay). Set false to render inline.
   * Default true.
   */
  overlay?: boolean;
  /** Mark store.inputCaptured while open (default true). */
  captureInput?: boolean;
  children?: ReactNode;
}

/** Inner content width for a modal of `frameWidth` (border 2 + padding 4). */
export function modalContentWidth(frameWidth: number): number {
  return Math.max(10, frameWidth - 6);
}

export const Modal = memo(function Modal({
  title,
  subtitle,
  icon,
  tone = 'primary',
  width,
  height,
  onClose,
  isActive = true,
  hints,
  overlay = true,
  captureInput = true,
  children,
}: ModalProps) {
  const theme = useTheme();
  const { columns, rows } = useWindowSize();
  useInputCapture(isActive && captureInput);
  useInput(
    (_input, key) => {
      if (key.escape) onClose?.();
    },
    { isActive: isActive && Boolean(onClose) },
  );
  const frameWidth = Math.max(24, Math.min(width ?? 72, columns - 4));
  const inner = frameWidth - 4;
  const accent = toneColor(theme, tone);
  const head = `${icon ? `${icon} ` : ''}${title}`;
  const sub = subtitle ? truncateDisplay(subtitle, Math.max(0, Math.floor(inner * 0.45))) : '';
  const headText = truncateDisplay(head, Math.max(4, inner - displayWidth(sub) - (onClose ? 6 : 1)));

  const frame = (
    <Box
      flexDirection="column"
      width={frameWidth}
      height={height ? Math.min(height, rows - 2) : undefined}
      borderStyle="round"
      borderColor={accent}
      backgroundColor={theme.surface}
      paddingX={1}
    >
      <Box height={1}>
        <Text color={accent} bold>
          {headText}
        </Text>
        <Box flexGrow={1} />
        {sub ? <Text color={theme.muted}>{sub}</Text> : null}
        {onClose ? <Text color={theme.dim}>{'  esc ✕'}</Text> : null}
      </Box>
      <Text color={theme.border}>{'─'.repeat(inner)}</Text>
      <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
        {children}
      </Box>
      {hints && hints.length > 0 ? (
        <Box height={1} marginTop={0} overflow="hidden">
          {hints.map((h) => (
            <Text key={`${h.key}:${h.label}`}>
              <Text color={theme.accent} bold>
                {h.key}
              </Text>
              <Text color={theme.muted}>{` ${h.label}   `}</Text>
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );

  if (!overlay) return frame;
  return (
    <Box position="absolute" top={0} left={0} width={columns} height={rows} alignItems="center" justifyContent="center">
      {frame}
    </Box>
  );
});
