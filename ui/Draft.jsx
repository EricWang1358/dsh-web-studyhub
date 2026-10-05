import { ui, uiFormat } from "./i18n.js";
import { uiRich } from "./i18n-rich.jsx";
import React from "react";
import { Banner, Button, Disclosure, Hint, PageHeader, Panel, useToast } from "./components/index.js";
import { formatNumber } from "./format.js";
import { isActiveJob, isCancellable } from "./job-visibility.js";
import { JOB_STATUS, JOB_TYPES } from "../lib/job-status.js";
import { kinds } from "./shared.js";
import { reviewedCardFingerprint, reviewedCardStatus } from "../lib/review-integrity.js";
import { readableQualityIssue } from "./quality.js";
import { JevCardBadge, JevCardSignals, JevDecidedBadge, JevDecidedNote } from "./JevBadge.jsx";
import { experimentalShown } from "./experimental-flag.js";
import { selfCitedCardCount } from "../lib/source-provenance.js";
import { repairSourcesForCard } from "../lib/repair-evidence.js";
import { CaseDraftHeader, CriteriaEditor } from "./CaseWorkspace.jsx";
import { renderRubric } from "../lib/case-study.js";
import { DraftAddFromSources, DraftTopUp, OmittedQuestions, ShortfallReasons } from "./DraftShortfall.jsx";
import { canAddFromSources, draftWork, generationRecordLines, missingQuestions } from "./draft-shortfall.js";
import { modelReadiness } from "./generation-status.js";
import LocalImagePicker from './LocalImagePicker.jsx';
import { useStudy } from "./study-context.jsx";
import { useSciencePreferences } from './SciencePreferences.jsx';

/* 草稿审阅视图：逐题表单 / JSON 文本两种编辑模式。保存走 draft.save，
   发布需先保存再 draft.publish（draftVersion 乐观锁）。blankCard /
   patchCard / parseDraft 由 App 传入：blankCard 依赖当前资料列表，
   parseDraft 同时被恢复暂存的 JSON 校验使用。 */
