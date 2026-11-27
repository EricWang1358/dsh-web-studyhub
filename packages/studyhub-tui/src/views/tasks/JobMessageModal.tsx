import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useStableWindowSize } from '../../components/resize.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { Spinner } from '../../components/Badge.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { useTheme } from '../../theme/tokens.js';
import { truncateDisplay } from '../../render/cjk.js';
import { tryAction } from '../../host/sample-actions.js';
import type { JobMessageResponse, JobRecord } from './tasks-model.js';

export interface JobMessageModalProps {
  host: HostClient;
  job: JobRecord;
  isActive: boolean;
  onClose: () => void;
  onSent: (receipt: JobMessageResponse) => void;
  lang: UiLanguage;
  asciiMode: boolean;
}

export const JobMessageModal = memo(function JobMessageModal({
  host,
  job,
  isActive,
  onClose,
  onSent,
  lang,
  asciiMode,
}: JobMessageModalProps) {
  const theme = useTheme();
  const { columns } = useStableWindowSize();
  const [message, setMessage] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [validationError, setValidationError] = useState('');
  const submittingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const frameW = Math.min(72, Math.max(40, columns - 4));
  const innerW = modalContentWidth(frameW);
  const inputW = Math.max(12, modalContentWidth(frameW) - 4);
  const ell = asciiMode ? '...' : '…';
  const charRange = asciiMode ? '1-4000' : '1–4000';

  const handleSubmit = useCallback(
    async (raw: string) => {
      if (submitting || submittingRef.current) return;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 4000) {
        setValidationError(
          t(lang, `请输入 ${charRange} 字的补充说明`, `Please enter ${charRange} characters`),
        );
        return;
      }
      submittingRef.current = true;
      setValidationError('');
      setSubmitting(true);
      try {
        const res = await tryAction<JobMessageResponse>(host, 'job.message', {
          jobId: job.id,
          message: trimmed,
        });
        if (!mountedRef.current) return;
        if (!res.ok) {
          setValidationError(
            res.error?.message || t(lang, '发送补充说明失败', 'Failed to send refinement message'),
          );
          return;
        }
        onSent(res.value ?? { jobId: job.id });
      } finally {
        submittingRef.current = false;
        if (mountedRef.current) setSubmitting(false);
      }
    },
    [charRange, host, job.id, lang, onSent, submitting],
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: 'Enter', label: t(lang, '发送', 'Send') },
      { key: 'Esc', label: t(lang, '取消', 'Cancel') },
    ],
    [lang],
  );

  const handleCloseSafe = useCallback(() => {
    if (submittingRef.current) return;
    onClose();
  }, [onClose]);

  return (
    <Modal
      title={t(lang, '发送任务补充说明', 'Send Refinement Message')}
      icon={asciiMode ? '>' : '✉'}
      tone="accent"
      subtitle={truncateDisplay(job.title, 24, ell)}
      width={frameW}
      onClose={submitting ? undefined : handleCloseSafe}
      isActive={isActive}
      hints={hints}
    >
      <Box flexDirection="column" width={innerW}>
        <Text color={theme.muted}>
          {truncateDisplay(
            t(
              lang,
              `向正在运行的出题任务发送实时补充要求（${charRange} 字），立即投递或用于下一阶段。`,
              `Send live guidance (${charRange} chars) to this active job for current or next-stage workers.`,
            ),
            innerW,
            ell,
          )}
        </Text>
        <Box
          marginTop={1}
          borderStyle={asciiMode ? 'classic' : 'round'}
          borderColor={submitting ? theme.muted : theme.borderActive}
          paddingX={1}
        >
          <TextInput
            value={message}
            onChange={(val) => {
              setMessage(val);
              if (validationError) setValidationError('');
            }}
            onSubmit={(val) => void handleSubmit(val)}
            onCancel={handleCloseSafe}
            isActive={isActive && !submitting}
            width={inputW}
            prompt={asciiMode ? '> ' : '› '}
            placeholder={t(
              lang,
              `例如：多出几道边界条件与反例题${ell}`,
              `e.g. Add more boundary-case questions${ell}`,
            )}
            maxLength={4000}
            captureInput={false}
          />
        </Box>
        {submitting ? (
          <Box marginTop={1}>
            <Spinner label={t(lang, `正在投递补充说明${ell}`, `Delivering message${ell}`)} active={isActive} />
          </Box>
        ) : validationError ? (
          <Box marginTop={1}>
            <Text color={theme.error} wrap="wrap">
              {`${asciiMode ? '! ' : '✕ '}${validationError}`}
            </Text>
          </Box>
        ) : null}
      </Box>
    </Modal>
  );
});
