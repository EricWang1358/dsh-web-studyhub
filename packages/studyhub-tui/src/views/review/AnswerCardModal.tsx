import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text } from 'ink';
import { useScopedInput as useInput } from '../../components/key-dispatcher.js';
import type { HostClient, KeyHint, UiLanguage } from '../../types/contracts.js';
import { t, useTuiStore } from '../../state/store.js';
import { currentCourse } from '../../shell/data.js';
import { startReview, tryAction, getReview, type ReviewRun } from '../../host/sample-actions.js';
import { useTheme } from '../../theme/tokens.js';
import { Badge, Divider, EmptyState, Spinner } from '../../components/Badge.js';
import { MarkdownView } from '../../components/MarkdownView.js';
import { Modal, modalContentWidth } from '../../components/Modal.js';
import { truncateDisplay } from '../../render/cjk.js';
import { currentDeckIdOf, kindLabel, type NormalizedKind } from './review-helpers.js';
import { NextStepFollowupBar } from './NextStepFollowupBar.js';

export interface AnswerCardSignal {
  word?: string;
  quote?: string;
  verified?: boolean;
  reason?: string;
  in?: string;
}

export interface AnswerCardFact {
  text?: string;
  quote?: string;
  verified?: boolean;
  reason?: string;
  in?: string;
}

export interface AnswerCardConcept {
  name?: string;
  quote?: string;
  verified?: boolean;
  reason?: string;
  where?: { sourceId?: string; title?: string };
}

export interface AnswerCardMarksRow {
  point?: string;
  criterionId?: string;
  label?: string;
  marks?: number;
  sentence?: string;
  found?: boolean;
}

export interface AnswerCardChecks {
  quotes?: { total?: number; verified?: number };
  coverage?: { total?: number; covered?: number; missing?: string[] };
  inventedNumbers?: string[];
  missing?: string[];
  review?: {
    ran?: boolean;
    issues?: Array<{ kind?: string; where?: string; text?: string }>;
    repaired?: boolean;
  };
}

export interface AnswerCardData {
  v?: number;
  language?: 'zh' | 'en' | string;
  questionType?: { id?: string; label?: string } | string;
  signals?: AnswerCardSignal[];
  facts?: AnswerCardFact[];
  concepts?: AnswerCardConcept[];
  assumptions?: string[];
  steps?: string[];
  conclusion?: string;
  thesis?: string;
  keyPoints?: string[];
  structure?: string[];
  justification?: {
    goal?: string;
    cost?: string;
    failure?: string;
    verify?: string;
  };
  pitfalls?: string[];
  marksMap?: AnswerCardMarksRow[];
  checks?: AnswerCardChecks;
  status?: 'verified' | 'partial' | string;
  state?: 'verified' | 'partial' | 'edited' | string;
  renderedDigest?: string;
  basis?: string;
  [k: string]: unknown;
}

interface CardRubricCriterion {
  id?: string;
  label?: string;
  marks?: number;
  descriptor?: string;
  keyPoints?: string[];
}

interface CardDetailPayload {
  id?: string;
  kind?: string;
  prompt?: string;
  answer?: string;
  topic?: string;
  marks?: number;
  rubric?: string;
  rubricCriteria?: CardRubricCriterion[];
  answerCard?: AnswerCardData | null;
}

interface CardGetResponse {
  deckId?: string;
  deckTitle?: string;
  folder?: string;
  card?: CardDetailPayload;
}

interface BookQaListResponse {
  followupIds?: string[];
  answerCardIds?: string[];
  courses?: string[];
}

interface AnswerCardBuildResponse {
  jobId?: string;
  status?: string;
  deckId?: string;
  cardId?: string;
  answerCard?: AnswerCardData;
  card?: { answerCard?: AnswerCardData };
}

interface JobStatusResponse {
  id?: string;
  status?: string;
  stage?: string | { code?: string; text?: string };
  stageText?: string;
  phase?: string;
  error?: { message?: string } | string;
  contract?: {
    status?: string;
    stage?: { code?: string; text?: string };
    error?: { message?: string };
  };
}

interface CaseDrillsResponse {
  jobId?: string;
  status?: string;
  deckId?: string;
  runId?: string;
  scope?: Array<{ deckId: string; cardId?: string }>;
  criteria?: number;
  count?: number;
}

export interface AnswerCardModalProps {
  host: HostClient;
  run: ReviewRun;
  cardId: string;
  kind: NormalizedKind;
  width: number;
  height: number;
  isActive: boolean;
  mathUnicode: boolean;
  onClose: () => void;
  onRunUpdated?: (nextRun: ReviewRun) => void;
  onRefreshSnapshot?: () => void;
}

const ACTIVE_JOB_STATUSES = new Set(['queued', 'running', 'pending', 'paused', 'starting', 'waiting']);

