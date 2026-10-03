import { ui, uiFormat } from "./i18n.js";
import React from "react";
import { kinds } from "./shared.js";
import { reviewedCardFingerprint, reviewedCardStatus } from "../lib/review-integrity.js";
import { readableQualityIssue } from "./quality.js";
import { JevCardBadge, JevCardSignals, JevDecidedBadge, JevDecidedNote } from "./JevBadge.jsx";
import { experimentalShown } from "./experimental-flag.js";
import { selfCitedCardCount } from "../lib/source-provenance.js";
import { repairSourcesForCard } from "../lib/repair-evidence.js";
import { CaseDraftHeader, CriteriaEditor } from "./CaseWorkspace.jsx";
import { renderRubric } from "../lib/case-study.js";
import { DraftTopUp, OmittedQuestions, ShortfallReasons } from "./DraftShortfall.jsx";
import { describeGenerationRecord, draftWork, missingQuestions } from "./draft-shortfall.js";
import { modelReadiness } from "./generation-status.js";
import LocalImagePicker from './LocalImagePicker.jsx';
import { useSciencePreferences } from './SciencePreferences.jsx';

/* 草稿审阅视图：逐题表单 / JSON 文本两种编辑模式。保存走 draft.save，
   发布需先保存再 draft.publish（draftVersion 乐观锁）。blankCard /
   patchCard / parseDraft 由 App 传入：blankCard 依赖当前资料列表，
   parseDraft 同时被恢复暂存的 JSON 校验使用。 */
