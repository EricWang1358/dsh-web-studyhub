import React, { Suspense, lazy } from 'react';
import { Box, Text } from 'ink';
import { KeyScope } from '../../input/hooks.js';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import type { ReviewRun } from '../../host/sample-actions.js';
import { t } from '../../state/store.js';
import { useTheme } from '../../theme/tokens.js';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { Modal } from '../../components/Modal.js';
import { TextInput } from '../../components/TextInput.js';
import type { AiTurn, CardFeedbackShape, NormalizedKind } from './review-helpers.js';
import type { SavedFollowupItem } from './AiHelpDrawer.js';
import type { CoachNudgeNote } from './CoachNudgeModal.js';
import { GradeAdjustModal } from './GradeAdjustModal.js';

const AiHelpDrawer = lazy(() => import('./AiHelpDrawer.js').then((m) => ({ default: m.AiHelpDrawer })));
const AnswerCardModal = lazy(() => import('./AnswerCardModal.js').then((m) => ({ default: m.AnswerCardModal })));
const CardToolsModal = lazy(() => import('./CardToolsModal.js').then((m) => ({ default: m.CardToolsModal })));
const CoachNudgeModal = lazy(() => import('./CoachNudgeModal.js').then((m) => ({ default: m.CoachNudgeModal })));
const QueueModal = lazy(() => import('./QueueModal.js').then((m) => ({ default: m.QueueModal })));
const RetellModal = lazy(() => import('./RetellModal.js').then((m) => ({ default: m.RetellModal })));
const SimilarCardsModal = lazy(() => import('./SimilarCardsModal.js').then((m) => ({ default: m.SimilarCardsModal })));

export interface ReviewOverlaysProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string | null;
  kind: NormalizedKind;
  userAnswerText: string;
  width: number;
  height: number;
  aiPaneW: number;
  isActive: boolean;
  lang: UiLanguage;
  asciiMode: boolean;
  mathUnicode: boolean;
  busy: boolean;
  busyRef: React.RefObject<boolean>;
  feedback: CardFeedbackShape | null;
  answeredCount: number;
  totalCount: number;
  canAdjustGrade: boolean;
  canCoachNudge: boolean;
  aiDrawerOpen: boolean;
  retellModalOpen: boolean;
  similarModalOpen: boolean;
  cardToolsModalOpen: boolean;
  queueModalOpen: boolean;
  answerCardModalOpen: boolean;
  nudgeModalOpen: boolean;
  flagModalOpen: boolean;
  flagReason: string;
  gradeAdjustModalOpen: boolean;
  confirmEndOpen: boolean;
  aiHistoryByCard: Record<string, AiTurn[]>;
  savedFollowupsByCard: Record<string, SavedFollowupItem[]>;
  initialNudgeNote: CoachNudgeNote | null;
  onAiHistoryChange: (cardId: string, nextTurns: AiTurn[]) => void;
  onSavedFollowup: (cardId: string, item: SavedFollowupItem) => void;
  onCloseAiDrawer: () => void;
  onCloseRetell: () => void;
  onNavigateToSource: (loc: { sourceId: string; pageNumber?: number }) => void;
  onCloseSimilar: () => void;
  onStartSimilarRun: (nextRun: ReviewRun) => void;
  onCloseCardTools: () => void;
  onRunUpdated: (nextRun: ReviewRun) => void;
  onCardEdited: (editedId: string) => void;
  onFocusChanged: (cid: string, focused: boolean) => void;
  onRefreshSnapshot: () => void;
  onCloseQueue: () => void;
  onCloseAnswerCard: () => void;
  onNudgeNoteUpdate: (note: CoachNudgeNote) => void;
  onCloseNudge: () => void;
  onFlagReasonChange: (value: string) => void;
  onSubmitFlag: () => void;
  onCloseFlag: () => void;
  onSelectGradeAdjust: (grade: number) => void;
  onCloseGradeAdjust: () => void;
  onConfirmEndRound: () => void;
  onCancelEndRound: () => void;
}

