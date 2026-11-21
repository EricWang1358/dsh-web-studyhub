import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { UiLanguage } from '../../types/contracts.js';
import {
  Badge,
  ConfirmDialog,
  MarkdownView,
  Panel,
  Spinner,
  TextInput,
  useClaimKeys,
  useTheme,
} from '../../components/index.js';
import { truncateDisplay } from '../../render/index.js';
import { t } from '../../state/store.js';
import type { ExamCard, OralView, RunView } from './types.js';
import { computeRemainingMs, formatDurationMs } from './utils.js';

export interface ExamRunnerProps {
  kind: 'written' | 'case' | 'oral';
  run: RunView | null;
  oral: OralView | null;
  width: number;
  height: number;
  lang: UiLanguage;
  isActive: boolean;
  busy: boolean;
  error: string | null;
  onSelectPick: (cardId: string, selected: string[]) => void;
  onSaveCaseResponse: (cardId: string, text: string) => void;
  onJumpWritten: (index: number) => void;
  onSubmitWritten: (caseResponses?: Record<string, string>) => void;
  onSaveOralAnswer: (cardId: string, answer: string, field: 'main' | 'followup') => void;
  onOralFollowup: (cardId: string) => void;
  onOralNext: () => void;
  onSubmitOral: () => void;
  onAbortBack: () => void;
}

const RUNNER_CLAIMED = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'n', 'a', 'r', 'b'];

