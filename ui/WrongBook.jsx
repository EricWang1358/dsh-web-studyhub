import { ui, uiFormat, errorMessage } from "./i18n.js";
import React, { memo, useCallback, useDeferredValue, useEffect, useId, useMemo, useRef, useState } from "react";
import css from "./views.css";
import wrongCss from "./wrongbook.css";
import { useInjectCss, plainPrompt } from "./shared.js";
import { usePolling } from "./use-polling.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import { RubricSkills } from "./CaseResult.jsx";
import PageScope, { decksInCourse, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { Banner, Button, Combobox, DisclosureToggle, foldLabel, EmptyState, ErrorState, Icon, InlineMessage, LoadingState, PageHeader, SegmentedControl, TextInput, Tooltip } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { NO_FILTER, RECS_PREVIEW, STATUS_KINDS, VARIANT_BATCH_CAP, deckChoices, filterActive, filterRows, groupRows, groupSummaryText, readGroupBy, readOpenGroups, reasonText, retrainOptions,
  sameVariantState, saveGroupBy, saveOpenGroups, scopedFilter, shortDeckNames, statusCounts, statusLabel, statusOf, variantFailureText, variantState } from './wrongbook-model.js';
import { useStudy } from './study-context.jsx';
import { setQueryData, useHostQuery } from './host-query.js';

// One page of this view holds ten pages of the service (which gives at most 100), so a filter sees every mistake of a normal library.
const FETCH_LIMIT = 100;
const PAGE_SIZE = 1000;
const POLL_MS = 2500;
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
const generateTip = () => tip(uiFormat('为错题改写新的变式题：每道题约 1 次轻量模型调用，一次最多 {0} 题。', [VARIANT_BATCH_CAP]), ui('写好的变式会存为草稿，可在「为你定制」里练。'));
/** What each kind of low outcome means: the chips and the row marks say it in the same words. */
function statusTip(kind) {
  switch (kind) {
    case 'graded': return tip(ui('答错：单选、多选、填空由系统判分，最近一次得分低于 3 分。'), ui('再答对一次，它就会移出错题本。'));
    case 'oral': return tip(ui('最近一次口头 AI 评估：需要巩固'));
    case 'rubric': return tip(ui('最近一次按评分标准批改：得分不足六成'));
    default: return tip(ui('未掌握：闪卡和开放题由你自评，最近一次自评低于 3 分。'), ui('自评到 3 分以上，它就会移出错题本。'));
  }
}

/** The one fold control of the page (a group header, a question row, a recommendation): a whole row is the target. */
function FoldButton({ className, open, controls, onClick, children }) {
  return <button type="button" className={className} aria-expanded={open} aria-controls={controls} onClick={onClick}>{children}</button>;
}

function StatusMark({ kind }) {
  return <Tooltip layer content={statusTip(kind)}><span tabIndex={0} className={"wb-grade" + (kind === "graded" ? "" : " self")}>{statusLabel(kind)}</span></Tooltip>;
}

function VariantControl({ state, onGenerate, onPractice, disabled }) {
  if (state.kind === "preparing")
    return <span className="wb-var is-busy" role="status"><span className="sh-spinner" aria-hidden="true" />{ui("生成中…")}</span>;
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
  return (
    <li className={"wb-rec" + (open ? " is-open" : "")}>
      <div className="wb-rec-line">
        <FoldButton className="wb-rec-toggle" open={open} controls={id} onClick={onToggle}>
          <Icon name="chevron" size={16} className="wb-chevron" />
          <span className="wb-prompt" title={plainPrompt(rec.prompt)}>{plainPrompt(rec.prompt)}</span>
        </FoldButton>
        <span className="wb-why" title={rec.reasons.map(reasonText).join(" · ")}>{reasonText(rec.reasons[0])}</span>
        <Button variant="quiet" size="sm" disabled={disabled} onClick={onPractice}
          aria-label={uiFormat("练习 {0}：{1}", [rec.topic || ui("未分类"), plainPrompt(rec.prompt)])}>{ui("练")}</Button>
      </div>
      {open && (
        <div className="wb-detail" id={id}>
          <p className="wb-full-prompt">{plainPrompt(rec.prompt)}</p>
          <ul className="wb-why-list">{rec.reasons.map((reason, index) => <li key={index}>{reasonText(reason)}</li>)}</ul>
          <small className="muted">{uiFormat("来自 {0}", [shortName(rec.deckTitle)])}</small>
        </div>
      )}
    </li>
  );
}

function DetailLine({ label, children }) {
  return children ? <div className="wb-fact"><dt>{label}</dt><dd>{children}</dd></div> : null;
}

function RowDetail({ id, item, detail, variants, recs, shortName, onPractice, disabled }) {
  return (
    <div className="wb-detail" id={id}>
      {detail === "loading" || detail === undefined ? <LoadingState label={ui("正在读取详情…")} />
        : detail?.error ? <InlineMessage tone="error">{ui("读取详情失败，稍后再试")}</InlineMessage>
          : (
            <dl className="wb-facts">
              <DetailLine label={ui("你的答案")}>{detail.selfGrade !== null && detail.selfGrade !== undefined ? uiFormat("自评 {0} 分", [detail.selfGrade]) : detail.yourAnswer}</DetailLine>
              <DetailLine label={ui("正确答案")}>{detail.correctAnswer}</DetailLine>
              <DetailLine label={ui("解析")}>{detail.explanation}</DetailLine>
              <DetailLine label={ui("易错点")}>{detail.misconception}</DetailLine>
            </dl>
          )}
      {variants.length > 0 && (
        <div className="wb-sub">
          <h4>{ui("这道题的变式")}</h4>
          <ul>{variants.map((prompt, index) => <li key={index}>{plainPrompt(prompt)}</li>)}</ul>
        </div>
      )}
      {recs.length > 0 && (
        <div className="wb-sub">
          <h4>{ui("同类题")}</h4>
          <ul>
            {recs.map((rec) => (
              <li key={rec.cardId} className="wb-sub-rec">
                <span className="wb-prompt" title={plainPrompt(rec.prompt)}>{plainPrompt(rec.prompt)}</span>
                <span className="wb-why">{reasonText(rec.reasons[0])}</span>
                <Button variant="quiet" size="sm" disabled={disabled} onClick={() => onPractice(rec)}>{ui("练")}</Button>
              </li>
            ))}
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
const Row = memo(function Row({ it, metaText, isOpen, state, detail, recItems, shortName, canGenerate, canPracticePrepared, disabled, variantDisabled, handlers }) {
  const detailId = `wb-detail-${it.cardId}`;
  const recs = useMemo(() => (isOpen ? relatedTo(recItems, it.cardId) : []), [isOpen, recItems, it.cardId]);
  return (
    <li className={"wb-row" + (isOpen ? " is-open" : "")}>
      <div className="wb-row-line">
        <FoldButton className="wb-row-toggle" open={isOpen} controls={detailId} onClick={() => handlers.open(it)}>
          <Icon name="chevron" size={16} className="wb-chevron" />
          <span className="wb-meta" title={metaText}>{metaText}</span>
          <span className="wb-prompt" title={plainPrompt(it.prompt)}>{plainPrompt(it.prompt)}</span>
        </FoldButton>
        <StatusMark kind={statusOf(it)} />
        {(canGenerate || state.kind === "ready") && (
          <VariantControl state={state} disabled={variantDisabled}
            onGenerate={canGenerate ? () => handlers.generate(it) : undefined}
            onPractice={canPracticePrepared ? () => handlers.practicePrepared(it) : undefined} />
        )}
        <Button variant="quiet" size="sm" disabled={disabled}
          aria-label={uiFormat("练习 {0}：{1}", [it.topic || "未分类", it.prompt])}
          onClick={() => handlers.practice(it)}>{ui("练")}</Button>
      </div>
      {isOpen && (
        <RowDetail id={detailId} item={it} detail={detail} shortName={shortName} disabled={disabled}
          variants={state.kind === "ready" ? state.prompts : []}
          recs={recs}
          onPractice={handlers.practiceRec} />
      )}
    </li>
  );
}, sameRow);

export function WrongBookView({
  data, course, onCourse, showInactive, onShowInactive, items, counts, loading, err, page = 0, pageSize = PAGE_SIZE, hasMore, onReload, onPage,
  recs, recsLoading = false, coach, details = {}, onLoadDetail, onPractice, onPracticePrepared, onGenerate, onOpenSettings, busy,
  onLibrary, onCreate, onSources, openKey, initial = {},
}) {
  useInjectCss(css, "study-views");
  useInjectCss(wrongCss, "study-wrongbook");
  const [groupBy, setGroupBy] = useState(() => initial.groupBy || readGroupBy());
  const chooseGroupBy = (value) => { setGroupBy(value); saveGroupBy(value); };
  const [expanded, setExpanded] = useState(() => new Set(initial.expanded || []));
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
  const hasCoach = !!coach;
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
  const similarNote = recItems.length > 0 && picked !== "similar" ? uiFormat("找到 {0} 道同类题", [recItems.length]) : null;
  const startRetrain = () => {
    const mistakes = rows.map(refOf);
    if (picked === "similar") onPractice([...mistakes, ...recItems.map(refOf)]);
    else if (picked === "variants" && onPracticePrepared)
      onPracticePrepared({ scope: mistakes, originCardIds: [...new Set(readyHere.map((variant) => variant.originCardId))] });
    else onPractice(mistakes);
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
  const toggleGroup = (key) => toggle(openGroups, setOpenGroups, key);
  const allOpen = groups.length > 0 && groups.every((group) => openGroups.has(group.key));
  const anyOpen = groups.some((group) => openGroups.has(group.key));
  const onlyThisDeck = (group) => {
    patchFilter({ deck: group.deckIds[0] });
    setOpenGroups((previous) => new Set(previous).add(group.key));
  };
  const recsShown = recsAll ? recItems : recItems.slice(0, RECS_PREVIEW);
  // One folded line from the first paint, so the answer never inserts a block above the list (#206).
  const showRecs = total > 0 && (!!recs || recsLoading);
  const practiceRec = (rec) => onPractice([refOf(rec)]);
  const groupsId = useId();
  // The handlers every row shares; the row itself is memoised, so these must keep their identity from render to render.
  const latest = useRef(null);
  latest.current = { openRow, generate, onPractice, onPracticePrepared, practiceRec };
  const handlers = useMemo(() => ({
    open: (item) => latest.current.openRow(item),
    generate: (item) => latest.current.generate([item]),
    practice: (item) => latest.current.onPractice([refOf(item)]),
    practicePrepared: (item) => latest.current.onPracticePrepared({ originCardIds: [item.cardId] }),
    practiceRec: (rec) => latest.current.practiceRec(rec),
  }), []);

  return (
    <section className="page wb">
      <PageHeader title={ui("错题与待巩固")}
        description={<>
          {counts.total ? uiFormat('客观答错 {0} 题 · 自评未掌握 {1} 题 · 口头评估待巩固 {2} 题。', [counts.graded, counts.self, counts.oral]) : ui('客观答错、自评未掌握或口头评估待巩固的题会收在这里。')}
          {counts.rubric > 0 && uiFormat('按评分标准批改未达标 {0} 题。', [counts.rubric])}
        </>}
        scope={<PageScope courses={data?.focus?.courses} value={course} onChange={onCourse} showInactive={showInactive} onShowInactive={onShowInactive} />}
        actions={<Button variant="secondary" icon="refresh" onClick={() => onReload(page)} disabled={busy || loading}>{ui("刷新")}</Button>} />

      {err && <ErrorState error={items ? uiFormat("读取失败，仍显示上次结果：{0}", [err]) : err} onRetry={busy || loading ? undefined : () => onReload(page)} />}
      {loading && !items && <LoadingState label={ui("正在读取待巩固题…")} />}

      {hasCoach && onPracticePrepared && coach.ready > 0 && (
        <Banner tone="success" icon="sparkle" title={uiFormat("已为你备好 {0} 道变式题", [coach.ready])}
          action={{ label: ui("去练 →"), onClick: () => onPracticePrepared({}), disabled: busy }}>
          {ui("它们由你的错题改写而来，练完会放进「为你定制」。")}
        </Banner>
      )}

      {total > 0 && (
        <div className="wb-retrain">
          <div className="wb-retrain-copy">
            <strong>{ui("重练")}</strong>
            <small className="muted">{similarNote || ui("选择这一轮练什么。")}</small>
          </div>
          <SegmentedControl label={ui("重练范围")} value={picked} options={options} onChange={setChoice} />
          <Button variant="primary" icon="arrow-right" disabled={busy || loading || !total} onClick={startRetrain}
            title={hasMore ? ui("把本页的待巩固题按学习路径重新练一遍") : ui("把这些待巩固题按学习路径重新练一遍")}>
            {uiFormat("开始重练 ({0})", [current.count])}
          </Button>
        </div>
      )}

      {/* Weak rubric criteria as skills (WP12): case linkage, assumptions, justification… */}
      <RubricSkills attempts={data?.attempts} practiceLabel={ui("练案例题")}
        onPractice={data?.decks?.some((deck) => deck.format === "case-study" && !deck.archived)
          ? () => onPractice(data.decks.filter((deck) => deck.format === "case-study" && !deck.archived).map((deck) => ({ deckId: deck.id }))) : undefined} />

      {items && !counts.total && (
        <EmptyState data-tour="wrongbook-list" icon="success" title={data?.attempts?.length ? ui("目前没有待巩固的题") : ui("还没有练习记录")}
          description={data?.attempts?.length
            ? ui("客观答错或自评未掌握的题会出现在这里，方便集中重练。")
            : ui("完成一次学习后，答错或自评未掌握的题会收在这里。")}>
          <EmptyStudyActions data={{ ...data, decks: localDecks }} busy={busy} onStart={() => onPractice(localDecks.map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
            onCreate={onCreate} onSources={onSources} />
        </EmptyState>
      )}

      {showRecs && (
        <section className={"wb-recs" + (recsOpen && recItems.length ? " is-open" : "")} aria-labelledby="wb-recs-title" data-tour="wrongbook-recs">
          <div className="wb-recs-bar">
            {/* The fold arrow's place is kept while there is nothing to fold, so the title does not move when the answer arrives. */}
            {recItems.length > 0
              ? <DisclosureToggle open={recsOpen} onToggle={setRecsOpen} controls="wb-recs-body" label={foldLabel(recsOpen, ui("为你推荐"))} />
              : <span className="wb-recs-spacer" aria-hidden="true" />}
            <h2 id="wb-recs-title">{ui("为你推荐")}<span className="wb-free">{ui("不消耗模型")}</span></h2>
            {recItems.length === 0 && <span className="muted wb-recs-status" role="status">{recsLoading ? ui("正在查找同类题…") : ui("暂时没有合适的同类题")}</span>}
            {recItems.length > 0 && (
              <Button variant="secondary" size="sm" icon="arrow-right" disabled={busy} onClick={() => onPractice(recItems.map(refOf))}>
                {uiFormat("练这 {0} 道", [recItems.length])}
              </Button>
            )}
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
                <Button variant="link" size="sm" onClick={() => setRecsAll(!recsAll)}>
                  {recsAll ? ui("收起") : uiFormat("再显示 {0} 道", [recItems.length - RECS_PREVIEW])}
                </Button>
              )}
            </div>
          )}
        </section>
      )}

      {total > 0 && (
        <div className="wb-controls">
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
          {canGenerate && (!filtering || shown.length > 0) && (
            <div className="wb-batch">
              <Tooltip layer content={generateTip()}>
                <Button variant="secondary" size="sm" icon="sparkle" busy={working} disabled={busy || !batch.length} onClick={() => generate(batch)}>
                  {filtering ? uiFormat("为当前筛选的 {0} 题生成变式", [shown.length]) : ui("为全部错题生成变式")}
                </Button>
              </Tooltip>
              <small className="muted">{uiFormat("一次最多 {0} 题 · 约 1 次轻量模型调用/题", [VARIANT_BATCH_CAP])}</small>
            </div>
          )}
        </div>
      )}

      {total > 0 && (
        <div className="wb-filter" role="search" aria-label={ui("筛选错题")}>
          <div className="wb-filter-fields">
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
          </div>
          <div className="wb-filter-status">
            <div className="wb-chips" role="group" aria-label={ui("按状态筛选")}>
              <Tooltip layer content={tip(ui('显示所有待巩固的题。'))}>
                <Button size="sm" shape="pill" aria-pressed={filter.status === 'all'} onClick={() => patchFilter({ status: 'all' })}>
                  {ui("全部")} <span className="wb-num">{STATUS_KINDS.reduce((sum, kind) => sum + kindsShown[kind], 0)}</span>
                </Button>
              </Tooltip>
              {STATUS_KINDS.filter((kind) => kind === 'graded' || kind === 'self' || kindsHere[kind] > 0 || filter.status === kind).map((kind) => (
                <Tooltip key={kind} layer content={statusTip(kind)}>
                  <Button size="sm" shape="pill" aria-pressed={filter.status === kind} onClick={() => patchFilter({ status: filter.status === kind ? 'all' : kind })}>
                    {statusLabel(kind)} <span className="wb-num">{kindsShown[kind]}</span>
                  </Button>
                </Tooltip>
              ))}
            </div>
            <div className="wb-filter-result" role="status">
              {canGenerate && batch.length > VARIANT_BATCH_CAP
                ? <Tooltip layer content={tip(uiFormat('这里有 {0} 题可以生成变式，一次最多 {1} 题。', [batch.length, VARIANT_BATCH_CAP]), ui('其余的等这批写好后再点一次。'))}>
                  <span tabIndex={0}>{uiFormat("显示 {0} / 共 {1} 题", [shown.length, total])}</span>
                </Tooltip>
                : <span>{uiFormat("显示 {0} / 共 {1} 题", [shown.length, total])}</span>}
              {filtering && <Button variant="link" size="sm" onClick={clearFilter}>{ui("清除筛选")}</Button>}
            </div>
          </div>
        </div>
      )}

      {gated && total > 0 && (
        <ModelSetupGate feature="variants" model={{ ready: false }} onOpenSettings={onOpenSettings} />
      )}

      {ask && canGenerate && (
        <div className="wb-consent" ref={consentRef} role="group" aria-label={ui("先确认是否备变式题")}>
          <strong>{ui("要让 AI 为错题备变式题吗？")}</strong>
          <p>{ui("生成变式会在后台少量调用模型：每道题约 1 次轻量调用，只用你的原题和原文引用改写，写好的题会放进「为你定制」。可以随时在「设置 › 学习画像与导览」里的「陪学」关闭。")}</p>
          <div className="wb-consent-actions">
            <Button variant="secondary" icon="sparkle" busy={working} disabled={!ask.cards.length}
              onClick={() => run(ask.cards, true)}>{ui("同意并生成")}</Button>
            <Button variant="quiet" disabled={working} onClick={() => setAsk(null)}>{ui("暂不")}</Button>
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
        const isOpen = openGroups.has(group.key);
        const rowsId = `${groupsId}-${group.key}`;
        return (
          <div key={group.key} className={"wb-group" + (isOpen ? " is-open" : "")} {...(index === 0 ? { "data-tour": "wrongbook-list" } : {})}>
            <div className="wb-group-head">
              <FoldButton className="wb-group-toggle" open={isOpen} controls={rowsId} onClick={() => toggleGroup(group.key)}>
                <Icon name="chevron" size={16} className="wb-chevron" />
                <span className="wb-group-title">
                  <strong>{group.title}</strong>
                  <small className="muted wb-num">{uiFormat("{0} 题", [group.rows.length])}</small>
                  <small className="wb-summary">{groupSummaryText(group.rows)}</small>
                  {group.mode === "topic" && <small className="muted wb-from">{uiFormat("来自 {0}", [group.deckTitles.join("、")])}</small>}
                </span>
              </FoldButton>
              <div className="wb-group-actions">
                {group.deckIds.length === 1 && applied.deck !== group.deckIds[0] && (
                  <Tooltip layer content={tip(ui('只显示这个题组里的错题。'), ui('点「清除筛选」可以回到全部。'))}>
                    <Button variant="quiet" size="sm" icon="filter" onClick={() => onlyThisDeck(group)}>{ui("只看这个题组")}</Button>
                  </Tooltip>
                )}
                {canGenerate && todo.length > 0 && (
                  <Tooltip layer content={generateTip()}>
                    <Button variant="quiet" size="sm" icon="sparkle" disabled={busy || working} onClick={() => generate(todo)}>
                      {uiFormat("为本组生成变式 ({0})", [todo.length])}
                    </Button>
                  </Tooltip>
                )}
              </div>
            </div>
            {isOpen && (
              <ul className="wb-rows" id={rowsId}>
                {group.rows.map((it) => (
                  <Row key={it.cardId} it={it} metaText={group.mode === "topic" ? shortName(it.deckTitle) : it.topic || ui("未分类")}
                    isOpen={expanded.has(it.cardId)} state={stateOf(it.cardId)} detail={details[it.cardId]} recItems={recItems} shortName={shortName}
                    canGenerate={canGenerate} canPracticePrepared={!!onPracticePrepared} disabled={busy} variantDisabled={busy || working} handlers={handlers} />
                ))}
              </ul>
            )}
          </div>
        );
      })}
      {items && hasMore && <nav className="wb-pages" aria-label={ui("待巩固题分页")}>
        <span>{uiFormat("第 {0}–{1} 题 / 共 {2} 题", [page * pageSize + 1, page * pageSize + total, counts.total])}</span>
        <Button disabled={busy || loading || page === 0} onClick={() => onPage(page - 1)}>{ui("上一页")}</Button>
        <Button disabled={busy || loading || (page + 1) * pageSize >= counts.total}
          onClick={() => onPage(page + 1)}>{ui("下一页")}</Button>
      </nav>}
    </section>
  );
}

export default function WrongBook({ data, onPractice, onPracticePrepared, onOpenSettings, onLibrary, onCreate, onSources }) {
  const { call, busy } = useStudy();
  const [course, setCourse] = usePageScope(data?.root, 'wrongbook', data?.focus?.course ?? '*');
  const [showInactive, setShowInactive] = useShowInactive(data?.root, 'wrongbook');
  const key = JSON.stringify(scopeArgs(course, showInactive));
  const [page, setPage] = useState(0);
  const [result, setResult] = useState(null),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState(""),
    [recs, setRecs] = useState(null),
    [details, setDetails] = useState({});
  // The coach status is the host's shared answer (ui/host-query.js): the review debrief and this page see the same copy while variants are written.
  const coachQuery = useHostQuery("coach.status", {}, { call, enabled: false });
  const coachLive = coachQuery.data ?? null;
  const setCoachLive = (value) => setQueryData("coach.status", {}, value);
  const seq = useRef(0);
  const current = result?.key === key ? result : null;
  const items = current?.items;
  const counts = current?.counts || { total: 0, graded: 0, self: 0, oral: 0 };
  const coach = coachLive || data?.coach || null;

  const load = useCallback(async (requestedPage = 0) => {
    const request = ++seq.current;
    setLoading(true);
    setErr("");
    try {
      let targetPage = requestedPage;
      const scope = scopeArgs(course, showInactive);
      // A page of this view is up to ten service pages, read one after the other (so a filter sees all of them, and the first draw waits for one).
      const readPage = async (at) => {
        const first = await call("wrongbook", { ...scope, offset: at * PAGE_SIZE, limit: FETCH_LIMIT });
        const found = [...(first?.items || [])];
        const wanted = Math.min(PAGE_SIZE, Math.max(0, (first?.total || 0) - at * PAGE_SIZE));
        while (found.length < wanted && request === seq.current) {
          const more = await call("wrongbook", { ...scope, offset: at * PAGE_SIZE + found.length, limit: FETCH_LIMIT });
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
      setResult({ key, counts: { total: res?.total ?? res?.items?.length ?? 0,
        graded: res?.gradedTotal ?? res?.items?.filter((item) => item.assessment === "graded").length ?? 0,
        self: res?.selfTotal ?? res?.items?.filter((item) => item.assessment === "self").length ?? 0,
        oral: res?.oralTotal ?? 0, rubric: res?.rubricTotal ?? 0 },
      // Keep this guard for older service versions that still return suspended cards.
        items: (res?.items || []).filter((it) => it && it.deckId && it.cardId && !it.suspended) });
      setPage(targetPage);
      asked.current = new Set();
      setDetails({});
      // Similar questions are a bonus: a library without the read just shows none.
      if (res?.total) call("wrongbook.recommend", { ...scope, limit: 10 })
        .then((found) => request === seq.current && setRecs({ key, items: found?.items || [] }))
        .catch(() => request === seq.current && setRecs({ key, items: [] }));
      else setRecs(null);
    } catch (e) {
      if (request === seq.current) setErr(errorMessage(e));
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [call, course, showInactive, key]);
  useEffect(() => {
    load(0);
  }, [load]);

  // While variants are being written, watch the cheap status call until they land.
  const preparing = !!coach?.preparing;
  usePolling(coachQuery.refresh, { intervalMs: POLL_MS, enabled: preparing });

  const generate = useCallback(async (cards, { consent } = {}) => {
    const res = await call("coach.variants", { cards, ...(consent ? { consent: true } : {}) });
    if (res?.status) setCoachLive(res.status);
    return res;
  }, [call]);
  const asked = useRef(new Set());
  const loadDetail = useCallback((ref) => {
    if (asked.current.has(ref.cardId)) return;
    asked.current.add(ref.cardId);
    setDetails((known) => ({ ...known, [ref.cardId]: "loading" }));
    call("wrongbook.detail", ref).then((detail) => setDetails((now) => ({ ...now, [ref.cardId]: detail })))
      .catch((e) => setDetails((now) => ({ ...now, [ref.cardId]: { error: e.message || true } })));
  }, [call]);

  return (
    <WrongBookView data={data} course={course} onCourse={setCourse} showInactive={showInactive} onShowInactive={setShowInactive} items={items} counts={counts} loading={loading} err={err}
      page={page} pageSize={PAGE_SIZE} hasMore={counts.total > PAGE_SIZE} onReload={load} onPage={load}
      recs={recs?.key === key ? recs : null} recsLoading={!!items?.length && recs?.key !== key} coach={coach} details={details} onLoadDetail={loadDetail}
      onPractice={onPractice} onPracticePrepared={onPracticePrepared} onGenerate={generate} onOpenSettings={onOpenSettings}
      busy={busy} onLibrary={onLibrary} onCreate={onCreate} onSources={onSources} openKey={`study-wrongbook-open:v1:${data?.root || ""}`} />
  );
}