export default function Draft({
  data,
  busy,
  act,
  call,
  draft,
  draftLoaded,
  setDraft,
  draftText,
  setDraftText,
  jsonMode,
  setJsonMode,
  openDraft,
  continueDraft,
  onOpenPublished,
  onStartPublished,
  clearRecovery,
  setPage,
  setNotice,
  setError,
  setModal,
  setSelectedSources,
  setGenSource,
  blankCard,
  patchCard,
  parseDraft,
}) {
  const [deleteArmedId, setDeleteArmedId] = React.useState(null);
  const science = useSciencePreferences();
  const appendImage = (cardId, key, markdown) => setDraft(current => current.id !== draft.id ? current : ({ ...current, cards: current.cards.map(card =>
    card.id === cardId ? { ...card, [key]: (card[key] || '') + '\n\n' + markdown } : card) }));
  const deleteArmed = deleteArmedId === draft.id;
  const rawAudits = draft.editorial?.audits ?? [draft.editorial?.audit];
  const audits = (Array.isArray(rawAudits) ? rawAudits : []).filter((audit) =>
    audit && Array.isArray(audit.targets) && Array.isArray(audit.changes) && Array.isArray(audit.checks));
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
    job.type === "draft-repair" && ["queued", "running", "cancelling"].includes(job.status));
  const repairRunning = !!repairJob;
  const publishJob = data.jobs?.find((job) => job.draftId === draft.id &&
    job.type === "draft-publish" && ["queued", "running"].includes(job.status));
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
      setError(ui("JSON 格式不正确：") + error.message);
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
        setError(ui("JSON 格式不正确：") + error.message);
        return;
      }
    }
    setJsonMode(!jsonMode);
  }
  return (
    <section className="page draft-page">
      <div className="page-heading draft-heading">
        <div>
          <div className="eyebrow">PUBLISH YOUR DRAFT</div>
          <h1>{ui("草稿与发布")}</h1>
        </div>
        {jsonMode && <button type="button" onClick={toggleJsonMode}>{ui("返回逐题编辑")}</button>}
      </div>
      {!jsonMode && <label className="draft-title-field">{ui("题组标题")}<input value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} />
      </label>}
      {!jsonMode && draft.format === "case-study" && <CaseDraftHeader draft={draft} data={data} />}
      <p className="draft-count">{ui("当前草稿 ")}<strong>{draft.cards.length}</strong>{ui(" 题")}{unsavedDraft && <span>{ui(" · 有未保存修改")}</span>}</p>
      <div className="sticky-actions" data-tour="draft-publish">
        <button
          disabled={busy || updatingDraft || staleDraft || missingDraft}
          onClick={() => {
            let d;
            try {
              d = jsonMode ? parseDraft(draftText) : draft;
            } catch (e) {
              setError("JSON 格式不正确：" + e.message);
              return;
            }
            act("draft.save", { deck: d }, openDraft);
          }}
        >{ui("保存并校验")}</button>
        <button
          className="primary"
          disabled={busy || updatingDraft || staleDraft || missingDraft || activeReview}
          title={activeReview ? ui("先完成或结束原题组的学习") : undefined}
          onClick={async () => {
            let d;
            try {
              d = jsonMode ? parseDraft(draftText) : draft;
            } catch (e) {
              setError("JSON 格式不正确：" + e.message);
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
                  setNotice(uiFormat("已发布，开始学习本轮 {0} 道新题。",[run.total]));
                }
              } catch {
                if (isCurrent()) {
                  setPage("library");
                  setNotice(ui("题组已发布；当前没有可开始的新题。"));
                }
              }
            }, { afterNavigation: true });
          }}
        >
          {publicationLabel}
        </button>
        <button
          className="danger-text"
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
        </button>
      </div>
      {staleDraft && unsavedDraft && <div className="quality-note warning" role="status">
        <strong>{ui("草稿已在后台更新")}</strong>
        <p>{ui("载入最新草稿可查看修题结果。本页尚未保存的修改会被替换。")}</p>
        <button type="button" onClick={() => openDraft(latestDraft)}>{ui("载入最新草稿")}</button>
      </div>}
      {missingDraft && <div className="quality-note warning" role="status">
        <strong>{ui("这份草稿已删除或发布")}</strong>
        <p>{ui("当前页面是旧版本，无法继续保存。可以把页面中的内容另存为独立的新草稿，发布前会重新检查。")}</p>
        <button type="button" disabled={busy} onClick={saveAsNewDraft}>{ui("另存为新草稿")}</button>
      </div>}
      {staleDraft && !unsavedDraft && <p className="quality-note" role="status">
        {updatingDraft ? ui("后台修题正在更新草稿，完成后会自动载入。") : ui("正在载入后台修好的题目…")}
      </p>}
      {updatingDraft && !staleDraft && <p className="quality-note" role="status">
        {publishJob ? publishJob.stage : ui("后台任务正在更新这份草稿，完成后可继续保存或发布。")}
      </p>}
      {activeReview && <p className="quality-note warning" role="status">{ui("原题组还有进行中的学习。请先从侧栏回到题目，完成或结束练习，再发布编辑。")}</p>}
      {rejectedCount > 0 && unsavedDraft && !staleDraft && <p className="quality-note warning" role="status">{ui("当前有未保存的编辑。先保存；如果改过题目内容，请重新发布检查，再决定是否交给后台修复。")}</p>}
      {shortBlock && <div className="quality-note warning draft-shortfall" role="status">
        <strong>{uiFormat("比计划少 {0} 题", [missing])}</strong>
        <ShortfallReasons draft={draft} />
        <OmittedQuestions draft={draft} />
        <DraftTopUp draft={draft} jobs={data.jobs} busy={busy || unsavedDraft || staleDraft} modelReady={modelReadiness(data).ready} call={call} onContinue={continueDraft} />
        {unsavedDraft && <small className="muted">{ui("先保存草稿，再补题。")}</small>}
      </div>}
      <details className="draft-generation-details">
        <summary>{ui("生成详情")}{draft.editorial?.failures?.length ? uiFormat(" · {0} 条生成记录", [draft.editorial.failures.length]) : ""}</summary>
      {draft.editorial && (
        <>
          {draft.editorial.summary && <details className="quality-note editorial-summary">
            <summary>{ui("生成审阅摘要 · 点击展开")}</summary>
            <p>{draft.editorial.summary}</p>
          </details>}
          {experimentalShown(data) && <JevDecidedNote decided={draft.editorial.jevDecided} />}
          <p className="quality-note"><small>
              {reviewStatus
                ? uiFormat("{0} / {1} 题与上次模型审阅时一致。", [reviewStatus.unchanged, reviewStatus.total])
                : ui("这份草稿没有可核对的逐题审阅版本。")}
              {needsReview > 0
                ? uiFormat(" {0} 题未经过模型审阅。", [needsReview])
                : ""}
          </small></p>
        </>
      )}
      {!draft.editorial && <p className="quality-note" role="status">{ui("这份草稿尚未经过模型审阅。直接发布会保留未审阅标记。")}</p>}
      {selfCited > 0 && <p className="quality-note warning" role="status">
        {selfCited}{ui(" 道题只引用了导入的题目自身。模型可以检查题目是否自洽，但无法据此独立核实答案；如需事实依据，请把引用换成原始资料。")}</p>}
      {draft.editorial?.requested && !draft.editorial?.repairOfDeckId && !draft.editorial?.partialEdit && <p>{ui("本次生成通过检查 ")}{draft.editorial.generated ?? draft.cards.length} / {draft.editorial.requested}{ui(" 题；当前草稿 ")}{draft.cards.length}{ui(" 题。")}</p>}
      {incomplete && <p className="warning" role="status">
        {generating ? ui("仍在生成") : ui("本次生成已中断")}{ui("：已完成 ")}{draft.editorial.completedParts} / {draft.editorial.parts}{ui(" 批。当前草稿只包含已保存的题目；其余批次尚未完成检查。")}</p>}
      {audits.map((audit, i) => <details key={i}>
        <summary>{ui("质量自查记录 · 第 ")}{audit.part || i + 1}{ui(" 批 · 主动改写 ")}{audit.changes.length}{ui(" 项")}</summary>
        <p className="muted">{ui("已规划 ")}{audit.targets.length}{ui(" 个考点；独立验收逐题检查自足性、泄题风险、选项质量、学习价值和证据支持。这是生成时的检查记录。")}</p>
        <ul>{audit.changes.filter((change) => typeof change?.summary === "string").map((change, index) => <li key={index}>{change.summary}</li>)}</ul>
        <ul>{audit.checks.filter((check) => typeof check?.explanation === "string").map((check, index) => <li key={index}>{check.explanation}</li>)}</ul>
      </details>)}
      {draft.editorial?.failures?.length > 0 && <details className="warning">
        <summary>{ui("部分题目未生成成功，合格题目已保留")}</summary>
        <ul>{draft.editorial.failures.map((failure, i) => <li key={i}>{describeGenerationRecord(failure)}</li>)}</ul>
      </details>}
      {!shortBlock && <OmittedQuestions draft={draft} />}
      {rejectedCount > 0 && <div className="quality-note warning" role="status">
        <strong>{rejectedCount}{ui(" 道题待处理")}{retryPublishCount > 0 ? uiFormat(" · {0} 道待重新检查发布", [retryPublishCount]) : ""}</strong>
        <p>{draft.editorial?.partialEdit
          ? ui("通过检查的修改已更新到原题组；未通过的修改留在草稿。原有题目仍按旧内容供学习，新加的题尚未发布。")
          : draft.editorial?.repairOfDeckId
            ? ui("先前通过检查的题目已发布；当前草稿中的题目尚未发布。")
            : ui("当前草稿中的题目尚未发布。")}
          {retryPublishCount > 0 && ui(" 可点击「保存并发布」重新检查其余题目。")}
          {ui(" 待处理题目可自行修改，或选择交给后台修题。")}</p>
        {publishedDeck && <p>{ui("已发布题组「")}{publishedDeck.title}{ui("」现有 ")}{publishedDeck.count}{ui(" 题。")}{" "}
          <button type="button" disabled={busy} onClick={() => onOpenPublished(publishedDeck.id)}>{ui("查看已发布题组")}</button>
        </p>}
        <details><summary>{ui("查看待处理问题")}</summary>
          <ul>{rejectedCards.map((card) =>
            <li key={card.id}><strong>{card.prompt || ui("问题尚未填写")}</strong>：{rejectedIssues[card.id]
              .map((issue) => readableQualityIssue(issue).replace(/^第 \d+ 题：/, "")).join("；")}</li>)}</ul>
        </details>
        {missingRepairEvidence > 0 && <p>
          {missingRepairEvidence}{ui(" 题没有可定位的资料。请先在题目中添加引用来源；")}{repairableCount > 0 ? uiFormat("后台仍可先处理其余 {0} 题。", [repairableCount]) : ui("补充后才能启动后台修题。")}
        </p>}
        <button type="button" disabled={busy || repairRunning || staleDraft || unsavedDraft || !data.modelReady || !repairableCount}
          title={unsavedDraft ? ui("先保存草稿") : !data.modelReady ? ui("先在设置中选择模型") : !repairableCount ? ui("先给待处理题目添加引用来源") : ui("后台逐题修复并独立复审")}
          onClick={() => act("draft.repair", { id: draft.id, draftVersion: draft.draftVersion },
            () => setNotice(ui("后台修题已启动；完成后可回来发布通过的题目。")))}>
          {repairRunning ? ui("后台修题中…") : ui("交给后台修题")}
        </button>
        {repairJob && <button type="button" disabled={busy || repairJob.status === "cancelling"}
          onClick={() => act("job.cancel", { jobId: repairJob.id },
            () => setNotice(ui("正在停止后台修题；已修好的题目会保留在草稿中。")))}>
          {repairJob.status === "cancelling" ? ui("正在停止修题…") : ui("停止修题，保留草稿")}
        </button>}
      </div>}
      {draft.editorial?.previousFailures?.length > 0 && <details className="warning">
        <summary>{ui("之前未完成的批次")}</summary>
        <ul>{draft.editorial.previousFailures.map((failure, i) => <li key={i}>{describeGenerationRecord(failure)}</li>)}</ul>
      </details>}
      {draft.editorial?.coverage && <details>
        <summary>{ui("逐份资料出题记录 · 已引用 ")}{draft.editorial.coverage.cited} / {draft.editorial.coverage.selected}{ui(" 份")}</summary>
        <p className="muted">{ui("“规划”是模型选出的考点次数，“通过”是最终引用该资料的合格题数；即使有题，也不代表整页或全部知识点都已覆盖。")}</p>
        {coveredSources.length > 0 && <ul>{coveredSources.map((source) => <li key={source.id}>
          {source.title}{ui("：规划 ")}{source.planned}{ui(" 个考点，通过 ")}{source.accepted}{ui(" 题")}</li>)}</ul>}
        {untestedSourceIds.length > 0 && !generating && <button type="button" disabled={busy}
          onClick={() => {
            setSelectedSources(untestedSourceIds);
            setGenSource("files");
            setPage("generate");
          }}>{ui("用未覆盖的 ")}{untestedSourceIds.length}{ui(" 份资料补题 →")}</button>}
        {uncoveredSources.length > 0 && <details>
          <summary>{uncoveredSources.length}{ui(" 份资料本次没有合格题 · 查看清单")}</summary>
          <ul>{uncoveredSources.map((source) => <li key={source.id}>
            {source.title}{source.planned ? uiFormat("：规划 {0} 个考点", [source.planned]) : ""}
          </li>)}</ul>
        </details>}
      </details>}
      {draft.quality?.warnings?.map((w, i) => (
        <p className="warning" key={i}>
          {w}
        </p>
      ))}
      {draft.quality?.errors?.length > 0 && <details className="quality-note warning">
        <summary>{draft.quality.errors.length}{ui(" 项题目问题 · 查看详情")}</summary>
        <ul>{draft.quality.errors.map((issue, index) => <li key={index}>{readableQualityIssue(issue)}</li>)}</ul>
      </details>}
      </details>
      {!jsonMode && <div className="draft-edit-heading">
        <div><h2>{ui("题目")}</h2><span>{draft.cards.length}{ui(" 题 · 按需展开编辑")}</span></div>
        <details className="draft-advanced">
          <summary>{ui("高级编辑")}</summary>
          <button type="button" onClick={toggleJsonMode}>{ui("JSON 编辑")}</button>
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
            <details className="draft-card" key={q.id}>
              <summary>
                <span>{String(i + 1).padStart(2, "0")}</span>
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
                    aria-label={ui("选项 ") + o.id}
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
                    aria-label={ui("选项解析 ") + o.id}
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
                  <button type="button" className="danger-text"
                    onClick={() => patchCard(i, "options", q.options.filter((_, index) => index !== oi))}>{ui("删除这个选项")}</button>
                </div>
              ))}
              {["quiz", "multi"].includes(q.kind) && <button type="button"
                disabled={(q.options?.length || 0) >= 6}
                onClick={() => patchCard(i, "options", [...(q.options || []),
                  { id: crypto.randomUUID(), text: "", correct: false, explanation: "" }])}>{ui("＋ 添加选项（")}{q.options?.length || 0}/6）
              </button>}
              <button
                disabled={draft.cards.length <= 1}
                onClick={() =>
                  setDraft({
                    ...draft,
                    cards: draft.cards.filter(
                      (_, index) => index !== i,
                    ),
                  })
                }
              >{ui("从草稿移除此题")}</button>
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
                    <button
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
                    </button>
                    <button type="button" className="danger-text"
                      onClick={() => patchCard(i, "citations", q.citations.filter((_, index) => index !== j))}>{ui("删除这条引用")}</button>
                  </div>
                ))}
                <button type="button" disabled={!data.sources.length}
                  onClick={() => patchCard(i, "citations", [...(q.citations || []),
                    { sourceId: data.sources[0].id, quote: "" }])}>{ui("＋ 添加原文引用")}</button>
              </div>
            </details>
          ))}
          <button
            disabled={draft.cards.length >= 100}
            onClick={() =>
              setDraft({
                ...draft,
                cards: [...draft.cards, blankCard()],
              })
            }
          >{ui("＋ 添加闪卡")}</button>
        </>
      )}
    </section>
  );
}
