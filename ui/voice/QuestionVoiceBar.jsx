import React from 'react';
import { ui } from '../i18n.js';
import { Button, InlineMessage, Spinner } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import MicButton from './MicButton.jsx';

/**
 * Voice answer action bar + status notes for cloze / open / flashcard cards in QuestionRun.
 * Kept in its own module so QuestionRun stays concise.
 */
export default function QuestionVoiceBar({
  voiceRef,
  mode,
  gradeTask,
  onVoiceSubmit,
  typedResponse = '',
  onGradeTyped,
  onSubmitCloze,
  canSubmitCloze = false,
}) {
  const { busy } = useStudy();
  const running = gradeTask?.status === 'running';
  const isCloze = mode === 'cloze';
  const label = isCloze ? '口述填空 (V)' : '语音作答 (V)';
  const hint = isCloze
    ? ui('一口气口述各空答案（如「第1空…第2空…」），快捷键 V')
    : ui('直接用语音口述本题思路或答案，AI 将严格评估并给出表达订正（快捷键 V）');

  return (
    <>
      <div className="voice-controls">
        {isCloze && (
          <Button
            variant="primary"
            className="submit-answer"
            data-usage="review.submit"
            disabled={!canSubmitCloze}
            lock={busy}
            onClick={onSubmitCloze}
          >
            {ui('提交答案')}
          </Button>
        )}
        {onVoiceSubmit && (
          <MicButton
            ref={voiceRef}
            label={label}
            hint={hint}
            disabled={busy || running}
            onRecorded={onVoiceSubmit}
          />
        )}
        {!isCloze && onGradeTyped && typedResponse.trim() && (
          <Button
            size="sm"
            variant="secondary"
            icon="sparkle"
            busy={running}
            busyLabel={ui('正在批改…')}
            lock={busy}
            onClick={onGradeTyped}
          >
            {ui('提交 AI 批改')}
          </Button>
        )}
      </div>
      {running && (
        <p className="assist-status" role="status">
          <Spinner size="sm" />
          {isCloze ? ui('正在转写并核对你的口述填空…') : ui('正在转写并评估你的回答，完成后将自动生成评分与订正…')}
        </p>
      )}
      {gradeTask?.status === 'failed' && (
        <InlineMessage tone="error">
          {gradeTask.message || (isCloze ? ui('语音批改没有完成，可以重录或手填提交。') : ui('语音评估没有完成，可以重录或自行翻卡评估。'))}
        </InlineMessage>
      )}
    </>
  );
}
