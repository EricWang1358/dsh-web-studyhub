import React, { memo, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { t, useTuiStore } from '../state/store.js';
import { useTheme } from '../theme/tokens.js';
import { Modal } from '../components/Modal.js';
import { SelectList, type SelectOption } from '../components/SelectList.js';
import { TextInput } from '../components/TextInput.js';
import { currentCourse, listCourses } from './data.js';
import { useShellActions } from './actions.js';

export interface CoursePickerModalProps {
  isActive: boolean;
  onClose: () => void;
}

const ALL = '\u0000all';
const NEW = '\u0000new';

export const CoursePickerModal = memo(function CoursePickerModal({ isActive, onClose }: CoursePickerModalProps) {
  const theme = useTheme();
  const actions = useShellActions();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const snapshot = useTuiStore((s) => s.snapshot);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const current = currentCourse(snapshot);

  const options = useMemo<SelectOption<string>[]>(() => {
    const courses = listCourses(snapshot);
    const ell = asciiMode ? '...' : '…';
    return [
      { value: ALL, label: t(lang, '全部课程', 'All courses'), icon: asciiMode ? 'o' : '◎', hint: t(lang, '不限定课程', 'No focus') },
      ...courses.map((c) => ({
        value: c.key,
        label: c.label,
        icon: asciiMode ? '*' : '◆',
        hint: c.deckCount ? t(lang, `${c.deckCount} 个题组`, `${c.deckCount} decks`) : undefined,
        badge: c.dueCount ? c.dueCount : undefined,
        badgeTone: 'warning' as const,
      })),
      { value: NEW, label: t(lang, `新建课程${ell}`, `New course${ell}`), icon: asciiMode ? '+' : '＋' },
    ];
  }, [snapshot, lang, asciiMode]);

  const width = 60;
  return (
    <Modal
      title={t(lang, '切换课程', 'Switch Course')}
      icon={asciiMode ? 'o' : '◎'}
      subtitle={current ?? t(lang, '全部课程', 'All courses')}
      width={width}
      onClose={creating ? () => setCreating(false) : onClose}
      isActive={isActive && !creating}
      hints={
        creating
          ? [
              { key: 'Enter', label: t(lang, '创建', 'Create') },
              { key: 'Esc', label: t(lang, '返回', 'Back') },
            ]
          : [
              { key: asciiMode ? 'Up/Dn 1-9' : '↑↓ 1-9', label: t(lang, '选择', 'Select') },
              { key: 'Enter', label: t(lang, '切换', 'Switch') },
              { key: 'Esc', label: t(lang, '关闭', 'Close') },
            ]
      }
    >
      {creating ? (
        <Box flexDirection="column" marginY={1}>
          <Text color={theme.muted}>{t(lang, '课程名称', 'Course name')}</Text>
          <Box borderStyle={asciiMode ? 'classic' : 'round'} borderColor={theme.borderActive} paddingX={1}>
            <TextInput
              value={name}
              onChange={setName}
              isActive={isActive && creating}
              width={width - 12}
              placeholder={t(lang, '例如：线性代数', 'e.g. Linear Algebra')}
              onCancel={() => setCreating(false)}
              onSubmit={(v) => {
                if (!v.trim()) return;
                setCreating(false);
                setName('');
                onClose();
                void actions.createCourse(v);
              }}
            />
          </Box>
        </Box>
      ) : (
        <Box marginY={1}>
          <SelectList
            options={options}
            isActive={isActive && !creating}
            width={width - 6}
            maxHeight={12}
            currentValue={current ?? ALL}
            initialIndex={Math.max(0, options.findIndex((o) => o.value === (current ?? ALL)))}
            onSelect={(opt) => {
              if (opt.value === NEW) {
                setCreating(true);
                return;
              }
              onClose();
              void actions.setCourse(opt.value === ALL ? null : opt.value);
            }}
          />
        </Box>
      )}
    </Modal>
  );
});
