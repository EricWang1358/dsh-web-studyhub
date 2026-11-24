import React, { memo, useCallback, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import { useTheme } from '../../theme/tokens.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import { t, useTuiStore } from '../../state/store.js';
import type { KeyHint, UiLanguage } from '../../types/contracts.js';
import { BOARD_COLUMNS, type BoardCard, type BoardColumnId } from './board-store.js';

export interface BoardCardModalProps {
  mode: 'add' | 'edit';
  lang: UiLanguage;
  initialColumn: BoardColumnId;
  initialCourse?: string;
  card?: BoardCard | null;
  terminalCols: number;
  onClose: () => void;
  onSubmit: (data: { title: string; course: string; dueDate: string; column: BoardColumnId }) => void;
}

type Field = 'title' | 'course' | 'dueDate' | 'column';
const FIELDS: readonly Field[] = ['title', 'course', 'dueDate', 'column'];

export const BoardCardModal = memo(function BoardCardModal({
  mode,
  lang,
  initialColumn,
  initialCourse = '',
  card,
  terminalCols,
  onClose,
  onSubmit,
}: BoardCardModalProps) {
  const theme = useTheme();
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const frameWidth = Math.max(46, Math.min(68, terminalCols - 6));
  const innerWidth = modalContentWidth(frameWidth);

  const initTitle = mode === 'edit' ? card?.title || '' : '';
  const initCourse = mode === 'edit' ? card?.course || '' : initialCourse;
  const initDueDate = mode === 'edit' ? card?.dueDate || '' : '';
  const initColumn: BoardColumnId = mode === 'edit' && card ? card.column : initialColumn;

  const [title, setTitle] = useState(() => initTitle);
  const [course, setCourse] = useState(() => initCourse);
  const [dueDate, setDueDate] = useState(() => initDueDate);
  const [column, setColumn] = useState<BoardColumnId>(() => initColumn);
  const [field, setField] = useState<Field>('title');
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [error, setError] = useState('');

  const dirty =
    mode === 'edit'
      ? title !== initTitle || course !== initCourse || dueDate !== initDueDate || column !== initColumn
      : title.trim().length > 0 || dueDate.trim().length > 0 || course !== initCourse || column !== initColumn;

  const requestClose = useCallback(() => {
    if (dirty) {
      setConfirmDiscard(true);
      return;
    }
    onClose();
  }, [dirty, onClose]);

  const handleConfirm = useCallback(() => {
    const trimmed = title.trim();
    if (!trimmed) {
      setError(t(lang, '请输入任务标题', 'Please enter a card title'));
      setField('title');
      return;
    }
    const cleanDue = dueDate.trim();
    if (cleanDue && !/^\d{4}-\d{2}-\d{2}$/.test(cleanDue)) {
      setError(t(lang, '截止日期格式请用 YYYY-MM-DD（或留空）', 'Due date must be YYYY-MM-DD (or leave blank)'));
      setField('dueDate');
      return;
    }
    onSubmit({
      title: trimmed,
      course: course.trim(),
      dueDate: cleanDue,
      column,
    });
  }, [title, dueDate, course, column, lang, onSubmit]);

  useInput(
    (input, key) => {
      if (key.ctrl && input === 's') {
        handleConfirm();
        return;
      }
      if (key.tab || key.downArrow || key.upArrow) {
        const dir = key.shift || key.upArrow ? -1 : 1;
        const idx = FIELDS.indexOf(field);
        setField(FIELDS[(idx + dir + FIELDS.length) % FIELDS.length]);
        return;
      }
      if (field === 'column') {
        if (key.leftArrow || input === 'h') {
          const idx = BOARD_COLUMNS.indexOf(column);
          setColumn(BOARD_COLUMNS[(idx + 2) % 3]);
        } else if (key.rightArrow || input === 'l') {
          const idx = BOARD_COLUMNS.indexOf(column);
          setColumn(BOARD_COLUMNS[(idx + 1) % 3]);
        } else if (input === '1') setColumn('todo');
        else if (input === '2') setColumn('doing');
        else if (input === '3') setColumn('done');
        else if (key.return) handleConfirm();
      }
    },
    { isActive: !confirmDiscard },
  );

  const hints: KeyHint[] = useMemo(
    () => [
      { key: asciiMode ? 'Tab/Up/Dn' : 'Tab/↑↓', label: t(lang, '切换栏位', 'Next field') },
      { key: 'Enter', label: t(lang, '确认', 'Save') },
      { key: 'Esc', label: dirty ? t(lang, '放弃/取消', 'Discard') : t(lang, '取消', 'Cancel') },
    ],
    [asciiMode, lang, dirty],
  );

  const colLabel = (c: BoardColumnId) =>
    c === 'todo' ? t(lang, '待办 Todo', 'Todo') : c === 'doing' ? t(lang, '进行中 Doing', 'Doing') : t(lang, '已完成 Done', 'Done');

  return (
    <>
    <Modal
      title={mode === 'add' ? t(lang, '添加看板任务', 'Add Board Card') : t(lang, '编辑看板任务', 'Edit Board Card')}
      subtitle={dirty ? t(lang, '未保存', 'unsaved') : undefined}
      icon={asciiMode ? '#' : '▦'}
      tone="primary"
      width={frameWidth}
      isActive={!confirmDiscard}
      onClose={confirmDiscard ? undefined : requestClose}
      hints={hints}
    >
      <Box flexDirection="column" gap={0}>
        <Text color={field === 'title' ? theme.primary : theme.muted} bold>
          {t(lang, '任务标题 *', 'Title *')}
        </Text>
        <TextInput
          value={title}
          onChange={setTitle}
          onSubmit={() => {
            if (title.trim()) setField('course');
            else setError(t(lang, '请输入任务标题', 'Please enter a card title'));
          }}
          onCancel={requestClose}
          isActive={!confirmDiscard && field === 'title'}
          width={innerWidth - 2}
          prompt={asciiMode ? '> ' : '› '}
          placeholder={t(lang, '例如：刷完第 5 章矩阵特征值错题', 'e.g. Review Chapter 5 eigenvalue mistakes')}
          maxLength={300}
          captureInput={false}
        />

        <Box marginTop={1} flexDirection="column">
          <Text color={field === 'course' ? theme.primary : theme.muted} bold>
            {t(lang, '课程标签（可选）', 'Course Tag (optional)')}
          </Text>
          <TextInput
            value={course}
            onChange={setCourse}
            onSubmit={() => setField('dueDate')}
            onCancel={requestClose}
            isActive={!confirmDiscard && field === 'course'}
            width={innerWidth - 2}
            prompt="# "
            placeholder={t(lang, '例如：线性代数', 'e.g. Linear Algebra')}
            maxLength={120}
            captureInput={false}
          />
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={field === 'dueDate' ? theme.primary : theme.muted} bold>
            {t(lang, '截止日期 YYYY-MM-DD（可选）', 'Due Date YYYY-MM-DD (optional)')}
          </Text>
          <TextInput
            value={dueDate}
            onChange={setDueDate}
            onSubmit={handleConfirm}
            onCancel={requestClose}
            isActive={!confirmDiscard && field === 'dueDate'}
            width={innerWidth - 2}
            prompt={asciiMode ? '@ ' : '◷ '}
            placeholder="2026-11-30"
            maxLength={20}
            captureInput={false}
          />
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text color={field === 'column' ? theme.primary : theme.muted} bold>
            {t(
              lang,
              asciiMode ? '所属列（<-/-> 或 1/2/3）' : '所属列（←/→ 或 1/2/3）',
              asciiMode ? 'Column (<-/-> or 1/2/3)' : 'Column (←/→ or 1/2/3)',
            )}
          </Text>
          <Box gap={2} marginTop={0}>
            {BOARD_COLUMNS.map((c, idx) => {
              const selected = column === c;
              return (
                <Text
                  key={c}
                  backgroundColor={selected ? (field === 'column' ? theme.primary : theme.surface) : undefined}
                  color={selected ? (field === 'column' ? (theme.dark ? theme.bg : '#ffffff') : theme.primary) : theme.muted}
                  bold={selected}
                >
                  {` ${idx + 1}:${colLabel(c)} `}
                </Text>
              );
            })}
          </Box>
        </Box>

        {error ? (
          <Box marginTop={1}>
            <Text color={theme.error}>{`${asciiMode ? 'x' : '✕'} ${error}`}</Text>
          </Box>
        ) : null}
      </Box>
    </Modal>

    {confirmDiscard ? (
      <ConfirmDialog
        title={t(lang, '放弃未保存的看板卡片修改？', 'Discard unsaved board card changes?')}
        message={t(
          lang,
          '当前看板任务仍有未保存的编辑内容。放弃后将丢失这些修改。',
          'You have unsaved edits in this board card. Closing now will discard them.',
        )}
        confirmLabel={t(lang, '放弃修改', 'Discard')}
        cancelLabel={t(lang, '继续编辑', 'Keep Editing')}
        danger
        isActive={confirmDiscard}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
        onCancel={() => setConfirmDiscard(false)}
      />
    ) : null}
    </>
  );
});
