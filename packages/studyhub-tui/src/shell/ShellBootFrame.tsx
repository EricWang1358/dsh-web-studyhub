import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const ASCII_SPINNER_FRAMES = ['|', '/', '-', '\\'] as const;

/**
 * Ultra-lightweight startup frame rendered before AppShell, marked, or any modal chunks load.
 * Keep dependencies minimal (`react`, `ink`, `store`, `tokens`) for instant Time-To-First-Frame.
 */
export function ShellBootFrame({ label }: { label?: string }) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const frames = asciiMode ? ASCII_SPINNER_FRAMES : SPINNER_FRAMES;
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setFrame((f) => (f + 1) % frames.length), 80);
    return () => clearInterval(timer);
  }, [frames.length]);

  return (
    <Box padding={1}>
      <Text>
        <Text color={theme.accent}>{frames[frame % frames.length]}</Text>
        <Text color={theme.muted}>{` ${label ?? 'StudyHub'}`}</Text>
      </Text>
      <Text color={theme.dim}> </Text>
    </Box>
  );
}
