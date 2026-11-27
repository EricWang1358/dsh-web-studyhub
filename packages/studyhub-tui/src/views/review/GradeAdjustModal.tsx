import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { KEY_LAYER_MODAL } from '../../input/dispatcher.js';
import { useKeyScope } from '../../input/hooks.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Modal } from '../../components/Modal.js';
import { gradeLabel } from '../../grade-scale.js';
import { FSRS_GRADES } from './review-helpers.js';

export interface GradeAdjustModalProps {
  lang: 'zh' | 'en';
  asciiMode: boolean;
  width: number;
  currentGrade: number | undefined;
  originalGrade: number | undefined;
  busy: boolean;
  isActive: boolean;
  onSelect: (grade: number) => void;
  onClose: () => void;
}

export function GradeAdjustModal({
  lang,
  asciiMode,
  width,
  currentGrade,
  originalGrade,
  busy,
  isActive,
  onSelect,
  onClose,
}: GradeAdjustModalProps) {
  const theme = useTheme();
  const initialCursor =
    typeof currentGrade === 'number' && currentGrade >= 0 && currentGrade <= 5 ? currentGrade : 3;
  const [cursor, setCursor] = useState(initialCursor);

  useEffect(() => {
    if (isActive) {
      setCursor(typeof currentGrade === 'number' && currentGrade >= 0 && currentGrade <= 5 ? currentGrade : 3);
    }
  }, [isActive, currentGrade]);

  useKeyScope({
    id: 'ReviewView:gradeAdjust',
    active: isActive,
    layer: KEY_LAYER_MODAL,
    onKey: (input, key) => {
      if (busy) return false;
      if (/^[0-5]$/.test(input)) {
        onSelect(Number(input));
        return true;
      }
      if (input === 'j' || key.downArrow) {
        setCursor((prev) => (prev + 1) % FSRS_GRADES.length);
        return true;
      }
      if (input === 'k' || key.upArrow) {
        setCursor((prev) => (prev - 1 + FSRS_GRADES.length) % FSRS_GRADES.length);
        return true;
      }
      if (key.return) {
        onSelect(FSRS_GRADES[cursor]?.grade ?? cursor);
        return true;
      }
      return false;
    },
  });

  return (
    <Modal
      title={t(lang, '手动调整 AI 评分', 'Adjust AI Grade')}
      icon={asciiMode ? '*' : '◆'}
      tone="primary"
      width={Math.min(56, Math.max(32, width - 6))}
      isActive={isActive}
      onClose={onClose}
      hints={[
        { key: '0-5', label: t(lang, '直接改分', 'Pick') },
        { key: 'j/k', label: t(lang, '选择', 'Move') },
        { key: 'Enter', label: t(lang, '确认', 'Confirm') },
        { key: 'Esc', label: t(lang, '取消', 'Cancel') },
      ]}
    >
      <Text color={theme.muted}>
        {typeof originalGrade === 'number' && originalGrade !== currentGrade
          ? t(
              lang,
              `当前: ${currentGrade ?? '-'}/5 (AI 原评 ${originalGrade})`,
              `Current: ${currentGrade ?? '-'}/5 (AI: ${originalGrade})`,
            )
          : t(
              lang,
              `当前评分: ${currentGrade ?? '-'}/5，选择调整后的 FSRS 评分 (0-5):`,
              `Current grade: ${currentGrade ?? '-'}/5. Pick new FSRS grade (0-5):`,
            )}
      </Text>
      {typeof currentGrade === 'number' && gradeLabel(currentGrade, lang) ? (
        <Text color={theme.dim}>
          {t(lang, `当前这一档：${gradeLabel(currentGrade, lang)}`, `This grade: ${gradeLabel(currentGrade, lang)}`)}
        </Text>
      ) : null}
      <Box flexDirection="column" marginTop={1}>
        {FSRS_GRADES.map((g, idx) => {
          const isCursor = idx === cursor;
          const isCurrent = g.grade === currentGrade;
          const isOriginal = g.grade === originalGrade;
          const label = lang === 'en' ? g.labelEn : g.labelZh;
          const meaning = gradeLabel(g.grade, lang);
          return (
            <Box key={g.key} flexDirection="row" gap={1}>
              <Text color={isCursor ? theme.primary : theme.dim} bold={isCursor}>
                {isCursor ? (asciiMode ? '> ' : '▸ ') : '  '}
              </Text>
              <Text color={isCursor ? theme.primary : theme.text} bold={isCursor || isCurrent}>
                {`[${g.key}] ${label}${meaning ? `${asciiMode ? ' - ' : ' · '}${meaning}` : ''}`}
              </Text>
              {isCurrent ? <Text color={theme.accent}>{t(lang, '(当前)', '(current)')}</Text> : null}
              {isOriginal ? <Text color={theme.muted}>{t(lang, '(AI原评)', '(AI)')}</Text> : null}
            </Box>
          );
        })}
      </Box>
    </Modal>
  );
}
