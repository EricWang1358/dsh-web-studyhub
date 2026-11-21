import React, { memo, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';
import { useTheme } from '../theme/tokens.js';
import { Modal } from './Modal.js';

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

/** y / Enter = confirm (when focused), n / Esc = cancel, ←/→/Tab switch buttons. */
export const ConfirmDialog = memo(function ConfirmDialog({
  title,
  message,
  confirmLabel = '确认',
  cancelLabel = '取消',
  danger = false,
  onConfirm,
  onCancel,
  isActive = true,
  width = 56,
  overlay = true,
}: ConfirmDialogProps) {
  const theme = useTheme();
  const [focus, setFocus] = useState<'confirm' | 'cancel'>(danger ? 'cancel' : 'confirm');
  useInput(
    (input, key) => {
      if (input === 'y' || input === 'Y') onConfirm();
      else if (input === 'n' || input === 'N') onCancel();
      else if (key.leftArrow || key.rightArrow || key.tab || input === 'h' || input === 'l') {
        setFocus((f) => (f === 'confirm' ? 'cancel' : 'confirm'));
      } else if (key.return) {
        if (focus === 'confirm') onConfirm();
        else onCancel();
      }
    },
    { isActive },
  );
  const confirmColor = danger ? theme.error : theme.primary;
  const btn = (label: string, active: boolean, color: string, hot: string) => (
    <Text backgroundColor={active ? color : theme.bg} color={active ? (theme.dark ? theme.bg : '#ffffff') : color} bold={active}>
      {` ${label} (${hot}) `}
    </Text>
  );
  return (
    <Modal title={title} icon={danger ? '▲' : '?'} tone={danger ? 'error' : 'primary'} width={width} onClose={onCancel} isActive={isActive} overlay={overlay}>
      <Box marginY={1} flexDirection="column">
        {typeof message === 'string' ? <Text color={theme.text}>{message}</Text> : message}
      </Box>
      <Box justifyContent="flex-end" gap={2}>
        {btn(cancelLabel, focus === 'cancel', theme.muted, 'n')}
        {btn(confirmLabel, focus === 'confirm', confirmColor, 'y')}
      </Box>
    </Modal>
  );
});
