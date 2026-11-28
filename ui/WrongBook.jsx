import { ui, uiFormat, errorMessage, getUiLanguage } from "./i18n.js";
import React, { memo, useCallback, useContext, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import css from "./views.css";
import wrongCss from "./wrongbook.css";
import overlayCss from "./components/overlays.css";
import { useInjectCss, plainPrompt } from "./shared.js";
import Markdown from "./Markdown.jsx";
import Cloze from "./Cloze.jsx";
import StudyInline from "./StudyInline.jsx";
import StudyMath from "./StudyMath.jsx";
import { splitStudyMath } from "./study-media.js";
import { usePolling } from "./use-polling.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import { RubricResult, RubricSkills, rubricSkills } from "./CaseResult.jsx";
import CorrectionCard from "./review/CorrectionCard.jsx";
import PageScope, { courseMatcher, courseParked, decksInCourse, scopedAttemptsOf, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { Badge, Banner, Button, ChunkedRows, Combobox, DisclosureToggle, foldLabel, EmptyState, ErrorState, Icon, InlineMessage, LoadingState, PageHeader, SegmentedControl, Spinner, Switch, TextInput, Tooltip, Chip, highlightParts, useToast } from './components/index.js';
import { scrollToAnchor } from './tour/anchor.js';
import { HandOff } from './hand-off/HandOff.jsx';
import { hasChatHost } from './hand-off/use-hand-off.js';
import { leechLimits } from '../lib/leech.js';
import { wrongbookClinic } from '../lib/practice-settings.js';
import { isJsonCardSource } from '../lib/source-provenance.js';
import { firstCitation, usableCitations } from './document-preview/practice/citations.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { modelReadiness } from './generation-status.js';
import { similarWinLine } from './review/similar-words.js';
import { buildWrongbookClinic } from './wrongbook-clinic.js';
import { FILTER_MIN, NO_FILTER, PRACTICE_SCOPE_CAP, RECS_PREVIEW, SORT_KINDS, STATUS_KINDS, VARIANT_BATCH_CAP, capPracticeScope, deckChoices, filterActive, filterRows, groupRows, groupSummaryText, leechCount, leechRetellNote, leechTriageView, leechWords, practiceCappedText, readGroupBy, readOpenGroups, readSortBy, reasonText, retrainOptions,
  sameVariantState, saveGroupBy, saveSortBy, sortGroupRows, rescueCall, rescueExperimentStatusText, rescueGate, rescueNote, takeArrival, undoPauseCall, readSignature, rowsAwaitingDetail, saveOpenGroups, scopedFilter, shortDeckNames, statusCounts, statusLabel, statusOf, variantFailureText, variantState } from './wrongbook-model.js';
import { useStudy } from './study-context.jsx';
import { AppContext } from './app/app-context.js';
import { peekQuery, refreshQuery, setQueryData, useHostQuery } from './host-query.js';
import { formatDateTime, joinMeta } from "./format.js";
import { companionSlideButtonLabel, openCompanionTarget, resolveCompanionTarget } from "./companions/companion-ref.js";
import { useRescueExperiments } from "./companions/use-rescue-experiments.js";
import LazyWrongBookClearStamp from "./seal-press/LazyWrongBookClearStamp.jsx";

// One page of this view holds ten pages of the service (which gives at most 100), so a filter sees every mistake of a normal library.
const FETCH_LIMIT = 100;
const PAGE_SIZE = 1000;
const PAGE_FETCH_CONCURRENCY = 4;
const DETAIL_FETCH_CONCURRENCY = 4;
const PAGE_CACHE_LIMIT = 12;
const DETAIL_CACHE_LIMIT = 200;
const POLL_MS = 2500;

/**
 * Fetch one WrongBook UI page (up to `pageSize` items) without a 10x serial waterfall:
 * read the first chunk to learn `total`, then fetch any remaining chunks with bounded concurrency while keeping offset order.
 */
export async function fetchWrongBookPage(call, {
  scope = {},
  view = "weak",
  page = 0,
  pageSize = PAGE_SIZE,
  fetchLimit = FETCH_LIMIT,
  concurrency = PAGE_FETCH_CONCURRENCY,
  isStale = () => false,
} = {}) {
  const baseOffset = page * pageSize;
  const first = await call("wrongbook", { ...scope, view, offset: baseOffset, limit: fetchLimit });
  const firstItems = Array.isArray(first?.items) ? first.items : [];
  if (isStale() || !firstItems.length) return { ...first, items: [...firstItems] };
  const wanted = Math.min(pageSize, Math.max(0, (first?.total || 0) - baseOffset));
  if (firstItems.length >= wanted) return { ...first, items: [...firstItems] };

  const step = Math.min(fetchLimit, firstItems.length);
  const offsets = [];
  for (let rel = firstItems.length; rel < wanted; rel += step) {
    offsets.push(baseOffset + rel);
  }
  const chunks = new Array(offsets.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, concurrency), offsets.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (cursor < offsets.length && !isStale()) {
      const idx = cursor++;
      const more = await call("wrongbook", { ...scope, view, offset: offsets[idx], limit: fetchLimit });
      chunks[idx] = Array.isArray(more?.items) ? more.items : [];
    }
  });
  await Promise.all(workers);
  if (isStale()) return { ...first, items: [...firstItems] };

  const found = [...firstItems];
  for (const chunk of chunks) {
    if (!chunk?.length) break;
    found.push(...chunk);
  }
  return { ...first, items: found };
}

/**
 * Concurrency-limited + LRU-cached loader for `wrongbook.detail`, eliminating thundering-herd bursts
 * when expanding a group of rows and serving repeated expansions from memory.
 */
export function createWrongDetailLoader({ call, concurrency = DETAIL_FETCH_CONCURRENCY, maxCache = DETAIL_CACHE_LIMIT } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const queue = [];
  let active = 0;

  const getCached = (key) => {
    if (!cache.has(key)) return undefined;
    const value = cache.get(key);
    cache.delete(key);
    cache.set(key, value);
    return value;
  };

  const setCached = (key, value) => {
    if (cache.has(key)) cache.delete(key);
    cache.set(key, value);
    while (cache.size > maxCache) {
      const oldest = cache.keys().next().value;
      cache.delete(oldest);
    }
  };

  const pump = () => {
    while (active < Math.max(1, concurrency) && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      Promise.resolve()
        .then(() => call("wrongbook.detail", job.args))
        .then((detail) => {
          setCached(job.key, detail);
          inflight.delete(job.key);
          job.resolve(detail);
        })
        .catch((error) => {
          inflight.delete(job.key);
          job.reject(error);
        })
        .finally(() => {
          active -= 1;
          pump();
        });
    }
  };

  const load = (key, args) => {
    const cached = getCached(key);
    if (cached !== undefined) return Promise.resolve(cached);
    if (inflight.has(key)) return inflight.get(key);
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    inflight.set(key, promise);
    queue.push({ key, args, resolve, reject });
    pump();
    return promise;
  };

  const clear = () => {
    cache.clear();
  };

  return { getCached, load, clear };
}
// How long the offer to undo a suspend stays (hovering or focusing it holds it).
const UNDO_TIMEOUT = 8000;
// How often the open page asks whether the list changed (one row is read; the whole list only when it did). It slows down by itself while nothing moves.
const WATCH_MS = 8000;
const refOf = ({ deckId, cardId }) => ({ deckId, cardId });
/** Recommendations that fit one mistake, with the reasons that apply to that mistake. */
const relatedTo = (recs, cardId) => recs
  .map((rec) => ({ rec, match: rec.matches?.find((entry) => entry.cardId === cardId) }))
  .filter(({ rec, match }) => match || rec.forCardIds?.includes(cardId))
  .sort((a, b) => (b.match?.score ?? 0) - (a.match?.score ?? 0))
  .slice(0, 3)
  .map(({ rec, match }) => ({ ...rec, reasons: match?.reasons?.length ? match.reasons : rec.reasons }));

/* 错题与待巩固。数据来自 call("wrongbook")；默认按题组看（每组先折叠，只露出标题行），也可按主题合并跨题组的同类错题；
   筛选栏按题组、状态、文字缩小列表，生成变式只处理筛选后看得见的题。「为你推荐」是题库里已有的相似题（不调用模型）；「生成变式」
   通过陪学的备题队列为错题写新题（需要同意和可用模型）。练习都交给主会话：
   onPractice(scope) 用 review.start {mode:"path", scope}，变式用 coach.practice。
   WrongBookView 只负责展示，便于单独渲染测试。 */

/** A tooltip body: one sentence, and at most one line on what follows from it. */
const tip = (sentence, consequence) => <>{sentence}{consequence && <><br />{consequence}</>}</>;
/** What 生成变式 does, said wherever a button starts it. */
const generateTip = () => tip(uiFormat('为错题改写新的变式题：每道题约 1 次轻量模型调用，一次最多 {0} 题。', [VARIANT_BATCH_CAP]), ui('写好的变式会先备好等你，点「去练」或从侧栏「为你定制」开练。'));
/** What each kind of low outcome means: the chips and the row marks say it in the same words. */
function statusTip(kind) {
  switch (kind) {
    case 'graded': return tip(ui('答错：单选、多选、判断、填空由系统判分，最近一次得分低于 3 分。'), ui('再答对一次，它会移到「已订正」，记录仍保留。'));
    case 'oral': return tip(ui('最近一次口头 AI 评估：需要巩固'));
    case 'rubric': return tip(ui('最近一次按评分标准批改：得分不足六成'));
    default: return tip(ui('未掌握：闪卡和开放题由你自评，最近一次自评低于 3 分。'), ui('自评到 3 分以上，它会移到「已订正」，记录仍保留。'));
  }
}
/** The same mark in 已订正: it says how the question was last missed, not how it stands now. */
const historyTip = () => tip(ui('这是这道题最近一次答错时的类型；现在已答对，记录保留。'));

/** The one fold control of the page (a group header, a question row, a recommendation): a whole row is the target. */
function FoldButton({ className, open, controls, onClick, children, ...rest }) {
  return <button type="button" className={className} aria-expanded={open} aria-controls={controls} onClick={onClick} {...rest}>{children}</button>;
}

const PROMPT_TIP_MIN = 48;
const META_TIP_MIN = 20;

function StatusMark({ kind, history = false }) {
  return <Tooltip layer content={history ? historyTip() : statusTip(kind)}><span tabIndex={0} className={"wb-grade" + (kind === "graded" ? "" : " self")}><Icon name={kind === "graded" ? "close" : "circle"} className="sh-icon--inline" />{statusLabel(kind)}</span></Tooltip>;
}

/** 顽固: the question keeps being failed (lib/leech.js). A state mark like the one beside it, not a control; the thresholds are the learner's own. */
function LeechMark({ limits }) {
  const words = leechWords(limits);
  return <Tooltip layer content={tip(words.sentence, words.consequence)}><span tabIndex={0} className="wb-grade leech"><Icon name="diamond" className="sh-icon--inline" />{ui("顽固")}</span></Tooltip>;
}

/** What each rescue action does, said where its button is. */
const rescueTip = (kind) => kind === 'experiment'
  ? tip(ui('围绕你上次选错的点做一个 3–4 页交互实验（约 15–30 秒，1–2 次模型调用）；没配生成模型时可走主会话零密钥编译。'), ui('做完关闭窗口后会直接回到这道题。'))
  : kind === 'fix'
    ? tip(ui('记下「这题有问题」，由后台助教检查并修这道题；没有可用模型时会提示先配好模型。有模型时会调用轻量模型，出错时最多再试 2 次。'), ui('会直接改这张卡；完成时信箱会提醒你，在信箱里可以一步撤销。'))
    : kind === 'easier'
      ? tip(ui('记下「太难」，写一张更基础的前置小卡（调用轻量模型）；没有可用模型时会提示先配好模型，未开启后台准备时会先在这里请你确认。'), ui('写好后放进「为你定制」。'))
      : tip(ui('暂停后，这道题不再出现在练习和错题里，也不调用模型。'), ui('在题组的管理页点「恢复学习」可以恢复。'));

