import React from 'react';
import { Box, Text } from 'ink';
import { KeyScope } from '../../input/hooks.js';
import type { UiLanguage } from '../../types/contracts.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge } from '../../components/Badge.js';
import { SectionHeader, computeProseLayout } from '../../layout/index.js';
import { TextInput } from '../../components/TextInput.js';
import { ClickableBox } from '../../components/mouse.js';
import { truncateDisplay } from '../../render/cjk.js';
import type {
  CardFeedbackShape,
  NormalizedKind,
  CardOptionItem,
  CardSolutionShape,
  CardTranslation,
  ClozeBlankItem,
} from './review-helpers.js';

export interface ReviewAnswerInputProps {
  kind: NormalizedKind;
  isRubricEligibleKind: boolean;
  options: readonly CardOptionItem[];
  clozeData: { text: string; blanks: ClozeBlankItem[] } | null;
  feedback: CardFeedbackShape | null;
  solution: CardSolutionShape | null;
  revealed: boolean;
  activeTranslation: CardTranslation | null;
  cursorOpt: number;
  selectedIds: string[];
  clozeInputs: Record<string, string>;
  activeBlankIdx: number;
  clozeEditing: boolean;
  openDraft: string;
  openEditing: boolean;
  innerW: number;
  isActive: boolean;
  cardScopeActive: boolean;
  lang: UiLanguage;
  asciiMode: boolean;
  setCursorOpt: React.Dispatch<React.SetStateAction<number>>;
  setSelectedIds: React.Dispatch<React.SetStateAction<string[]>>;
  setClozeInputs: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  setActiveBlankIdx: React.Dispatch<React.SetStateAction<number>>;
  setClozeEditing: React.Dispatch<React.SetStateAction<boolean>>;
  setOpenDraft: React.Dispatch<React.SetStateAction<string>>;
  setOpenEditing: React.Dispatch<React.SetStateAction<boolean>>;
  onSubmitChoice: (ids: string[]) => void;
  onSubmitCloze: (vals: Record<string, string>) => void;
  onReveal: () => void;
  onScheduleDraftSave: (patch: { text?: string; stepInputs?: Record<string, string>; selected?: string[] }) => void;
}

