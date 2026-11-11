import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import css from "./views.css";
import wrongCss from "./wrongbook.css";
import overlayCss from "./components/overlays.css";
import { useInjectCss, plainPrompt } from "./shared.js";
import Markdown from "./Markdown.jsx";
import StudyInline from "./StudyInline.jsx";
import { usePolling } from "./use-polling.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import { RubricSkills } from "./CaseResult.jsx";
import PageScope, { decksInCourse, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { Badge, Banner, Button, ChunkedRows, Combobox, DisclosureToggle, foldLabel, EmptyState, ErrorState, Icon, InlineMessage, LoadingState, PageHeader, SegmentedControl, TextInput, Tooltip, Chip, useToast } from './components/index.js';
import { scrollToAnchor } from './tour/anchor.js';
import { HandOff } from './hand-off/HandOff.jsx';
import { leechLimits } from '../lib/leech.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { modelReadiness } from './generation-status.js';
import { FILTER_MIN, NO_FILTER, PRACTICE_SCOPE_CAP, RECS_PREVIEW, STATUS_KINDS, VARIANT_BATCH_CAP, capPracticeScope, deckChoices, filterActive, filterRows, groupRows, groupSummaryText, leechCount, leechWords, practiceCappedText, readGroupBy, readOpenGroups, reasonText, retrainOptions,
  sameVariantState, saveGroupBy, rescueCall, rescueGate, rescueNote, takeArrival, undoPauseCall, readSignature, rowsAwaitingDetail, saveOpenGroups, scopedFilter, shortDeckNames, statusCounts, statusLabel, statusOf, variantFailureText, variantState } from './wrongbook-model.js';
import { useStudy } from './study-context.jsx';
import { peekQuery, refreshQuery, setQueryData, useHostQuery } from './host-query.js';
import { formatDateTime, joinMeta, META_DOT } from "./format.js";

// One page of this view holds ten pages of the service (which gives at most 100), so a filter sees every mistake of a normal library.
const FETCH_LIMIT = 100;
const PAGE_SIZE = 1000;
const POLL_MS = 2500;
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
  return <Tooltip layer content={history ? historyTip() : statusTip(kind)}><span tabIndex={0} className={"wb-grade" + (kind === "graded" ? "" : " self")}>{statusLabel(kind)}</span></Tooltip>;
}

/** 顽固: the question keeps being failed (lib/leech.js). A state mark like the one beside it, not a control; the thresholds are the learner's own. */
function LeechMark({ limits }) {
  const words = leechWords(limits);
  return <Tooltip layer content={tip(words.sentence, words.consequence)}><span tabIndex={0} className="wb-grade leech">{ui("顽固")}</span></Tooltip>;
}

/** What each rescue action does, said where its button is. */
const rescueTip = (kind) => kind === 'fix'
  ? tip(ui('记下「这题有问题」，由后台助教检查并修这道题；没有可用模型时会提示先配好模型。有模型时会调用轻量模型，出错时最多再试 2 次。'), ui('会直接改这张卡；完成时信箱会提醒你，在信箱里可以一步撤销。'))
  : kind === 'easier'
    ? tip(ui('记下「太难」，写一张更基础的前置小卡（调用轻量模型）；没有可用模型时会提示先配好模型，未开启后台准备时会先在这里请你确认。'), ui('写好后放进「为你定制」。'))
    : tip(ui('暂停后，这道题不再出现在练习和错题里，也不调用模型。'), ui('在题组的管理页点「恢复学习」可以恢复。'));