export const ExamRunner = memo(function ExamRunner({
  kind,
  run,
  oral,
  width,
  height,
  lang,
  isActive,
  busy,
  error,
  onSelectPick,
  onSaveCaseResponse,
  onJumpWritten,
  onSubmitWritten,
  onSaveOralAnswer,
  onOralFollowup,
  onOralNext,
  onSubmitOral,
  onAbortBack,
}: ExamRunnerProps) {
  const theme = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const [flagged, setFlagged] = useState<Set<string>>(() => new Set());
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [editingField, setEditingField] = useState<'none' | 'case' | 'oral-main' | 'oral-followup'>('none');
  const [draftText, setDraftText] = useState('');
  const [caseIdx, setCaseIdx] = useState(0);
  const [caseDrafts, setCaseDrafts] = useState<Record<string, string>>({});
  const autoSubmittedRef = useRef(false);

  // Sync case drafts when run opens / changes
  useEffect(() => {
    autoSubmittedRef.current = false;
    setFlagged(new Set());
    setConfirmSubmit(false);
    setEditingField('none');
    setCaseIdx(0);
    if (run?.examKinds === 'case' && Array.isArray(run.responses)) {
      const map: Record<string, string> = {};
      for (const r of run.responses) map[r.cardId] = r.response || '';
      setCaseDrafts(map);
    } else {
      setCaseDrafts({});
    }
  }, [run?.id, oral?.id]);

  // Sync oral text buffer when question changes
  useEffect(() => {
    if (kind !== 'oral' || !oral?.entry) return;
    if (editingField === 'none') {
      setDraftText(oral.entry.answer || '');
    }
  }, [kind, oral?.index, oral?.entry?.cardId]);

  // Countdown / elapsed timer — cleanly cleared on unmount!
  useEffect(() => {
    if (!isActive) return undefined;
    const id = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(id);
  }, [isActive]);

  const remainingMs = useMemo(
    () => (kind === 'oral' ? null : computeRemainingMs(run, now)),
    [kind, run, now],
  );
  const elapsedMs = useMemo(() => {
    const started = kind === 'oral' ? oral?.startedAt : run?.startedAt;
    const ms = started ? Date.parse(started) : NaN;
    return Number.isFinite(ms) ? Math.max(0, now - ms) : 0;
  }, [kind, oral?.startedAt, run?.startedAt, now]);

  // Auto-submit when written/case timer expires
  useEffect(() => {
    if (kind === 'oral' || !run || busy || autoSubmittedRef.current) return;
    if (remainingMs !== null && remainingMs <= 0) {
      autoSubmittedRef.current = true;
      onSubmitWritten(kind === 'case' ? caseDrafts : undefined);
    }
  }, [kind, run, remainingMs, busy, caseDrafts, onSubmitWritten]);

  const caseCards: ExamCard[] = useMemo(
    () => (kind === 'case' ? (run?.paperCards ?? (run?.card ? [run.card] : [])) : []),
    [kind, run?.paperCards, run?.card],
  );
  const safeCaseIdx = Math.max(0, Math.min(caseIdx, Math.max(0, caseCards.length - 1)));
  const currentCaseCard = caseCards[safeCaseIdx] ?? null;

  const currentWrittenCard = kind === 'written' ? run?.card ?? null : null;
  const totalCount =
    kind === 'oral'
      ? (oral?.total ?? 0)
      : kind === 'case'
        ? caseCards.length
        : (run?.total ?? run?.picks?.length ?? 0);
  const currentIdx =
    kind === 'oral' ? (oral?.index ?? 0) : kind === 'case' ? safeCaseIdx : (run?.index ?? 0);

  // Selected picks map for written MCQ
  const picksMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const p of run?.picks ?? []) {
      if (p.cardId && Array.isArray(p.selected) && p.selected.length > 0) {
        map.set(p.cardId, p.selected);
      }
    }
    return map;
  }, [run?.picks]);

  const currentSelected = currentWrittenCard ? (picksMap.get(currentWrittenCard.id) ?? []) : [];

  const isTyping = editingField !== 'none';
  useClaimKeys(RUNNER_CLAIMED, isActive && !isTyping && !confirmSubmit);

  useInput(
    (input, key) => {
      if (confirmSubmit || isTyping) return;
      if (key.ctrl && input === 's') {
        setConfirmSubmit(true);
        return;
      }
      if (busy) return;

      if (kind === 'written' && run && currentWrittenCard) {
        const opts = currentWrittenCard.options ?? [];
        const isMulti = Boolean(currentWrittenCard.multiple || currentWrittenCard.kind === 'multi');
        // Digit keys 1..9 toggle/select options
        if (/^[1-9]$/.test(input)) {
          const idx = Number(input) - 1;
          const opt = opts[idx];
          if (!opt) return;
          if (isMulti) {
            const exists = currentSelected.includes(opt.id);
            const next = exists
              ? currentSelected.filter((x) => x !== opt.id)
              : [...currentSelected, opt.id];
            onSelectPick(currentWrittenCard.id, next);
          } else {
            const next = currentSelected.includes(opt.id) ? [] : [opt.id];
            onSelectPick(currentWrittenCard.id, next);
          }
          return;
        }
        if (input === 'f') {
          setFlagged((prev) => {
            const next = new Set(prev);
            if (next.has(currentWrittenCard.id)) next.delete(currentWrittenCard.id);
            else next.add(currentWrittenCard.id);
            return next;
          });
          return;
        }
        if (input === 'n' || key.rightArrow || (key.tab && !key.shift)) {
          const nextIdx = (run.index + 1) % Math.max(1, totalCount);
          onJumpWritten(nextIdx);
          return;
        }
        if (input === 'p' || key.leftArrow || (key.tab && key.shift)) {
          const prevIdx = (run.index - 1 + Math.max(1, totalCount)) % Math.max(1, totalCount);
          onJumpWritten(prevIdx);
          return;
        }
        if (key.escape) {
          onAbortBack();
        }
        return;
      }

      if (kind === 'case' && currentCaseCard) {
        if (input === 'e' || key.return) {
          setDraftText(caseDrafts[currentCaseCard.id] ?? '');
          setEditingField('case');
          return;
        }
        if (input === 'f') {
          setFlagged((prev) => {
            const next = new Set(prev);
            if (next.has(currentCaseCard.id)) next.delete(currentCaseCard.id);
            else next.add(currentCaseCard.id);
            return next;
          });
          return;
        }
        if (input === 'n' || key.rightArrow || (key.tab && !key.shift)) {
          setCaseIdx((i) => (i + 1) % Math.max(1, caseCards.length));
          return;
        }
        if (input === 'p' || key.leftArrow || (key.tab && key.shift)) {
          setCaseIdx((i) => (i - 1 + Math.max(1, caseCards.length)) % Math.max(1, caseCards.length));
          return;
        }
        if (key.escape) {
          onAbortBack();
        }
        return;
      }

      if (kind === 'oral' && oral?.entry) {
        if (input === 'e' || key.return) {
          setDraftText(oral.entry.answer || '');
          setEditingField('oral-main');
          return;
        }
        if (input === 'u' && oral.entry.followup) {
          setDraftText(oral.entry.followupAnswer || '');
          setEditingField('oral-followup');
          return;
        }
        if (input === 'a' && !oral.entry.followup && oral.entry.answer.trim()) {
          onOralFollowup(oral.entry.cardId);
          return;
        }
        if (input === 'n' && oral.index < oral.total - 1) {
          onOralNext();
          return;
        }
        if (key.escape) {
          onAbortBack();
        }
      }
    },
    { isActive: isActive && !isTyping && !confirmSubmit },
  );

  // Header status
  const answeredCount =
    kind === 'oral'
      ? (oral?.answered ?? 0)
      : kind === 'case'
        ? caseCards.filter((c) => (caseDrafts[c.id] ?? '').trim().length > 0).length
        : (run?.picks ?? []).filter((p) => Array.isArray(p.selected) && p.selected.length > 0).length;

  const timerText =
    remainingMs !== null
      ? `${t(lang, '剩余', 'Left')} ${formatDurationMs(remainingMs)}`
      : `${t(lang, '用时', 'Elapsed')} ${formatDurationMs(elapsedMs)}`;
  const timerTone =
    remainingMs === null
      ? 'info'
      : remainingMs <= 60_000
        ? 'error'
        : remainingMs <= 300_000
          ? 'warning'
          : 'accent';

  const modeBadge =
    kind === 'oral'
      ? t(lang, '口试模拟', 'Oral Mock')
      : kind === 'case'
        ? t(lang, '案例卷', 'Case Paper')
        : t(lang, '选择题卷', 'Written MCQ');

  const innerW = Math.max(24, width - 4);

  // Navigator strip 1..N
  const navTokens = useMemo(() => {
    const items: Array<{ n: number; current: boolean; answered: boolean; flag: boolean }> = [];
    if (kind === 'written') {
      const picks = run?.picks ?? [];
      const count = picks.length || totalCount;
      for (let i = 0; i < count; i++) {
        const p = picks[i];
        items.push({
          n: i + 1,
          current: i === currentIdx,
          answered: Boolean(p && Array.isArray(p.selected) && p.selected.length > 0),
          flag: Boolean(p && flagged.has(p.cardId)),
        });
      }
    } else if (kind === 'case') {
      caseCards.forEach((c, i) => {
        items.push({
          n: i + 1,
          current: i === currentIdx,
          answered: Boolean((caseDrafts[c.id] ?? '').trim()),
          flag: flagged.has(c.id),
        });
      });
    } else if (oral) {
      for (let i = 0; i < oral.total; i++) {
        items.push({
          n: i + 1,
          current: i === oral.index,
          answered: i < oral.index || (i === oral.index && Boolean(oral.entry?.answer?.trim())),
          flag: false,
        });
      }
    }
    return items;
  }, [kind, run?.picks, totalCount, currentIdx, flagged, caseCards, caseDrafts, oral]);

  const bodyH = Math.max(6, height - 6);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Panel
        title={`${modeBadge} · ${currentIdx + 1}/${Math.max(1, totalCount)}`}
        subtitle={`${t(lang, '已答', 'Ans')} ${answeredCount}/${totalCount}${flagged.size ? ` · ⚑ ${flagged.size}` : ''}`}
        focused={!confirmSubmit}
        width={width}
        height={height}
      >
        <Box justifyContent="space-between" marginBottom={1}>
          <Box gap={1}>
            <Badge label={timerText} tone={timerTone} />
            {busy ? <Spinner label={t(lang, '正在处理…', 'Working…')} active={isActive} /> : null}
          </Box>
          <Text color={theme.muted}>
            {kind === 'oral'
              ? t(lang, 'e 作答 · a 追问 · n 下一题 · Ctrl+S 交卷', 'e Answer · a Follow-up · n Next · Ctrl+S Submit')
              : kind === 'case'
                ? t(lang, 'e 作答 · f 标记 · n/p 切题 · Ctrl+S 交卷', 'e Answer · f Flag · n/p Move · Ctrl+S Submit')
                : t(lang, '1-9 选项 · f 标记 · n/p 切题 · Ctrl+S 交卷', '1-9 Pick · f Flag · n/p Move · Ctrl+S Submit')}
          </Text>
        </Box>

        {/* Navigator strip */}
        <Box flexWrap="wrap" gap={1} marginBottom={1}>
          {navTokens.slice(0, 30).map((tok) => {
            const sym = tok.flag ? '⚑' : tok.answered ? '●' : '○';
            return (
              <Text
                key={tok.n}
                backgroundColor={tok.current ? theme.primary : theme.surface}
                color={
                  tok.current
                    ? theme.dark
                      ? theme.bg
                      : '#ffffff'
                    : tok.flag
                      ? theme.warning
                      : tok.answered
                        ? theme.success
                        : theme.dim
                }
                bold={tok.current}
              >
                {` ${tok.n}${sym} `}
              </Text>
            );
          })}
        </Box>

        {error ? (
          <Box marginBottom={1}>
            <Text color={theme.error}>{truncateDisplay(error, innerW)}</Text>
          </Box>
        ) : null}

        {/* Written Question Body */}
        {kind === 'written' && currentWrittenCard ? (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            <Box gap={1} marginBottom={1}>
              <Badge
                label={
                  currentWrittenCard.multiple || currentWrittenCard.kind === 'multi'
                    ? t(lang, '多选', 'Multi')
                    : currentWrittenCard.kind === 'truefalse'
                      ? t(lang, '判断', 'T/F')
                      : t(lang, '单选', 'Single')
                }
                tone="info"
                variant="soft"
              />
              {currentWrittenCard.topic ? (
                <Badge label={currentWrittenCard.topic} tone="accent" variant="soft" />
              ) : null}
              {flagged.has(currentWrittenCard.id) ? (
                <Badge label={t(lang, '已标记', 'Flagged')} tone="warning" />
              ) : null}
            </Box>

            <MarkdownView
              markdown={currentWrittenCard.prompt || ''}
              width={innerW}
              height={Math.max(4, Math.floor(bodyH * 0.45))}
            />

            <Box flexDirection="column" marginTop={1}>
              {(currentWrittenCard.options ?? []).map((opt, idx) => {
                const picked = currentSelected.includes(opt.id);
                const keyNum = idx + 1;
                return (
                  <Box key={opt.id} marginBottom={0}>
                    <Text
                      backgroundColor={picked ? theme.selectionBg : undefined}
                      color={picked ? theme.primary : theme.text}
                      bold={picked}
                    >
                      {` [${keyNum}] ${picked ? '◉' : '○'} ${truncateDisplay(opt.text, Math.max(10, innerW - 10))}`}
                    </Text>
                  </Box>
                );
              })}
            </Box>
          </Box>
        ) : null}

        {/* Case Paper Body */}
        {kind === 'case' && currentCaseCard ? (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            <Box gap={1} marginBottom={1}>
              <Badge
                label={`${currentCaseCard.marks ?? 0} ${t(lang, '分', 'pts')}`}
                tone="accent"
              />
              {currentCaseCard.topic ? (
                <Badge label={currentCaseCard.topic} tone="info" variant="soft" />
              ) : null}
              {flagged.has(currentCaseCard.id) ? (
                <Badge label={t(lang, '已标记', 'Flagged')} tone="warning" />
              ) : null}
            </Box>

            <MarkdownView
              markdown={currentCaseCard.prompt || ''}
              width={innerW}
              height={Math.max(4, Math.floor(bodyH * 0.42))}
            />

            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.muted} bold>
                {editingField === 'case'
                  ? t(lang, '编辑作答 (Ctrl+S 保存，Esc 取消):', 'Editing answer (Ctrl+S save, Esc cancel):')
                  : t(lang, '你的作答 (按 e 编辑):', 'Your response (press e to edit):')}
              </Text>
              {editingField === 'case' ? (
                <TextInput
                  value={draftText}
                  onChange={setDraftText}
                  multiline
                  height={Math.max(4, Math.floor(bodyH * 0.35))}
                  width={innerW}
                  isActive={isActive}
                  onSubmit={(val) => {
                    setCaseDrafts((prev) => ({ ...prev, [currentCaseCard.id]: val }));
                    onSaveCaseResponse(currentCaseCard.id, val);
                    setEditingField('none');
                  }}
                  onCancel={() => setEditingField('none')}
                />
              ) : (
                <Text color={(caseDrafts[currentCaseCard.id] ?? '').trim() ? theme.text : theme.dim}>
                  {(caseDrafts[currentCaseCard.id] ?? '').trim() ||
                    t(lang, '（尚未填写，按 e 开始作答）', '(Empty — press e to type response)')}
                </Text>
              )}
            </Box>
          </Box>
        ) : null}

        {/* Oral Mock Body */}
        {kind === 'oral' && oral?.entry ? (
          <Box flexDirection="column" height={bodyH} overflow="hidden">
            <Box gap={1} marginBottom={1}>
              {oral.role ? <Badge label={oral.role} tone="ai" /> : null}
              {oral.entry.topic ? (
                <Badge label={oral.entry.topic} tone="info" variant="soft" />
              ) : null}
            </Box>

            <MarkdownView
              markdown={oral.entry.prompt || ''}
              width={innerW}
              height={Math.max(3, Math.floor(bodyH * 0.32))}
            />

            <Box flexDirection="column" marginTop={1}>
              <Text color={theme.muted} bold>
                {editingField === 'oral-main'
                  ? t(lang, '口述作答 (Ctrl+S 保存，Esc 取消):', 'Editing answer (Ctrl+S save, Esc cancel):')
                  : t(lang, '你的回答 (按 e 编辑):', 'Your answer (press e to edit):')}
              </Text>
              {editingField === 'oral-main' ? (
                <TextInput
                  value={draftText}
                  onChange={setDraftText}
                  multiline
                  height={Math.max(3, Math.floor(bodyH * 0.25))}
                  width={innerW}
                  isActive={isActive}
                  onSubmit={(val) => {
                    onSaveOralAnswer(oral.entry!.cardId, val, 'main');
                    setEditingField('none');
                  }}
                  onCancel={() => setEditingField('none')}
                />
              ) : (
                <Text color={oral.entry.answer.trim() ? theme.text : theme.dim}>
                  {oral.entry.answer.trim() ||
                    t(lang, '（按 e 录入回答，保存后可按 a 触发考官追问）', '(Press e to answer; press a after saving for AI follow-up)')}
                </Text>
              )}
            </Box>

            {oral.entry.followup ? (
              <Box flexDirection="column" marginTop={1}>
                <Text color={theme.ai} bold>
                  {t(lang, `考官追问: ${oral.entry.followup}`, `Follow-up: ${oral.entry.followup}`)}
                </Text>
                {editingField === 'oral-followup' ? (
                  <TextInput
                    value={draftText}
                    onChange={setDraftText}
                    multiline
                    height={3}
                    width={innerW}
                    isActive={isActive}
                    onSubmit={(val) => {
                      onSaveOralAnswer(oral.entry!.cardId, val, 'followup');
                      setEditingField('none');
                    }}
                    onCancel={() => setEditingField('none')}
                  />
                ) : (
                  <Text color={oral.entry.followupAnswer.trim() ? theme.text : theme.dim}>
                    {oral.entry.followupAnswer.trim() ||
                      t(lang, '（按 u 回答追问）', '(Press u to answer follow-up)')}
                  </Text>
                )}
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Panel>

      {confirmSubmit ? (
        <ConfirmDialog
          title={t(lang, '确认交卷', 'Submit Exam')}
          message={
            kind === 'oral'
              ? t(
                  lang,
                  `已回答 ${answeredCount}/${totalCount} 题。提交后将由 AI 考官统一评分并计入复习计划。`,
                  `Answered ${answeredCount}/${totalCount}. Submit for AI assessment and scheduling?`,
                )
              : t(
                  lang,
                  `已作答 ${answeredCount}/${totalCount} 题。确认交卷并生成考试报告吗？`,
                  `Answered ${answeredCount}/${totalCount}. Submit paper and grade now?`,
                )
          }
          confirmLabel={t(lang, '确认交卷', 'Submit')}
          cancelLabel={t(lang, '继续作答', 'Cancel')}
          isActive={isActive}
          onConfirm={() => {
            setConfirmSubmit(false);
            if (kind === 'oral') onSubmitOral();
            else onSubmitWritten(kind === 'case' ? caseDrafts : undefined);
          }}
          onCancel={() => setConfirmSubmit(false)}
        />
      ) : null}
    </Box>
  );
});