/** Highlighted single recommendation + collapsed "Other ways" disclosure for a question that keeps being failed (5.0.0 §2.1 & §3.5.3 #2). */
function LeechRescue({ item, course, detail, companionTarget, experimentState, disabled, rescuePrompt, rescuing, canOpenModel, canOpenSettings, initialOtherOpen = false, onRescue, onStartExperiment, onOpenExperiment, onOpenConfusable, onOpenBook, onPracticePrereq, onDismissRescue, onOpenModel, onOpenProfileSettings }) {
  const { host } = useStudy();
  const canChat = hasChatHost(host);
  const [otherOpen, setOtherOpen] = useState(Boolean(initialOtherOpen));
  const [confusableBusy, setConfusableBusy] = useState(false);
  const otherId = useId();
  const retellNote = leechRetellNote(item?.retell);
  const rec = leechTriageView(item);
  const experimentRunning = experimentState?.status === 'starting' || experimentState?.status === 'running';
  const readyCompanion = experimentState?.status === 'ready' && experimentState?.companionId
    ? { companionId: experimentState.companionId, course: experimentState.course || course, slide: 1, anchor: '#1', companionTitle: experimentState.title || '', lessonMode: 'rescue' }
    : (companionTarget?.lessonMode === 'rescue' ? companionTarget : null);
  const hasDetail = detail && detail !== 'loading' && !detail?.error;
  const runConfusable = async () => {
    if (!onOpenConfusable || confusableBusy) return;
    setConfusableBusy(true);
    try { await onOpenConfusable(rec.triage, item, rec.triage.course || course); } finally { setConfusableBusy(false); }
  };
  const experimentBtn = (variant) => (readyCompanion && onOpenExperiment ? (
    <Button variant={variant} size="sm" iconEnd="arrow-right" data-rescue="experiment-open" disabled={disabled}
      onClick={() => onOpenExperiment(readyCompanion)}>{ui("打开 4 页交互实验")}</Button>
  ) : (
    <Tooltip layer content={rescueTip('experiment')}>
      <Button variant={variant} size="sm" icon="sparkle" data-rescue="experiment" busy={experimentRunning}
        disabled={disabled || experimentRunning} lock={rescuing}
        onClick={() => onStartExperiment?.(item, hasDetail ? detail : null)}>{ui("做一个 4 页交互实验")}</Button>
    </Tooltip>
  ));
  const prereqRefs = rec.triage.prereqRefs?.length ? rec.triage.prereqRefs : (rec.triage.prereq ? [rec.triage.prereq] : []);
  return (
    <div className="wb-sub wb-leech" data-triage-route={rec.route}>
      <h4>{ui("这道题总是答错")}</h4>
      <p className="muted" data-rescue-lead={rec.route}>{rec.lead}</p>
      {retellNote && <p className="muted wb-leech__retell" data-retell-signal={retellNote.signal}>{retellNote.text}</p>}
      <div className="wb-leech__primary">
        {rec.route === 'confusable_contrast' && (
          <Button variant="secondary" size="sm" iconEnd="arrow-right" data-rescue="confusable" busy={confusableBusy}
            disabled={disabled || !onOpenConfusable}
            onClick={runConfusable}>{rec.actionLabel}</Button>
        )}
        {rec.route === 'book_retell' && (
          <Button variant="secondary" size="sm" iconEnd="arrow-right" data-rescue="book-retell" disabled={disabled || !onOpenBook}
            onClick={() => onOpenBook?.({ course: rec.triage.course || course, hid: rec.triage.hid || item.hid || '' })}>{rec.actionLabel}</Button>
        )}
        {rec.route === 'prereq_branch' && (
          <Button variant="secondary" size="sm" iconEnd="arrow-right" data-rescue="prereq" disabled={disabled || !prereqRefs.length || !onPracticePrereq}
            onClick={() => onPracticePrereq?.(prereqRefs, item)}>{rec.actionLabel}</Button>
        )}
        {rec.route === 'fix_question' && (
          <Tooltip layer content={rescueTip('fix')}>
            <Button variant="secondary" size="sm" data-rescue="fix" disabled={disabled} lock={rescuing}
              onClick={() => onRescue('fix', item)}>{rec.actionLabel}</Button>
          </Tooltip>
        )}
        {rec.route === 'rescue_companion' && experimentBtn('secondary')}
        <Button variant="quiet" size="sm" className="wb-leech__more-toggle" data-rescue-other-toggle=""
          aria-expanded={otherOpen} aria-controls={otherId} onClick={() => setOtherOpen((open) => !open)}>
          {otherOpen ? ui("收起其他办法") : ui("其他办法")}
        </Button>
      </div>
      {experimentRunning && (
        <div className="wb-leech__status" role="status" aria-live="polite" data-rescue-status={experimentState.status}>
          <Spinner size="sm" />
          <span>{rescueExperimentStatusText(experimentState.stage || experimentState.status)}</span>
        </div>
      )}
      {experimentState?.status === 'ready' && (
        <div className="wb-leech__status is-ready" role="status" aria-live="polite" data-rescue-status="ready">
          <Icon name="success" className="sh-icon--inline" />
          <span>{ui("4 页交互实验已做好，做完关闭窗口就会回到这道题。")}</span>
        </div>
      )}
      {experimentState?.status === 'failed' && (
        <InlineMessage className="wb-leech__notice" tone="error" boxed
          action={!disabled && onStartExperiment ? { label: ui("重试"), onClick: () => onStartExperiment(item, hasDetail ? detail : null) } : undefined}>
          {experimentState.message || ui("这次没能生成交互实验，可以重试或展开「其他办法」。")}
        </InlineMessage>
      )}
      {rescuePrompt?.type === "rescue-handoff" && (
        <div className="wb-consent wb-leech__handoff" role="group" aria-label={ui("由主会话生成 4 页交互实验")}>
          <strong>{ui("未配置生成模型 · 可用主会话零密钥生成")}</strong>
          <p>{ui("发给主会话后，它会直接编译 3–4 页交互实验并挂回这道题；挂载好后回到这里刷新就能直接打开，做完关闭窗口仍回到这道题。")}</p>
          <div className="wb-consent-actions">
            <HandOff id="companion.rescue" shape="secondary" what="让主会话零密钥编译一个 3–4 页急救交互实验并挂回这道题"
              input={{
                course,
                deckId: item.deckId,
                cardId: item.cardId,
                topic: item.topic || '',
                prompt: plainPrompt(item.prompt),
                yourAnswer: hasDetail ? (detail.yourAnswer || '') : '',
                correctAnswer: hasDetail ? (detail.correctAnswer || '') : '',
              }} />
            {canOpenModel && <Button iconEnd="arrow-right" variant="link" size="sm" onClick={onOpenModel}>{ui("打开模型设置")}</Button>}
            <Button variant="quiet" size="sm" onClick={onDismissRescue}>{ui("取消")}</Button>
          </div>
        </div>
      )}
      {rescuePrompt?.type === "consent" && (
        <div className="wb-consent" role="group" aria-label={ui("确认补一张前置小卡")}>
          <strong>{ui("要开启后台准备并补一张前置小卡吗？")}</strong>
          <p>{ui("这会在后台写一张更基础的前置小卡（约 1 次轻量调用），写好后放进「为你定制」；同时会在设置里开启后台准备，随时可以去那里关掉。")}
            {canOpenSettings && <>{" "}<Button iconEnd="arrow-right" variant="link" size="sm" onClick={onOpenProfileSettings}>{ui("前往设置")}</Button></>}</p>
          <div className="wb-consent-actions">
            <Button variant="secondary" size="sm" icon="sparkle" busy={rescuing} lock={disabled}
              onClick={() => onRescue('easier', item, { consent: true })}>{ui("同意并生成")}</Button>
            <Button variant="quiet" size="sm" lock={rescuing} onClick={onDismissRescue}>{ui("取消")}</Button>
          </div>
        </div>
      )}
      {rescuePrompt?.type === "no-model" && (
        <InlineMessage className="wb-leech__notice" tone="warning" boxed actionsBelow
          action={canOpenModel ? { label: ui("打开模型设置"), iconEnd: "arrow-right", onClick: onOpenModel } : undefined}
          onDismiss={onDismissRescue}>
          {rescuePrompt.text || rescueGate(rescuePrompt.kind, { modelReady: false, canChat }).text}
        </InlineMessage>
      )}
      {otherOpen && (
        <div id={otherId} className="wb-leech__actions wb-leech__other" data-rescue-other="">
          {rec.route !== 'rescue_companion' && experimentBtn('quiet')}
          {rec.route !== 'fix_question' && (
            <Tooltip layer content={rescueTip('fix')}><Button variant="quiet" size="sm" data-rescue="fix" disabled={disabled} lock={rescuing} onClick={() => onRescue('fix', item)}>{ui("这题有问题，交给后台修")}</Button></Tooltip>
          )}
          <Tooltip layer content={rescueTip('easier')}><Button variant="quiet" size="sm" data-rescue="easier" disabled={disabled} lock={rescuing} onClick={() => onRescue('easier', item)}>{ui("太难了，补一张前置小卡")}</Button></Tooltip>
          <HandOff id="question.stubborn" shape="quiet" what="让主会话和你一起看这道题：是你还没弄懂，还是题目本身有问题" disabled={disabled || rescuing}
            input={{ course, deckId: item.deckId, cardId: item.cardId, topic: item.topic || '', prompt: plainPrompt(item.prompt) }} />
          <Tooltip layer content={rescueTip('pause')}><Button variant="quiet" size="sm" data-rescue="pause" disabled={disabled} lock={rescuing} onClick={() => onRescue('pause', item)}>{ui("暂停此题")}</Button></Tooltip>
        </div>
      )}
    </div>
  );
}

function VariantControl({ state, onGenerate, onPractice, disabled }) {
  if (state.kind === "preparing")
    return <span className="wb-var is-busy" role="status"><span className="sh-spinner wb-var__spinner" aria-hidden="true" />{ui("生成中…")}</span>;
  if (state.kind === "ready")
    return (
      <span className="wb-var is-ready">
        <Icon className="sh-icon--inline" name="success" />{uiFormat("已备好 {0} 道", [state.count])}
        {onPractice && <Button iconEnd="arrow-right" variant="link" size="sm" disabled={disabled} onClick={onPractice}>{ui("去练")}</Button>}
      </span>
    );
  if (state.kind === "failed")
    return (
      <span className="wb-var is-failed">
        <span>{variantFailureText(state.message)}</span>
        {onGenerate && <Button variant="quiet" size="sm" disabled={disabled} onClick={onGenerate}>{ui("重试")}</Button>}
      </span>
    );
  return onGenerate
    ? <Tooltip layer content={generateTip()}><Button variant="quiet" size="sm" icon="sparkle" disabled={disabled} onClick={onGenerate}>{ui("生成变式")}</Button></Tooltip>
    : null;
}

