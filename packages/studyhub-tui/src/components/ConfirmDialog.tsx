import React, { memo, useState, type ReactNode } from 'react';
import { Box, Text } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { t, useTuiStore } from '../state/store.js';
import {
  KEY_LAYER_MODAL,
  KEY_SCOPE_DEPTH_SHELL_OVERLAY,
  KeyScope,
  useKeyScopeDepth,
  useScopeActive,
  useScopedInput,
} from './key-dispatcher.js';
import { Modal } from './Modal.js';
import { ClickableBox } from './mouse.js';

export interface ConfirmDialogProps {
  title: string;
  message: string | ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Danger styling (error tone confirm). */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  isActive?: boolean;
  width?: number;
  overlay?: boolean;
}

const ConfirmDialogContent = memo(function ConfirmDialogContent({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
  onCancel,
  baseActive,
  width = 56,
  overlay = true,
}: Omit<ConfirmDialogProps, 'isActive'> & { baseActive: boolean }) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const effectiveActive = useScopeActive(baseActive);
  const resolvedConfirm = confirmLabel ?? t(lang, '确认', 'Confirm');
  const resolvedCancel = cancelLabel ?? t(lang, '取消', 'Cancel');
  const [focus, setFocus] = useState<'confirm' | 'cancel'>(danger ? 'cancel' : 'confirm');
  const keyDepth = useKeyScopeDepth();
  useScopedInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') {
        onConfirm();
        return true;
      }
      if (input === 'n' || input === 'N') {
        onCancel();
        return true;
      }
      if (key.leftArrow || key.rightArrow || key.tab || input === 'h' || input === 'l') {
        setFocus((f) => (f === 'confirm' ? 'cancel' : 'confirm'));
        return true;
      }
      if (key.return) {
        if (focus === 'confirm') onConfirm();
        else onCancel();
        return true;
      }
      return false;
    },
    { isActive: effectiveActive, layer: KEY_LAYER_MODAL, depth: keyDepth, id: 'ConfirmDialog' },
  );
  const confirmColor = danger ? theme.error : theme.primary;
  const btn = (label: string, active: boolean, color: string, hot: string, onPress: () => void) => (
    <ClickableBox onClick={onPress} clickActive={effectiveActive}>
      <Text backgroundColor={active ? color : theme.bg} color={active ? (theme.dark ? theme.bg : '#ffffff') : color} bold={active}>
        {` ${label} (${hot}) `}
      </Text>
    </ClickableBox>
  );
  const dialogHints = [
    { key: 'y/Enter', label: resolvedConfirm },
    { key: 'n/Esc', label: resolvedCancel },
    { key: 'Tab', label: t(lang, '切换按钮', 'Switch') },
  ];
  return (
    <Modal title={title} icon={danger ? (asciiMode ? '!' : '▲') : '?'} tone={danger ? 'error' : 'primary'} width={width} onClose={onCancel} isActive={effectiveActive} overlay={overlay} hints={dialogHints}>
      <Box marginY={1} flexDirection="column">
        {typeof message === 'string' ? <Text color={theme.text}>{message}</Text> : message}
      </Box>
      <Box justifyContent="flex-end" gap={2}>
        {btn(resolvedCancel, focus === 'cancel', theme.muted, 'n', onCancel)}
        {btn(resolvedConfirm, focus === 'confirm', confirmColor, 'y', onConfirm)}
      </Box>
    </Modal>
  );
});

/** y / Enter = confirm (when focused), n / Esc = cancel, ←/→/Tab switch buttons. */
export const ConfirmDialog = memo(function ConfirmDialog({
  isActive = true,
  ...rest
}: ConfirmDialogProps) {
  const parentDepth = useKeyScopeDepth();
  const isShellLevel = parentDepth >= KEY_SCOPE_DEPTH_SHELL_OVERLAY;
  const shellOverlay = useTuiStore(
    (s) => s.commandPaletteOpen || s.helpOpen || s.coursePickerOpen || s.inboxOpen || s.notificationHistoryOpen,
  );
  // Page-level ConfirmDialogs defer to shell overlays (both via LIFO depth stack and store flag for standalone tests);
  // Shell-level dialogs (e.g. AppShell Quit ConfirmDialog at KEY_SCOPE_DEPTH_QUIT_CONFIRM) stay active above Help/Palette.
  const baseActive = isActive && (isShellLevel || !shellOverlay);
  return (
    <KeyScope id="ConfirmDialog" opaque active={baseActive}>
      <ConfirmDialogContent {...rest} baseActive={baseActive} />
    </KeyScope>
  );
});