function isActiveJobStatus(raw: unknown): boolean {
  return ACTIVE_JOB_STATUSES.has(String(raw ?? '').toLowerCase());
}

function escapeCell(text: unknown): string {
  return String(text ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

function formatMarks(value: unknown): string {
  const num = Number(value);
  if (!Number.isFinite(num)) return '0';
  return Number.isInteger(num) ? String(num) : String(Math.round(num * 100) / 100);
}

function extractStageText(job: JobStatusResponse | undefined): string {
  if (!job) return '';
  if (typeof job.stage === 'object' && job.stage?.text) return String(job.stage.text);
  if (typeof job.stageText === 'string' && job.stageText) return job.stageText;
  if (typeof job.contract?.stage?.text === 'string' && job.contract.stage.text) return job.contract.stage.text;
  if (typeof job.phase === 'string' && job.phase) return job.phase;
  if (typeof job.stage === 'string' && job.stage) return job.stage;
  return '';
}

function extractJobError(job: JobStatusResponse | undefined): string {
  if (!job) return '';
  if (typeof job.error === 'string') return job.error;
  if (job.error && typeof job.error === 'object' && job.error.message) return String(job.error.message);
  if (job.contract?.error?.message) return String(job.contract.error.message);
  return '';
}

function resolveCardState(card: AnswerCardData | null | undefined): 'verified' | 'partial' | 'edited' {
  if (!card) return 'partial';
  if (card.state === 'edited') return 'edited';
  if (card.state === 'verified' || card.status === 'verified') return 'verified';
  return 'partial';
}

function buildAnswerCardMarkdown(
  card: AnswerCardData,
  cardDetail: CardDetailPayload | null,
  lang: UiLanguage,
  asciiMode: boolean,
): string {
  const blocks: string[] = [];
  const openQ = asciiMode ? '"' : lang === 'en' ? '"' : '「';
  const closeQ = asciiMode ? '"' : lang === 'en' ? '"' : '」';
  const quoteText = (val: unknown) => `${openQ}${String(val ?? '').replace(/\s+/g, ' ').trim()}${closeQ}`;
  const unverifiedTag = (verified: unknown) =>
    verified === false ? (asciiMode ? t(lang, ' [未核实]', ' [unverified]') : t(lang, '（未核实）', ' (unverified)')) : '';

  if (card.state === 'edited') {
    blocks.push(
      `> **${t(lang, '提示', 'Notice')}**: ${t(
        lang,
        '这道题在答题卡生成后发生过修改，建议按 [g] 重新生成核对。',
        'This question changed after the answer card was built. Press [g] to rebuild.',
      )}`,
    );
  }

  const invented = Array.isArray(card.checks?.inventedNumbers) ? card.checks.inventedNumbers : [];
  if (invented.length > 0) {
    blocks.push(
      `> **${t(lang, '数字警告', 'Number Check')}**: ${t(
        lang,
        `以下数字在题干、假设与概念中未找到出处：${invented.join('、')}`,
        `Numbers not found in stem/assumptions/concepts: ${invented.join(', ')}`,
      )}`,
    );
  }

  // Thesis / Conclusion first as executive summary if present
  const thesisText = card.thesis || card.conclusion || '';
  if (thesisText) {
    blocks.push(`### ${t(lang, '核心结论 / 论点', 'Thesis & Conclusion')}\n\n${thesisText}`);
  }

  if (Array.isArray(card.keyPoints) && card.keyPoints.length > 0) {
    blocks.push(
      `### ${t(lang, '核心得分要点', 'Key Points')}\n\n${card.keyPoints.map((p) => `- ${p}`).join('\n')}`,
    );
  }

  // Signals & Stem Facts
  if (Array.isArray(card.signals) && card.signals.length > 0) {
    const lines = card.signals.map(
      (s) => `- **${s.word || '-'}**: ${quoteText(s.quote)}${unverifiedTag(s.verified)}`,
    );
    blocks.push(`### ${t(lang, '题型识别信号', 'Question Signals')}\n\n${lines.join('\n')}`);
  }

  if (Array.isArray(card.facts) && card.facts.length > 0) {
    const lines = card.facts.map(
      (f) =>
        `- ${f.text || ''}${f.quote ? ` — ${quoteText(f.quote)}` : ''}${unverifiedTag(f.verified)}`,
    );
    blocks.push(`### ${t(lang, '题干事实依据', 'Stem Facts')}\n\n${lines.join('\n')}`);
  }

  if (Array.isArray(card.concepts) && card.concepts.length > 0) {
    const lines = card.concepts.map((c) => {
      const from = c.where?.title ? ` (${t(lang, '资料', 'Source')}: ${c.where.title})` : '';
      return `- **${c.name || '-'}**${from}: ${quoteText(c.quote)}${unverifiedTag(c.verified)}`;
    });
    blocks.push(`### ${t(lang, '核心概念原文', 'Grounded Concepts')}\n\n${lines.join('\n')}`);
  }

  if (Array.isArray(card.assumptions) && card.assumptions.length > 0) {
    blocks.push(
      `### ${t(lang, '显式假设', 'Explicit Assumptions')}\n\n${card.assumptions.map((a) => `- ${a}`).join('\n')}`,
    );
  }

  // Model Answer Structure / Reasoning Steps
  const steps = Array.isArray(card.steps) && card.steps.length > 0
    ? card.steps
    : Array.isArray(card.structure)
      ? card.structure
      : [];
  if (steps.length > 0) {
    const stepLines = steps.map((step, i) => `${i + 1}. ${String(step).replace(/\n+/g, ' ')}`);
    blocks.push(`### ${t(lang, '标准作答结构 / 推理链', 'Model Answer Structure & Reasoning')}\n\n${stepLines.join('\n')}`);
  }

  // Justification
  const just = card.justification;
  if (just && (just.goal || just.cost || just.failure || just.verify)) {
    const jLines: string[] = [];
    if (just.goal) jLines.push(`- **${t(lang, '满足目标', 'Why It Meets Goal')}**: ${just.goal}`);
    if (just.cost) jLines.push(`- **${t(lang, '代价与权衡', 'Cost & Tradeoffs')}**: ${just.cost}`);
    if (just.failure) jLines.push(`- **${t(lang, '失败处理', 'Failure Handling')}**: ${just.failure}`);
    if (just.verify) jLines.push(`- **${t(lang, '验证方式', 'How to Verify')}**: ${just.verify}`);
    blocks.push(`### ${t(lang, '论证与边界验证', 'Justification & Verification')}\n\n${jLines.join('\n')}`);
  }

  // Pitfalls / Traps
  if (Array.isArray(card.pitfalls) && card.pitfalls.length > 0) {
    blocks.push(
      `### ${t(lang, '易错陷阱检查', 'Pitfalls & Traps')}\n\n${card.pitfalls.map((p) => `- ${p}`).join('\n')}`,
    );
  }

  // Rubric Criteria Map
  if (Array.isArray(card.marksMap) && card.marksMap.length > 0) {
    const header = `| ${t(lang, '评分点', 'Criterion')} | ${t(lang, '分值', 'Marks')} | ${t(lang, '对应句子', 'Mapped Sentence')} |`;
    const sep = '| --- | --- | --- |';
    const rows = card.marksMap.map((m) => {
      const label = escapeCell(m.label ? `${m.label} · ${m.point ?? ''}` : m.point || m.criterionId || '-');
      const sent = m.found
        ? escapeCell(m.sentence)
        : t(lang, '没有句子对应', 'no sentence matched');
      return `| ${label} | ${formatMarks(m.marks)} | ${sent} |`;
    });
    blocks.push(`### ${t(lang, '评分点对照', 'Rubric Criteria Map')}\n\n${[header, sep, ...rows].join('\n')}`);
  } else if (Array.isArray(cardDetail?.rubricCriteria) && cardDetail.rubricCriteria.length > 0) {
    const lines = cardDetail.rubricCriteria.map((c, idx) => {
      const pts = Array.isArray(c.keyPoints) && c.keyPoints.length > 0 ? `: ${c.keyPoints.join('; ')}` : c.descriptor ? `: ${c.descriptor}` : '';
      return `- **${c.label || c.id || `#${idx + 1}`}** (${formatMarks(c.marks)} ${t(lang, '分', 'pts')})${pts}`;
    });
    blocks.push(`### ${t(lang, '评分标准', 'Rubric Criteria')}\n\n${lines.join('\n')}`);
  }

  return blocks.join('\n\n');
}

export const AnswerCardModal = memo(function AnswerCardModal({
  host,
  run,
  cardId,
  kind,
  width,
  height,
  isActive,
  mathUnicode,
  onClose,
  onRunUpdated,
  onRefreshSnapshot,
}: AnswerCardModalProps) {
  const theme = useTheme();
  const lang = useTuiStore((s) => s.preferences.language);
  const asciiMode = useTuiStore((s) => Boolean(s.preferences.asciiMode));
  const ell = asciiMode ? '...' : '…';
  const snapshot = useTuiStore((s) => s.snapshot);
  const notify = useTuiStore((s) => s.notify);
  const navigate = useTuiStore((s) => s.navigate);

  const fallbackDeckId = currentDeckIdOf(run);
  const [resolvedDeckId, setResolvedDeckId] = useState<string | null>(fallbackDeckId);
  const effectiveDeckId = resolvedDeckId ?? fallbackDeckId;

  const deckMeta = useMemo(
    () => snapshot?.decks?.find((d) => d.id === effectiveDeckId) ?? null,
    [snapshot?.decks, effectiveDeckId],
  );
  const course = useMemo(() => {
    const fromDeck =
      (typeof deckMeta?.course === 'string' && deckMeta.course.trim()) ||
      (typeof (deckMeta as { folder?: unknown } | null)?.folder === 'string' &&
        String((deckMeta as { folder?: unknown }).folder).trim());
    if (fromDeck) return fromDeck;
    const fromRun = typeof (run as { course?: unknown }).course === 'string' ? String((run as { course?: unknown }).course).trim() : '';
    if (fromRun) return fromRun;
    return currentCourse(snapshot) || undefined;
  }, [deckMeta, run, snapshot]);

  const [loading, setLoading] = useState(true);
  const [cardDetail, setCardDetail] = useState<CardDetailPayload | null>(null);
  const [answerCard, setAnswerCard] = useState<AnswerCardData | null>(() => {
    const sol = (run as { solution?: { answerCard?: AnswerCardData } } | null)?.solution?.answerCard;
    return sol && typeof sol === 'object' ? sol : null;
  });
  const [pinnedInBook, setPinnedInBook] = useState(false);
  const [hasBook, setHasBook] = useState(false);
  const [bookBusy, setBookBusy] = useState(false);
  const [drillBusy, setDrillBusy] = useState(false);
  const [drillResult, setDrillResult] = useState<CaseDrillsResponse | null>(null);
  const [jobState, setJobState] = useState<{ status: 'starting' | 'running'; jobId?: string; stageText?: string } | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const cardIdRef = useRef(cardId);
  cardIdRef.current = cardId;
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPoll = useCallback(() => {
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearPoll();
    };
  }, [clearPoll]);

  const hydrateCardAndBook = useCallback(async () => {
    const targetCardId = cardId;
    const [cardRes, qaRes] = await Promise.all([
      tryAction<CardGetResponse>(host, 'card.get', {
        ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
        cardId: targetCardId,
      }),
      tryAction<BookQaListResponse>(host, 'book.qa.list', course ? { course } : {}),
    ]);
    if (!mountedRef.current || cardIdRef.current !== targetCardId) return;
    if (cardRes.ok && cardRes.value) {
      if (cardRes.value.deckId) setResolvedDeckId(cardRes.value.deckId);
      if (cardRes.value.card) {
        setCardDetail(cardRes.value.card);
        const solAc = (run as { solution?: { answerCard?: AnswerCardData } } | null)?.solution?.answerCard;
        const fetchedAc = cardRes.value.card.answerCard;
        if (fetchedAc && typeof fetchedAc === 'object') {
          // Preserve computed state ('edited') from run.solution if available
          setAnswerCard(
            solAc?.state && !fetchedAc.state ? { ...fetchedAc, state: solAc.state } : fetchedAc,
          );
        } else if (solAc && typeof solAc === 'object') {
          setAnswerCard(solAc);
        } else {
          setAnswerCard(null);
        }
      }
    }
    if (qaRes.ok && qaRes.value) {
      const ids = Array.isArray(qaRes.value.answerCardIds) ? qaRes.value.answerCardIds : [];
      const courses = Array.isArray(qaRes.value.courses) ? qaRes.value.courses : [];
      setPinnedInBook(ids.includes(targetCardId));
      setHasBook(courses.length > 0);
    }
    setLoading(false);
  }, [host, effectiveDeckId, cardId, course, run]);

  // Reset & load when card changes
  useEffect(() => {
    clearPoll();
    setLoading(true);
    setErrorBanner(null);
    setDrillResult(null);
    const solAc = (run as { solution?: { answerCard?: AnswerCardData } } | null)?.solution?.answerCard;
    setAnswerCard(solAc && typeof solAc === 'object' ? solAc : null);

    // Check if an answer-card job for this card is already running in snapshot
    const activeJob = snapshot?.jobs?.find((j) => {
      if (!isActiveJobStatus(j.status)) return false;
      if (j.type !== 'case-answer-card' && j.kind !== 'case-answer-card') return false;
      const detailCardId =
        (j as { detail?: { cardId?: string }; contract?: { detail?: { cardId?: string } } }).detail?.cardId ??
        (j as { contract?: { detail?: { cardId?: string } } }).contract?.detail?.cardId;
      return detailCardId === cardId;
    });
    setJobState(
      activeJob
        ? {
            status: 'running',
            jobId: activeJob.id,
            stageText: typeof activeJob.phase === 'string' ? activeJob.phase : activeJob.message,
          }
        : null,
    );

    void hydrateCardAndBook();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cardId]);

  const finishJobAndReload = useCallback(async () => {
    const targetCardId = cardId;
    await hydrateCardAndBook();
    if (!mountedRef.current || cardIdRef.current !== targetCardId) return;
    onRefreshSnapshot?.();
    if (onRunUpdated && run.id) {
      try {
        const refreshed = await getReview(host, run.id);
        if (mountedRef.current && cardIdRef.current === targetCardId) {
          onRunUpdated(refreshed);
        }
      } catch {
        // card.get already hydrated the modal view
      }
    }
  }, [cardId, hydrateCardAndBook, onRefreshSnapshot, onRunUpdated, run.id, host]);

  // Poll running answer-card job until finished
  useEffect(() => {
    if (jobState?.status !== 'running' || !jobState.jobId) return;
    let cancelled = false;
    const jobId = jobState.jobId;
    const targetCardId = cardId;

    const pollOnce = async () => {
      const res = await tryAction<JobStatusResponse>(host, 'job.status', { jobId });
      if (cancelled || !mountedRef.current || cardIdRef.current !== targetCardId) return;
      if (res.ok && res.value) {
        const st = res.value.status ?? res.value.contract?.status;
        if (st && !isActiveJobStatus(st)) {
          setJobState(null);
          if (st === 'failed' || st === 'error' || st === 'cancelled') {
            const msg =
              extractJobError(res.value) ||
              extractStageText(res.value) ||
              t(lang, '答题卡生成未完成，可在后台任务页查看或重试', 'Answer card build did not complete; check Tasks or retry');
            setErrorBanner(msg);
            notify(msg, 'warning');
          } else {
            setErrorBanner(null);
            notify(t(lang, '答题卡已生成并核对完成', 'Answer card built and checked'), 'success');
            await finishJobAndReload();
          }
          return;
        }
        const stage = extractStageText(res.value);
        if (stage) {
          setJobState((prev) => (prev && prev.jobId === jobId ? { ...prev, stageText: stage } : prev));
        }
      }
      pollTimerRef.current = setTimeout(() => {
        void pollOnce();
      }, 1000);
    };

    pollTimerRef.current = setTimeout(() => {
      void pollOnce();
    }, 600);

    return () => {
      cancelled = true;
      clearPoll();
    };
  }, [jobState?.status, jobState?.jobId, cardId, host, lang, notify, finishJobAndReload, clearPoll]);

  const building = jobState !== null;

  const handleBuild = useCallback(async () => {
    if (building) return;
    const targetCardId = cardId;
    const again = Boolean(answerCard);
    setErrorBanner(null);
    setJobState({ status: 'starting', stageText: t(lang, `正在提交答题卡生成任务${ell}`, `Starting answer card build${ell}`) });

    const res = await tryAction<AnswerCardBuildResponse>(host, 'generation.answerCard.build', {
      ...(effectiveDeckId ? { deckId: effectiveDeckId } : {}),
      cardId: targetCardId,
      ...(again ? { again: true } : {}),
      language: lang,
    });
    if (!mountedRef.current || cardIdRef.current !== targetCardId) return;

    if (!res.ok || !res.value) {
      setJobState(null);
      const msg = res.error?.message || t(lang, '无法生成答题卡', 'Failed to start answer card build');
      setErrorBanner(msg);
      notify(msg, 'warning');
      return;
    }

    const immediate = res.value.answerCard ?? res.value.card?.answerCard;
    if (immediate && typeof immediate === 'object') {
      setJobState(null);
      setAnswerCard(immediate);
      notify(t(lang, '答题卡已生成', 'Answer card ready'), 'success');
      void finishJobAndReload();
      return;
    }

    if (res.value.jobId) {
      setJobState({
        status: 'running',
        jobId: res.value.jobId,
        stageText: t(lang, `正在写入、核对引文与独立复核${ell}`, `Writing, checking quotes & reviewing${ell}`),
      });
      notify(
        t(lang, `已开始生成答题卡 (${res.value.jobId})`, `Building answer card (${res.value.jobId})`),
        'info',
      );
      return;
    }

    setJobState(null);
    await finishJobAndReload();
  }, [building, cardId, answerCard, lang, ell, host, effectiveDeckId, notify, finishJobAndReload]);

  const handleTogglePin = useCallback(async () => {
    if (bookBusy || building) return;
    if (!answerCard) {
      const msg = t(lang, '请先按 [g] 生成答题卡，再加入复习全书', 'Build an answer card with [g] before pinning to Book');
      setErrorBanner(msg);
      notify(msg, 'info');
      return;
    }
    const targetCardId = cardId;
    setBookBusy(true);
    setErrorBanner(null);

    const action = pinnedInBook ? 'book.qa.remove' : 'book.qa.add';
    const args: Record<string, unknown> = {
      cardId: targetCardId,
      answerCard: true,
      ...(effectiveDeckId && !pinnedInBook ? { deckId: effectiveDeckId } : {}),
      ...(course ? { course } : {}),
    };
    const res = await tryAction<{ status?: string }>(host, action, args);
    if (!mountedRef.current || cardIdRef.current !== targetCardId) return;
    setBookBusy(false);

    if (!res.ok) {
      const msg = res.error?.message || t(lang, '操作复习全书失败', 'Failed to update Review Book');
      setErrorBanner(msg);
      notify(msg, 'warning');
      return;
    }
    const nextPinned = !pinnedInBook;
    setPinnedInBook(nextPinned);
    setHasBook(true);
    onRefreshSnapshot?.();
    notify(
      nextPinned
        ? t(lang, '已将答题卡加入复习全书', 'Pinned answer card to Review Book')
        : t(lang, '已从复习全书撤回答题卡', 'Removed answer card from Review Book'),
      'success',
    );
  }, [bookBusy, building, answerCard, lang, cardId, pinnedInBook, effectiveDeckId, course, host, onRefreshSnapshot, notify]);

  const rawCardKind = String(cardDetail?.kind ?? run.card?.kind ?? '').toLowerCase();
  const isCaseOrOpen =
    kind === 'short_answer' ||
    rawCardKind === 'open' ||
    rawCardKind === 'task' ||
    rawCardKind === 'case' ||
    Boolean(cardDetail?.rubricCriteria?.length);
  const canLaunchDrills = isCaseOrOpen && Boolean(effectiveDeckId);

  const handleCaseDrills = useCallback(async () => {
    if (drillBusy || !canLaunchDrills || !effectiveDeckId) return;
    const targetCardId = cardId;
    setDrillBusy(true);
    setErrorBanner(null);

    const res = await tryAction<CaseDrillsResponse>(host, 'case.drills', {
      deckId: effectiveDeckId,
    });
    if (!mountedRef.current || cardIdRef.current !== targetCardId) return;
    setDrillBusy(false);

    if (!res.ok || !res.value) {
      const msg = res.error?.message || t(lang, '无法发起薄弱评分项练习', 'Failed to launch weak-criterion drills');
      setErrorBanner(msg);
      notify(msg, 'warning');
      return;
    }

    const val = res.value;
    if (val.runId) {
      notify(t(lang, '已开启薄弱项针对练习', 'Started weak-criterion drill run'), 'success');
      onClose();
      navigate('review', { runId: val.runId });
      return;
    }

    if (Array.isArray(val.scope) && val.scope.length > 0 && !val.jobId) {
      try {
        const nextRun = await startReview(host, { mode: 'path', scope: val.scope, fresh: true });
        if (!mountedRef.current) return;
        notify(t(lang, '已开启薄弱项针对练习', 'Started weak-criterion drill run'), 'success');
        onRunUpdated?.(nextRun);
        onClose();
        return;
      } catch (err) {
        if (!mountedRef.current) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorBanner(msg);
        notify(msg, 'error');
        return;
      }
    }

    setDrillResult(val);
    onRefreshSnapshot?.();
    if (val.jobId) {
      notify(
        t(
          lang,
          `已将 ${val.criteria ?? ''} 个薄弱评分项排入练习生成 (${val.jobId})`,
          `Queued ${val.count ?? ''} weak-criterion drills (${val.jobId})`,
        ),
        'success',
      );
    } else if (val.deckId) {
      notify(t(lang, '薄弱项练习题组已就绪，按 [p] 开始练习', 'Drill deck ready — press [p] to practise'), 'success');
    } else {
      notify(t(lang, '已触发薄弱评分项练习', 'Weak-criterion drills triggered'), 'success');
    }
  }, [drillBusy, canLaunchDrills, effectiveDeckId, cardId, host, lang, notify, onClose, navigate, onRunUpdated, onRefreshSnapshot]);

  const [followupEngaged, setFollowupEngaged] = useState(false);

  useInput(
    (input) => {
      if (input === 'g') {
        void handleBuild();
        return;
      }
      if (input === 'b') {
        void handleTogglePin();
        return;
      }
      if (input === 'd' && canLaunchDrills) {
        void handleCaseDrills();
        return;
      }
      if (input === 't' && (drillResult?.jobId || jobState?.jobId)) {
        const targetJobId = drillResult?.jobId || jobState?.jobId;
        onClose();
        navigate('tasks', targetJobId ? { jobId: targetJobId } : {});
        return;
      }
      if (input === 'p' && drillResult?.deckId && !drillResult.jobId) {
        const targetDeckId = drillResult.deckId;
        onClose();
        navigate('review', { deckId: targetDeckId, mode: 'path' });
      }
    },
    { isActive: isActive && !followupEngaged },
  );

  const frameW = Math.max(48, Math.min(104, width - 4));
  const frameH = Math.max(16, Math.min(36, height - 2));
  const innerW = modalContentWidth(frameW);
  const bodyH = Math.max(8, frameH - 5);

  const cardState = resolveCardState(answerCard);
  const typeLabel =
    typeof answerCard?.questionType === 'string'
      ? answerCard.questionType
      : answerCard?.questionType?.label || answerCard?.questionType?.id || '';

  const checksLine = useMemo(() => {
    if (!answerCard?.checks) return '';
    const q = answerCard.checks.quotes;
    const cov = answerCard.checks.coverage;
    const parts: string[] = [];
    if (q && typeof q.verified === 'number' && typeof q.total === 'number') {
      parts.push(t(lang, `引文 ${q.verified}/${q.total}`, `Quotes ${q.verified}/${q.total}`));
    }
    if (cov && typeof cov.covered === 'number' && typeof cov.total === 'number') {
      parts.push(t(lang, `评分点 ${cov.covered}/${cov.total}`, `Rubric ${cov.covered}/${cov.total}`));
    }
    parts.push(asciiMode ? t(lang, '已核对 != 答案正确', 'Checked != correct') : t(lang, '已核对 ≠ 答案正确', 'Checked != correct'));
    return parts.join(' · ');
  }, [answerCard, lang, asciiMode]);

  const cardMarkdown = useMemo(
    () => (answerCard ? buildAnswerCardMarkdown(answerCard, cardDetail, lang, asciiMode) : ''),
    [answerCard, cardDetail, lang, asciiMode],
  );

  const hints = useMemo<KeyHint[]>(() => {
    const items: KeyHint[] = [
      {
        key: 'g',
        label: answerCard ? t(lang, '重生成', 'Rebuild') : t(lang, '生成', 'Build'),
      },
    ];
    if (answerCard) {
      items.push({
        key: 'b',
        label: pinnedInBook ? t(lang, '撤出全书', 'Unpin') : t(lang, '加全书', 'Pin'),
      });
    }
    if (canLaunchDrills) {
      items.push({ key: 'd', label: t(lang, '弱项练习', 'Drills') });
    }
    if (drillResult?.jobId || jobState?.jobId) {
      items.push({ key: 't', label: t(lang, '任务', 'Tasks') });
    } else if (drillResult?.deckId) {
      items.push({ key: 'p', label: t(lang, '去练习', 'Practise') });
    }
    if (answerCard) {
      items.push({ key: asciiMode ? 'j/k' : '↑/↓', label: t(lang, '滚动', 'Scroll') });
    }
    items.push({ key: 'Esc', label: t(lang, '关闭', 'Close') });
    return items;
  }, [answerCard, pinnedInBook, canLaunchDrills, drillResult, jobState?.jobId, lang, asciiMode]);

  const showBanner = Boolean(building || bookBusy || drillBusy || errorBanner || drillResult);
  const fixedHeaderRows =
    1 + // top badges bar
    (checksLine ? 1 : 0) +
    (showBanner ? 1 : 0) +
    1; // divider
  const canFollowup = Boolean(answerCard && !loading && !building);
  const followupExpandedH = Math.min(11, Math.max(8, Math.floor(bodyH * 0.55)));
  const contentH = Math.max(4, bodyH - fixedHeaderRows - (canFollowup ? (followupEngaged ? followupExpandedH : 3) : 0));

  const topicName = typeof cardDetail?.topic === 'string' && cardDetail.topic
    ? cardDetail.topic
    : typeof run.card?.topic === 'string' && run.card.topic
      ? run.card.topic
      : '';

  const stateBadgeLabel =
    cardState === 'verified'
      ? asciiMode
        ? t(lang, '+ 已核对', '+ Checked')
        : t(lang, '✓ 已核对', '✓ Checked')
      : cardState === 'edited'
        ? asciiMode
          ? t(lang, '! 题目已改', '! Edited')
          : t(lang, '▲ 题目已改', '▲ Edited')
        : asciiMode
          ? t(lang, '~ 部分未核对', '~ Partial')
          : t(lang, '◐ 部分未核对', '◐ Partial');
  const stateBadgeTone = cardState === 'verified' ? 'success' : 'warning';

  return (
    <Modal
      title={t(lang, '分析题答题卡', 'Case Answer Card')}
      icon={asciiMode ? '#' : '▤'}
      tone="accent"
      subtitle={`${kindLabel(kind, lang)}${topicName ? ` · ${topicName}` : ''}`}
      width={frameW}
      height={frameH}
      onClose={onClose}
      isActive={isActive && !followupEngaged}
      hints={hints}
    >
      {/* Top Status & Action Badges */}
      <Box flexDirection="row" alignItems="center" justifyContent="space-between" width={innerW} height={1} overflow="hidden">
        <Box flexDirection="row" alignItems="center" gap={1}>
          {answerCard ? (
            <>
              <Badge label={stateBadgeLabel} tone={stateBadgeTone} />
              {typeLabel ? <Badge label={truncateDisplay(typeLabel, 20)} tone="primary" variant="soft" /> : null}
              <Badge
                label={
                  pinnedInBook
                    ? asciiMode
                      ? t(lang, '+ 已加全书', '+ Pinned')
                      : t(lang, '✓ 已加全书', '✓ In Book')
                    : hasBook
                      ? t(lang, '未加全书', 'Not in Book')
                      : t(lang, '无全书', 'No Book')
                }
                tone={pinnedInBook ? 'info' : 'neutral'}
                variant="soft"
              />
            </>
          ) : (
            <Badge label={t(lang, '尚未生成答题卡', 'No Answer Card')} tone="neutral" variant="soft" />
          )}
        </Box>
        {cardDetail?.marks ? (
          <Text color={theme.muted}>{`${cardDetail.marks} ${t(lang, '分', 'pts')}`}</Text>
        ) : null}
      </Box>

      {/* Checks / verification summary line */}
      {checksLine ? (
        <Box height={1} width={innerW} overflow="hidden">
          <Text color={theme.dim} wrap="truncate">
            {truncateDisplay(checksLine, innerW)}
          </Text>
        </Box>
      ) : null}

      {/* Live job / action / error banner */}
      {showBanner ? (
        <Box height={1} width={innerW} overflow="hidden" flexDirection="row" alignItems="center" gap={1}>
          {building ? (
            <Spinner
              label={truncateDisplay(
                jobState?.stageText || t(lang, `正在生成答题卡${ell}`, `Building answer card${ell}`),
                Math.max(12, innerW - 4),
                ell,
              )}
              tone="ai"
              active={isActive}
            />
          ) : drillBusy ? (
            <Spinner label={t(lang, `正在生成薄弱评分项练习${ell}`, `Launching weak-criterion drills${ell}`)} tone="primary" active={isActive} />
          ) : bookBusy ? (
            <Spinner label={t(lang, `正在更新复习全书${ell}`, `Updating Review Book${ell}`)} tone="info" active={isActive} />
          ) : errorBanner ? (
            <Text color={theme.error} wrap="truncate">
              {truncateDisplay(`${asciiMode ? '!' : '▲'} ${errorBanner}`, innerW, ell)}
            </Text>
          ) : drillResult ? (
            <Text color={theme.success} wrap="truncate">
              {truncateDisplay(
                drillResult.jobId
                  ? t(
                      lang,
                      `已排入 ${drillResult.count ?? ''} 道薄弱项练习 (${drillResult.jobId}) · 按 [t] 查看任务`,
                      `Queued ${drillResult.count ?? ''} drills (${drillResult.jobId}) · [t] Tasks`,
                    )
                  : t(lang, '薄弱项练习已就绪 · 按 [p] 开始练习', 'Drills ready · Press [p] to practise'),
                innerW,
                ell,
              )}
            </Text>
          ) : null}
        </Box>
      ) : null}

      <Divider width={innerW} />

      {/* Main Content */}
      {loading && !answerCard ? (
        <Box height={contentH} width={innerW} alignItems="center" justifyContent="center">
          <Spinner label={t(lang, `正在读取答题卡${ell}`, `Loading answer card${ell}`)} active={isActive} />
        </Box>
      ) : answerCard ? (
        <Box flexDirection="column" width={innerW} flexGrow={1} overflow="hidden">
          <Box height={contentH} width={innerW} overflow="hidden">
            <MarkdownView
              markdown={cardMarkdown}
              width={innerW}
              height={contentH}
              isActive={isActive && !building && !followupEngaged}
              mathUnicode={mathUnicode}
              ascii={asciiMode}
            />
          </Box>
          {canFollowup ? (
            <NextStepFollowupBar
              host={host}
              run={run}
              cardId={cardId}
              kind={kind}
              toolLabel={t(lang, '分析题答题卡', 'Case Answer Card')}
              resultContext={cardMarkdown}
              width={innerW}
              expandedHeight={followupExpandedH}
              isActive={isActive && canFollowup}
              onFocusChange={setFollowupEngaged}
            />
          ) : null}
        </Box>
      ) : (
        <EmptyState
          icon={asciiMode ? '*' : '✦'}
          title={t(lang, '这道题还没有结构化答题卡', 'No Answer Card Built Yet')}
          hint={
            isCaseOrOpen
              ? t(
                  lang,
                  '答题卡将提炼题型信号、题干事实、概念原文引文、推理结构、易错陷阱与评分点对照，并逐字核对引文。按 [g] 立即生成。',
                  'Extracts signals, stem facts, verbatim concept quotes, reasoning steps, pitfalls, and rubric map. Press [g] to build.',
                )
              : t(
                  lang,
                  '答题卡主要面向带评分标准的案例分析/开放大题。按 [g] 可尝试生成或查看原因。',
                  'Answer cards target rubric-graded case/open questions. Press [g] to check or build.',
                )
          }
          actions={[
            { key: 'g', label: t(lang, '生成答题卡', 'Build Answer Card') },
            ...(canLaunchDrills ? [{ key: 'd', label: t(lang, '弱项练习', 'Weak Drills') }] : []),
            { key: 'Esc', label: t(lang, '返回', 'Close') },
          ]}
          width={innerW}
          height={contentH}
        />
      )}
    </Modal>
  );
});