function RecRow({ rec, shortName, open, onToggle, onPractice, disabled }) {
  const id = useId();
  const fullPrompt = plainPrompt(rec.prompt);
  const toggleBtn = (
    <FoldButton className="wb-rec-toggle" open={open} controls={id} onClick={onToggle}>
      <Icon name="chevron" size={16} className="wb-chevron" />
      <span className="wb-prompt"><StudyInline text={rec.prompt} /></span>
    </FoldButton>
  );
  return (
    <li className={"wb-rec" + (open ? " is-open" : "")}>
      <div className="wb-rec-line">
        {fullPrompt.length > PROMPT_TIP_MIN
          ? <Tooltip layer content={fullPrompt} anchorClassName="wb-toggle-tip">{toggleBtn}</Tooltip>
          : toggleBtn}
        {rec.reasons.length > 1
          ? <Tooltip layer content={rec.reasons.map(reasonText).join(" · ")} anchorClassName="wb-why-tip">
            <span tabIndex={0} className="wb-why">{reasonText(rec.reasons[0])}</span>
          </Tooltip>
          : <span className="wb-why">{reasonText(rec.reasons[0])}</span>}
        <Button variant="quiet" size="sm" iconEnd="arrow-right" disabled={disabled} onClick={onPractice}
          aria-label={uiFormat("练习 {0}：{1}", [rec.topic || ui("未分类"), fullPrompt])}>{ui("练")}</Button>
      </div>
      {open && (
        <div className="wb-detail" id={id}>
          <div className="wb-full-prompt"><Markdown text={fullPrompt} links={false} /></div>
          <ul className="wb-why-list">{rec.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul>
          <small className="muted">{uiFormat("来自 {0}", [shortName(rec.deckTitle)])}</small>
        </div>
      )}
    </li>
  );
}

const LONG_DETAIL_CHARS = 420;
const LONG_MISCONCEPTION_CHARS = 240;

/** Renders study text or plain learner text, collapsing long blocks with an accessible expand/collapse toggle instead of silently slicing them. */
function ExpandableText({ text, plain = false, threshold = LONG_DETAIL_CHARS }) {
  const [open, setOpen] = useState(false);
  const raw = String(text ?? "");
  const isLong = raw.length > threshold;
  const content = plain ? <StudyInline text={raw} /> : <Markdown text={raw} links={false} />;
  if (!isLong) return content;
  return (
    <div className={"wb-expandable" + (open ? " is-open" : "")} data-expandable={open ? "open" : "collapsed"}>
      <div className="wb-expandable__body">{content}</div>
      <Button variant="link" size="sm" className="wb-expandable__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? ui("收起") : ui("展开全文")}
      </Button>
    </div>
  );
}

/** One fact of an opened mistake. The correct answer, the explanation and the pitfall are study text: drawn as Markdown, so formulas are formulas. What the
 * learner typed (`plain`) is theirs: only its formulas are drawn, no Markdown marks change it. */
function DetailLine({ label, children, plain = false, collapseAt = LONG_DETAIL_CHARS }) {
  const shown = typeof children !== "string"
    ? children
    : <ExpandableText text={children} plain={plain} threshold={collapseAt} />;
  return children ? <div className="wb-fact"><dt>{label}</dt><dd>{shown}</dd></div> : null;
}

const SORT_LABELS = { recent: () => ui("最近"), most: () => ui("错次"), order: () => ui("原序") };

function renderHighlightedText(text, query) {
  const value = String(text ?? "");
  const trimmed = String(query ?? "").trim();
  if (!trimmed || !value) return value;
  return highlightParts(value, trimmed).map((part, index) => (
    part.match ? <span key={index} className="wb-hit">{part.text}</span> : <React.Fragment key={index}>{part.text}</React.Fragment>
  ));
}

const PromptPreview = memo(function PromptPreview({ text, query }) {
  const trimmed = String(query ?? "").trim();
  const parsed = useMemo(() => {
    if (!trimmed) return null;
    const plain = plainPrompt(text);
    const pieces = splitStudyMath(plain).map((piece) => (typeof piece === "string" || piece.raw.startsWith("\\begin{")
      ? piece
      : { ...piece, display: false }));
    return { plain, pieces, hasMath: pieces.some((piece) => typeof piece !== "string") };
  }, [text, trimmed]);
  if (!trimmed || !parsed) return <StudyInline text={text} />;
  if (!parsed.hasMath) return renderHighlightedText(parsed.plain, trimmed);
  return parsed.pieces.map((piece, at) => {
    if (typeof piece === "string") return <React.Fragment key={at}>{renderHighlightedText(piece, trimmed)}</React.Fragment>;
    if (piece.raw.startsWith("\\begin{")) return <React.Fragment key={at}>{piece.raw.replace(/\s+/g, " ")}</React.Fragment>;
    return <StudyMath key={at} formula={piece} />;
  });
});

function resolveCardSourceTarget(item, { deckById, cardByRef, sourceById, sources = [] } = {}) {
  if (!item || !Array.isArray(sources) || !sources.length) return null;
  const deck = deckById?.get(item.deckId) || null;
  const card = cardByRef?.get(`${item.deckId}\0${item.cardId}`) || null;
  if (card) {
    const usable = usableCitations(card, sources);
    const pick = usable.find((citation) => citation.selection) || usable[0];
    if (pick) {
      return {
        source: pick.selection ? { ...pick.source, selection: pick.selection } : pick.source,
        quote: pick.quote || pick.selection?.quote || "",
        peekPage: pick.selection?.page ?? pick.page ?? card.page ?? undefined,
      };
    }
    if (card.sourceId) {
      const src = sourceById?.get(card.sourceId);
      if (src && !isJsonCardSource(src)) return { source: src, quote: card.quote || "", peekPage: card.page ?? undefined };
    }
    return null;
  }
  const itemCited = firstCitation(item, sources);
  if (itemCited) return { ...itemCited, peekPage: itemCited.source?.selection?.page ?? itemCited.source?.document?.page ?? item.page ?? undefined };
  const fallbackId = item.sourceId || (!deck?.cards ? (deck?.sourceId || deck?.case?.sourceId) : null);
  if (fallbackId) {
    const src = sourceById?.get(fallbackId);
    if (src && !isJsonCardSource(src)) return { source: src, quote: item.quote || "", peekPage: item.page ?? undefined };
  }
  return null;
}

function RowDetail({ id, item, course, detail, variants, recs, shortName, rescuePrompt, rescuing, experimentState, initialOtherOpen, canOpenModel, canOpenSettings, onPractice, onRescue, onStartExperiment, onOpenConfusable, onOpenBook, onPracticePrereq, onDismissRescue, onOpenModel, onOpenProfileSettings, onOpenSource, companionTarget, onOpenCompanion, disabled }) {
  const ready = detail && detail !== "loading" && !detail?.error;
  const yourAnswerText = ready
    ? (detail.selfGrade !== null && detail.selfGrade !== undefined ? uiFormat("自评 {0} 分", [detail.selfGrade]) : detail.yourAnswer)
    : "";
  const hasClozeContext = Boolean(ready && detail.cloze?.text);
  const distractors = ready && Array.isArray(detail.distractorExplanations) ? detail.distractorExplanations : [];
  const joinedDistractors = distractors.length ? distractors.map((d) => d.explanation).join(" ") : "";
  const showExplanation = Boolean(ready && detail.explanation && (!joinedDistractors || detail.explanation !== joinedDistractors));
  const oralCorrection = ready ? detail.oralFeedback?.correction || null : null;
  const standaloneCorrection = ready && detail.correction && detail.correction !== oralCorrection ? detail.correction : null;
  const hasCompare = Boolean(!hasClozeContext && yourAnswerText && detail?.correctAnswer);
  return (
    <div className="wb-detail" id={id}>
      {item.similarWin && <p className="muted" data-similar-win="">{similarWinLine()}</p>}
      {(detail?.socratic || item.socratic) && (() => {
        const soc = detail?.socratic || item.socratic;
        const helped = (soc.hintLevel ?? 0) > 0;
        return (
          <p className="muted" data-socratic-meta="">
            {soc.retellPassed
              ? (helped ? ui("苏格拉底带学：自己讲清楚了，期间用过提示") : ui("苏格拉底带学：没用提示就讲清楚了"))
              : (helped ? ui("苏格拉底带学：用过提示，还没讲清楚") : ui("苏格拉底带学：聊过，还没讲清楚"))}
          </p>
        );
      })()}
      {detail === "loading" || detail === undefined ? <LoadingState label={ui("正在读取详情…")} />
        : detail?.error ? <InlineMessage tone="error">{ui("没能读取这道题的详情。收起这道题再点开，就会重新读取。")}</InlineMessage>
          : (
            <>
              <dl className="wb-facts">
                <DetailLine label={ui("上次答错")}>{detail.missedAt ? formatDateTime(detail.missedAt, "stamp") : ""}</DetailLine>
                {hasClozeContext ? (
                  <DetailLine label={ui("填空上下文")}>
                    <Cloze card={{ kind: "cloze", cloze: detail.cloze }} values={detail.clozeAnswers || {}} onChange={() => {}} disabled
                      details={detail.clozeDetails || null} solution={{ cloze: detail.cloze }} />
                  </DetailLine>
                ) : hasCompare ? (
                  <div className="wb-compare">
                    <DetailLine label={ui("你的答案")} plain>{yourAnswerText}</DetailLine>
                    <DetailLine label={ui("正确答案")}>{detail.correctAnswer}</DetailLine>
                  </div>
                ) : (
                  <>
                    <DetailLine label={ui("你的答案")} plain>{yourAnswerText}</DetailLine>
                    <DetailLine label={ui("正确答案")}>{detail.correctAnswer}</DetailLine>
                  </>
                )}
                {distractors.length > 0 && (
                  <DetailLine label={ui("所选错项辨析")}>
                    <ul className="wb-distractors">
                      {distractors.map((entry, idx) => (
                        <li key={entry.id || idx}>
                          {entry.text && <strong className="wb-distractors__choice"><StudyInline text={entry.text} /></strong>}
                          <ExpandableText text={entry.explanation} threshold={LONG_DETAIL_CHARS} />
                        </li>
                      ))}
                    </ul>
                  </DetailLine>
                )}
                {detail.oralFollowup?.question && (
                  <DetailLine label={ui("追问与补充")}>
                    <div className="wb-oral-followup">
                      <p>{detail.oralFollowup.question}</p>
                      <p className="muted"><StudyInline text={detail.oralFollowup.answer || ui("未答")} /></p>
                    </div>
                  </DetailLine>
                )}
                {detail.oralFeedback?.reason && (
                  <DetailLine label={ui("口头评估反馈")}>{detail.oralFeedback.reason}</DetailLine>
                )}
                {showExplanation && <DetailLine label={ui("解析")}>{detail.explanation}</DetailLine>}
                <DetailLine label={ui("易错点")} collapseAt={LONG_MISCONCEPTION_CHARS}>{detail.misconception}</DetailLine>
              </dl>
              {detail.rubric && <RubricResult rubric={detail.rubric} compact />}
              {oralCorrection && <CorrectionCard feedback={{ correction: oralCorrection }} />}
              {standaloneCorrection && <CorrectionCard feedback={{ correction: standaloneCorrection }} />}
            </>
          )}
      {item.leech && onRescue && (
        <LeechRescue item={item} course={course} detail={detail} companionTarget={companionTarget} experimentState={experimentState}
          disabled={disabled} rescuePrompt={rescuePrompt} rescuing={rescuing} initialOtherOpen={initialOtherOpen}
          canOpenModel={canOpenModel} canOpenSettings={canOpenSettings}
          onRescue={onRescue} onStartExperiment={onStartExperiment} onOpenExperiment={onOpenCompanion}
          onOpenConfusable={onOpenConfusable} onOpenBook={onOpenBook} onPracticePrereq={onPracticePrereq}
          onDismissRescue={onDismissRescue} onOpenModel={onOpenModel} onOpenProfileSettings={onOpenProfileSettings} />
      )}
      {variants.length > 0 && (
        <div className="wb-sub">
          <h4>{ui("这道题的变式")}</h4>
          <ul>{variants.map((prompt, index) => <li key={index}><StudyInline text={prompt} /></li>)}</ul>
        </div>
      )}
      {recs.length > 0 && (
        <div className="wb-sub">
          <h4>{ui("同类题")}</h4>
          <ul>
            {recs.map((rec) => {
              const fullPrompt = plainPrompt(rec.prompt);
              return (
                <li key={rec.cardId} className="wb-sub-rec">
                  {fullPrompt.length > PROMPT_TIP_MIN
                    ? <Tooltip layer content={fullPrompt} anchorClassName="wb-prompt-tip">
                      <span tabIndex={0} className="wb-prompt"><StudyInline text={rec.prompt} /></span>
                    </Tooltip>
                    : <span className="wb-prompt"><StudyInline text={rec.prompt} /></span>}
                  <span className="wb-why">{reasonText(rec.reasons[0])}</span>
                  <Button variant="quiet" size="sm" iconEnd="arrow-right" disabled={disabled} onClick={() => onPractice(rec)}>{ui("练")}</Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="wb-detail__foot">
        <small className="muted">{shortName(item.deckTitle)}</small>
        {companionTarget && onOpenCompanion && !(item.leech && onRescue && companionTarget.lessonMode === 'rescue') && (
          <Button variant="quiet" size="sm" iconEnd="arrow-right" onClick={() => onOpenCompanion(companionTarget)}>
            {companionSlideButtonLabel(companionTarget)}
          </Button>
        )}
        {onOpenSource && <Button iconEnd="arrow-right" variant="link" size="sm" onClick={onOpenSource}>{ui("打开出处")}</Button>}
      </div>
    </div>
  );
}

/** Two prop sets for a row that mean the same: everything is compared by identity but the variant state, which a poll rebuilds. */
const sameRow = (a, b) => Object.keys(a).every((key) => (key === 'state' ? sameVariantState(a.state, b.state) : a[key] === b[key]));

/* One question. Memoised, so opening a group, typing in the search box or a status poll redraws only the rows whose own props changed (the
   `handlers` are stable). */
const Row = memo(function Row({ it, metaText, query = "", isOpen, state, detail, sourceTarget = null, companionTarget = null, experimentState = null, initialOtherOpen = false, recItems, shortName, canGenerate, canPracticePrepared, disabled, variantDisabled, handlers, limits, course, rescuePrompt = null, rescuing = false, canOpenModel = false, canOpenSettings = false, canOpenBook = false, canOpenConfusable = false, canPracticePrereq = false, history = false, mistake = "", showPractice = true }) {
  const detailId = `wb-detail-${it.cardId}`;
  const recs = useMemo(() => (isOpen ? relatedTo(recItems, it.cardId) : []), [isOpen, recItems, it.cardId]);
  const fullPrompt = plainPrompt(it.prompt);
  const overflowTip = fullPrompt.length > PROMPT_TIP_MIN || (metaText && metaText.length > META_TIP_MIN)
    ? joinMeta([metaText, fullPrompt])
    : "";
  const toggleBtn = (
    <FoldButton className="wb-row-toggle" open={isOpen} controls={detailId} data-card-id={it.cardId} onClick={() => handlers.open(it)}>
      <Icon name="chevron" size={16} className="wb-chevron" />
      <span className="wb-meta">{renderHighlightedText(metaText, query)}</span>
      <span className="wb-prompt"><PromptPreview text={it.prompt} query={query} /></span>
    </FoldButton>
  );
  return (
    <li className={"wb-row" + (isOpen ? " is-open" : "")}>
      <div className="wb-row-line">
        {overflowTip
          ? <Tooltip layer content={overflowTip} anchorClassName="wb-toggle-tip">{toggleBtn}</Tooltip>
          : toggleBtn}
        <StatusMark kind={statusOf(it)} history={history} />
        {it.leech && <LeechMark limits={limits} />}
        {history && (
          <span className="wb-fixed">
            <Badge tone="success" size="sm" icon="success" className="wb-fixed-mark">{ui("已订正")}</Badge>
            <span className="wb-fixed-meta">{mistake}</span>
          </span>
        )}
        {(canGenerate || state.kind === "ready") && (
          <VariantControl state={state} disabled={variantDisabled}
            onGenerate={canGenerate ? () => handlers.generate(it) : undefined}
            onPractice={canPracticePrepared ? () => handlers.practicePrepared(it) : undefined} />
        )}
        {showPractice && (
          <Button variant="quiet" size="sm" iconEnd="arrow-right" disabled={disabled}
            aria-label={uiFormat("练习 {0}：{1}", [it.topic || ui("未分类"), it.prompt])}
            onClick={() => handlers.practice(it)}>{ui("练")}</Button>
        )}
      </div>
      {isOpen && (
        <RowDetail id={detailId} item={it} course={course} detail={detail} shortName={shortName} disabled={disabled}
          rescuePrompt={rescuePrompt} rescuing={rescuing} experimentState={experimentState} initialOtherOpen={initialOtherOpen}
          canOpenModel={canOpenModel} canOpenSettings={canOpenSettings}
          variants={state.kind === "ready" ? state.prompts : []}
          recs={recs}
          onPractice={handlers.practiceRec} onRescue={handlers.rescue} onStartExperiment={handlers.startExperiment}
          onOpenConfusable={canOpenConfusable ? handlers.openConfusable : undefined}
          onOpenBook={canOpenBook ? handlers.openBook : undefined}
          onPracticePrereq={canPracticePrereq ? handlers.practicePrereq : undefined}
          onDismissRescue={handlers.dismissRescue} onOpenModel={handlers.openModel} onOpenProfileSettings={handlers.openProfileSettings}
          onOpenSource={sourceTarget ? () => handlers.openSource(sourceTarget) : undefined}
          companionTarget={companionTarget}
          onOpenCompanion={handlers.openCompanion} />
      )}
    </li>
  );
}, sameRow);

/* 薄弱点分布 (#748): one bar over the groups the list is already grouped by, so where the mass of mistakes is shows before a learner opens groups one
   by one. Hand-drawn with the rules of the dashboard's charts (ui/charts/DashboardCharts.jsx) and nothing of their code: colours from tokens, a tooltip
   drawn over the segment it explains (aria-hidden, because the button's aria-label says the same facts), the count drawn inside the segment as the second,
   non-colour cue, and an empty line when the current filter leaves nothing. Shown from FILTER_MIN mistakes on (#675). */
/** What a segment says: its title, its count, its share and what a press does. The tooltip and the aria-label both read this list, so the drawn words
    and the spoken ones cannot drift apart. */
export function weaknessFacts(group, total) {
  const share = Math.round((group.rows.length / Math.max(1, total)) * 100);
  return [group.title, uiFormat("{0} 题", [group.rows.length]), uiFormat("占 {0}%", [share]),
    group.deckIds.length === 1 ? ui("只看这个题组") : ui("展开这一组")];
}
export function WeaknessBar({ groups = [], onPick }) {
  const [tip, setTip] = useState(null);
  const bar = useRef(null);
  const total = groups.reduce((sum, group) => sum + group.rows.length, 0);
  const facts = (group) => weaknessFacts(group, total);
  const point = (index, event) => {
    const element = event.currentTarget, box = bar.current;
    if (!element || !box) return;
    setTip({ index, x: element.offsetLeft + element.offsetWidth / 2, y: element.offsetTop });
  };
  const shown = tip && groups[tip.index] ? { ...tip, facts: facts(groups[tip.index]) } : null;
  return (
    <section className="wb-dist" aria-label={ui("薄弱点分布")} data-tour="wrongbook-dist">
      <div className="wb-dist-head">
        <h2>{ui("薄弱点分布")}</h2>
        <small className="muted">{uiFormat("{0} 组 · 共 {1} 题", [groups.length, total])}</small>
      </div>
      {groups.length === 0 ? <p className="wb-dist-empty">{ui("当前筛选下没有错题")}</p> : (
        <div className="wb-dist-bar" ref={bar} role="group" aria-label={ui("每组错题数占全部的比例")}>
            {groups.map((group, index) => {
              const words = facts(group);
              return (
                <Button key={group.key} variant="quiet" size="sm" className="wb-dist-seg" style={{ flexGrow: group.rows.length }}
                  data-tight={group.rows.length / Math.max(1, total) < 0.08 || undefined} data-narrow={group.rows.length / Math.max(1, total) < 0.2 || undefined}
                  aria-label={words.join(" · ")} onMouseEnter={(event) => point(index, event)} onMouseLeave={() => setTip(null)}
                  onFocus={(event) => point(index, event)} onBlur={() => setTip(null)} onClick={() => onPick?.(group)}>
                  <span className="wb-dist-name" aria-hidden="true">{group.title}</span>
                  <span className="wb-dist-count" aria-hidden="true">{group.rows.length}</span>
                </Button>
              );
            })}
            {shown && <span className="sh-popover sh-tooltip sh-tooltip--point" aria-hidden="true" style={{ left: shown.x, top: shown.y }}>
              <strong>{shown.facts[0]}</strong>
              {shown.facts.slice(1).map((fact, at) => <span key={at}>{fact}</span>)}
            </span>}
          </div>
      )}
    </section>
  );
}

/** The separator belongs to the item after it (#1086): a space the line may break at, then the item, which carries its own dot, so a line never ends in a lone
 *  「·」. Inside one string (the history sentence) the dot is glued to the next word with a no-break space instead. */
const HEAD_DOT = " ·\u00a0";
function HeadItem({ first, children }) {
  return <>{!first && " "}<span className="wb-headline__item">{!first && <><span className="wb-headline__dot" aria-hidden="true">·</span>{" "}</>}{children}</span></>;
}

function WrongBookClinic({
  lanes, filterLeech, loading, canOpenSource, canPractice, course = '', canChat = true, canOpenModel = false,
  experimentJobs = {}, rescuePrompt = null, onOpenSource, onOpenCompanion, onPracticeScope, onToggleLeech,
  onRescueCluster, onDismissRescue, onOpenModel,
}) {
  const { busy } = useStudy();
  if (!lanes.length) return null;
  const clusterTitle = (lane) => {
    if (lane.kind === "companion") {
      if (lane.companionTitle) {
        return lane.slide ? uiFormat("伴学同页 · 《{0}》第 {1} 页", [lane.companionTitle, lane.slide]) : uiFormat("伴学同课 · 《{0}》", [lane.companionTitle]);
      }
      return lane.slide ? uiFormat("伴学同页 · 第 {0} 页", [lane.slide]) : ui("伴学同课");
    }
    if (lane.kind === "hid") {
      return lane.pointTitle ? uiFormat("同知识点错题 · 「{0}」", [lane.pointTitle]) : ui("同知识点错题");
    }
    const hasPage = lane.page != null && lane.page !== "";
    if (lane.sourceTitle) {
      return hasPage ? uiFormat("同页错题 · 《{0}》第 {1} 页", [lane.sourceTitle, lane.page]) : uiFormat("同源错题 · 《{0}》", [lane.sourceTitle]);
    }
    return hasPage ? uiFormat("同页错题 · 第 {0} 页", [lane.page]) : ui("同源错题");
  };
  const practiceBtn = (lane, label, variant = "secondary") => {
    if (!canPractice) return null;
    const btn = (
      <Button variant={variant} size="sm" wrap iconEnd="arrow-right" lock={busy || loading} onClick={() => onPracticeScope(lane.refs)}>
        {label}
      </Button>
    );
    return lane.scope.capped
      ? <Tooltip layer content={practiceCappedText(lane.scope.total, { group: false })}>{btn}</Tooltip>
      : btn;
  };
  return (
    <section className="wb-clinic" aria-labelledby="wb-clinic-title" data-tour="wrongbook-clinic">
      <div className="wb-clinic-head">
        <h2 id="wb-clinic-title">{ui("靶向清零处方")}<span className="wb-free">{ui("不消耗模型")}</span></h2>
        <span className="muted wb-clinic-lead">{ui("按引用位置与作答记录整理，可回看原文或直接专项重练。")}</span>
      </div>
      <ul className="wb-clinic-list">
        {lanes.map((lane) => {
          if (lane.id === "cluster") {
            const jobKey = lane.clusterKey ? `clinic:${lane.clusterKey}` : 'clinic:cluster';
            const expState = lane.recommendRescue ? (experimentJobs?.[jobKey] || null) : null;
            const expRunning = expState?.status === 'starting' || expState?.status === 'running';
            const readyCompanion = expState?.status === 'ready' && expState?.companionId
              ? { companionId: expState.companionId, course: expState.course || course, slide: 1, anchor: '#1', companionTitle: expState.title || '', lessonMode: 'rescue' }
              : null;
            const showRescue = Boolean(lane.recommendRescue && onRescueCluster);
            const jumpTarget = lane.kind === "companion" ? lane.target : (lane.sourceTarget || (lane.kind === "source" ? lane.target : null));
            const hasJump = Boolean(canOpenSource && jumpTarget && (lane.kind === "companion" || jumpTarget.source));
            const promptForCluster = rescuePrompt?.cardId === jobKey ? rescuePrompt : null;
            return (
              <li key={lane.id} className="wb-clinic-item" data-clinic-lane={lane.id} data-clinic-kind={lane.kind}>
                <div className="wb-clinic-copy">
                  <span className="wb-clinic-name">{clusterTitle(lane)}</span>
                  <span className="muted wb-clinic-meta">
                    {showRescue
                      ? uiFormat("{0} 道错题集中在同一处，推荐做一个 4 页交互实验一次打通", [lane.count])
                      : (hasJump ? uiFormat("{0} 道错题集中在同一处，可先回看再连练", [lane.count]) : uiFormat("{0} 道错题集中在同一处，可集中连练", [lane.count]))}
                  </span>
                </div>
                <div className="wb-clinic-actions">
                  {hasJump && (
                    <Button variant="quiet" size="sm" wrap iconEnd="arrow-right" onClick={() => (lane.kind === "companion" ? onOpenCompanion(jumpTarget) : onOpenSource(jumpTarget))}>
                      {lane.kind === "companion" ? companionSlideButtonLabel(jumpTarget) : ui("先看原文")}
                    </Button>
                  )}
                  {showRescue && (readyCompanion ? (
                    <Button variant="secondary" size="sm" wrap iconEnd="arrow-right" data-clinic-rescue="open"
                      onClick={() => onOpenCompanion?.(readyCompanion)}>{ui("打开 4 页交互实验")}</Button>
                  ) : (
                    <Tooltip layer content={rescueTip('experiment')}>
                      <Button variant="secondary" size="sm" wrap icon="sparkle" data-clinic-rescue="start"
                        busy={expRunning} disabled={busy || loading || expRunning}
                        onClick={() => onRescueCluster(lane, jobKey)}>
                        {ui("做一个 4 页交互实验")}
                      </Button>
                    </Tooltip>
                  ))}
                  {practiceBtn(lane, uiFormat("练这 {0} 题", [lane.scope.scope.length]), showRescue ? "quiet" : "secondary")}
                </div>
                {(expRunning || expState?.status === 'ready' || expState?.status === 'failed' || promptForCluster) && (
                  <div className="wb-clinic-feedback">
                    {expRunning && (
                      <div className="wb-leech__status" role="status" aria-live="polite" data-clinic-rescue-status={expState.status}>
                        <Spinner size="sm" />
                        <span>{rescueExperimentStatusText(expState.stage || expState.status)}</span>
                      </div>
                    )}
                    {expState?.status === 'ready' && (
                      <div className="wb-leech__status is-ready" role="status" aria-live="polite" data-clinic-rescue-status="ready">
                        <Icon name="success" className="sh-icon--inline" />
                        <span>{ui("4 页交互实验已做好，做完关闭窗口就会回到这道题。")}</span>
                      </div>
                    )}
                    {expState?.status === 'failed' && (
                      <InlineMessage className="wb-leech__notice" tone="error" boxed
                        action={!busy && onRescueCluster ? { label: ui("重试"), onClick: () => onRescueCluster(lane, jobKey) } : undefined}>
                        {expState.message || ui("这次没能生成交互实验，可以重试或展开「其他办法」。")}
                      </InlineMessage>
                    )}
                    {promptForCluster?.type === "rescue-handoff" && (
                      <div className="wb-consent wb-leech__handoff" role="group" aria-label={ui("由主会话生成 4 页交互实验")}>
                        <strong>{ui("未配置生成模型 · 可用主会话零密钥生成")}</strong>
                        <p>{ui("发给主会话后，它会直接编译 3–4 页交互实验并挂回这组错题；挂载好后回到这里刷新就能直接打开，做完关闭窗口仍回到错题本。")}</p>
                        <div className="wb-consent-actions">
                          <HandOff id="companion.rescue" shape="secondary" what="让主会话零密钥编译一个 3–4 页急救交互实验并挂回这道题"
                            input={{
                              course: promptForCluster.course || course,
                              ...(lane.deckIds?.length === 1 ? { deckId: lane.deckIds[0] } : {}),
                              cardId: lane.cardIds?.[0] || '',
                              cardIds: lane.cardIds || [],
                              hid: lane.hid || '',
                              topic: lane.pointTitle || lane.sourceTitle || '',
                            }} />
                          {canOpenModel && <Button iconEnd="arrow-right" variant="link" size="sm" onClick={onOpenModel}>{ui("打开模型设置")}</Button>}
                          <Button variant="quiet" size="sm" onClick={onDismissRescue}>{ui("取消")}</Button>
                        </div>
                      </div>
                    )}
                    {promptForCluster?.type === "no-model" && (
                      <InlineMessage className="wb-leech__notice" tone="warning" boxed actionsBelow
                        action={canOpenModel ? { label: ui("打开模型设置"), iconEnd: "arrow-right", onClick: onOpenModel } : undefined}
                        onDismiss={onDismissRescue}>
                        {promptForCluster.text || rescueGate('experiment', { modelReady: false, canChat }).text}
                      </InlineMessage>
                    )}
                  </div>
                )}
              </li>
            );
          }
          if (lane.id === "leech") {
            return (
              <li key={lane.id} className="wb-clinic-item" data-clinic-lane={lane.id}>
                <div className="wb-clinic-copy">
                  <span className="wb-clinic-name">{ui("顽固题专项")}</span>
                  <span className="muted wb-clinic-meta">{uiFormat("{0} 道题反复答错，先专练或点开排查原因", [lane.count])}</span>
                </div>
                <div className="wb-clinic-actions">
                  {(lane.partial || filterLeech) && (
                    <Button variant="quiet" size="sm" wrap onClick={onToggleLeech}>
                      {filterLeech ? ui("显示全部") : ui("只看顽固题")}
                    </Button>
                  )}
                  {practiceBtn(lane, uiFormat("练顽固题 ({0})", [lane.scope.scope.length]))}
                </div>
              </li>
            );
          }
          return (
            <li key={lane.id} className="wb-clinic-item" data-clinic-lane={lane.id}>
              <div className="wb-clinic-copy">
                <span className="wb-clinic-name">{ui("单次失误速清")}</span>
                <span className="muted wb-clinic-meta">{uiFormat("{0} 道仅错过一次的题，适合几分钟内快速清零", [lane.count])}</span>
              </div>
              <div className="wb-clinic-actions">
                {practiceBtn(lane, uiFormat("速清 {0} 题", [lane.scope.scope.length]))}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The one sentence about the open list (#1086): the counts that are not zero, one separator, one full stop. From 待巩固 the kept history is the last part
 *  of the same sentence; the history view says its own counts the same way and the same words. With more than one mistake (or a filter on)
 *  each count is a toggle that filters the list below. It sits under the view switch, not in the page header: the header and the switch stay put
 *  when the sentence changes length between the views. A plain function, not a component: its toggles are part of the page's tree. */
export function wrongBookHeadline({ isHistory, counts, historyCount = 0, status = "all", onToggle }) {
  const parts = [
    { kind: "graded", count: counts.graded, text: uiFormat("客观答错 {0} 题", [counts.graded]) },
    { kind: "self", count: counts.self, text: uiFormat("未掌握 {0} 题", [counts.self]) },
    { kind: "oral", count: counts.oral, text: uiFormat("口头评估待巩固 {0} 题", [counts.oral]) },
    { kind: "rubric", count: counts.rubric, text: uiFormat("按评分标准批改未达标 {0} 题", [counts.rubric]) },
  ].filter((part) => part.count > 0 || (!isHistory && status === part.kind));
  const kept = !isHistory && historyCount > 0 ? uiFormat("已订正 {0} 题，记录保留", [historyCount]) : "";
  if (isHistory) {
    return parts.length ? uiFormat("已订正的错题：{0}。", [parts.map((part) => part.text).join(HEAD_DOT)])
      : ui("答对一次后，错题会移到这里，作为历史保留，随时可以再练。");
  }
  if (!parts.length) {
    return historyCount > 0 ? uiFormat("客观答错、自评未掌握或口头评估待巩固的题会收在这里。已订正 {0} 题，记录保留。", [historyCount])
      : ui("客观答错、自评未掌握或口头评估待巩固的题会收在这里。");
  }
  const toggles = (counts.total || 0) > 1 || status !== "all";
  return <>
    {parts.map((part, index) => (
      <HeadItem key={part.kind} first={index === 0}>
        {toggles && part.count > 0
          ? <Button variant="quiet" size="sm" className="wb-count-toggle" aria-pressed={status === part.kind} onClick={() => onToggle?.(part.kind)}>{part.text}</Button>
          : part.text}
      </HeadItem>
    ))}
    {kept && <HeadItem first={!parts.length}>{kept}</HeadItem>}
    {ui("。")}
  </>;
}

export function WrongBookView({
  data, course, onCourse, showInactive, onShowInactive, items, counts, view = "weak", onView, viewCounts, loading, err, page = 0, pageSize = PAGE_SIZE, hasMore, onReload, onPage,
  recs, recsLoading = false, coach, details = {}, onLoadDetail, onPractice, onPracticePrepared, onGenerate, onOpenSettings, onSettings,
  onLibrary, onCreate, onSources, onOpenBook, onRescue, onStartExperiment, onStartClusterExperiment, onOpenConfusable, experimentJobs = null, onNotify, onToggleClinic = null, arrival, openKey, initial = {}, filterMin = FILTER_MIN,
}) {
  const { busy, call, openModal, host } = useStudy();
  const canChat = hasChatHost(host);
  useInjectCss(css, "study-views");
  useInjectCss(wrongCss, "study-wrongbook");
  // The distribution's tooltip is the shared point tooltip surface (.sh-tooltip--point, ui/components/overlays.css).
  useInjectCss(overlayCss, "study-overlays");
  // 待巩固 is the page; 已订正 is its history. The switch shows both counts and is only offered once there is a history; while the history is open it
  // stays (even at 0) so the learner can always come back.
  const isHistory = view === "history";
  const historyCount = viewCounts?.history ?? 0;
  const weakCount = viewCounts?.weak ?? counts.total;
  const showViews = typeof onView === "function" && (historyCount > 0 || isHistory);
  const [groupBy, setGroupBy] = useState(() => initial.groupBy || readGroupBy());
  const chooseGroupBy = (value) => { setGroupBy(value); saveGroupBy(value); };
  const [sortBy, setSortBy] = useState(() => initial.sortBy || readSortBy());
  const chooseSortBy = (value) => { setSortBy(value); saveSortBy(value); };
  const [expanded, setExpanded] = useState(() => new Set(initial.expanded || []));
  // A row that stays open across a reload (刷新 drops what was read) asks for its detail again; the page asks each card once per list load, so this never loops.
  useEffect(() => {
    for (const ref of rowsAwaitingDetail(items || [], expanded, details)) onLoadDetail?.(ref);
  }, [items, details, expanded, onLoadDetail]);
  // The filter is part of the page: refreshes keep it, another course scope starts clean (scopedFilter).
  const scopeKey = JSON.stringify([course, !!showInactive]);
  const [filterState, setFilterState] = useState(() => ({ scope: scopeKey, filter: { ...NO_FILTER, ...initial.filter } }));
  const filter = scopedFilter(filterState, scopeKey);
  const applied = useDeferredValue(filter);
  const patchFilter = (patch) => setFilterState({ scope: scopeKey, filter: { ...filter, ...patch } });
  const clearFilter = () => setFilterState({ scope: scopeKey, filter: NO_FILTER });
  // Folded groups are keyed by their id (deck or topic), so a refresh or a switch of grouping never closes what the learner opened; the set lasts for the tab.
  const [openGroups, setOpenGroups] = useState(() => (initial.groups === 'all'
    ? new Set(groupRows(filterRows(items || [], { ...NO_FILTER, ...initial.filter }), groupBy, data?.decks).map((group) => group.key))
    : Array.isArray(initial.groups) ? new Set(initial.groups) : readOpenGroups(openKey)));
  useEffect(() => { saveOpenGroups(openKey, openGroups); }, [openKey, openGroups]);
  const [recsAll, setRecsAll] = useState(!!initial.recsAll);
  const [recsOpen, setRecsOpen] = useState(!!initial.recsOpen || !!initial.recsAll);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(Boolean(initial.diagnosticsOpen || initial.recsOpen || initial.recsAll));
  const [recOpen, setRecOpen] = useState(() => new Set());
  const [choice, setChoice] = useState(initial.retrain || null);
  const [ask, setAsk] = useState(initial.askConsent ? { cards: [] } : null);
  const [rescuePrompt, setRescuePrompt] = useState(initial.rescuePrompt || null);
  const [rescuingCard, setRescuingCard] = useState(null);
  const [pending, setPending] = useState(() => new Set());
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState(null);
  const consentRef = useRef(null);

  const rows = useMemo(() => items || [], [items]);
  const total = rows.length;
  const recItems = useMemo(() => recs?.items || [], [recs]);
  const localDecks = useMemo(() => decksInCourse(data, course, showInactive), [data, course, showInactive]);
  const scopedAttempts = useMemo(() => scopedAttemptsOf(data, course, localDecks), [data, course, localDecks]);
  const scopedCaseDecks = useMemo(() => localDecks.filter((deck) => deck.format === "case-study" && deck.available !== 0), [localDecks]);
  const shortName = useMemo(() => shortDeckNames(rows, data?.decks), [rows, data?.decks]);
  const shown = useMemo(() => filterRows(rows, applied), [rows, applied]);
  const wrongCounts = useMemo(() => {
    if (!Array.isArray(data?.attempts) || !data.attempts.length) return null;
    const map = new Map();
    for (const attempt of data.attempts) {
      if (!attempt || attempt.retry || !(attempt.grade < 3)) continue;
      const key = `${attempt.deckId}\0${attempt.quiz_id}`;
      map.set(key, (map.get(key) || 0) + 1);
    }
    return map;
  }, [data?.attempts]);
  const groups = useMemo(
    () => sortGroupRows(groupRows(shown, groupBy, data?.decks), sortBy, { decks: data?.decks, wrongCounts }),
    [shown, groupBy, data?.decks, sortBy, wrongCounts]
  );
  const deckById = useMemo(() => new Map((data?.decks || []).map((deck) => [deck.id, deck])), [data?.decks]);
  const cardByRef = useMemo(() => {
    const map = new Map();
    for (const deck of data?.decks || []) {
      if (!deck?.id || !Array.isArray(deck.cards)) continue;
      for (const card of deck.cards) {
        if (card?.id) map.set(`${deck.id}\0${card.id}`, card);
      }
    }
    return map;
  }, [data?.decks]);
  const sourceById = useMemo(() => new Map((data?.sources || []).map((src) => [src.id, src])), [data?.sources]);
  const rowByCardId = useMemo(() => new Map(rows.map((row) => [row.cardId, row])), [rows]);
  const courseOfDeck = useMemo(() => new Map((data?.decks || []).map((deck) => [deck.id, deck.course ?? deck.folder ?? ''])), [data?.decks]);
  const resolveSourceForRow = useCallback(
    (item) => resolveCardSourceTarget(item, { deckById, cardByRef, sourceById, sources: data?.sources }),
    [deckById, cardByRef, sourceById, data?.sources],
  );
  const resolveCompanionForRow = useCallback((item) => {
    if (!item) return null;
    const card = cardByRef.get(`${item.deckId}\0${item.cardId}`) || item;
    return resolveCompanionTarget({
      card,
      courses: data?.courses,
      sources: data?.sources,
      fallbackCourse: courseOfDeck.get(item.deckId) || '',
    });
  }, [cardByRef, data?.courses, data?.sources, courseOfDeck]);
  const expandedTargets = useMemo(() => {
    const sourcesMap = new Map();
    const companionsMap = new Map();
    if (!expanded.size) return { sources: sourcesMap, companions: companionsMap };
    for (const cardId of expanded) {
      const item = rowByCardId.get(cardId);
      if (!item) continue;
      const src = resolveSourceForRow(item);
      if (src) sourcesMap.set(cardId, src);
      const comp = resolveCompanionForRow(item);
      if (comp) companionsMap.set(cardId, comp);
    }
    return { sources: sourcesMap, companions: companionsMap };
  }, [expanded, rowByCardId, resolveSourceForRow, resolveCompanionForRow]);
  const choices = useMemo(() => deckChoices(rows, data?.decks), [rows, data?.decks]);
  const filtering = filterActive(applied);
  const kindsHere = useMemo(() => statusCounts(rows), [rows]);
  const kindsShown = useMemo(() => statusCounts(filterRows(rows, { ...applied, status: 'all' })), [rows, applied]);
  // 顽固题 (lib/leech.js): the thresholds are the learner's own (设置 › 练习); how many of the rows the other filters leave are one.
  const limits = useMemo(() => leechLimits(data?.settings?.practice), [data?.settings?.practice]);
  const leechShown = useMemo(() => leechCount(filterRows(rows, { ...applied, leech: false, only: null })), [rows, applied]);
  const onlyShown = useMemo(() => (Array.isArray(applied.only) ? filterRows(rows, { ...NO_FILTER, only: applied.only }).length : 0), [rows, applied]);
  // The result page of a round asked to open on exactly its 顽固题 (ui/Review.jsx; the container read the request once): applied when the list of that scope has come, with
  // the groups holding them open, so the rows shown are the ones the line counted. The chip below widens it to every 顽固题.
  const appliedArrival = useRef(null);
  useEffect(() => {
    if (!arrival?.refs || !items || appliedArrival.current === arrival) return;
    appliedArrival.current = arrival;
    const filterNow = { ...NO_FILTER, only: arrival.refs };
    setFilterState({ scope: scopeKey, filter: filterNow });
    setOpenGroups((previous) => new Set([...previous, ...groupRows(filterRows(items, filterNow), groupBy, data?.decks).map((group) => group.key)]));
  }, [arrival, items, scopeKey, groupBy, data?.decks]);
  const hasCoach = !!coach;
  const hasModelField = data?.model !== undefined || data?.modelReady !== undefined;
  const generationModelReady = hasModelField ? modelReadiness(data).ready : true;
  const modelReady = generationModelReady && (!hasCoach || !!coach.enabled);
  const openModel = onOpenSettings || (onSettings ? () => onSettings("settings-model") : undefined);
  const openProfileSettings = onSettings ? () => onSettings("settings-profile") : undefined;
  const activeRescuePrompt = rescuePrompt
    && !(rescuePrompt.type === "rescue-handoff" && generationModelReady)
    && !(rescuePrompt.type === "no-model" && (rescuePrompt.kind === "experiment" ? generationModelReady : modelReady))
    && !(rescuePrompt.type === "consent" && coach?.consent === true)
    ? rescuePrompt
    : null;
  const activeExperimentJobs = experimentJobs || initial.experimentJobs || {};
  const gated = hasCoach && !coach.enabled;
  const canGenerate = hasCoach && coach.enabled && !!onGenerate;
  const rowIds = new Set(rows.map((row) => row.cardId));
  const readyHere = (coach?.readyCards || []).filter((variant) => rowIds.has(variant.originCardId));
  const settingClinicOn = wrongbookClinic(data?.settings?.practice);
  const [clinicOverride, setClinicOverride] = useState(null);
  const [togglingClinic, setTogglingClinic] = useState(false);
  useEffect(() => { setClinicOverride(null); }, [settingClinicOn]);
  const clinicOn = clinicOverride ?? settingClinicOn;
  const handleToggleClinic = async (next) => {
    if (typeof onToggleClinic !== "function" || togglingClinic) return;
    setClinicOverride(next);
    setTogglingClinic(true);
    try {
      const ok = await onToggleClinic(next);
      if (ok === false) setClinicOverride(null);
    } catch {
      setClinicOverride(null);
    } finally {
      setTogglingClinic(false);
    }
  };
  const focusedOnly = Array.isArray(applied.only) && applied.only.length > 0 && shown.length > 0;
  const clinicLanes = useMemo(() => {
    if (!clinicOn || isHistory || focusedOnly || rows.length < 2) return [];
    const sourceTargetByCard = new Map();
    const companionTargetByCard = new Map();
    const hidTargetByCard = new Map();
    for (const item of rows) {
      const src = resolveSourceForRow(item);
      if (src) sourceTargetByCard.set(item.cardId, src);
      const comp = resolveCompanionForRow(item);
      if (comp) companionTargetByCard.set(item.cardId, comp);
      const card = cardByRef.get(`${item.deckId}\0${item.cardId}`) || null;
      const hid = String(card?.hid || item?.hid || '').trim();
      if (hid) hidTargetByCard.set(item.cardId, { hid, title: String(card?.pointTitle || item?.pointTitle || item?.topic || '').trim() });
    }
    return buildWrongbookClinic({ rows, sourceTargetByCard, companionTargetByCard, hidTargetByCard, wrongCounts });
  }, [clinicOn, isHistory, focusedOnly, rows, resolveSourceForRow, resolveCompanionForRow, cardByRef, wrongCounts]);
  const stateOf = (cardId) => variantState(coach, cardId, pending);
  const eligible = (list) => list.filter((row) => stateOf(row.cardId).kind === "none" || stateOf(row.cardId).kind === "failed");
  const toggle = (set, setter, key) => setter((previous) => {
    const next = new Set(previous);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const { options, fallback } = retrainOptions({ mistakes: total, similar: recItems.length, variants: readyHere.length, paged: !!hasMore });
  // The default practice mode is decided once, from what the learner could see when the area first appeared (#206): recommendations that are found
  // later update the counts and add a note, but never switch the mode under the learner or change the number on the start button.
  const firstDefault = useRef(null);
  if (!total) firstDefault.current = null;
  else if (firstDefault.current === null) firstDefault.current = fallback;
  const wanted = choice ?? firstDefault.current;
  const picked = options.find((option) => option.value === wanted && !option.disabled) ? wanted : fallback;
  const current = options.find((option) => option.value === picked);
  // Why a 重练 choice is disabled, one line each, and what to do about missing variants (#577).
  const unavailable = options.filter((option) => option.disabled).map((option) => uiFormat("「{0}」暂不能选：{1}。",
    [option.label, option.value === "variants" && coach?.preparing ? ui("变式正在生成") : option.reason]));
  if (options.some((option) => option.value === "variants" && option.disabled) && canGenerate && !coach?.preparing) unavailable.push(ui("先为错题生成变式，写好后就能选。"));
  const unavailableTip = unavailable.length ? unavailable.map((line, index) => <React.Fragment key={index}>{index > 0 && <br />}{line}</React.Fragment>) : null;
  const notifyCapped = (count, { group = false } = {}) => {
    const note = practiceCappedText(count, { group });
    if (onNotify) onNotify(note);
    else setMessage({ tone: "info", text: note });
  };
  const afterPracticeStart = (result, count, options) => {
    if (result && typeof result.then === "function") {
      result.then((started) => { if (started) notifyCapped(count, options); }, () => {});
      return;
    }
    if (result !== false) notifyCapped(count, options);
  };
  const practiceScope = (refs, { group = false } = {}) => {
    const { scope, total: count, capped } = capPracticeScope(refs);
    const result = onPractice(scope);
    if (capped) afterPracticeStart(result, count, { group });
  };
  const startRetrain = () => {
    const mistakes = rows.map(refOf);
    if (picked === "similar") practiceScope([...mistakes, ...recItems.map(refOf)]);
    else if (picked === "variants" && onPracticePrepared) {
      const { scope, total: count, capped } = capPracticeScope(mistakes);
      const result = onPracticePrepared({ scope, originCardIds: [...new Set(readyHere.map((variant) => variant.originCardId))] });
      if (capped) afterPracticeStart(result, count, { group: false });
    } else practiceScope(mistakes);
  };

  async function run(cards, consent) {
    const chosen = cards.slice(0, VARIANT_BATCH_CAP).map(refOf);
    if (!chosen.length) return;
    setWorking(true);
    setAsk(null);
    setMessage(null);
    setPending(new Set(chosen.map((card) => card.cardId)));
    try {
      const result = await onGenerate(chosen, { consent });
      setPending(new Set());
      // No answer: the app was already writing something else (one write at a time), or the library changed; nothing was started.
      if (!result) return;
      if (result?.needsConsent) { setAsk({ cards }); return; }
      const queued = result?.queued || 0;
      setMessage(queued
        ? { tone: "success", text: uiFormat("已开始为 {0} 道题生成变式，通常一两分钟；写好后这里会出现「去练」。", [queued])
          + (result.deferred || cards.length > chosen.length ? " " + uiFormat("一次最多 {0} 题，另有 {1} 题等这批写好后再点一次。", [VARIANT_BATCH_CAP, (result.deferred || 0) + Math.max(0, cards.length - chosen.length)]) : "") }
        : { tone: "info", text: ui("这些题已经有变式，或正在生成。") });
    } catch (e) {
      setPending(new Set());
      setMessage({ tone: "error", text: errorMessage(e) });
    } finally {
      setWorking(false);
    }
  }
  const generate = (cards) => {
    if (!cards.length || working) return;
    if (coach?.consent !== true) {
      setAsk({ cards });
      requestAnimationFrame?.(() => consentRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" }));
      return;
    }
    run(cards, false);
  };

  const openRow = (item) => {
    toggle(expanded, setExpanded, item.cardId);
    if (!expanded.has(item.cardId)) onLoadDetail?.(refOf(item));
  };
  const batch = eligible(shown);
  // A short list is read as it stands: the filter bar, the grouping switch and fold-all come with FILTER_MIN mistakes (or while a filter is on, so it can be cleared).
  const showBar = total >= filterMin || filtering;
  const oneGroup = groups.length === 1;
  // One question has its own generate button; the batch is for a page with more than one that could use it.
  const showBatch = !isHistory && canGenerate && batch.length > 1;
  const toggleGroup = (key) => toggle(openGroups, setOpenGroups, key);
  const allOpen = groups.length > 0 && groups.every((group) => openGroups.has(group.key));
  const anyOpen = groups.some((group) => openGroups.has(group.key));
  const onlyThisDeck = (group) => {
    patchFilter({ deck: group.deckIds[0] });
    setOpenGroups((previous) => new Set(previous).add(group.key));
  };
  const recsShown = recsAll ? recItems : recItems.slice(0, RECS_PREVIEW);
  // One folded line from the first paint, so the answer never inserts a block above the list (#206).
  const showRecs = !isHistory && total > 0 && (!!recs || recsLoading);
  const hasRubricSkills = useMemo(() => !isHistory && rubricSkills(scopedAttempts).length > 0, [isHistory, scopedAttempts]);
  const canToggleClinic = !isHistory && rows.length >= 2 && typeof onToggleClinic === "function";
  const showWeaknessBar = !isHistory && total >= filterMin;
  const hasDiagnostics = !isHistory && (hasRubricSkills || clinicLanes.length > 0 || canToggleClinic || showRecs || showWeaknessBar);
  const diagnosticsMeta = joinMeta([
    clinicLanes.length > 0 && uiFormat("{0} 条清零建议", [clinicLanes.length]),
    recItems.length > 0 && uiFormat("同类题 {0} 道", [recItems.length]),
    showWeaknessBar && uiFormat("分布 {0} 组", [groups.length]),
  ]);
  const practiceRec = (rec) => onPractice([refOf(rec)]);
  const groupsId = useId();
  // A group draws its rows in chunks (ChunkedRows); another filter, grouping, view, scope or page starts every group from its first chunk again.
  const chunkKey = useMemo(() => JSON.stringify([scopeKey, applied, groupBy, sortBy, view, page]), [scopeKey, applied, groupBy, sortBy, view, page]);
  // A segment of 薄弱点分布 takes the learner to its group: the row's own 只看这个题组 when the group is one deck, otherwise open it and go there.
  const pickGroup = (group) => {
    if (group.deckIds.length === 1) { onlyThisDeck(group); return; }
    setOpenGroups((previous) => new Set(previous).add(group.key));
    // In one scroll, not an animation, and re-checked once frames settle in case an open chunked group right above appended a batch (#900, #930).
    requestAnimationFrame?.(() => {
      const target = document.getElementById(`${groupsId}-${group.key}`)?.closest(".wb-group");
      if (target) scrollToAnchor(target, { block: "start" });
    });
  };
  const batchButton = (
    <div className="wb-batch">
      <Tooltip layer content={generateTip()}>
        <Button size="sm" icon="sparkle" data-tour="wrongbook-batch" busy={working} disabled={busy || !batch.length} onClick={() => generate(batch)}>
          {filtering ? uiFormat("为当前筛选的 {0} 题生成变式", [shown.length]) : ui("为全部错题生成变式")}
        </Button>
      </Tooltip>
    </div>
  );
  const triggerRescue = async (kind, item, options) => {
    if (!options?.consent) {
      const gate = rescueGate(kind, { modelReady, consent: !hasCoach || coach?.consent === true, canChat });
      if (gate.type !== "run") {
        setRescuePrompt({ cardId: item.cardId, ...gate });
        return;
      }
    }
    setRescuePrompt(null);
    if (!onRescue) return;
    setRescuingCard(item.cardId);
    try {
      await onRescue(kind, item, options);
    } finally {
      setRescuingCard(null);
    }
  };
  const triggerExperiment = async (item, detail) => {
    const gate = rescueGate('experiment', { modelReady: generationModelReady, canChat });
    if (gate.type !== 'run') {
      setRescuePrompt({ cardId: item.cardId, ...gate });
      return;
    }
    setRescuePrompt(null);
    if (!onStartExperiment) return;
    await onStartExperiment(item, detail, courseOfDeck.get(item.deckId) || (course && course !== '*' ? course : ''));
  };
  const triggerClusterExperiment = async (lane, jobKey) => {
    const clusterCourse = (lane.deckIds?.length ? courseOfDeck.get(lane.deckIds[0]) : '') || (course && course !== '*' ? course : '');
    const gate = rescueGate('experiment', { modelReady: generationModelReady, canChat });
    if (gate.type !== 'run') {
      setRescuePrompt({ cardId: jobKey, course: clusterCourse, ...gate });
      return;
    }
    setRescuePrompt(null);
    if (onStartClusterExperiment) {
      await onStartClusterExperiment(lane, jobKey, clusterCourse);
      return;
    }
    if (onStartExperiment && lane.refs?.[0]) {
      await onStartExperiment(
        { deckId: lane.refs[0].deckId, cardId: lane.refs[0].cardId, hid: lane.hid || '', topic: lane.pointTitle || lane.sourceTitle || '' },
        null,
        clusterCourse,
      );
    }
  };
  const dismissRescue = () => setRescuePrompt(null);
  const openCardSource = (target) => {
    if (!target?.source || !openModal) return;
    openModal({
      type: "source",
      source: target.source,
      ...(target.quote ? { quote: target.quote } : {}),
      ...(target.peekPage != null ? { peekPage: target.peekPage } : {}),
      back: true,
    });
  };
  const openCardCompanion = (target) => {
    if (!target || !openModal) return;
    openCompanionTarget(openModal, target, { returnLabel: ui("返回错题"), from: "wrongbook" });
  };
  const openConfusable = async (triage, item, itemCourse) => {
    if (onOpenConfusable) { await onOpenConfusable(triage, item, itemCourse); return; }
    const pair = triage?.confusable;
    const targetCourse = itemCourse || courseOfDeck.get(item?.deckId) || (course && course !== '*' ? course : '');
    const hid = triage?.hid || pair?.hids?.find(Boolean) || item?.hid || '';
    if (pair?.rows?.length && call && openModal) {
      try {
        const res = await call('companion.compile', {
          confusables: [pair],
          course: targetCourse || undefined,
          ...(hid ? { hid } : {}),
          language: getUiLanguage(),
          mountMode: 'companion-only',
        });
        if (res?.companion?.id) {
          openCompanionTarget(openModal, {
            companionId: res.companion.id,
            course: res.companion.course || targetCourse || '',
            companionTitle: res.companion.title || '',
            returnLabel: ui("返回错题"),
            from: "wrongbook",
          });
          return;
        }
      } catch (failure) {
        if (!onOpenBook) { setMessage({ tone: "error", text: errorMessage(failure) }); return; }
      }
    }
    onOpenBook?.({ course: targetCourse, hid, view: 'lookup' });
  };
  const practicePrereq = (refs) => {
    if (!Array.isArray(refs) || !refs.length || !onPractice) return;
    practiceScope(refs);
  };
  const toggleGroupDetails = (capRows, allExpanded) => {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (allExpanded) {
        for (const row of capRows) next.delete(row.cardId);
      } else {
        for (const row of capRows) next.add(row.cardId);
      }
      return next;
    });
  };
  const onRowsKeyDown = (event, groupRowsList) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
    const target = event.target;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    if (event.key === "Escape") {
      const rowEl = target?.closest?.(".wb-row");
      const toggleBtn = rowEl?.querySelector?.(".wb-row-toggle");
      const cardId = toggleBtn?.dataset?.cardId;
      if (cardId && expanded.has(cardId)) {
        const item = groupRowsList.find((row) => row.cardId === cardId);
        if (item) {
          event.preventDefault();
          event.stopPropagation();
          handlers.open(item);
          toggleBtn?.focus?.();
          return;
        }
      }
    }
    const toggleEl = target?.closest?.(".wb-row-toggle");
    if (!toggleEl) return;
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const toggles = [...event.currentTarget.querySelectorAll(".wb-row-toggle")];
      const index = toggles.indexOf(toggleEl);
      if (index < 0 || !toggles.length) return;
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown" ? Math.min(toggles.length - 1, index + 1)
        : event.key === "ArrowUp" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
        : toggles.length - 1;
      toggles[nextIndex]?.focus?.();
      return;
    }
    if (event.key === "l" || event.key === "L") {
      const cardId = toggleEl.dataset?.cardId;
      const item = cardId ? groupRowsList.find((row) => row.cardId === cardId) : null;
      if (item && !busy && onPractice) {
        event.preventDefault();
        handlers.practice(item);
      }
      return;
    }
    if (event.key === "o" || event.key === "O") {
      const cardId = toggleEl.dataset?.cardId;
      const item = cardId ? rowByCardId.get(cardId) : null;
      const srcTarget = item ? resolveSourceForRow(item) : null;
      if (srcTarget?.source && openModal) {
        event.preventDefault();
        handlers.openSource(srcTarget);
      }
    }
  };
  // The handlers every row shares; the row itself is memoised, so these must keep their identity from render to render.
  const latest = useRef(null);
  latest.current = { openRow, generate, onPractice, onPracticePrepared, practiceRec, triggerRescue, triggerExperiment, openConfusable, onOpenBook, practicePrereq, dismissRescue, openModel, openProfileSettings, openCardSource, openCardCompanion };
  const handlers = useMemo(() => ({
    open: (item) => latest.current.openRow(item),
    generate: (item) => latest.current.generate([item]),
    practice: (item) => latest.current.onPractice([refOf(item)]),
    practicePrepared: (item) => latest.current.onPracticePrepared({ originCardIds: [item.cardId] }),
    practiceRec: (rec) => latest.current.practiceRec(rec),
    rescue: (kind, item, options) => latest.current.triggerRescue(kind, item, options),
    startExperiment: (item, detail) => latest.current.triggerExperiment(item, detail),
    openConfusable: (triage, item, itemCourse) => latest.current.openConfusable(triage, item, itemCourse),
    openBook: (target) => latest.current.onOpenBook?.(target),
    practicePrereq: (refs) => latest.current.practicePrereq(refs),
    dismissRescue: () => latest.current.dismissRescue(),
    openModel: () => latest.current.openModel?.(),
    openProfileSettings: () => latest.current.openProfileSettings?.(),
    openSource: (target) => latest.current.openCardSource(target),
    openCompanion: (target) => latest.current.openCardCompanion(target),
  }), []);

  return (
    <section className="page wb">
      <PageHeader title={ui("错题与待巩固")}
        scope={<PageScope courses={data?.focus?.courses} value={course} onChange={onCourse} showInactive={showInactive} onShowInactive={onShowInactive} />} />

      {err && <ErrorState error={items ? uiFormat("没能刷新，下面仍是上次读到的内容：{0}", [err]) : err} onRetry={busy || loading ? undefined : () => onReload(page)} />}
      {loading && !items && <LoadingState label={ui(isHistory ? "正在读取已订正的错题…" : "正在读取待巩固题…")} />}

      {/* 待巩固 / 已订正 first: a cleared 待巩固 page must not read as "no mistakes ever" (the field report). */}
      {showViews && (
        <div className="wb-views">
          <SegmentedControl className="wb-views__seg" itemClassName="wb-views__seg-item" label={ui("错题视图")} value={view} size="sm" onChange={onView}
            options={[{ value: "weak", label: uiFormat("待巩固 {0}", [weakCount]) }, { value: "history", label: uiFormat("已订正 {0}", [historyCount]) }]} />
        </div>
      )}
      <p className="wb-headline">{wrongBookHeadline({ isHistory, counts, historyCount, status: filter.status,
        onToggle: (kind) => patchFilter({ status: filter.status === kind ? "all" : kind }) })}</p>

      {!isHistory && hasCoach && onPracticePrepared && coach.ready > 0 && (
        <Banner tone="success" icon="sparkle" title={uiFormat("已为你备好 {0} 道变式题", [coach.ready])}
          action={{ label: ui("去练"), iconEnd: "arrow-right", onClick: () => onPracticePrepared({}), disabled: busy }}>
          {ui("它们由你的错题改写而来，开练后会放进「为你定制」。")}
        </Banner>
      )}

      {!isHistory && total > 0 && (() => {
        const filteredSubset = filtering && shown.length > 0 && shown.length < rows.length;
        return (
          <div className="wb-retrain" data-tour="wrongbook-retrain">
            <div className="wb-retrain-copy">
              <strong>{ui("重练")}</strong>
              <small className="muted">{ui("选择这一轮练什么。")}</small>
            </div>
            {/* A disabled choice cannot take focus or a hover of its own, so the group says why on hover and on focus (an empty tip draws nothing). */}
            <Tooltip layer anchorClassName="wb-retrain-pick" content={unavailableTip}>
              <SegmentedControl className="wb-retrain__seg" itemClassName="wb-retrain__seg-item" label={ui("重练范围")} value={picked} options={options} onChange={setChoice} disabled={busy || loading} />
            </Tooltip>
            {/* When arriving on a focused subset (e.g., from a round's result page), promote that subset to the page's sole primary CTA. */}
            {focusedOnly && filteredSubset ? (
              <>
                <Tooltip layer content={shown.length > PRACTICE_SCOPE_CAP ? practiceCappedText(shown.length, { group: false }) : ui("只练下面筛选出来的错题")}>
                  <Button className="wb-retrain__btn" variant="primary" iconEnd="arrow-right" lock={busy || loading} onClick={() => practiceScope(shown.map(refOf))}>
                    {uiFormat("练筛选的 {0} 道", [shown.length])}
                  </Button>
                </Tooltip>
                <Button className="wb-retrain__btn" variant="secondary" iconEnd="arrow-right" disabled={!total} lock={busy || loading} onClick={startRetrain}>
                  {uiFormat("开始重练 · {0} 题", [current.count])}
                </Button>
              </>
            ) : (
              <>
                {/* The one start of the page: the scope above decides what it takes (the mistakes, with the similar questions, with the prepared variants). */}
                <Button className="wb-retrain__btn" variant="primary" iconEnd="arrow-right" disabled={!total} lock={busy || loading} onClick={startRetrain}>
                  {uiFormat("开始重练 · {0} 题", [current.count])}
                </Button>
                {/* The start takes the whole page, whatever the filter shows; with a filter on, what is shown has its own, quieter button. */}
                {filteredSubset && (
                  <Tooltip layer content={shown.length > PRACTICE_SCOPE_CAP ? practiceCappedText(shown.length, { group: false }) : ui("只练下面筛选出来的错题")}>
                    <Button className="wb-retrain__btn" variant="secondary" iconEnd="arrow-right" lock={busy || loading} onClick={() => practiceScope(shown.map(refOf))}>
                      {uiFormat("练筛选的 {0} 道", [shown.length])}
                    </Button>
                  </Tooltip>
                )}
              </>
            )}
          </div>
        );
      })()}

      {/* Secondary diagnostic blocks fold into one disclosure so wrong questions sit immediately above the fold while preserving all tour anchors. */}
      {hasDiagnostics && (
        <details
          className="wb-diagnostics-fold"
          open={diagnosticsOpen}
          onToggle={(event) => setDiagnosticsOpen(event.currentTarget.open)}
        >
          <summary className="wb-diagnostics-fold__summary">
            <span className="wb-diagnostics-fold__title">{ui("错题诊断与推荐")}</span>
            {diagnosticsMeta && <span className="muted wb-diagnostics-fold__meta">{diagnosticsMeta}</span>}
          </summary>
          <div className="wb-diagnostics-fold__body">
            {/* Weak rubric criteria as skills (WP12): case linkage, assumptions, justification… */}
            <RubricSkills attempts={scopedAttempts} practiceLabel={ui("练案例题")}
              onPractice={scopedCaseDecks.length
                ? () => onPractice(scopedCaseDecks.map((deck) => ({ deckId: deck.id }))) : undefined} />

            {/* 显示靶向清零处方 shows the 处方 below or not: a display switch looks like one and says whether it is on, the same switch either way (#1707). */}
            {canToggleClinic && (
              <div className="wb-plan-offer" data-wrongbook-plan-toggle="">
                <Switch label={ui("显示靶向清零处方")} hint={ui("按同页出处、顽固题与单次失误整理（不消耗模型）")}
                  checked={clinicOn} disabled={togglingClinic} onChange={handleToggleClinic} />
              </div>
            )}
            {clinicLanes.length > 0 && (
              <WrongBookClinic lanes={clinicLanes} filterLeech={!!filter.leech} loading={loading}
                course={course && course !== '*' ? course : ''} canChat={canChat} canOpenModel={!!openModel}
                canOpenSource={!!openModal} canPractice={!!onPractice}
                experimentJobs={activeExperimentJobs} rescuePrompt={activeRescuePrompt}
                onOpenSource={openCardSource} onOpenCompanion={openCardCompanion}
                onPracticeScope={(refs) => practiceScope(refs)}
                onToggleLeech={() => patchFilter({ leech: !filter.leech })}
                onRescueCluster={(onStartClusterExperiment || onStartExperiment) ? triggerClusterExperiment : undefined}
                onDismissRescue={dismissRescue} onOpenModel={openModel} />
            )}

            {showRecs && (
              <section className={"wb-recs" + (recsOpen && recItems.length ? " is-open" : "")} aria-labelledby="wb-recs-title" data-tour="wrongbook-recs">
                <div className="wb-recs-bar">
                  {/* The fold arrow's place is kept while there is nothing to fold, so the title does not move when the answer arrives. */}
                  {recItems.length > 0
                    ? <DisclosureToggle open={recsOpen} onToggle={setRecsOpen} controls="wb-recs-body" label={foldLabel(recsOpen, ui("为你推荐"))} />
                    : <span className="wb-recs-spacer" aria-hidden="true" />}
                  <h2 id="wb-recs-title">{ui("为你推荐")}<span className="wb-free">{ui("不消耗模型")}</span></h2>
                  {/* What was found and how it is practised: the page's one start takes it when 「错题 + 同类题」 is the scope. */}
                  <span className="muted wb-recs-status" role="status">{recItems.length === 0 ? (recsLoading ? ui("正在查找同类题…") : ui("题库里没有找到合适的同类题"))
                    : picked === "similar" ? uiFormat("共 {0} 道，已在这一轮重练里", [recItems.length])
                      : uiFormat("共 {0} 道，选「错题 + 同类题」来练", [recItems.length])}</span>
                </div>
                {recsOpen && recItems.length > 0 && (
                  <div id="wb-recs-body" className="wb-recs-body">
                    <p className="muted">{ui("题库里已有的相似题：同主题、引用同一页，或关键词相近；已排除你刚答对的。")}</p>
                    <ul className="wb-rec-list">
                      {recsShown.map((rec) => (
                        <RecRow key={rec.deckId + rec.cardId} rec={rec} shortName={shortName} disabled={busy}
                          open={recOpen.has(rec.cardId)} onToggle={() => toggle(recOpen, setRecOpen, rec.cardId)} onPractice={() => practiceRec(rec)} />
                      ))}
                    </ul>
                    {recItems.length > RECS_PREVIEW && (
                      <Button className="wb-recs-body__more" variant="link" size="sm" onClick={() => setRecsAll(!recsAll)}>
                        {recsAll ? ui("收起") : uiFormat("再显示 {0} 道", [recItems.length - RECS_PREVIEW])}
                      </Button>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Where the mistakes are, before a learner opens groups one by one (#748). */}
            {showWeaknessBar && <WeaknessBar groups={groups} onPick={pickGroup} />}
          </div>
        </details>
      )}

      {items && !counts.total && (isHistory ? (
        <EmptyState data-tour="wrongbook-list" icon="success" title={ui("还没有已订正的错题")}
          description={ui("答对一次后，错题会移到这里，作为历史保留，随时可以再练。")} />
      ) : (
        <EmptyState data-tour="wrongbook-list" icon="success"
          data-tone={historyCount > 0 ? "success" : undefined}
          className={historyCount > 0 ? "wb-cleared-milestone" : undefined}
          title={historyCount > 0 ? ui("待巩固已清零 · 目前没有待巩固的题") : (data?.attempts?.length ? ui("目前没有待巩固的题") : ui("还没有练习记录"))}
          description={historyCount > 0
            ? uiFormat("已累计攻克并订正 {0} 道错题；新的错题或低自评题会继续收在这里。", [historyCount])
            : (data?.attempts?.length
              ? ui("客观答错或自评未掌握的题会出现在这里，方便集中重练。")
              : ui("完成一次学习后，答错或自评未掌握的题会收在这里。"))}>
          {historyCount > 0 && <LazyWrongBookClearStamp clearedCount={historyCount} course={course} />}
          <EmptyStudyActions data={{ ...data, decks: localDecks }} onStart={() => onPractice(localDecks.map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
            onCreate={onCreate} onSources={onSources} />
          {historyCount > 0 && onView && (
            <div className="wb-cleared-history">
              <Button variant="secondary" size="sm" iconEnd="arrow-right" onClick={() => onView('history')}>
                {uiFormat("查看已订正记录 ({0})", [historyCount])}
              </Button>
            </div>
          )}
        </EmptyState>
      ))}

      {/* One toolbar under a hairline, no box (#577): how the list is grouped and folded, what it shows, and the one batch action on the right.
          Only from FILTER_MIN mistakes on (or while a filter is on): a short list has nothing to narrow down (#675). */}
      {total > 0 && showBar && (
        <div className="wb-toolbar" data-tour="wrongbook-filter">
          <div className="wb-view">
            <Tooltip layer content={tip(ui('按题组把错题分到各自的题组里；按主题则把不同题组里同一主题的错题放在一起。'), ui('你的选择会被记住。'))}>
              <SegmentedControl label={ui("分组方式")} value={groupBy} onChange={chooseGroupBy} size="sm"
                options={[{ value: "topic", label: ui("按主题") }, { value: "deck", label: ui("按题组") }]} />
            </Tooltip>
            <SegmentedControl className="wb-sort__seg" label={ui("排序方式")} value={sortBy} onChange={chooseSortBy} size="sm"
              options={SORT_KINDS.map((value) => ({ value, label: SORT_LABELS[value]() }))} />
            <span className="wb-fold-all">
              <Button variant="quiet" size="sm" disabled={allOpen || !groups.length} onClick={() => setOpenGroups((previous) => new Set([...previous, ...groups.map((group) => group.key)]))}>{ui("全部展开")}</Button>
              <Button variant="quiet" size="sm" disabled={!anyOpen} onClick={() => setOpenGroups(new Set())}>{ui("全部收起")}</Button>
            </span>
          </div>
          <div className="wb-filter" role="search" aria-label={ui("筛选错题")}>
            <div className="wb-filter-deck">
              <Combobox label={ui("题组")} value={filter.deck} onChange={(value) => patchFilter({ deck: value || '' })} searchPlaceholder={ui("搜索题组")}
                emptyText={(query) => uiFormat("没有叫「{0}」的题组", [query])}
                options={[{ value: '', label: ui("全部题组") },
                  ...choices.map((choice) => ({ value: choice.value, label: choice.label, hint: uiFormat("{0} 题", [choice.count]) })),
                  ...(filter.deck && !choices.some((choice) => choice.value === filter.deck)
                    ? [{ value: filter.deck, label: shortName(deckById.get(filter.deck)?.title) || filter.deck }] : [])]} />
            </div>
            <label className="wb-search">
              <Icon name="search" size={16} className="wb-search-icon" />
              <TextInput type="search" className="wb-search-input" value={filter.query} onChange={(event) => patchFilter({ query: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key !== "Escape") return;
                  if (filter.query) {
                    event.preventDefault();
                    event.stopPropagation();
                    patchFilter({ query: "" });
                  } else {
                    event.currentTarget?.blur?.();
                  }
                }}
                placeholder={ui("搜索题目或主题")} aria-label={ui("搜索题目或主题")} />
            </label>
            <div className="wb-status-group" role="group" aria-label={ui("按状态筛选")}>
              <Tooltip layer content={tip(ui(isHistory ? '显示所有已订正的题。' : '显示所有待巩固的题。'))}>
                <Chip size="sm" selected={filter.status === 'all'} onClick={() => patchFilter({ status: 'all' })}>
                  {ui("全部")} <span className="wb-num">{STATUS_KINDS.reduce((sum, kind) => sum + kindsShown[kind], 0)}</span>
                </Chip>
              </Tooltip>
              {STATUS_KINDS.filter((kind) => kind === 'graded' || kind === 'self' || kindsHere[kind] > 0 || filter.status === kind).map((kind) => (
                <Tooltip key={kind} layer content={statusTip(kind)}>
                  <Chip size="sm" selected={filter.status === kind} onClick={() => patchFilter({ status: filter.status === kind ? 'all' : kind })}>
                    {statusLabel(kind)} <span className="wb-num">{kindsShown[kind]}</span>
                  </Chip>
                </Tooltip>
              ))}
              {Array.isArray(filter.only) && (
                <Tooltip layer content={tip(ui('只看刚练完的这一轮里的顽固题。'), ui('点一下，改看所有顽固题。'))}>
                  <Chip size="sm" selected onClick={() => patchFilter({ only: null, leech: true })}>
                    {ui("本轮的顽固题")} <span className="wb-num">{onlyShown}</span>
                  </Chip>
                </Tooltip>
              )}
              {!Array.isArray(filter.only) && (leechShown > 0 || filter.leech) && (
                <Tooltip layer content={(() => { const words = leechWords(limits); return tip(words.sentence, words.consequence); })()}>
                  <Chip size="sm" selected={!!filter.leech} onClick={() => patchFilter({ leech: !filter.leech })}>
                    {ui("顽固")} <span className="wb-num">{leechShown}</span>
                  </Chip>
                </Tooltip>
              )}
            </div>
          </div>
          <div className="wb-filter-result" role="status" aria-live="polite">
            {canGenerate && batch.length > VARIANT_BATCH_CAP
              ? <Tooltip layer content={tip(uiFormat('这里有 {0} 题可以生成变式，一次最多 {1} 题。', [batch.length, VARIANT_BATCH_CAP]), ui('其余的等这批写好后再点一次。'))}>
                <span tabIndex={0}>{uiFormat("显示 {0} / 共 {1} 题", [shown.length, total])}</span>
              </Tooltip>
              : <span>{uiFormat("显示 {0} / 共 {1} 题", [shown.length, total])}</span>}
            {filtering && <Button variant="link" size="sm" onClick={clearFilter}>{ui("清除筛选")}</Button>}
          </div>
          {/* The batch stays here rather than in each group: it is the only action that takes exactly what the filter shows, across groups (a topic spans
              decks); with more than one group each keeps its own 为本组生成变式. Its cost and cap are in the tooltip, so the bar carries no helper line. */}
          {showBatch && (!filtering || shown.length > 0) && batchButton}
        </div>
      )}
      {total > 0 && !showBar && showBatch && batchButton}

      {!isHistory && gated && total > 0 && (
        <ModelSetupGate feature="variants" model={{ ready: false }} onOpenSettings={onOpenSettings} />
      )}

      {ask && canGenerate && (
        <div className="wb-consent" ref={consentRef} role="group" aria-label={ui("先确认是否备变式题")}>
          <strong>{ui("要让 AI 为错题备变式题吗？")}</strong>
          <p>{ui("生成变式会在后台少量调用模型：每道题约 1 次轻量调用，只用你的原题和原文引用改写，写好的题会放进「为你定制」。可以随时在设置里关闭「陪学」。")}
            {onSettings && <>{" "}<Button iconEnd="arrow-right" variant="link" size="sm" onClick={() => onSettings("settings-profile")}>{ui("前往设置")}</Button></>}</p>
          <div className="wb-consent-actions">
            <Button variant="secondary" icon="sparkle" busy={working} disabled={busy || !ask.cards.length}
              onClick={() => run(ask.cards, true)}>{ui("同意并生成")}</Button>
            <Button variant="quiet" lock={working} onClick={() => setAsk(null)}>{ui("暂不")}</Button>
          </div>
        </div>
      )}
      {message && <InlineMessage tone={message.tone} boxed onDismiss={() => setMessage(null)}>{message.text}</InlineMessage>}

      {total > 0 && !shown.length && (
        <div className="wb-filter-empty" role="status">
          <p>{ui("没有符合筛选的错题")}</p>
          <Button variant="secondary" size="sm" onClick={clearFilter}>{ui("清除筛选")}</Button>
        </div>
      )}
      {groups.map((group, index) => {
        const todo = eligible(group.rows);
        // The one group of a short list is just the list: open, with its title and no fold (#675).
        const flat = oneGroup && group.rows.length < filterMin;
        const isOpen = flat || openGroups.has(group.key);
        const rowsId = `${groupsId}-${group.key}`;
        const title = (
          <span className="wb-group-title">
            <strong>{group.title}</strong>
            <small className="muted wb-num">{uiFormat("{0} 题", [group.rows.length])}</small>
            <small className="wb-summary">{groupSummaryText(group.rows)}</small>
            {group.mode === "topic" && <small className="muted wb-from">{uiFormat("来自 {0}", [group.deckTitles.join("、")])}</small>}
          </span>
        );
        const capRows = group.rows.slice(0, 20);
        const canExpandDetails = isOpen && group.rows.length >= 2;
        const allGroupRowsExpanded = canExpandDetails && capRows.every((row) => expanded.has(row.cardId));
        return (
          <div key={group.key} className={"wb-group" + (isOpen ? " is-open" : "")} {...(index === 0 ? { "data-tour": "wrongbook-list" } : {})}>
            <div className={"wb-group-head" + (flat ? " is-flat" : "")}>
              {flat ? title : (
                <FoldButton className="wb-group-toggle" open={isOpen} controls={rowsId} onClick={() => toggleGroup(group.key)}>
                  <Icon name="chevron" size={16} className="wb-chevron" />
                  {title}
                </FoldButton>
              )}
              {/* With one group these would say what the page's own buttons already say: the start, the filter and the batch. */}
              {(!oneGroup || canExpandDetails) && (
                <div className="wb-group-actions">
                  {canExpandDetails && (
                    <Button size="sm" variant="quiet" onClick={() => toggleGroupDetails(capRows, allGroupRowsExpanded)}>
                      {allGroupRowsExpanded ? ui("收起各题解析") : ui("展开各题解析")}
                    </Button>
                  )}
                  {!oneGroup && group.rows.length > PRACTICE_SCOPE_CAP ? (
                    <Tooltip layer content={practiceCappedText(group.rows.length, { group: true })}>
                      <Button variant="quiet" size="sm" iconEnd="arrow-right" lock={busy} aria-label={uiFormat("练这一组：{0}", [group.title])}
                        onClick={() => practiceScope(group.rows.map(refOf), { group: true })}>{ui("练这一组")}</Button>
                    </Tooltip>
                  ) : !oneGroup && (
                    <Button variant="quiet" size="sm" iconEnd="arrow-right" lock={busy} aria-label={uiFormat("练这一组：{0}", [group.title])}
                      onClick={() => practiceScope(group.rows.map(refOf), { group: true })}>{ui("练这一组")}</Button>
                  )}
                  {!oneGroup && showBar && group.deckIds.length === 1 && applied.deck !== group.deckIds[0] && (
                    <Tooltip layer content={tip(ui('只显示这个题组里的错题。'), ui('点「清除筛选」可以回到全部。'))}>
                      <Button variant="quiet" size="sm" icon="filter" onClick={() => onlyThisDeck(group)}>{ui("只看这个题组")}</Button>
                    </Tooltip>
                  )}
                  {!oneGroup && !isHistory && canGenerate && todo.length > 0 && (
                    <Tooltip layer content={generateTip()}>
                      <Button variant="quiet" size="sm" icon="sparkle" lock={busy || working} onClick={() => generate(todo)}>
                        {uiFormat("为本组生成变式 ({0})", [todo.length])}
                      </Button>
                    </Tooltip>
                  )}
                </div>
              )}
            </div>
            {isOpen && (
              <ul className="wb-rows" id={rowsId} onKeyDown={(event) => onRowsKeyDown(event, group.rows)}>
                <ChunkedRows as="li" items={group.rows} resetKey={chunkKey} render={(it) => (
                  <Row key={it.cardId} it={it} metaText={group.mode === "topic" ? shortName(it.deckTitle) : it.topic || ui("未分类")}
                    query={applied.query.trim()}
                    isOpen={expanded.has(it.cardId)} state={stateOf(it.cardId)} detail={details[it.cardId]}
                    sourceTarget={expanded.has(it.cardId) ? (expandedTargets.sources.get(it.cardId) || null) : null}
                    companionTarget={expanded.has(it.cardId) ? (expandedTargets.companions.get(it.cardId) || null) : null}
                    experimentState={activeExperimentJobs[it.cardId] || null}
                    initialOtherOpen={Array.isArray(initial.rescueOtherOpen) ? initial.rescueOtherOpen.includes(it.cardId) : Boolean(initial.rescueOtherOpen)}
                    recItems={recItems} shortName={shortName}
                    canGenerate={!isHistory && canGenerate} canPracticePrepared={!!onPracticePrepared} disabled={busy} variantDisabled={busy || working} handlers={handlers} limits={limits} course={courseOfDeck.get(it.deckId) || ''} showPractice={isHistory || total !== 1}
                    rescuePrompt={activeRescuePrompt?.cardId === it.cardId ? activeRescuePrompt : null} rescuing={rescuingCard === it.cardId}
                    canOpenModel={!!openModel} canOpenSettings={!!openProfileSettings}
                    canOpenBook={!!onOpenBook} canOpenConfusable={Boolean(onOpenConfusable || (call && openModal) || onOpenBook)} canPracticePrereq={!!onPractice}
                    history={isHistory} mistake={isHistory ? joinMeta([uiFormat("答错 {0} 次", [it.wrongCount ?? 0]), uiFormat("最近答错 {0}", [formatDateTime(it.lastWrongAt, "stamp")])]) : ""} />
                )} />
              </ul>
            )}
          </div>
        );
      })}
      {items && hasMore && <nav className="wb-pages" aria-label={ui(isHistory ? "已订正题分页" : "待巩固题分页")}>
        <span>{uiFormat("第 {0}–{1} 题 / 共 {2} 题", [page * pageSize + 1, page * pageSize + total, counts.total])}</span>
        <Button size="sm" icon="arrow-left" disabled={page === 0} lock={busy || loading} onClick={() => onPage(page - 1)}>{ui("上一页")}</Button>
        <Button size="sm" iconEnd="arrow-right" disabled={(page + 1) * pageSize >= counts.total} lock={busy || loading}
          onClick={() => onPage(page + 1)}>{ui("下一页")}</Button>
      </nav>}
    </section>
  );
}

/** Compute the narrowest course + inactive scope that still includes all arrived question refs. */
export function resolveArrivalScope(refs, data, pinnedCourse, pinnedInactive) {
  if (!Array.isArray(refs) || !refs.length) return { course: pinnedCourse, showInactive: pinnedInactive };
  const deckById = new Map((data?.decks || []).map((deck) => [deck.id, deck]));
  const matched = [];
  let allFound = true;
  for (const ref of refs) {
    const deck = ref?.deckId ? deckById.get(ref.deckId) : null;
    if (!deck) { allFound = false; continue; }
    matched.push(deck);
  }
  if (!matched.length || !allFound) return { course: '*', showInactive: true };
  const anyInactive = matched.some((deck) => !!deck.inactive);
  const courses = [...new Set(matched.map((deck) => deck.course ?? deck.folder ?? ''))];
  const pinnedMatch = courseMatcher(data, pinnedCourse);
  const fitsPinned = courses.every((name) => pinnedMatch(name))
    && (!anyInactive || pinnedInactive || courseParked(data, pinnedCourse));
  if (fitsPinned) return { course: pinnedCourse, showInactive: pinnedInactive };
  if (courses.length === 1) return { course: courses[0], showInactive: anyInactive ? true : pinnedInactive };
  return { course: '*', showInactive: anyInactive ? true : pinnedInactive };
}

export default function WrongBook({ data, onPractice, onPracticePrepared, onOpenSettings, onLibrary, onCreate, onSources, onOpenBook }) {
  const { call, act, openSettings, busy } = useStudy();
  const app = useContext(AppContext);
  const [pinnedCourse, setCourse] = usePageScope(data?.root, 'wrongbook', data?.focus?.course ?? '*');
  const [pinnedInactive, setShowInactive] = useShowInactive(data?.root, 'wrongbook');
  // The result page's line about 顽固题 / 本轮错题 asked this page to open on exactly those questions (ui/Review.jsx).
  // Keep the narrowest scope that contains those questions (staying inside the active course when they belong to one).
  const [arrival, setArrival] = useState(null);
  const [released, setReleased] = useState(false);
  useEffect(() => {
    const taken = takeArrival(data?.root);
    if (taken.refs) { setArrival(taken); setReleased(false); }
  }, [data?.root]);
  const arrived = !!arrival && !released;
  const arrivalScope = arrived ? resolveArrivalScope(arrival.refs, data, pinnedCourse, pinnedInactive) : { course: pinnedCourse, showInactive: pinnedInactive };
  const course = arrivalScope.course, showInactive = arrivalScope.showInactive;
  const chooseCourse = (value) => { setReleased(true); setCourse(value); };
  chooseCourse.scope = setCourse.scope;
  const chooseInactive = (value) => { setReleased(true); setShowInactive(value); };
  // 待巩固 is the page and 已订正 the mistakes it kept: the service reads the chosen view, so neither list is filtered apart here.
  const [view, setView] = useState('weak');
  const toast = useToast();
  const scopeKey = JSON.stringify(scopeArgs(course, showInactive));
  const key = JSON.stringify([scopeKey, view]);
  const [page, setPage] = useState(0);
  const [result, setResult] = useState(null),
    [viewCounts, setViewCounts] = useState({ scope: '', weak: 0, history: 0 }),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState(""),
    [recs, setRecs] = useState(null),
    [details, setDetails] = useState({});
  // The coach status is the host's shared answer (ui/host-query.js): the review debrief and this page see the same copy while variants are written.
  const coachQuery = useHostQuery("coach.status", {}, { call, enabled: false });
  const coachLive = coachQuery.data ?? null;
  const setCoachLive = (value) => setQueryData("coach.status", {}, value);
  const lastOverviewCoach = useRef(data?.coach);
  useEffect(() => {
    if (peekQuery("coach.status", {})) void refreshQuery(call, "coach.status", {});
  }, [call]);
  useEffect(() => {
    if (data?.coach && data.coach !== lastOverviewCoach.current) {
      lastOverviewCoach.current = data.coach;
      setCoachLive(data.coach);
    }
  }, [data?.coach]);
  const seq = useRef(0);
  // What the list looked like at the last full read, whether a read is going on, and the page the learner is on: the watch below compares and reloads from these.
  const signature = useRef('');
  const pageCacheRef = useRef(new Map());
  const detailLoaderRef = useRef(null);
  if (!detailLoaderRef.current || detailLoaderRef.current.call !== call) {
    detailLoaderRef.current = { call, loader: createWrongDetailLoader({ call }) };
  }
  const reading = useRef(false);
  const pageRef = useRef(0);
  pageRef.current = page;
  const busyRef = useRef(false);
  busyRef.current = !!busy;
  const current = result?.key === key ? result : null;
  const items = current?.items;
  const counts = current?.counts || { total: 0, graded: 0, self: 0, oral: 0, rubric: 0 };
  // Both views' counts, as last read in this scope: the switch keeps its numbers while the other view loads, and the header stops at the scope edge.
  const knownViewCounts = viewCounts.scope === scopeKey ? viewCounts : null;
  const coach = coachLive || data?.coach || null;

  // `quiet` is the page re-reading its own list (the watch): nothing flashes, the rows that were opened and the details already read stay, and an answer that
  // says nothing changed leaves the page untouched.
  const load = useCallback(async (requestedPage = 0, { quiet = false, force = false } = {}) => {
    const request = ++seq.current;
    reading.current = true;
    if (!quiet) {
      setLoading(true);
      setErr("");
    }
    try {
      let targetPage = requestedPage;
      const scope = scopeArgs(course, showInactive);
      const readPage = async (at) => {
        const cacheKey = `${scopeKey}\0${view}\0${at}`;
        if (!force && pageCacheRef.current.has(cacheKey)) {
          const cached = pageCacheRef.current.get(cacheKey);
          const probe = await call("wrongbook", { ...scope, view, offset: at * PAGE_SIZE, limit: 1 });
          if (request !== seq.current) return cached.res;
          if (readSignature(probe) === cached.signature) {
            pageCacheRef.current.delete(cacheKey);
            pageCacheRef.current.set(cacheKey, cached);
            return cached.res;
          }
        }
        const fetched = await fetchWrongBookPage(call, {
          scope,
          view,
          page: at,
          pageSize: PAGE_SIZE,
          fetchLimit: FETCH_LIMIT,
          concurrency: PAGE_FETCH_CONCURRENCY,
          isStale: () => request !== seq.current,
        });
        if (request === seq.current) {
          pageCacheRef.current.delete(cacheKey);
          pageCacheRef.current.set(cacheKey, { signature: readSignature(fetched), res: fetched });
          while (pageCacheRef.current.size > PAGE_CACHE_LIMIT) {
            pageCacheRef.current.delete(pageCacheRef.current.keys().next().value);
          }
        }
        return fetched;
      };
      let res = await readPage(targetPage);
      if (targetPage > 0 && !res?.items?.length) {
        targetPage = Math.max(0, Math.ceil((res?.total || 0) / PAGE_SIZE) - 1);
        res = await readPage(targetPage);
      }
      if (request !== seq.current) return;
      signature.current = readSignature(res);
      setErr("");
      // An older service returns no view: read its answer as the weak list, with no history to offer.
      const answerView = res?.view === "history" || res?.view === "weak" ? res.view : "weak";
      const viewTotal = res?.total ?? res?.items?.length ?? 0;
      const numberOf = (value, fallback) => (Number.isFinite(value) ? value : fallback);
      const both = res?.view === "weak" || res?.view === "history"
        ? { weak: numberOf(res?.counts?.weak, answerView === "weak" ? viewTotal : 0), history: numberOf(res?.counts?.history, 0) }
        : { weak: viewTotal, history: 0 };
      const storedKey = JSON.stringify([scopeKey, answerView]);
      setViewCounts({ scope: scopeKey, ...both });
      setResult({ key: storedKey, view: answerView, viewCounts: both,
        counts: { total: viewTotal,
          graded: res?.gradedTotal ?? res?.items?.filter((item) => item.assessment === "graded").length ?? 0,
          self: res?.selfTotal ?? res?.items?.filter((item) => item.assessment === "self").length ?? 0,
          oral: res?.oralTotal ?? res?.items?.filter((item) => item.assessment === "oral").length ?? 0,
          rubric: res?.rubricTotal ?? res?.items?.filter((item) => item.assessment === "rubric").length ?? 0 },
      // Keep this guard for older service versions that still return suspended cards.
        items: (res?.items || []).filter((it) => it && it.deckId && it.cardId && !it.suspended) });
      setPage(targetPage);
      if (!quiet) {
        asked.current = new Set();
        setDetails({});
      }
      // Similar questions are a bonus of the weak list: a library without the read just shows none.
      if (viewTotal && answerView === "weak") call("wrongbook.recommend", { ...scope, limit: 10 })
        .then((found) => request === seq.current && setRecs({ key: storedKey, items: found?.items || [] }))
        .catch(() => request === seq.current && setRecs({ key: storedKey, items: [] }));
      else setRecs(null);
    } catch (e) {
      if (request === seq.current && !quiet) setErr(errorMessage(e));
    } finally {
      if (request === seq.current) {
        reading.current = false;
        setLoading(false);
      }
    }
  }, [call, course, showInactive, scopeKey, view]);
  useEffect(() => {
    load(0);
  }, [load]);

  // The list keeps itself up to date: while the page is showing, ask for one row (cheap) every WATCH_MS and read the list again only when its counts or its
  // newest row changed. Nothing is asked while the page is reading, busy, or hidden (usePolling), and it comes back to ask at once.
  const watch = useCallback(async () => {
    if (reading.current || busyRef.current) return { unchanged: true };
    const probe = await call("wrongbook", { ...scopeArgs(course, showInactive), view, offset: pageRef.current * PAGE_SIZE, limit: 1 });
    if (readSignature(probe) === signature.current) return { unchanged: true };
    await load(pageRef.current, { quiet: true, force: true });
    return {};
  }, [call, course, showInactive, view, load]);
  usePolling(watch, { intervalMs: WATCH_MS, backoff: true });

  // While variants are being written, watch the cheap status call until they land.
  const preparing = !!coach?.preparing;
  usePolling(coachQuery.refresh, { intervalMs: POLL_MS, enabled: preparing });

  // Track inline row-level & clinic cluster 3–4 slide rescue experiment builds non-blockingly via shared poller.
  const onRescueCompleted = useCallback(() => {
    Promise.resolve(app?.core?.refresh?.()).catch(() => {});
    void load(pageRef.current, { quiet: true, force: true });
  }, [app?.core, load]);
  const { jobs: experimentJobs, start: startRescueJob } = useRescueExperiments({ call, onCompleted: onRescueCompleted });

  const startExperiment = useCallback(async (item, _detail, itemCourse) => {
    const errorReason = item.errorReason || item.triage?.reason || '';
    await startRescueJob(item.cardId, {
      course: itemCourse || '',
      deckId: item.deckId,
      cardIds: [item.cardId],
      ...(item.hid ? { hid: item.hid } : {}),
      ...(errorReason ? { errorReason } : {}),
    });
  }, [startRescueJob]);

  const startClusterExperiment = useCallback(async (lane, jobKey, clusterCourse) => {
    await startRescueJob(jobKey, {
      course: clusterCourse || '',
      ...(lane.deckIds?.length === 1 ? { deckId: lane.deckIds[0] } : {}),
      cardIds: Array.isArray(lane.cardIds) ? lane.cardIds.slice(0, 4) : [],
      ...(lane.hid ? { hid: lane.hid } : {}),
      ...(lane.pointTitle || lane.sourceTitle ? { topic: lane.pointTitle || lane.sourceTitle } : {}),
    });
  }, [startRescueJob]);

  // Starting variants is a write that starts background work: it goes the app's write way (act), which reads the library again after it, so the 任务
  // console and its badge show the day's 为你定制 row at once instead of after the next quiet poll.
  const generate = useCallback(async (cards, { consent } = {}) => {
    const res = await act("coach.variants", { cards, ...(consent ? { consent: true } : {}) }, undefined, { rethrow: true });
    if (res?.status) setCoachLive(res.status);
    return res;
  }, [act]);
  // 顽固题's four ways out, each the action that exists elsewhere: the thumbs-down record that sends a question to the background repair or prepares a
  // prerequisite card (coach.feedback, ui/ThumbFeedback.jsx), the hand-off to the main chat (drawn by the row itself) and 暂停此题 (card.suspend, ui/Manage.jsx).
  // Nothing here starts on its own: each runs from one click, and says what became of it.
  const rescuing = useRef(false);
  const rescue = useCallback(async (kind, item, options = {}) => {
    if (rescuing.current) return;
    rescuing.current = true;
    const { action, args } = rescueCall(kind, { deckId: item.deckId, cardId: item.cardId }, {
      consent: !!options.consent,
      flush: kind === 'easier',
    });
    try {
      if (kind === 'pause') {
        const done = await act(action, args, undefined, { rethrow: true });
        if (done === undefined) { toast.info(ui('刚才还有操作在进行，请稍后再点一次。')); return; }
        pageCacheRef.current.clear();
        await load(pageRef.current, { quiet: true, force: true });
        // The row is gone from the page at once, so the way back is here, not only on the manage page.
        toast.show({ tone: 'success', message: rescueNote(kind, done).text, undo: true, timeout: UNDO_TIMEOUT,
          action: { label: ui('撤销'), onClick: async () => {
            const back = undoPauseCall({ deckId: item.deckId, cardId: item.cardId });
            try {
              const restored = await act(back.action, back.args, undefined, { rethrow: true });
              if (restored === undefined) { toast.info(ui('刚才还有操作在进行，请稍后再点一次。')); return; }
              toast.dismiss();
              pageCacheRef.current.clear();
              await load(pageRef.current, { quiet: true, force: true });
              toast.info(ui('已恢复这道题。'));
            } catch (failure) { toast.error(failure); }
          } } });
        return;
      }
      const done = options.consent
        ? await act(action, args, undefined, { rethrow: true })
        : await call(action, args);
      if (options.consent && done === undefined) {
        toast.info(ui('刚才还有操作在进行，请稍后再点一次。'));
        return;
      }
      if (done?.status) setCoachLive(done.status);
      const note = rescueNote(kind, done);
      const openModel = onOpenSettings || (openSettings ? () => openSettings('settings-model') : undefined);
      const needsModel = !done?.scheduled?.length && done?.status?.enabled === false && openModel;
      toast.show({
        tone: note.tone,
        message: note.text,
        ...(needsModel ? { action: { label: ui('打开模型设置'), iconEnd: 'arrow-right', onClick: openModel } } : {}),
      });
    } catch (failure) { toast.error(failure); }
    finally { rescuing.current = false; }
  }, [act, call, load, onOpenSettings, openSettings, toast]);
  const asked = useRef(new Set());
  const loadDetail = useCallback((ref) => {
    if (asked.current.has(ref.cardId)) return;
    asked.current.add(ref.cardId);
    const cacheKey = `${signature.current}\0${view}\0${ref.deckId}\0${ref.cardId}`;
    const loader = detailLoaderRef.current.loader;
    const cached = loader.getCached(cacheKey);
    if (cached !== undefined) {
      setDetails((known) => ({ ...known, [ref.cardId]: cached }));
      return;
    }
    setDetails((known) => ({ ...known, [ref.cardId]: "loading" }));
    // A history row opens on the answer that was wrong, so the detail is asked in the same view as the list.
    loader.load(cacheKey, { ...ref, ...(view === "history" ? { view: "history" } : {}) })
      .then((detail) => setDetails((now) => ({ ...now, [ref.cardId]: detail })))
      .catch((e) => {
        asked.current.delete(ref.cardId);
        setDetails((now) => ({ ...now, [ref.cardId]: { error: e.message || true } }));
      });
  }, [view]);

  const reloadPage = useCallback((requestedPage = 0) => load(requestedPage, { force: true }), [load]);

  const toggleClinic = useCallback(async (next) => {
    if (typeof act !== "function") return false;
    const res = await act("settings.practice.set", { patch: { wrongbookClinic: next ? true : null } });
    return res !== undefined;
  }, [act]);

  return (
    <WrongBookView data={data} course={course} onCourse={chooseCourse} showInactive={showInactive} onShowInactive={chooseInactive} items={items} counts={counts}
      view={view} onView={setView} viewCounts={current?.viewCounts || knownViewCounts} loading={loading} err={err}
      page={page} pageSize={PAGE_SIZE} hasMore={counts.total > PAGE_SIZE} onReload={reloadPage} onPage={load}
      recs={recs?.key === key ? recs : null} recsLoading={view === "weak" && !!items?.length && recs?.key !== key} coach={coach} details={details} onLoadDetail={loadDetail}
      onPractice={onPractice} onPracticePrepared={onPracticePrepared} onGenerate={generate} onOpenSettings={onOpenSettings} onSettings={openSettings}
      onLibrary={onLibrary} onCreate={onCreate} onSources={onSources} onOpenBook={onOpenBook} onRescue={rescue} onStartExperiment={startExperiment} onStartClusterExperiment={startClusterExperiment} experimentJobs={experimentJobs} onNotify={(text) => toast.info(text)} onToggleClinic={toggleClinic} arrival={arrived ? arrival : null} openKey={`study-wrongbook-open:v1:${data?.root || ""}`} />
  );
}