/** The four ways out for a question that keeps being failed: the actions that exist elsewhere, called from here (the opened row only; a collapsed row has no menu, #675). */
function LeechRescue({ item, course, disabled, rescuePrompt, rescuing, canOpenModel, canOpenSettings, onRescue, onDismissRescue, onOpenModel, onOpenProfileSettings }) {
  return (
    <div className="wb-sub wb-leech">
      <h4>{ui("这道题总是答错")}</h4>
      <p className="muted">{ui("反复答错，常常是题目本身有问题。先试试这几个办法，再决定要不要接着练：")}</p>
      <div className="wb-leech__actions">
        <Tooltip layer content={rescueTip('fix')}><Button variant="quiet" size="sm" data-rescue="fix" disabled={disabled} lock={rescuing} onClick={() => onRescue('fix', item)}>{ui("这题有问题，交给后台修")}</Button></Tooltip>
        <Tooltip layer content={rescueTip('easier')}><Button variant="quiet" size="sm" data-rescue="easier" disabled={disabled} lock={rescuing} onClick={() => onRescue('easier', item)}>{ui("太难了，补一张前置小卡")}</Button></Tooltip>
        <HandOff id="question.stubborn" shape="quiet" what="让主会话和你一起看这道题：是你还没弄懂，还是题目本身有问题" disabled={disabled || rescuing}
          input={{ course, deckId: item.deckId, cardId: item.cardId, topic: item.topic || '', prompt: plainPrompt(item.prompt) }} />
        <Tooltip layer content={rescueTip('pause')}><Button variant="quiet" size="sm" data-rescue="pause" disabled={disabled} lock={rescuing} onClick={() => onRescue('pause', item)}>{ui("暂停此题")}</Button></Tooltip>
      </div>
      {rescuePrompt?.type === "consent" && (
        <div className="wb-consent" role="group" aria-label={ui("确认补一张前置小卡")}>
          <strong>{ui("要开启后台准备并补一张前置小卡吗？")}</strong>
          <p>{ui("这会在后台写一张更基础的前置小卡（约 1 次轻量调用），写好后放进「为你定制」；同时会在设置里开启后台准备，随时可以去那里关掉。")}
            {canOpenSettings && <>{" "}<Button variant="link" size="sm" onClick={onOpenProfileSettings}>{ui("前往设置")}</Button></>}</p>
          <div className="wb-consent-actions">
            <Button variant="secondary" size="sm" icon="sparkle" busy={rescuing} lock={disabled}
              onClick={() => onRescue('easier', item, { consent: true })}>{ui("同意并生成")}</Button>
            <Button variant="quiet" size="sm" lock={rescuing} onClick={onDismissRescue}>{ui("取消")}</Button>
          </div>
        </div>
      )}
      {rescuePrompt?.type === "no-model" && (
        <InlineMessage className="wb-leech__notice" tone="warning" boxed actionsBelow
          action={canOpenModel ? { label: ui("打开模型设置"), onClick: onOpenModel } : undefined}
          onDismiss={onDismissRescue}>
          {rescueGate(rescuePrompt.kind, { modelReady: false }).text}
        </InlineMessage>
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
        <Icon name="success" size={16} />{uiFormat("已备好 {0} 道", [state.count])}
        {onPractice && <Button variant="link" size="sm" disabled={disabled} onClick={onPractice}>{ui("去练")}</Button>}
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
        <Button variant="quiet" size="sm" disabled={disabled} onClick={onPractice}
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

/** One fact of an opened mistake. The correct answer, the explanation and the pitfall are study text: drawn as Markdown, so formulas are formulas. What the
 * learner typed (`plain`) is theirs: only its formulas are drawn, no Markdown marks change it. */
function DetailLine({ label, children, plain = false }) {
  const shown = typeof children !== "string" ? children : plain ? <StudyInline text={children} /> : <Markdown text={children} links={false} />;
  return children ? <div className="wb-fact"><dt>{label}</dt><dd>{shown}</dd></div> : null;
}

function RowDetail({ id, item, course, detail, variants, recs, shortName, rescuePrompt, rescuing, canOpenModel, canOpenSettings, onPractice, onRescue, onDismissRescue, onOpenModel, onOpenProfileSettings, disabled }) {
  return (
    <div className="wb-detail" id={id}>
      {detail === "loading" || detail === undefined ? <LoadingState label={ui("正在读取详情…")} />
        : detail?.error ? <InlineMessage tone="error">{ui("没能读取这道题的详情。收起这道题再点开，就会重新读取。")}</InlineMessage>
          : (
            <dl className="wb-facts">
              <DetailLine label={ui("上次答错")}>{detail.missedAt ? formatDateTime(detail.missedAt, "stamp") : ""}</DetailLine>
              <DetailLine label={ui("你的答案")} plain>{detail.selfGrade !== null && detail.selfGrade !== undefined ? uiFormat("自评 {0} 分", [detail.selfGrade]) : detail.yourAnswer}</DetailLine>
              <DetailLine label={ui("正确答案")}>{detail.correctAnswer}</DetailLine>
              <DetailLine label={ui("解析")}>{detail.explanation}</DetailLine>
              <DetailLine label={ui("易错点")}>{detail.misconception}</DetailLine>
            </dl>
          )}
      {item.leech && onRescue && (
        <LeechRescue item={item} course={course} disabled={disabled} rescuePrompt={rescuePrompt} rescuing={rescuing}
          canOpenModel={canOpenModel} canOpenSettings={canOpenSettings}
          onRescue={onRescue} onDismissRescue={onDismissRescue} onOpenModel={onOpenModel} onOpenProfileSettings={onOpenProfileSettings} />
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
                  <Button variant="quiet" size="sm" disabled={disabled} onClick={() => onPractice(rec)}>{ui("练")}</Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <small className="muted">{shortName(item.deckTitle)}</small>
    </div>
  );
}

/** Two prop sets for a row that mean the same: everything is compared by identity but the variant state, which a poll rebuilds. */
const sameRow = (a, b) => Object.keys(a).every((key) => (key === 'state' ? sameVariantState(a.state, b.state) : a[key] === b[key]));

/* One question. Memoised, so opening a group, typing in the search box or a status poll redraws only the rows whose own props changed (the
   `handlers` are stable). */
const Row = memo(function Row({ it, metaText, isOpen, state, detail, recItems, shortName, canGenerate, canPracticePrepared, disabled, variantDisabled, handlers, limits, course, rescuePrompt = null, rescuing = false, canOpenModel = false, canOpenSettings = false, history = false, mistake = "", showPractice = true }) {
  const detailId = `wb-detail-${it.cardId}`;
  const recs = useMemo(() => (isOpen ? relatedTo(recItems, it.cardId) : []), [isOpen, recItems, it.cardId]);
  const fullPrompt = plainPrompt(it.prompt);
  const overflowTip = fullPrompt.length > PROMPT_TIP_MIN || (metaText && metaText.length > META_TIP_MIN)
    ? joinMeta([metaText, fullPrompt])
    : "";
  const toggleBtn = (
    <FoldButton className="wb-row-toggle" open={isOpen} controls={detailId} onClick={() => handlers.open(it)}>
      <Icon name="chevron" size={16} className="wb-chevron" />
      <span className="wb-meta">{metaText}</span>
      <span className="wb-prompt"><StudyInline text={it.prompt} /></span>
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
          <Button variant="quiet" size="sm" disabled={disabled}
            aria-label={uiFormat("练习 {0}：{1}", [it.topic || "未分类", it.prompt])}
            onClick={() => handlers.practice(it)}>{ui("练")}</Button>
        )}
      </div>
      {isOpen && (
        <RowDetail id={detailId} item={it} course={course} detail={detail} shortName={shortName} disabled={disabled}
          rescuePrompt={rescuePrompt} rescuing={rescuing} canOpenModel={canOpenModel} canOpenSettings={canOpenSettings}
          variants={state.kind === "ready" ? state.prompts : []}
          recs={recs}
          onPractice={handlers.practiceRec} onRescue={handlers.rescue}
          onDismissRescue={handlers.dismissRescue} onOpenModel={handlers.openModel} onOpenProfileSettings={handlers.openProfileSettings} />
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
        <>
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
        </>
      )}
    </section>
  );
}
export function WrongBookView({
  data, course, onCourse, showInactive, onShowInactive, items, counts, view = "weak", onView, viewCounts, loading, err, page = 0, pageSize = PAGE_SIZE, hasMore, onReload, onPage,
  recs, recsLoading = false, coach, details = {}, onLoadDetail, onPractice, onPracticePrepared, onGenerate, onOpenSettings, onSettings,
  onLibrary, onCreate, onSources, onRescue, onNotify, arrival, openKey, initial = {}, filterMin = FILTER_MIN,
}) {
  const { busy } = useStudy();
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
  const localDecks = decksInCourse(data, course, showInactive);
  const shortName = useMemo(() => shortDeckNames(rows, data?.decks), [rows, data?.decks]);
  const shown = useMemo(() => filterRows(rows, applied), [rows, applied]);
  const groups = useMemo(() => groupRows(shown, groupBy, data?.decks), [shown, groupBy, data?.decks]);
  const choices = useMemo(() => deckChoices(rows, data?.decks), [rows, data?.decks]);
  const filtering = filterActive(applied);
  const kindsHere = useMemo(() => statusCounts(rows), [rows]);
  const kindsShown = useMemo(() => statusCounts(filterRows(rows, { ...applied, status: 'all' })), [rows, applied]);
  // 顽固题 (lib/leech.js): the thresholds are the learner's own (设置 › 练习); how many of the rows the other filters leave are one.
  const limits = useMemo(() => leechLimits(data?.settings?.practice), [data?.settings?.practice]);
  const leechShown = useMemo(() => leechCount(filterRows(rows, { ...applied, leech: false, only: null })), [rows, applied]);
  const onlyShown = useMemo(() => (Array.isArray(applied.only) ? filterRows(rows, { ...NO_FILTER, only: applied.only }).length : 0), [rows, applied]);
  const courseOfDeck = useMemo(() => new Map((data?.decks || []).map((deck) => [deck.id, deck.course ?? deck.folder ?? ''])), [data?.decks]);
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
  const modelReady = (hasModelField ? modelReadiness(data).ready : true) && (!hasCoach || !!coach.enabled);
  const openModel = onOpenSettings || (onSettings ? () => onSettings("settings-model") : undefined);
  const openProfileSettings = onSettings ? () => onSettings("settings-profile") : undefined;
  const activeRescuePrompt = rescuePrompt
    && !(rescuePrompt.type === "no-model" && modelReady)
    && !(rescuePrompt.type === "consent" && coach?.consent === true)
    ? rescuePrompt
    : null;
  const gated = hasCoach && !coach.enabled;
  const canGenerate = hasCoach && coach.enabled && !!onGenerate;
  const rowIds = new Set(rows.map((row) => row.cardId));
  const readyHere = (coach?.readyCards || []).filter((variant) => rowIds.has(variant.originCardId));
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
  const practiceRec = (rec) => onPractice([refOf(rec)]);
  const groupsId = useId();
  // A group draws its rows in chunks (ChunkedRows); another filter, grouping, view, scope or page starts every group from its first chunk again.
  const chunkKey = useMemo(() => JSON.stringify([scopeKey, applied, groupBy, view, page]), [scopeKey, applied, groupBy, view, page]);
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
        <Button variant="quiet" size="sm" icon="sparkle" data-tour="wrongbook-batch" busy={working} disabled={busy || !batch.length} onClick={() => generate(batch)}>
          {filtering ? uiFormat("为当前筛选的 {0} 题生成变式", [shown.length]) : ui("为全部错题生成变式")}
        </Button>
      </Tooltip>
    </div>
  );
  const triggerRescue = async (kind, item, options) => {
    if (!options?.consent) {
      const gate = rescueGate(kind, { modelReady, consent: !hasCoach || coach?.consent === true });
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
  const dismissRescue = () => setRescuePrompt(null);
  // The handlers every row shares; the row itself is memoised, so these must keep their identity from render to render.
  const latest = useRef(null);
  latest.current = { openRow, generate, onPractice, onPracticePrepared, practiceRec, triggerRescue, dismissRescue, openModel, openProfileSettings };
  const handlers = useMemo(() => ({
    open: (item) => latest.current.openRow(item),
    generate: (item) => latest.current.generate([item]),
    practice: (item) => latest.current.onPractice([refOf(item)]),
    practicePrepared: (item) => latest.current.onPracticePrepared({ originCardIds: [item.cardId] }),
    practiceRec: (rec) => latest.current.practiceRec(rec),
    rescue: (kind, item, options) => latest.current.triggerRescue(kind, item, options),
    dismissRescue: () => latest.current.dismissRescue(),
    openModel: () => latest.current.openModel?.(),
    openProfileSettings: () => latest.current.openProfileSettings?.(),
  }), []);

  return (
    <section className="page wb">
      <PageHeader title={ui("错题与待巩固")}
        description={<>
          {isHistory
            ? counts.total ? uiFormat('已订正的错题：答错 {0} 题 · 自评未掌握 {1} 题 · 口头评估 {2} 题。', [counts.graded, counts.self, counts.oral])
              : ui('答对一次后，错题会移到这里，作为历史保留，随时可以再练。')
            : counts.total ? uiFormat('客观答错 {0} 题 · 自评未掌握 {1} 题 · 口头评估待巩固 {2} 题。', [counts.graded, counts.self, counts.oral])
              : ui('客观答错、自评未掌握或口头评估待巩固的题会收在这里。')}
          {/* The switch already says 已订正 N; the weak page's header says the history is kept so a cleared page is not read as an empty one. */}
          {!isHistory && historyCount > 0 && <>{META_DOT}{uiFormat('已订正 {0} 题，记录保留', [historyCount])}</>}
          {counts.rubric > 0 && uiFormat('按评分标准批改未达标 {0} 题。', [counts.rubric])}
        </>}
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

      {!isHistory && hasCoach && onPracticePrepared && coach.ready > 0 && (
        <Banner tone="success" icon="sparkle" title={uiFormat("已为你备好 {0} 道变式题", [coach.ready])}
          action={{ label: ui("去练 →"), onClick: () => onPracticePrepared({}), disabled: busy }}>
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
            {/* The one start of the page: the scope above decides what it takes (the mistakes, with the similar questions, with the prepared variants). */}
            <Button className="wb-retrain__btn" variant="primary" icon="arrow-right" disabled={!total} lock={busy || loading} onClick={startRetrain}>
              {uiFormat("开始重练 · {0} 题", [current.count])}
            </Button>
            {/* The start takes the whole page, whatever the filter shows; with a filter on, what is shown has its own, quieter button. */}
            {filteredSubset && (
              <Tooltip layer content={shown.length > PRACTICE_SCOPE_CAP ? practiceCappedText(shown.length, { group: false }) : ui("只练下面筛选出来的错题")}>
                <Button className="wb-retrain__btn" variant="secondary" icon="arrow-right" lock={busy || loading} onClick={() => practiceScope(shown.map(refOf))}>
                  {uiFormat("练筛选的 {0} 道", [shown.length])}
                </Button>
              </Tooltip>
            )}
          </div>
        );
      })()}

      {/* Weak rubric criteria as skills (WP12): case linkage, assumptions, justification… */}
      {!isHistory && <RubricSkills attempts={data?.attempts} practiceLabel={ui("练案例题")}
        onPractice={data?.decks?.some((deck) => deck.format === "case-study" && !deck.archived)
          ? () => onPractice(data.decks.filter((deck) => deck.format === "case-study" && !deck.archived).map((deck) => ({ deckId: deck.id }))) : undefined} />}

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

      {items && !counts.total && (isHistory ? (
        <EmptyState data-tour="wrongbook-list" icon="success" title={ui("还没有已订正的错题")}
          description={ui("答对一次后，错题会移到这里，作为历史保留，随时可以再练。")} />
      ) : (
        <EmptyState data-tour="wrongbook-list" icon="success" title={data?.attempts?.length ? ui("目前没有待巩固的题") : ui("还没有练习记录")}
          description={data?.attempts?.length
            ? ui("客观答错或自评未掌握的题会出现在这里，方便集中重练。")
            : ui("完成一次学习后，答错或自评未掌握的题会收在这里。")}>
          <EmptyStudyActions data={{ ...data, decks: localDecks }} onStart={() => onPractice(localDecks.map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
            onCreate={onCreate} onSources={onSources} />
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
                    ? [{ value: filter.deck, label: shortName((data?.decks || []).find((deck) => deck.id === filter.deck)?.title) || filter.deck }] : [])]} />
            </div>
            <label className="wb-search">
              <Icon name="search" size={16} className="wb-search-icon" />
              <TextInput type="search" className="wb-search-input" value={filter.query} onChange={(event) => patchFilter({ query: event.target.value })}
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
          <div className="wb-filter-result" role="status">
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
      {/* Where the mistakes are, before a learner opens groups one by one (#748). The same threshold as the toolbar (#675), and it follows the
          grouping and the filter the list uses: the bar is the list, seen at once. */}
      {!isHistory && total >= filterMin && <WeaknessBar groups={groups} onPick={pickGroup} />}

      {!isHistory && gated && total > 0 && (
        <ModelSetupGate feature="variants" model={{ ready: false }} onOpenSettings={onOpenSettings} />
      )}

      {ask && canGenerate && (
        <div className="wb-consent" ref={consentRef} role="group" aria-label={ui("先确认是否备变式题")}>
          <strong>{ui("要让 AI 为错题备变式题吗？")}</strong>
          <p>{ui("生成变式会在后台少量调用模型：每道题约 1 次轻量调用，只用你的原题和原文引用改写，写好的题会放进「为你定制」。可以随时在设置里关闭「陪学」。")}
            {onSettings && <>{" "}<Button variant="link" size="sm" onClick={() => onSettings("settings-profile")}>{ui("前往设置")}</Button></>}</p>
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
              {!oneGroup && (
                <div className="wb-group-actions">
                  {group.rows.length > PRACTICE_SCOPE_CAP ? (
                    <Tooltip layer content={practiceCappedText(group.rows.length, { group: true })}>
                      <Button variant="quiet" size="sm" icon="arrow-right" lock={busy} aria-label={uiFormat("练这一组：{0}", [group.title])}
                        onClick={() => practiceScope(group.rows.map(refOf), { group: true })}>{ui("练这一组")}</Button>
                    </Tooltip>
                  ) : (
                    <Button variant="quiet" size="sm" icon="arrow-right" lock={busy} aria-label={uiFormat("练这一组：{0}", [group.title])}
                      onClick={() => practiceScope(group.rows.map(refOf), { group: true })}>{ui("练这一组")}</Button>
                  )}
                  {showBar && group.deckIds.length === 1 && applied.deck !== group.deckIds[0] && (
                    <Tooltip layer content={tip(ui('只显示这个题组里的错题。'), ui('点「清除筛选」可以回到全部。'))}>
                      <Button variant="quiet" size="sm" icon="filter" onClick={() => onlyThisDeck(group)}>{ui("只看这个题组")}</Button>
                    </Tooltip>
                  )}
                  {!isHistory && canGenerate && todo.length > 0 && (
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
              <ul className="wb-rows" id={rowsId}>
                <ChunkedRows as="li" items={group.rows} resetKey={chunkKey} render={(it) => (
                  <Row key={it.cardId} it={it} metaText={group.mode === "topic" ? shortName(it.deckTitle) : it.topic || ui("未分类")}
                    isOpen={expanded.has(it.cardId)} state={stateOf(it.cardId)} detail={details[it.cardId]} recItems={recItems} shortName={shortName}
                    canGenerate={!isHistory && canGenerate} canPracticePrepared={!!onPracticePrepared} disabled={busy} variantDisabled={busy || working} handlers={handlers} limits={limits} course={courseOfDeck.get(it.deckId) || ''} showPractice={isHistory || total !== 1}
                    rescuePrompt={activeRescuePrompt?.cardId === it.cardId ? activeRescuePrompt : null} rescuing={rescuingCard === it.cardId}
                    canOpenModel={!!openModel} canOpenSettings={!!openProfileSettings}
                    history={isHistory} mistake={isHistory ? joinMeta([uiFormat("答错 {0} 次", [it.wrongCount ?? 0]), uiFormat("最近答错 {0}", [formatDateTime(it.lastWrongAt, "stamp")])]) : ""} />
                )} />
              </ul>
            )}
          </div>
        );
      })}
      {items && hasMore && <nav className="wb-pages" aria-label={ui(isHistory ? "已订正题分页" : "待巩固题分页")}>
        <span>{uiFormat("第 {0}–{1} 题 / 共 {2} 题", [page * pageSize + 1, page * pageSize + total, counts.total])}</span>
        <Button size="sm" disabled={page === 0} lock={busy || loading} onClick={() => onPage(page - 1)}>{ui("上一页")}</Button>
        <Button size="sm" disabled={(page + 1) * pageSize >= counts.total} lock={busy || loading}
          onClick={() => onPage(page + 1)}>{ui("下一页")}</Button>
      </nav>}
    </section>
  );
}

export default function WrongBook({ data, onPractice, onPracticePrepared, onOpenSettings, onLibrary, onCreate, onSources }) {
  const { call, act, openSettings, busy } = useStudy();
  const [pinnedCourse, setCourse] = usePageScope(data?.root, 'wrongbook', data?.focus?.course ?? '*');
  const [pinnedInactive, setShowInactive] = useShowInactive(data?.root, 'wrongbook');
  // The result page's line about 顽固题 asked this page to open on exactly those questions (ui/Review.jsx). The request waits under the library's root, so it is read in
  // an effect keyed on the root (a page that mounts before the library has loaded takes nothing), once, and forgotten. Those questions can be in any course, parked
  // ones included, so on arrival the page shows every course and the parked ones, whatever scope the learner pinned, until the learner picks a scope of their own.
  const [arrival, setArrival] = useState(null);
  const [released, setReleased] = useState(false);
  useEffect(() => {
    const taken = takeArrival(data?.root);
    if (taken.refs) { setArrival(taken); setReleased(false); }
  }, [data?.root]);
  const arrived = !!arrival && !released;
  const course = arrived ? '*' : pinnedCourse, showInactive = arrived ? true : pinnedInactive;
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
  const reading = useRef(false);
  const pageRef = useRef(0);
  pageRef.current = page;
  const busyRef = useRef(false);
  busyRef.current = !!busy;
  const current = result?.key === key ? result : null;
  const items = current?.items;
  const counts = current?.counts || { total: 0, graded: 0, self: 0, oral: 0 };
  // Both views' counts, as last read in this scope: the switch keeps its numbers while the other view loads, and the header stops at the scope edge.
  const knownViewCounts = viewCounts.scope === scopeKey ? viewCounts : null;
  const coach = coachLive || data?.coach || null;

  // `quiet` is the page re-reading its own list (the watch): nothing flashes, the rows that were opened and the details already read stay, and an answer that
  // says nothing changed leaves the page untouched.
  const load = useCallback(async (requestedPage = 0, { quiet = false } = {}) => {
    const request = ++seq.current;
    reading.current = true;
    if (!quiet) {
      setLoading(true);
      setErr("");
    }
    try {
      let targetPage = requestedPage;
      const scope = scopeArgs(course, showInactive);
      // A page of this view is up to ten service pages, read one after the other (so a filter sees all of them, and the first draw waits for one).
      const readPage = async (at) => {
        const first = await call("wrongbook", { ...scope, view, offset: at * PAGE_SIZE, limit: FETCH_LIMIT });
        const found = [...(first?.items || [])];
        const wanted = Math.min(PAGE_SIZE, Math.max(0, (first?.total || 0) - at * PAGE_SIZE));
        while (found.length < wanted && request === seq.current) {
          const more = await call("wrongbook", { ...scope, view, offset: at * PAGE_SIZE + found.length, limit: FETCH_LIMIT });
          if (!more?.items?.length) break;
          found.push(...more.items);
        }
        return { ...first, items: found };
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
          oral: res?.oralTotal ?? 0, rubric: res?.rubricTotal ?? 0 },
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
    await load(pageRef.current, { quiet: true });
    return {};
  }, [call, course, showInactive, view, load]);
  usePolling(watch, { intervalMs: WATCH_MS, backoff: true });

  // While variants are being written, watch the cheap status call until they land.
  const preparing = !!coach?.preparing;
  usePolling(coachQuery.refresh, { intervalMs: POLL_MS, enabled: preparing });

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
        await load(pageRef.current, { quiet: true });
        // The row is gone from the page at once, so the way back is here, not only on the manage page.
        toast.show({ tone: 'success', message: rescueNote(kind, done).text, undo: true, timeout: UNDO_TIMEOUT,
          action: { label: ui('撤销'), onClick: async () => {
            toast.dismiss();
            const back = undoPauseCall({ deckId: item.deckId, cardId: item.cardId });
            try { await act(back.action, back.args, undefined, { rethrow: true }); await load(pageRef.current, { quiet: true }); toast.info(ui('已恢复这道题。')); } catch (failure) { toast.error(failure); }
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
        ...(needsModel ? { action: { label: ui('打开模型设置'), onClick: openModel } } : {}),
      });
    } catch (failure) { toast.error(failure); }
    finally { rescuing.current = false; }
  }, [act, call, load, onOpenSettings, openSettings, toast]);
  const asked = useRef(new Set());
  const loadDetail = useCallback((ref) => {
    if (asked.current.has(ref.cardId)) return;
    asked.current.add(ref.cardId);
    setDetails((known) => ({ ...known, [ref.cardId]: "loading" }));
    // A history row opens on the answer that was wrong, so the detail is asked in the same view as the list.
    call("wrongbook.detail", { ...ref, ...(view === "history" ? { view: "history" } : {}) })
      .then((detail) => setDetails((now) => ({ ...now, [ref.cardId]: detail })))
      .catch((e) => {
        asked.current.delete(ref.cardId);
        setDetails((now) => ({ ...now, [ref.cardId]: { error: e.message || true } }));
      });
  }, [call, view]);

  return (
    <WrongBookView data={data} course={course} onCourse={chooseCourse} showInactive={showInactive} onShowInactive={chooseInactive} items={items} counts={counts}
      view={view} onView={setView} viewCounts={current?.viewCounts || knownViewCounts} loading={loading} err={err}
      page={page} pageSize={PAGE_SIZE} hasMore={counts.total > PAGE_SIZE} onReload={load} onPage={load}
      recs={recs?.key === key ? recs : null} recsLoading={view === "weak" && !!items?.length && recs?.key !== key} coach={coach} details={details} onLoadDetail={loadDetail}
      onPractice={onPractice} onPracticePrepared={onPracticePrepared} onGenerate={generate} onOpenSettings={onOpenSettings} onSettings={openSettings}
      onLibrary={onLibrary} onCreate={onCreate} onSources={onSources} onRescue={rescue} onNotify={(text) => toast.info(text)} arrival={arrived ? arrival : null} openKey={`study-wrongbook-open:v1:${data?.root || ""}`} />
  );
}
