import React, { Suspense, lazy } from 'react';
import { Box } from 'ink';
import type { HostClient, UiLanguage } from '../../types/contracts.js';
import type { ReviewRun } from '../../host/sample-actions.js';
import type { PracticeContextFrame } from '../../state/practice-stack.js';
import { t } from '../../state/store.js';
import { EmptyState, Spinner } from '../../components/Badge.js';
import { Panel } from '../../components/Panel.js';

const RoundSummary = lazy(() => import('./RoundSummary.js').then((m) => ({ default: m.RoundSummary })));

export interface ReviewEmptyStatesProps {
  loading: boolean;
  endedRestoreFrame: PracticeContextFrame | null;
  run: ReviewRun | null;
  isFinished: boolean;
  loadError: string | null;
  host: HostClient;
  width: number;
  height: number;
  isActive: boolean;
  lang: UiLanguage;
  asciiMode: boolean;
  mathUnicode: boolean;
  onPracticeWeak: () => void;
  onNewRound: () => void;
  onGoLibrary: () => void;
}

export function ReviewEmptyStates({
  loading,
  endedRestoreFrame,
  run,
  isFinished,
  loadError,
  host,
  width,
  height,
  isActive,
  lang,
  asciiMode,
  mathUnicode,
  onPracticeWeak,
  onNewRound,
  onGoLibrary,
}: ReviewEmptyStatesProps) {
  if (loading) {
    return (
      <Box width={width} height={height} alignItems="center" justifyContent="center">
        <Spinner
          label={
            asciiMode
              ? t(lang, '正在准备复习队列...', 'Preparing review queue...')
              : t(lang, '正在准备复习队列…', 'Preparing review queue…')
          }
          active={isActive}
        />
      </Box>
    );
  }

  if (endedRestoreFrame) {
    const qNum = (endedRestoreFrame.cardIndex ?? 0) + 1;
    return (
      <Panel
        title={t(lang, '原题所在练习已结束', 'Original Practice Round Ended')}
        icon={asciiMode ? '!' : '⚠'}
        tone="warning"
        width={width}
        height={height}
      >
        <EmptyState
          icon={asciiMode ? '!' : '⚠'}
          title={t(lang, `原题所在练习已结束（第 ${qNum} 题）`, `Original practice round ended (Question #${qNum})`)}
          hint={
            endedRestoreFrame.promptPreview
              ? `${t(lang, '原题预览', 'Card')}: ${endedRestoreFrame.promptPreview}`
              : t(lang, '你可以重新练习这道原题，或返回学习库。', 'You can practice this card again or return to Library.')
          }
          actions={[
            { key: 'R', label: t(lang, '重新练这道题', 'Practice This Card Again') },
            { key: 'Esc', label: t(lang, '返回学习库', 'Back to Library') },
          ]}
          width={Math.max(20, width - 4)}
          height={Math.max(6, height - 4)}
        />
      </Panel>
    );
  }

  if (!run) {
    return (
      <Panel title={t(lang, '刷题复习', 'Review')} icon={asciiMode ? '>' : '▶'} width={width} height={height}>
        <EmptyState
          icon={asciiMode ? '*' : '✦'}
          title={t(lang, '当前没有待复习题目', 'No questions due for review')}
          hint={
            loadError ||
            t(lang, '可以先去学习库挑选一个题组，或导入新资料生成题目。', 'Pick a deck in Library or generate cards from Sources.')
          }
          actions={[
            { key: 'L', label: t(lang, '返回学习库', 'Go to Library') },
            { key: 'R', label: t(lang, '重新加载', 'Reload') },
          ]}
          width={Math.max(20, width - 4)}
          height={Math.max(6, height - 4)}
        />
      </Panel>
    );
  }

  if (isFinished) {
    return (
      <Suspense
        fallback={
          <Box paddingX={1} paddingY={1}>
            <Spinner
              label={t(
                lang,
                asciiMode ? '正在载入总结...' : '正在载入总结…',
                asciiMode ? 'Loading summary...' : 'Loading summary…',
              )}
              active={isActive}
            />
          </Box>
        }
      >
        <RoundSummary
          host={host}
          run={run}
          width={width}
          height={height}
          isActive={isActive}
          mathUnicode={mathUnicode}
          onPracticeWeak={onPracticeWeak}
          onNewRound={onNewRound}
          onGoLibrary={onGoLibrary}
        />
      </Suspense>
    );
  }

  return null;
}