export function ReviewAnswerInput({
  kind,
  isRubricEligibleKind,
  options,
  clozeData,
  feedback,
  solution,
  revealed,
  activeTranslation,
  cursorOpt,
  selectedIds,
  clozeInputs,
  activeBlankIdx,
  clozeEditing,
  openDraft,
  openEditing,
  innerW,
  isActive,
  cardScopeActive,
  lang,
  asciiMode,
  setCursorOpt,
  setSelectedIds,
  setClozeInputs,
  setActiveBlankIdx,
  setClozeEditing,
  setOpenDraft,
  setOpenEditing,
  onSubmitChoice,
  onSubmitCloze,
  onReveal,
  onScheduleDraftSave,
}: ReviewAnswerInputProps) {
  const theme = useTheme();

  if ((kind === 'single' || kind === 'multiple' || kind === 'true_false') && options.length > 0) {
    return (
      <Box flexDirection="column" marginTop={1} width={innerW}>
        {options.map((opt, idx) => {
          const activeIds = feedback?.selected ?? selectedIds;
          const isSelected = activeIds.includes(opt.id);
          const isCursor = !feedback && idx === cursorOpt;
          const solOpt = solution?.options?.find((o) => o.id === opt.id);
          const isCorrectOpt = Boolean(solOpt?.correct);

          let mark =
            kind === 'multiple'
              ? isSelected
                ? asciiMode
                  ? '[x]'
                  : '[✓]'
                : '[ ]'
              : isSelected
                ? asciiMode
                  ? '(*)'
                  : '(●)'
                : '( )';
          let lineColor = isCursor ? theme.primary : isSelected ? theme.accent : theme.text;
          if (feedback) {
            if (isCorrectOpt) {
              mark = asciiMode ? '+' : '✓';
              lineColor = theme.success;
            } else if (isSelected && !isCorrectOpt) {
              mark = asciiMode ? 'x' : '✕';
              lineColor = theme.error;
            } else {
              mark = asciiMode ? '.' : '·';
              lineColor = theme.muted;
            }
          }
          const keyTag =
            kind === 'true_false' ? (idx === 0 ? '[1]' : '[2]') : `[${idx + 1}/${String.fromCharCode(97 + idx)}]`;
          const trOptText = activeTranslation?.options?.find((o) => o.id === opt.id)?.text;
          const onClickOption = () => {
            if (!cardScopeActive || feedback) return;
            setCursorOpt(idx);
            if (kind === 'multiple') {
              setSelectedIds((prev) => (prev.includes(opt.id) ? prev.filter((x) => x !== opt.id) : [...prev, opt.id]));
            } else {
              setSelectedIds([opt.id]);
              onSubmitChoice([opt.id]);
            }
          };
          return (
            <ClickableBox
              key={opt.id}
              flexDirection="column"
              width={innerW}
              clickActive={cardScopeActive && !feedback}
              onClick={onClickOption}
            >
              <Box flexDirection="row" width={innerW}>
                <Text color={isCursor ? theme.primary : theme.dim} bold={isCursor}>
                  {isCursor ? (asciiMode ? '> ' : '▸ ') : '  '}
                </Text>
                <Text color={theme.muted}>{`${keyTag} `}</Text>
                <Text color={lineColor} bold={isSelected || isCorrectOpt || isCursor}>
                  {`${mark} ${opt.text}`}
                </Text>
              </Box>
              {trOptText ? <Text color={theme.muted}>{`      EN: ${trOptText}`}</Text> : null}
            </ClickableBox>
          );
        })}
        {kind === 'multiple' && !feedback ? (
          <ClickableBox
            clickActive={cardScopeActive && selectedIds.length > 0}
            onClick={() => {
              if (selectedIds.length > 0) onSubmitChoice(selectedIds);
            }}
          >
            <Text color={theme.dim}>
              {cardScopeActive
                ? t(lang, '  提示: 1-6/Space 勾选多选，Enter 提交答案', '  Hint: 1-6/Space to toggle, Enter to submit')
                : t(lang, '  提示: 按 Esc 返回题卡后选择并提交', '  Hint: Press Esc to return to card to submit')}
            </Text>
          </ClickableBox>
        ) : null}
      </Box>
    );
  }

  if (kind === 'fill_blank' && clozeData && !feedback) {
    return (
      <Box flexDirection="column" marginTop={1} width={innerW}>
        {clozeData.blanks.length > 1 ? (
          <Box flexDirection="row" alignItems="center" gap={1} marginBottom={0} width={innerW} overflow="hidden">
            <Badge
              label={`${Math.min(activeBlankIdx, Math.max(0, clozeData.blanks.length - 1)) + 1}/${clozeData.blanks.length}`}
              tone={clozeEditing ? 'primary' : 'neutral'}
              variant="outline"
            />
            <Text color={theme.dim} wrap="truncate">
              {truncateDisplay(
                clozeEditing
                  ? asciiMode
                    ? t(lang, 'Tab 下一空 | Enter 下一空/提交 | Esc 退出', 'Tab next blank | Enter next/submit | Esc blur')
                    : t(lang, 'Tab 下一空 · Enter 下一空/提交 · Esc 退出', 'Tab next blank · Enter next/submit · Esc blur')
                  : cardScopeActive
                    ? t(lang, '按 [i] 或 [Enter] 开始填空', 'Press [i] or [Enter] to fill blanks')
                    : t(lang, '按 [Esc] 返回题卡后开始填空', 'Press [Esc] to return to card to fill blanks'),
                Math.max(10, innerW - 10),
                asciiMode ? '...' : '…',
              )}
            </Text>
          </Box>
        ) : null}
        {clozeData.blanks.map((blank, idx) => {
          const safeIdx = Math.min(activeBlankIdx, Math.max(0, clozeData.blanks.length - 1));
          const isThisActive = clozeEditing && idx === safeIdx;
          return (
            <Box
              key={blank.id}
              flexDirection="row"
              borderStyle={asciiMode ? 'classic' : 'single'}
              borderColor={isThisActive ? theme.primary : theme.border}
              paddingX={1}
              width={Math.min(innerW, 64)}
            >
              <Text color={theme.muted}>{`#${idx + 1} `}</Text>
              <KeyScope id={`review:cloze-${blank.id}`} opaque active={isActive && isThisActive}>
                <TextInput
                  value={clozeInputs[blank.id] ?? ''}
                  onChange={(val) => {
                    const next = { ...clozeInputs, [blank.id]: val };
                    setClozeInputs(next);
                    onScheduleDraftSave({ stepInputs: next });
                  }}
                  isActive={isActive && isThisActive}
                  width={Math.max(12, Math.min(innerW, 64) - 10)}
                  placeholder={t(
                    lang,
                    '输入答案 (Enter 下一空/提交, Esc 退出)',
                    'Type answer (Enter next/submit, Esc blur)',
                  )}
                  onTab={() => {
                    setActiveBlankIdx((idx + 1) % clozeData.blanks.length);
                    return undefined;
                  }}
                  onSubmit={(val) => {
                    const updated = { ...clozeInputs, [blank.id]: val };
                    setClozeInputs(updated);
                    if (idx + 1 < clozeData.blanks.length) {
                      setActiveBlankIdx(idx + 1);
                    } else {
                      setClozeEditing(false);
                      onSubmitCloze(updated);
                    }
                  }}
                  onCancel={() => setClozeEditing(false)}
                />
              </KeyScope>
            </Box>
          );
        })}
      </Box>
    );
  }

  if (isRubricEligibleKind && !revealed) {
    return (
      <Box flexDirection="column" marginTop={1} width={innerW}>
        <SectionHeader
          title={
            !cardScopeActive
              ? t(lang, '你的作答（按 [Esc] 返回题卡后编辑或翻看）:', 'Your answer (press [Esc] to return to card):')
              : openDraft.trim()
                ? t(
                    lang,
                    '你的作答（[i] 编辑，Enter 翻看，[G] AI 按标准评分，[Space] 翻看）:',
                    'Your answer ([i] edit, Enter reveal, [G] AI rubric grade, [Space] reveal):',
                  )
                : t(
                    lang,
                    '你的作答（按 [i] 输入，Enter 翻看答案；或按 [Space] 直接翻看）:',
                    'Your answer ([i] to type, Enter to reveal; or [Space] to reveal):',
                  )
          }
          width={innerW}
          ascii={asciiMode}
          focused={openEditing}
        />
        <Box paddingX={1} width={innerW}>
          <KeyScope id="review:open-input" opaque active={isActive && openEditing}>
            <TextInput
              value={openDraft}
              onChange={(val) => {
                setOpenDraft(val);
                onScheduleDraftSave({ text: val });
              }}
              isActive={isActive && openEditing}
              width={Math.max(16, innerW - 4)}
              placeholder={
                asciiMode
                  ? t(lang, '输入你的思路或简答...', 'Type your answer or key points...')
                  : t(lang, '输入你的思路或简答…', 'Type your answer or key points…')
              }
              onSubmit={() => {
                setOpenEditing(false);
                onReveal();
              }}
              onCancel={() => setOpenEditing(false)}
            />
          </KeyScope>
        </Box>
      </Box>
    );
  }

  if (kind === 'flashcard' && !isRubricEligibleKind && !revealed) {
    return (
      <ClickableBox
        marginTop={1}
        marginLeft={computeProseLayout(innerW).marginLeft}
        clickActive={cardScopeActive}
        onClick={() => onReveal()}
      >
        <Badge
          label={
            cardScopeActive
              ? t(lang, '按 [Space] 或 [Enter] 翻开答案', 'Press [Space] or [Enter] to flip card')
              : t(lang, '按 [Esc] 返回题卡后翻开答案', 'Press [Esc] to return to card and flip')
          }
          tone={cardScopeActive ? 'primary' : 'muted'}
          variant="soft"
        />
      </ClickableBox>
    );
  }

  return null;
}
