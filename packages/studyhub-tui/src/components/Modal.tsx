import React, { memo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { KeyHint } from '../types/contracts.js';
import { toneColor, useTheme, type Tone } from '../theme/tokens.js';
import { displayWidth, truncateDisplay } from '../render/cjk.js';
import { glyph, hairline } from '../render/glyphs.js';
import { useTuiStore } from '../state/store.js';
import { useInputCapture, useModalFooterHints } from './focus.js';
import { KEY_LAYER_MODAL_FRAME, KeyScopeProvider, useKeyScopeDepth, useScopedInput } from './key-dispatcher.js';
import { LAYOUT_CHROME } from './layout-tokens.js';
import { useStableWindowSize } from './resize.js';
import {
  ClickableBox,
  MOUSE_LAYER_MODAL,
  MouseLayerContext,
  useMouseLayer,
  useMouseModalBarrier,
} from './mouse.js';

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
  return Math.max(10, frameWidth - LAYOUT_CHROME.MODAL_CHROME_X);
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
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const { columns, rows } = useStableWindowSize();
  const parentLayer = useMouseLayer();
  const modalLayer = overlay ? Math.max(MOUSE_LAYER_MODAL, parentLayer + MOUSE_LAYER_MODAL) : parentLayer;
  const keyDepth = useKeyScopeDepth();
  // Opaque modal capture (#1354 D1): while mounted, a modal always captures global input
  // and blocks background mouse clicks even if its own isActive is temporarily false (e.g. busy/nested child).
  useInputCapture(captureInput);
  useMouseModalBarrier(overlay, modalLayer);
  useModalFooterHints(hints, isActive && overlay);
  useScopedInput(
    (_input, key) => {
      if (key.escape) {
        onClose?.();
        return true;
      }
      return false;
    },
    { isActive: isActive && Boolean(onClose), layer: KEY_LAYER_MODAL_FRAME, depth: keyDepth, id: 'Modal:esc' },
  );
  const frameWidth = Math.max(
    LAYOUT_CHROME.MODAL_MIN_WIDTH,
    Math.min(width ?? LAYOUT_CHROME.MODAL_DEFAULT_WIDTH, columns - LAYOUT_CHROME.MODAL_MARGIN_X),
  );
  const inner = frameWidth - LAYOUT_CHROME.PANEL_CHROME_X;
  const accent = toneColor(theme, tone);
  const ell = glyph('ellipsis', asciiMode);
  const head = `${icon ? `${icon} ` : ''}${title}`;
  const sub = subtitle ? truncateDisplay(subtitle, Math.max(0, Math.floor(inner * 0.45)), ell) : '';
  const headText = truncateDisplay(head, Math.max(4, inner - displayWidth(sub) - (onClose ? 6 : 1)), ell);

  const frame = (
    <KeyScopeProvider depth={keyDepth} opaque={false}>
      <MouseLayerContext.Provider value={modalLayer}>
      <Box
        flexDirection="column"
        width={frameWidth}
        height={height ? Math.min(height, rows - 2) : undefined}
        borderStyle={asciiMode ? 'classic' : 'round'}
        borderColor={accent}
        backgroundColor={theme.surface}
        paddingX={1}
      >
        <Box height={1} flexShrink={0}>
          <Text color={accent} bold>
            {headText}
          </Text>
          <Box flexGrow={1} />
          {sub ? <Text color={theme.muted}>{sub}</Text> : null}
          {onClose ? (
            <ClickableBox onClick={() => onClose()} clickActive={isActive} clickLayer={modalLayer} flexShrink={0}>
              <Text color={theme.dim}>{`  esc ${glyph('close', asciiMode)}`}</Text>
            </ClickableBox>
          ) : null}
        </Box>
        <Box height={1} flexShrink={0}>
          <Text color={theme.border}>{hairline(inner, asciiMode)}</Text>
        </Box>
        <Box flexDirection="column" paddingX={1} flexGrow={1} overflow="hidden">
          {children}
        </Box>
        {hints && hints.length > 0 ? (
          <Box height={1} flexShrink={0} marginTop={0} overflow="hidden">
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
    </MouseLayerContext.Provider>
    </KeyScopeProvider>
  );

  if (!overlay) return frame;
  return (
    <Box position="absolute" top={0} left={0} width="100%" height="100%" alignItems="center" justifyContent="center">
      {frame}
    </Box>
  );
});
