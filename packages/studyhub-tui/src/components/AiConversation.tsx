/**
 * Unified `<AiConversation>` transcript + streaming + wrapped-error component (#1354 D7).
 *
 * Zero `marked` dependency: renders plain wrapped turns via `ScrollView` by default, or
 * delegates body rendering via `renderBody` when a caller wants full Markdown + LaTeX.
 */
import React, { memo, useMemo, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import type { DialogueTurn } from '../host/ai-dialogue.js';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { wrapDisplay } from '../render/cjk.js';
import { glyph } from '../render/glyphs.js';
import { ScrollView } from './ScrollView.js';

export interface AiConversationProps {
  turns: readonly DialogueTurn[];
  streaming: boolean;
  streamingText: string;
  errorText?: string | null;
  width: number;
  height: number;
  isActive: boolean;
  /** Optional custom empty-state copy when idle with 0 turns. */
  emptyText?: string;
  /** Optional custom live-streaming placeholder copy before first chunk arrives. */
  streamingPlaceholder?: string;
  /** Optional custom transcript renderer (e.g. MarkdownView) when caller needs rich rendering. */
  renderBody?: (opts: { bodyHeight: number; innerWidth: number }) => ReactNode;
}

export const AiConversation = memo(function AiConversation({
  turns,
  streaming,
  streamingText,
  errorText,
  width,
  height,
  isActive,
  emptyText,
  streamingPlaceholder,
  renderBody,
}: AiConversationProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = glyph('ellipsis', asciiMode);

  const safeW = Math.max(12, Math.floor(width));
  const scrollTextW = Math.max(10, safeW - 3);

  const wrappedErrorLines = useMemo(() => {
    if (!errorText) return [];
    const prefix = `${glyph('warn', asciiMode)} `;
    return wrapDisplay(`${prefix}${errorText}`, safeW);
  }, [asciiMode, errorText, safeW]);

  const errorRows = Math.min(wrappedErrorLines.length, Math.max(0, Math.floor(height) - 2));
  const bodyHeight = Math.max(1, Math.floor(height) - errorRows);

  const transcriptLines = useMemo<string[]>(() => {
    if (renderBody) return [];
    const out: string[] = [];
    for (const turn of turns) {
      const prefix =
        turn.role === 'user'
          ? `${asciiMode ? '>' : '▸'} ${t(lang, '你', 'You')}: `
          : `${asciiMode ? '*' : '✦'} AI: `;
      const paragraphs = turn.text.split('\n');
      paragraphs.forEach((p, pIdx) => {
        const rawLine = pIdx === 0 ? `${prefix}${p}` : p;
        for (const wLine of wrapDisplay(rawLine, scrollTextW)) out.push(wLine);
      });
      out.push('');
    }
    if (streaming) {
      const live = streamingText || streamingPlaceholder || t(lang, `正在思考并回应${ell}`, `Thinking${ell}`);
      for (const p of live.split('\n')) {
        for (const wLine of wrapDisplay(p, scrollTextW)) out.push(wLine);
      }
    }
    while (out.length > 0 && out[out.length - 1] === '') out.pop();
    return out;
  }, [renderBody, turns, streaming, streamingText, streamingPlaceholder, scrollTextW, asciiMode, lang, ell]);

  return (
    <Box flexDirection="column" width={safeW} height={height} overflow="hidden">
      {wrappedErrorLines.length > 0 ? (
        <Box flexDirection="column" width={safeW} flexShrink={0}>
          {wrappedErrorLines.slice(0, Math.max(1, errorRows)).map((line, i) => (
            <Text key={i} color={theme.error} wrap="wrap">
              {line}
            </Text>
          ))}
        </Box>
      ) : null}
      <Box flexDirection="column" width={safeW} height={bodyHeight} overflow="hidden">
        {renderBody ? (
          renderBody({ bodyHeight, innerWidth: safeW })
        ) : transcriptLines.length > 0 ? (
          <ScrollView
            lines={transcriptLines}
            width={safeW}
            height={bodyHeight}
            isActive={isActive}
            follow={streaming}
          />
        ) : (
          <Box height={bodyHeight} alignItems="center" justifyContent="center">
            <Text color={theme.dim} wrap="wrap">
              {emptyText || t(lang, '输入任意问题或指令，回车即送模型回应。', 'Type any instruction and press Enter.')}
            </Text>
          </Box>
        )}
      </Box>
    </Box>
  );
});