export function ReviewOverlays({
  host,
  run,
  cardId,
  kind,
  userAnswerText,
  width,
  height,
  aiPaneW,
  isActive,
  lang,
  asciiMode,
  mathUnicode,
  busy,
  busyRef,
  feedback,
  answeredCount,
  totalCount,
  canAdjustGrade,
  canCoachNudge,
  aiDrawerOpen,
  retellModalOpen,
  similarModalOpen,
  cardToolsModalOpen,
  queueModalOpen,
  answerCardModalOpen,
  nudgeModalOpen,
  flagModalOpen,
  flagReason,
  gradeAdjustModalOpen,
  confirmEndOpen,
  aiHistoryByCard,
  savedFollowupsByCard,
  initialNudgeNote,
  onAiHistoryChange,
  onSavedFollowup,
  onCloseAiDrawer,
  onCloseRetell,
  onNavigateToSource,
  onCloseSimilar,
  onStartSimilarRun,
  onCloseCardTools,
  onRunUpdated,
  onCardEdited,
  onFocusChanged,
  onRefreshSnapshot,
  onCloseQueue,
  onCloseAnswerCard,
  onNudgeNoteUpdate,
  onCloseNudge,
  onFlagReasonChange,
  onSubmitFlag,
  onCloseFlag,
  onSelectGradeAdjust,
  onCloseGradeAdjust,
  onConfirmEndRound,
  onCancelEndRound,
}: ReviewOverlaysProps) {
  const theme = useTheme();

  return (
    <>
      {aiDrawerOpen && cardId ? (
        <KeyScope id="review:ai-drawer" opaque>
          <Suspense fallback={null}>
            <AiHelpDrawer
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              userAnswer={userAnswerText}
              width={aiPaneW}
              height={height}
              isActive={isActive}
              mathUnicode={mathUnicode}
              history={aiHistoryByCard[cardId]}
              onHistoryChange={onAiHistoryChange}
              extraSavedFollowups={savedFollowupsByCard[cardId]}
              onSavedFollowup={onSavedFollowup}
              onClose={onCloseAiDrawer}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {retellModalOpen && cardId ? (
        <KeyScope id="review:retell" opaque>
          <Suspense fallback={null}>
            <RetellModal
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              width={width}
              height={height}
              isActive={isActive}
              mathUnicode={mathUnicode}
              onClose={onCloseRetell}
              onNavigateToSource={onNavigateToSource}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {similarModalOpen && cardId ? (
        <KeyScope id="review:similar" opaque>
          <Suspense fallback={null}>
            <SimilarCardsModal
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              width={width}
              height={height}
              isActive={isActive}
              mathUnicode={mathUnicode}
              onClose={onCloseSimilar}
              onStartRun={onStartSimilarRun}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {cardToolsModalOpen && cardId ? (
        <KeyScope id="review:card-tools" opaque>
          <Suspense fallback={null}>
            <CardToolsModal
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              width={width}
              height={height}
              isActive={isActive}
              onClose={onCloseCardTools}
              onRunUpdated={onRunUpdated}
              onCardEdited={onCardEdited}
              onFocusChanged={onFocusChanged}
              onRefreshSnapshot={onRefreshSnapshot}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {queueModalOpen && run.mode !== 'exam' ? (
        <KeyScope id="review:queue" opaque>
          <Suspense fallback={null}>
            <QueueModal
              host={host}
              run={run}
              width={width}
              height={height}
              isActive={isActive}
              onClose={onCloseQueue}
              onRunUpdated={onRunUpdated}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {answerCardModalOpen && cardId ? (
        <KeyScope id="review:answer-card" opaque>
          <Suspense fallback={null}>
            <AnswerCardModal
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              width={width}
              height={height}
              isActive={isActive}
              mathUnicode={mathUnicode}
              onClose={onCloseAnswerCard}
              onRunUpdated={onRunUpdated}
              onRefreshSnapshot={onRefreshSnapshot}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {nudgeModalOpen && cardId && canCoachNudge ? (
        <KeyScope id="review:nudge" opaque>
          <Suspense fallback={null}>
            <CoachNudgeModal
              host={host}
              run={run}
              cardId={cardId}
              width={width}
              height={height}
              isActive={isActive}
              initialNote={initialNudgeNote}
              onNoteUpdate={onNudgeNoteUpdate}
              onClose={onCloseNudge}
            />
          </Suspense>
        </KeyScope>
      ) : null}

      {flagModalOpen ? (
        <KeyScope id="review:flag" opaque>
          <Modal
            title={t(lang, '标记当前题目', 'Flag Current Card')}
            icon={asciiMode ? '!' : '⚑'}
            tone="warning"
            isActive={isActive}
            onClose={onCloseFlag}
            hints={[
              { key: 'Enter', label: t(lang, '提交标记', 'Submit') },
              { key: 'Esc', label: t(lang, '取消', 'Cancel') },
            ]}
          >
            <Text color={theme.muted}>
              {t(
                lang,
                '输入问题标记说明（如：答案有误、解析不清、需重点复习）：',
                'Enter a reason (e.g. unclear stem, wrong key, review later):',
              )}
            </Text>
            <Box borderStyle={asciiMode ? 'classic' : 'single'} borderColor={theme.primary} paddingX={1} marginTop={1}>
              <TextInput
                value={flagReason}
                onChange={onFlagReasonChange}
                isActive={isActive}
                width={54}
                placeholder={asciiMode ? t(lang, '输入标记原因...', 'Reason...') : t(lang, '输入标记原因…', 'Reason…')}
                onSubmit={onSubmitFlag}
                onCancel={onCloseFlag}
              />
            </Box>
          </Modal>
        </KeyScope>
      ) : null}

      {gradeAdjustModalOpen && canAdjustGrade ? (
        <KeyScope id="review:grade-adjust" opaque>
          <GradeAdjustModal
            lang={lang}
            asciiMode={asciiMode}
            width={width}
            currentGrade={typeof feedback?.grade === 'number' ? feedback.grade : undefined}
            originalGrade={typeof feedback?.gradeOriginal === 'number' ? feedback.gradeOriginal : undefined}
            busy={busy}
            isActive={isActive}
            onSelect={onSelectGradeAdjust}
            onClose={() => {
              if (!busyRef.current) onCloseGradeAdjust();
            }}
          />
        </KeyScope>
      ) : null}

      {confirmEndOpen ? (
        <KeyScope id="review:confirm-end" opaque>
          <ConfirmDialog
            title={t(lang, '结束本轮练习', 'End This Round')}
            message={t(
              lang,
              `当前已作答 ${answeredCount}/${totalCount} 题。结束后本轮不可恢复，将直接进入本轮总结；如需暂离请按 [1] 返回学习库（保留进度）。`,
              `Answered ${answeredCount}/${totalCount}. Ending closes this round permanently; press [1] to return to Library and keep progress.`,
            )}
            confirmLabel={t(lang, '结束本轮', 'End Round')}
            cancelLabel={t(lang, '继续练习', 'Keep Going')}
            danger
            isActive={isActive}
            onConfirm={onConfirmEndRound}
            onCancel={onCancelEndRound}
          />
        </KeyScope>
      ) : null}
    </>
  );
}