export default function Draft({
  data,
  draft,
  draftLoaded,
  setDraft,
  draftText,
  setDraftText,
  jsonMode,
  setJsonMode,
  openDraft,
  continueDraft,
  addFromSources,
  onOpenPublished,
  onStartPublished,
  clearRecovery,
  setPage,
  setModal,
  setSelectedSources,
  setGenSource,
  blankCard,
  patchCard,
  parseDraft,
}) {
  const { call, busy, act } = useStudy();
  const toast = useToast();
  const [deleteArmedId, setDeleteArmedId] = React.useState(null);
  const science = useSciencePreferences();
  const appendImage = (cardId, key, markdown) => setDraft(current => current.id !== draft.id ? current : ({ ...current, cards: current.cards.map(card =>
    card.id === cardId ? { ...card, [key]: (card[key] || '') + '\n\n' + markdown } : card) }));
  const deleteArmed = deleteArmedId === draft.id;
  const rawAudits = draft.editorial?.audits ?? [draft.editorial?.audit];
  const audits = (Array.isArray(rawAudits) ? rawAudits : []).filter((audit) =>
    audit && Array.isArray(audit.targets) && Array.isArray(audit.changes) && Array.isArray(audit.checks));
  const failureLines = generationRecordLines(draft.editorial?.failures), previousLines = generationRecordLines(draft.editorial?.previousFailures);
  const incomplete = Number.isInteger(draft.editorial?.completedParts) &&
    Number.isInteger(draft.editorial?.parts) && draft.editorial.completedParts < draft.editorial.parts;
  // Whatever is working on this draft right now (a top-up, the run still writing it, a repair, a publication check) owns it:
  // saving or publishing over it would be overwritten or refused.
  const work = draftWork(draft, data.jobs);
  const generating = incomplete && ['topup', 'generating'].includes(work?.kind);
  const missing = missingQuestions(draft);
  const shortBlock = missing > 0 && !draft.editorial?.repairOfDeckId && !draft.editorial?.partialEdit;
  const availableSources = new Set(data.sources.map((source) => source.id));
  const untestedSourceIds = (draft.editorial?.coverage?.uncited || [])
    .map((source) => source.id).filter((id) => availableSources.has(id));
  const coverageSources = draft.editorial?.coverage?.sources || [];
  const coveredSources = coverageSources.filter((source) => source.accepted > 0);
  const uncoveredSources = coverageSources.length
    ? coverageSources.filter((source) => !source.accepted)
    : draft.editorial?.coverage?.uncited || [];
  const reviewStatus = Object.keys(draft.editorial?.reviewedCards || {}).length
    ? reviewedCardStatus(draft) : null;
  const needsReview = reviewStatus ? reviewStatus.changed : draft.cards.length;
  const selfCited = selfCitedCardCount(draft.cards, data.sources);
  const rejectedIssues = draft.editorial?.rejectedIssues || {};
  const rejectedCards = draft.cards.filter((card) => rejectedIssues[card.id]);
  const rejectedCount = rejectedCards.length;
  const missingRepairEvidence = rejectedCards.filter((card) =>
    !repairSourcesForCard(card, draft, data.sources).length).length;
  const repairableCount = rejectedCount - missingRepairEvidence;
  const retryPublishCount = draft.cards.length - rejectedCount;
  const publishedDeckId = draft.editorial?.repairOfDeckId ||
    (draft.editorial?.partialEdit ? draft.editingDeckId : null);
  const publishedDeck = data.decks.find((deck) => deck.id === publishedDeckId);
  const publicationLabel = draft.editingDeckId
    ? ui("保存并更新题组 →")
    : draft.editorial?.repairOfDeckId ? ui("保存并补发到原题组 →") : ui("保存并发布 →");
  const repairJob = data.jobs?.find((job) => job.draftId === draft.id &&
    job.type === JOB_TYPES.DRAFT_REPAIR && isActiveJob(job));
  const repairRunning = !!repairJob;
  const publishJob = data.jobs?.find((job) => job.draftId === draft.id &&
    job.type === JOB_TYPES.DRAFT_PUBLISH && isCancellable(job));
  const latestDraft = data.drafts.find((item) => item.id === draft.id);
  const missingDraft = draft.draftVersion > 0 && !latestDraft;
  const staleDraft = latestDraft && latestDraft.draftVersion !== draft.draftVersion;
  const updatingDraft = generating || repairRunning || !!publishJob || !!work;
  const unsavedDraft = JSON.stringify(draft) !== draftLoaded ||
    (jsonMode && draftText !== JSON.stringify(draft, null, 2));
  React.useEffect(() => {
    if (staleDraft && !updatingDraft && !unsavedDraft) openDraft(latestDraft);
  }, [staleDraft, updatingDraft, unsavedDraft, latestDraft, openDraft]);
  const activeReview = draft.editingDeckId && data.runs?.some((run) =>
    run.deckIds?.includes(draft.editingDeckId) || run.deckId === draft.editingDeckId);
  function saveAsNewDraft() {
    let copy;
    try {
      copy = structuredClone(jsonMode ? parseDraft(draftText) : draft);
    } catch (error) {
      toast.error(uiFormat("JSON 格式不正确：{0}", [error.message]));
      return;
    }
    copy.id = crypto.randomUUID();
    delete copy.draftVersion;
    delete copy.editingDeckId;
    delete copy.baseVersion;
    delete copy.quality;
    if (copy.editorial) copy.editorial = { summary: ui("由旧草稿另存；发布前会重新检查") };
    act("draft.save", { deck: copy }, openDraft);
  }
  function toggleJsonMode() {
    if (!jsonMode) setDraftText(JSON.stringify(draft, null, 2));
    else {
      try {
        setDraft(parseDraft(draftText));
      } catch (error) {
        toast.error(uiFormat("JSON 格式不正确：{0}", [error.message]));
        return;
      }
    }
    setJsonMode(!jsonMode);
  }
  return (
    <section className="page draft-page">
      <PageHeader eyebrow={ui("发布草稿")} title={ui("草稿与发布")}
        actions={jsonMode && <Button variant="quiet" onClick={toggleJsonMode}>{ui("返回逐题编辑")}</Button>} />
      {!jsonMode && <label className="draft-title-field">{ui("题组标题")}<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>}
      {!jsonMode && draft.format === "case-study" && <CaseDraftHeader draft={draft} data={data} />}
      <p className="draft-count">{uiRich("当前草稿 {0} 题", <strong>{draft.cards.length}</strong>)}{unsavedDraft && <><span aria-hidden="true"> · </span><span>{ui("有未保存修改")}</span></>}</p>
      <div className="sticky-actions" data-tour="draft-publish">
        <Button
          disabled={busy || updatingDraft || staleDraft || missingDraft}
          onClick={() => {
            let d;
            try {
              d = jsonMode ? parseDraft(draftText) : draft;
            } catch (e) {
              toast.error("JSON 格式不正确：" + e.message);
              return;
            }
            act("draft.save", { deck: d }, openDraft);
          }}
        >{ui("保存并校验")}</Button>
        <Button variant="primary"
          disabled={busy || updatingDraft || staleDraft || missingDraft || activeReview}
          title={activeReview ? ui("先完成或结束原题组的学习") : undefined}
          onClick={async () => {
            let d;
            try {
              d = jsonMode ? parseDraft(draftText) : draft;
            } catch (e) {
              toast.error("JSON 格式不正确：" + e.message);
              return;
            }
            await act("draft.save", { deck: d }, async (saved, { isCurrent = () => true } = {}) => {
              if (isCurrent()) openDraft(saved);
              const published = await call("draft.publish.quick", {
                id: saved.id,
                draftVersion: saved.draftVersion,
              });
              if (isCurrent()) clearRecovery();
              try {
                const run = await call("review.start", { deckId: published.id,
                  mode: "new", count: 10, ordered: true, fresh: true });
                if (isCurrent()) {
                  onStartPublished(run);
                  toast.success(uiFormat("已发布，开始学习本轮 {0} 道新题。",[run.total]));
                }
              } catch {
                if (isCurrent()) {
                  setPage("library");
                  toast.success(ui("题组已发布；当前没有可开始的新题。"));
                }
              }
            }, { afterNavigation: true });
          }}
        >
          {publicationLabel}
        </Button>
        <Button variant="danger"
          disabled={busy || missingDraft}
          onBlur={() => setDeleteArmedId(null)}
          onClick={() => {
            if (!deleteArmed) {
              setDeleteArmedId(draft.id);
              return;
            }
            setDeleteArmedId(null);
            act(
              "draft.delete",
              { id: draft.id, draftVersion: draft.draftVersion },
              () => {
                clearRecovery();
                setPage("library");
              },
            );
          }}
        >
          {deleteArmed
            ? updatingDraft ? ui("确认删除并停止任务（无法撤销）") : ui("确认删除草稿（无法撤销）")
            : updatingDraft ? ui("删除草稿并停止任务") : ui("删除草稿")}
        </Button>
      </div>
      <div className="draft-notices">
        {staleDraft && unsavedDraft && <Banner tone="warning" role="status" title={ui("草稿已在后台更新")}
          action={{ label: ui("载入最新草稿"), onClick: () => openDraft(latestDraft) }}>
          {ui("载入最新草稿可查看修题结果。本页尚未保存的修改会被替换。")}
        </Banner>}
        {missingDraft && <Banner tone="warning" role="status" title={ui("这份草稿已删除或发布")}
          action={{ label: ui("另存为新草稿"), disabled: busy, onClick: saveAsNewDraft }}>
          {ui("当前页面是旧版本，无法继续保存。可以把页面中的内容另存为独立的新草稿，发布前会重新检查。")}
        </Banner>}
        {staleDraft && !unsavedDraft && <Banner tone="info" role="status">
          {updatingDraft ? ui("后台修题正在更新草稿，完成后会自动载入。") : ui("正在载入后台修好的题目…")}
        </Banner>}
        {updatingDraft && !staleDraft && <Banner tone="info" role="status">
          {publishJob ? publishJob.stage : ui("后台任务正在更新这份草稿，完成后可继续保存或发布。")}
        </Banner>}
        {activeReview && <Banner tone="warning" role="status">{ui("原题组还有进行中的学习。请先从侧栏回到题目，完成或结束练习，再发布编辑。")}</Banner>}
        {rejectedCount > 0 && unsavedDraft && !staleDraft && <Banner tone="warning" role="status">{ui("当前有未保存的编辑。先保存；如果改过题目内容，请重新发布检查，再决定是否交给后台修复。")}</Banner>}
        {shortBlock && <Banner tone="warning" role="status" className="draft-shortfall" title={uiFormat("比计划少 {0} 题", [missing])}>
          <ShortfallReasons draft={draft} />
          <OmittedQuestions draft={draft} />
          <DraftTopUp draft={draft} jobs={data.jobs} busy={busy || unsavedDraft || staleDraft} modelReady={modelReadiness(data).ready} call={call} onContinue={continueDraft} />
          {unsavedDraft && <Hint as="small">{ui("先保存草稿，再补题。")}</Hint>}
        </Banner>}
      </div>
      <details className="draft-generation-details">
        <summary>{draft.editorial?.failures?.length ? uiFormat("生成详情 · {0} 条生成记录", [draft.editorial.failures.length]) : ui("生成详情")}</summary>
      {draft.editorial && (
        <>
          {draft.editorial.summary && <Disclosure className="editorial-summary" summary={ui("生成审阅摘要 · 点击展开")}>
            <p>{draft.editorial.summary}</p>
          </Disclosure>}
          {experimentalShown(data) && <JevDecidedNote decided={draft.editorial.jevDecided} />}
          {draft.editorial.repairTried > 0 && <Hint data-repair-yield>{uiFormat("修复后保留 {0} 题 · 丢弃 {1} 题（其中 {2} 题修复后仍未通过，原因见「没进入草稿的题」）",
            [draft.editorial.repairedInRun || 0, (draft.editorial.omitted || []).length, draft.editorial.repairTried - (draft.editorial.repairedInRun || 0)])}</Hint>}
          {draft.editorial.suggestions?.length > 0 && <Disclosure className="review-suggestions" summary={uiFormat("审阅建议（已记录，不影响通过）· {0}", [draft.editorial.suggestions.length])}>
            <ul>{draft.editorial.suggestions.map((item, index) => <li key={index}>{item.text}</li>)}</ul>
          </Disclosure>}
          <Hint>
            {[reviewStatus
              ? uiFormat("{0} / {1} 题与上次模型审阅时一致。", [reviewStatus.unchanged, reviewStatus.total])
              : ui("这份草稿没有可核对的逐题审阅版本。"),
            needsReview > 0 ? uiFormat("{0} 题未经过模型审阅。", [needsReview]) : ""].filter(Boolean).join(" ")}
          </Hint>
        </>
      )}
      {!draft.editorial && <Banner tone="info" role="status">{ui("这份草稿尚未经过模型审阅。直接发布会保留未审阅标记。")}</Banner>}
      {selfCited > 0 && <Banner tone="warning" role="status">
        {uiFormat("{0} 道题只引用了导入的题目自身。模型可以检查题目是否自洽，但无法据此独立核实答案；如需事实依据，请把引用换成原始资料。", [selfCited])}</Banner>}
      {draft.editorial?.requested && !draft.editorial?.repairOfDeckId && !draft.editorial?.partialEdit && <p>{uiFormat("本次生成通过检查 {0} / {1} 题；当前草稿 {2} 题。", [draft.editorial.generated ?? draft.cards.length, draft.editorial.requested, draft.cards.length])}</p>}
      {incomplete && <Banner tone="warning" role="status">
        {uiFormat("{0}：已完成 {1} / {2} 批。当前草稿只包含已保存的题目；其余批次尚未完成检查。", [generating ? ui("仍在生成") : ui("本次生成已中断"), draft.editorial.completedParts, draft.editorial.parts])}</Banner>}
      {audits.map((audit, i) => <Disclosure key={i} summary={uiFormat("质量自查记录 · 第 {0} 批 · 主动改写 {1} 项", [audit.part || i + 1, audit.changes.length])}>
        <p className="muted">{uiFormat("已规划 {0} 个考点；独立验收逐题检查自足性、泄题风险、选项质量、学习价值和证据支持。这是生成时的检查记录。", [audit.targets.length])}</p>
        <ul>{audit.changes.filter((change) => typeof change?.summary === "string").map((change, index) => <li key={index}>{change.summary}</li>)}</ul>
        <ul>{audit.checks.filter((check) => typeof check?.explanation === "string").map((check, index) => <li key={index}>{check.explanation}</li>)}</ul>
      </Disclosure>)}
      {failureLines.length > 0 && <Banner tone="warning" title={ui("部分题目未生成成功，合格题目已保留")}>
        <Disclosure summary={ui("查看记录")}><ul>{failureLines.map((line, i) => <li key={i}>{line}</li>)}</ul></Disclosure>
      </Banner>}
      {!shortBlock && <OmittedQuestions draft={draft} />}
      {rejectedCount > 0 && <Banner tone="warning" role="status"
        title={retryPublishCount > 0 ? uiFormat("{0} 道题待处理 · {1} 道待重新检查发布", [rejectedCount, retryPublishCount]) : uiFormat("{0} 道题待处理", [rejectedCount])}>
        <p>{[draft.editorial?.partialEdit
          ? ui("通过检查的修改已更新到原题组；未通过的修改留在草稿。原有题目仍按旧内容供学习，新加的题尚未发布。")
          : draft.editorial?.repairOfDeckId
            ? ui("先前通过检查的题目已发布；当前草稿中的题目尚未发布。")
            : ui("当前草稿中的题目尚未发布。"),
        retryPublishCount > 0 && ui("可点击「保存并发布」重新检查其余题目。"),
        ui("待处理题目可自行修改，或选择交给后台修题。")].filter(Boolean).join(" ")}</p>
        {publishedDeck && <p>{uiFormat("已发布题组「{0}」现有 {1} 题。", [publishedDeck.title, publishedDeck.count])}{" "}
          <Button variant="link" size="sm" disabled={busy} onClick={() => onOpenPublished(publishedDeck.id)}>{ui("查看已发布题组")}</Button>
        </p>}
        <Disclosure summary={ui("查看待处理问题")}>
          <ul>{rejectedCards.map((card) =>
            <li key={card.id}><strong>{card.prompt || ui("问题尚未填写")}</strong>：{rejectedIssues[card.id]
              .map((issue) => readableQualityIssue(issue).replace(/^第 \d+ 题：/, "")).join("；")}</li>)}</ul>
        </Disclosure>
        {missingRepairEvidence > 0 && <p>
          {uiFormat("{0} 题没有可定位的资料。请先在题目中添加引用来源；{1}", [missingRepairEvidence, repairableCount > 0 ? uiFormat("后台仍可先处理其余 {0} 题。", [repairableCount]) : ui("补充后才能启动后台修题。")])}
        </p>}
        <div className="draft-banner__actions">
          <Button size="sm" disabled={busy || repairRunning || staleDraft || unsavedDraft || !data.modelReady || !repairableCount}
            title={unsavedDraft ? ui("先保存草稿") : !data.modelReady ? ui("先在设置中选择模型") : !repairableCount ? ui("先给待处理题目添加引用来源") : ui("后台逐题修复并独立复审")}
            onClick={() => act("draft.repair", { id: draft.id, draftVersion: draft.draftVersion },
              () => toast.success(ui("后台修题已启动；完成后可回来发布通过的题目。")))}>
            {repairRunning ? ui("后台修题中…") : ui("交给后台修题")}
          </Button>
          {repairJob && <Button size="sm" variant="quiet" disabled={busy || repairJob.status === JOB_STATUS.CANCELLING}
            onClick={() => act("job.cancel", { jobId: repairJob.id },
              () => toast.success(ui("正在停止后台修题；已修好的题目会保留在草稿中。")))}>
            {repairJob.status === JOB_STATUS.CANCELLING ? ui("正在停止修题…") : ui("停止修题，保留草稿")}
          </Button>}
        </div>
      </Banner>}
      {previousLines.length > 0 && <Banner tone="warning" title={ui("之前未完成的批次")}>
        <Disclosure summary={ui("查看记录")}><ul>{previousLines.map((line, i) => <li key={i}>{line}</li>)}</ul></Disclosure>
      </Banner>}
      {draft.editorial?.coverage && <Disclosure summary={uiFormat("逐份资料出题记录 · 已引用 {0} / {1} 份", [draft.editorial.coverage.cited, draft.editorial.coverage.selected])}>
        <p className="muted">{ui("“规划”是模型选出的考点次数，“通过”是最终引用该资料的合格题数；即使有题，也不代表整页或全部知识点都已覆盖。")}</p>
        {coveredSources.length > 0 && <ul>{coveredSources.map((source) => <li key={source.id}>
          {uiFormat("{0}：规划 {1} 个考点，通过 {2} 题", [source.title, source.planned, source.accepted])}</li>)}</ul>}
        {untestedSourceIds.length > 0 && canAddFromSources(draft) && <DraftAddFromSources draft={draft} jobs={data.jobs} sourceIds={untestedSourceIds}
          busy={busy || unsavedDraft || staleDraft} modelReady={modelReadiness(data).ready} call={call} onAdd={addFromSources}
          onNewDeck={(ids) => { setSelectedSources(ids); setGenSource("files"); setPage("generate"); }} />}
        {untestedSourceIds.length > 0 && canAddFromSources(draft) && unsavedDraft && <Hint as="small">{ui("先保存草稿，再补题。")}</Hint>}
        {uncoveredSources.length > 0 && <Disclosure summary={uiFormat("{0} 份资料本次没有合格题 · 查看清单", [uncoveredSources.length])}>
          <ul>{uncoveredSources.map((source) => <li key={source.id}>
            {source.title}{source.planned ? uiFormat("：规划 {0} 个考点", [source.planned]) : ""}
          </li>)}</ul>
        </Disclosure>}
      </Disclosure>}
      {draft.quality?.warnings?.map((w, i) => <Banner tone="warning" key={i}>{w}</Banner>)}
      {draft.quality?.errors?.length > 0 && <Banner tone="warning" title={uiFormat("{0} 项题目问题", [draft.quality.errors.length])}>
        <Disclosure summary={ui("查看详情")}>
          <ul>{draft.quality.errors.map((issue, index) => <li key={index}>{readableQualityIssue(issue)}</li>)}</ul>
        </Disclosure>
      </Banner>}
      </details>
      {!jsonMode && <div className="draft-edit-heading">
        <div><h2>{ui("题目")}</h2><span>{uiFormat("{0} 题 · 按需展开编辑", [draft.cards.length])}</span></div>
        <details className="draft-advanced">
          <summary>{ui("高级编辑")}</summary>
          <Button onClick={toggleJsonMode}>{ui("JSON 编辑")}</Button>
        </details>
      </div>}
      {jsonMode ? (
        <textarea
          className="json-editor"
          aria-label={ui("题组 JSON")}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
        />
      ) : (
        <>
          {draft.cards.map((q, i) => (
            <Panel as="details" className="draft-card" key={q.id}>
              <summary>
                <span>{formatNumber(i + 1, { minimumIntegerDigits: 2 })}</span>
                {q.prompt.replace(/!\[([^\]]*)\]\(data:image\/[^)]+\)/g, '[$1]')}
                <small>{kinds[q.kind]}</small>
                {draft.editorial?.reviewedCards?.[q.id] !== reviewedCardFingerprint(q) &&
                  <small>{ui("未自动审阅")}</small>}
                {selfCitedCardCount([q], data.sources) > 0 && <small>{ui("仅有导入题目引用")}</small>}
                {experimentalShown(data) && <JevCardBadge signal={draft.editorial?.jev?.signals?.[q.id]} />}
                {experimentalShown(data) && draft.editorial?.jevDecided?.cards?.[q.id] && <JevDecidedBadge />}
              </summary>
              {experimentalShown(data) && <JevCardSignals signal={draft.editorial?.jev?.signals?.[q.id]} threshold={draft.editorial?.jev?.threshold} />}
              <label>{ui("问题")}<textarea
                  rows={3}
                  value={q.prompt}
                  onChange={(e) =>
                    patchCard(i, "prompt", e.target.value)
                  }
                />
              </label>
              {science.localImages && <LocalImagePicker key={JSON.stringify([data.root, draft.id, q.id, 'prompt'])} disabled={busy} onInsert={markdown => appendImage(q.id, 'prompt', markdown)} />}
              <div className="two-col">
                <label>{ui("主题")}<input
                    value={q.topic}
                    onChange={(e) =>
                      patchCard(i, "topic", e.target.value)
                    }
                  />
                </label>
                <label>{ui("学习目标")}<input
                    value={q.objective}
                    onChange={(e) =>
                      patchCard(i, "objective", e.target.value)
                    }
                  />
                </label>
              </div>
              {[
                "answer",
                "hint",
                "explanation",
                "misconception",
                ...(q.kind === "open" && !q.rubricCriteria ? ["rubric"] : []),
              ].map((key) => (
                <React.Fragment key={key}><label>
                  {
                    {
                      answer: ui("答案"),
                      hint: ui("提示"),
                      explanation: ui("讲解"),
                      misconception: ui("易错点"),
                      rubric: ui("评分标准"),
                    }[key]
                  }
                  <textarea
                    rows={2}
                    value={q[key] || ""}
                    onChange={(e) =>
                      patchCard(i, key, e.target.value)
                    }
                  />
                </label>
                {science.localImages && ['answer', 'explanation'].includes(key) && <LocalImagePicker key={JSON.stringify([data.root, draft.id, q.id, key])} disabled={busy} onInsert={markdown => appendImage(q.id, key, markdown)} />}
                </React.Fragment>
              ))}
              {q.rubricCriteria && <CriteriaEditor criteria={q.rubricCriteria} onChange={(criteria) => {
                // Case questions (WP12): marks follow the criteria; the plain rubric text is rewritten for older readers.
                patchCard(i, "rubricCriteria", criteria);
                patchCard(i, "marks", criteria.reduce((sum, criterion) => sum + (Number(criterion.marks) || 0), 0));
                patchCard(i, "rubric", renderRubric(criteria, draft.case?.language));
              }} />}
              {q.options?.map((o, oi) => (
                <div className="edit-option" key={o.id}>
                  <label className="inline">
                    <input
                      type={q.kind === "quiz" ? "radio" : "checkbox"}
                      name={q.kind === "quiz" ? `correct-${q.id}` : undefined}
                      checked={o.correct}
                      onChange={(e) =>
                        patchCard(
                          i,
                          "options",
                          q.options.map((x, j) =>
                            ({ ...x, correct: q.kind === "quiz"
                              ? j === oi : j === oi ? e.target.checked : x.correct }),
                          ),
                        )
                      }
                    />{ui("正确选项")}</label>
                  <input
                    aria-label={uiFormat("选项 {0}", [o.id])}
                    value={o.text}
                    onChange={(e) =>
                      patchCard(
                        i,
                        "options",
                        q.options.map((x, j) =>
                          j === oi
                            ? { ...x, text: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                  <textarea
                    aria-label={uiFormat("选项解析 {0}", [o.id])}
                    value={o.explanation}
                    onChange={(e) =>
                      patchCard(
                        i,
                        "options",
                        q.options.map((x, j) =>
                          j === oi
                            ? { ...x, explanation: e.target.value }
                            : x,
                        ),
                      )
                    }
                  />
                  <Button variant="danger"
                    onClick={() => patchCard(i, "options", q.options.filter((_, index) => index !== oi))}>{ui("删除这个选项")}</Button>
                </div>
              ))}
              {["quiz", "multi"].includes(q.kind) && <Button icon="plus"
                disabled={(q.options?.length || 0) >= 6}
                onClick={() => patchCard(i, "options", [...(q.options || []),
                  { id: crypto.randomUUID(), text: "", correct: false, explanation: "" }])}>{uiFormat("添加选项（{0}/6）", [q.options?.length || 0])}
              </Button>}
              <Button
                disabled={draft.cards.length <= 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    cards: draft.cards.filter(
                      (_, index) => index !== i,
                    ),
                  })
                }
              >{ui("从草稿移除此题")}</Button>
              <div className="citations">
                {q.citations?.map((c, j) => (
                  <div key={j}>
                    <label>{ui("引用来源")}<select
                        value={c.sourceId}
                        onChange={(e) =>
                          patchCard(
                            i,
                            "citations",
                            q.citations.map((citation, index) =>
                              index === j
                                ? {
                                    ...citation,
                                    sourceId: e.target.value,
                                    quote: "",
                                  }
                                : citation,
                            ),
                          )
                        }
                      >
                        {data.sources.map((source) => (
                          <option key={source.id} value={source.id}>
                            {source.title}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>{ui("逐字原文引用")}<textarea
                        value={c.quote}
                        onChange={(e) =>
                          patchCard(
                            i,
                            "citations",
                            q.citations.map((citation, index) =>
                              index === j
                                ? {
                                    ...citation,
                                    quote: e.target.value,
                                  }
                                : citation,
                            ),
                          )
                        }
                        placeholder={ui("从原文复制能支持答案的段落")}
                      />
                    </label>
                    <Button
                      onClick={() =>
                        setModal({
                          type: "source",
                          source: data.sources.find(
                            (s) => s.id === c.sourceId,
                          ),
                          quote: c.quote,
                        })
                      }
                    >
                      ↗{" "}
                      {data.sources.find((s) => s.id === c.sourceId)
                        ?.title || ui("原文")}
                      <blockquote>{c.quote}</blockquote>
                    </Button>
                    <Button variant="danger"
                      onClick={() => patchCard(i, "citations", q.citations.filter((_, index) => index !== j))}>{ui("删除这条引用")}</Button>
                  </div>
                ))}
                <Button icon="plus" disabled={!data.sources.length}
                  onClick={() => patchCard(i, "citations", [...(q.citations || []),
                    { sourceId: data.sources[0].id, quote: "" }])}>{ui("添加原文引用")}</Button>
              </div>
            </Panel>
          ))}
          <Button
            icon="plus" disabled={draft.cards.length >= 100}
            onClick={() =>
              setDraft({
                ...draft,
                cards: [...draft.cards, blankCard()],
              })
            }
          >{ui("添加闪卡")}</Button>
        </>
      )}
    </section>
  );
}
