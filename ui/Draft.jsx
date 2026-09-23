import React from "react";
import { kinds } from "./shared.js";
import { reviewedCardFingerprint, reviewedCardStatus } from "../lib/review-integrity.js";
import { readableQualityIssue } from "./quality.js";
import { selfCitedCardCount } from "../lib/source-provenance.js";
import { repairSourcesForCard } from "../lib/repair-evidence.js";

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
  onOpenPublished,
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
  const deleteArmed = deleteArmedId === draft.id;
  const rawAudits = draft.editorial?.audits ?? [draft.editorial?.audit];
  const audits = (Array.isArray(rawAudits) ? rawAudits : []).filter((audit) =>
    audit && Array.isArray(audit.targets) && Array.isArray(audit.changes) && Array.isArray(audit.checks));
  const incomplete = Number.isInteger(draft.editorial?.completedParts) &&
    Number.isInteger(draft.editorial?.parts) && draft.editorial.completedParts < draft.editorial.parts;
  const generating = incomplete && data.jobs?.some((j) => j.draftId === draft.id &&
    ["queued", "running", "cancelling"].includes(j.status));
  const availableSources = new Set(data.sources.map((source) => source.id));
  const untestedSourceIds = (draft.editorial?.coverage?.uncited || [])
    .map((source) => source.id).filter((id) => availableSources.has(id));
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
    ? "保存并更新题组 →"
    : draft.editorial?.repairOfDeckId ? "保存并补发到原题组 →" : "保存并发布 →";
  const repairJob = data.jobs?.find((job) => job.draftId === draft.id &&
    job.type === "draft-repair" && ["queued", "running", "cancelling"].includes(job.status));
  const repairRunning = !!repairJob;
  const latestDraft = data.drafts.find((item) => item.id === draft.id);
  const missingDraft = draft.draftVersion > 0 && !latestDraft;
  const staleDraft = latestDraft && latestDraft.draftVersion !== draft.draftVersion;
  const updatingDraft = generating || repairRunning;
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
      setError("JSON 格式不正确：" + error.message);
      return;
    }
    copy.id = crypto.randomUUID();
    delete copy.draftVersion;
    delete copy.editingDeckId;
    delete copy.baseVersion;
    delete copy.quality;
    if (copy.editorial) copy.editorial = { summary: "由旧草稿另存；发布前会重新检查" };
    act("draft.save", { deck: copy }, openDraft);
  }
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">PUBLISH YOUR DRAFT</div>
          <h1>草稿与发布</h1>
        </div>
        <button
          onClick={() => {
            if (!jsonMode)
              setDraftText(JSON.stringify(draft, null, 2));
            else {
              try {
                setDraft(parseDraft(draftText));
              } catch (e) {
                setError("JSON 格式不正确：" + e.message);
                return;
              }
            }
            setJsonMode(!jsonMode);
          }}
        >
          {jsonMode ? "逐题编辑" : "JSON 编辑"}
        </button>
      </div>
      {staleDraft && unsavedDraft && <div className="quality-note warning" role="status">
        <strong>草稿已在后台更新</strong>
        <p>载入最新草稿可查看修题结果。本页尚未保存的修改会被替换。</p>
        <button type="button" onClick={() => openDraft(latestDraft)}>载入最新草稿</button>
      </div>}
      {missingDraft && <div className="quality-note warning" role="status">
        <strong>这份草稿已删除或发布</strong>
        <p>当前页面是旧版本，无法继续保存。可以把页面中的内容另存为独立的新草稿，发布前会重新检查。</p>
        <button type="button" disabled={busy} onClick={saveAsNewDraft}>另存为新草稿</button>
      </div>}
      {staleDraft && !unsavedDraft && <p className="quality-note" role="status">
        {updatingDraft ? "后台修题正在更新草稿，完成后会自动载入。" : "正在载入后台修好的题目…"}
      </p>}
      {updatingDraft && !staleDraft && <p className="quality-note" role="status">
        后台任务正在更新这份草稿，完成后可继续保存或发布。
      </p>}
      {activeReview && <p className="quality-note warning" role="status">
        原题组还有进行中的学习。请先从侧栏回到题目，完成或结束练习，再发布编辑。
      </p>}
      {rejectedCount > 0 && unsavedDraft && !staleDraft && <p className="quality-note warning" role="status">
        当前有未保存的编辑。先保存；如果改过题目内容，请重新发布检查，再决定是否交给后台修复。
      </p>}
      {draft.editorial && (
        <div className="quality-note">
          <p>
            {draft.editorial.summary}
            <br />
            <small>
              {reviewStatus
                ? `${reviewStatus.unchanged} / ${reviewStatus.total} 题与上次模型审阅时一致。`
                : "这份草稿没有可核对的逐题审阅版本。"}
              {needsReview > 0
                ? data.modelReady
                  ? ` ${needsReview} 题将在发布前自动审阅。`
                  : ` ${needsReview} 题尚未审阅；当前没有可用模型。`
                : " 模型审阅仍不能保证事实完全正确。"}
            </small>
          </p>
        </div>
      )}
      {!draft.editorial && <p className="quality-note" role="status">
        这份草稿尚未经过模型审阅。{data.modelReady ? "发布前会自动审阅。" : "当前没有可用模型，发布后仍属于未审阅题目。"}
      </p>}
      {selfCited > 0 && <p className="quality-note warning" role="status">
        {selfCited} 道题只引用了导入的题目自身。模型可以检查题目是否自洽，但无法据此独立核实答案；如需事实依据，请把引用换成原始资料。
      </p>}
      {draft.editorial?.requested && !draft.editorial?.repairOfDeckId && !draft.editorial?.partialEdit && <p>
        本次生成通过检查 {draft.editorial.generated ?? draft.cards.length} / {draft.editorial.requested} 题；当前草稿 {draft.cards.length} 题。
        {draft.editorial.generation?.sourceIds?.length && draft.cards.length < draft.editorial.requested &&
          " 可返回学习库点「继续补齐」，沿用原资料补题。"}
      </p>}
      {incomplete && <p className="warning" role="status">
        {generating ? "仍在生成" : "本次生成已中断"}：已完成 {draft.editorial.completedParts} / {draft.editorial.parts} 批。当前草稿只包含已保存的题目；其余批次尚未完成检查。
      </p>}
      {audits.map((audit, i) => <details key={i}>
        <summary>质量自查记录 · 第 {audit.part || i + 1} 批 · 主动改写 {audit.changes.length} 项</summary>
        <p className="muted">已规划 {audit.targets.length} 个考点；独立验收逐题检查自足性、泄题风险、选项质量、学习价值和证据支持。这是生成时的检查记录。</p>
        <ul>{audit.changes.filter((change) => typeof change?.summary === "string").map((change, index) => <li key={index}>{change.summary}</li>)}</ul>
        <ul>{audit.checks.filter((check) => typeof check?.explanation === "string").map((check, index) => <li key={index}>{check.explanation}</li>)}</ul>
      </details>)}
      {draft.editorial?.failures?.length > 0 && <details className="warning" open>
        <summary>部分题目未生成成功，合格题目已保留</summary>
        <ul>{draft.editorial.failures.map((failure, i) => <li key={i}>{failure}</li>)}</ul>
      </details>}
      {rejectedCount > 0 && <div className="quality-note warning" role="status">
        <strong>{rejectedCount} 道题待处理{retryPublishCount > 0 ? ` · ${retryPublishCount} 道待重新检查发布` : ""}</strong>
        <p>{draft.editorial?.partialEdit
          ? "通过检查的修改已更新到原题组；未通过的修改留在草稿。原有题目仍按旧内容供学习，新加的题尚未发布。"
          : draft.editorial?.repairOfDeckId
            ? "先前通过检查的题目已发布；当前草稿中的题目尚未发布。"
            : "当前草稿中的题目尚未发布。"}
          {retryPublishCount > 0 && " 可点击「保存并发布」重新检查其余题目。"}
          {" 待处理题目可自行修改，或选择交给后台修题。"}</p>
        {publishedDeck && <p>
          已发布题组「{publishedDeck.title}」现有 {publishedDeck.count} 题。{" "}
          <button type="button" disabled={busy} onClick={() => onOpenPublished(publishedDeck.id)}>
            查看已发布题组
          </button>
        </p>}
        <details><summary>查看待处理问题</summary>
          <ul>{rejectedCards.map((card) =>
            <li key={card.id}><strong>{card.prompt || "问题尚未填写"}</strong>：{rejectedIssues[card.id]
              .map((issue) => readableQualityIssue(issue).replace(/^第 \d+ 题：/, "")).join("；")}</li>)}</ul>
        </details>
        {missingRepairEvidence > 0 && <p>
          {missingRepairEvidence} 题没有可定位的资料。请先在题目中添加引用来源；
          {repairableCount > 0 ? `后台仍可先处理其余 ${repairableCount} 题。` : "补充后才能启动后台修题。"}
        </p>}
        <button type="button" disabled={busy || repairRunning || staleDraft || unsavedDraft || !data.modelReady || !repairableCount}
          title={unsavedDraft ? "先保存草稿" : !data.modelReady ? "先在设置中选择模型" : !repairableCount ? "先给待处理题目添加引用来源" : "后台逐题修复并独立复审"}
          onClick={() => act("draft.repair", { id: draft.id, draftVersion: draft.draftVersion },
            () => setNotice("后台修题已启动；完成后可回来发布通过的题目。"))}>
          {repairRunning ? "后台修题中…" : "交给后台修题"}
        </button>
        {repairJob && <button type="button" disabled={busy || repairJob.status === "cancelling"}
          onClick={() => act("job.cancel", { jobId: repairJob.id },
            () => setNotice("正在停止后台修题；已修好的题目会保留在草稿中。"))}>
          {repairJob.status === "cancelling" ? "正在停止修题…" : "停止修题，保留草稿"}
        </button>}
      </div>}
      {draft.editorial?.previousFailures?.length > 0 && <details className="warning">
        <summary>之前未完成的批次</summary>
        <ul>{draft.editorial.previousFailures.map((failure, i) => <li key={i}>{failure}</li>)}</ul>
      </details>}
      {draft.editorial?.coverage && <details>
        <summary>逐份资料出题记录 · 已引用 {draft.editorial.coverage.cited} / {draft.editorial.coverage.selected} 份</summary>
        <p className="muted">“规划”是模型选出的考点次数，“通过”是最终引用该资料的合格题数；即使有题，也不代表整页或全部知识点都已覆盖。</p>
        {draft.editorial.coverage.sources?.length ?
          <ul>{draft.editorial.coverage.sources.map((source) => <li key={source.id}>
            {source.title}：规划 {source.planned} 个考点，通过 {source.accepted} 题
            {source.accepted === 0 ? " · 本次没有合格题" : ""}
          </li>)}</ul> :
          <ul>{draft.editorial.coverage.uncited.map((source) => <li key={source.id}>{source.title}：本次没有合格题</li>)}</ul>}
        {untestedSourceIds.length > 0 && !generating && <button type="button" disabled={busy}
          onClick={() => {
            setSelectedSources(untestedSourceIds);
            setGenSource("files");
            setPage("generate");
          }}>只选这 {untestedSourceIds.length} 份资料，另建补充草稿</button>}
      </details>}
      {draft.quality?.warnings?.map((w, i) => (
        <p className="warning" key={i}>
          {w}
        </p>
      ))}
      {draft.quality?.errors?.length > 0 && <details className="quality-note warning" open>
        <summary>{draft.quality.errors.length} 项待修复问题；发布时会跳过未通过的题目</summary>
        <ul>{draft.quality.errors.map((issue, index) => <li key={index}>{readableQualityIssue(issue)}</li>)}</ul>
      </details>}
      {jsonMode ? (
        <textarea
          className="json-editor"
          aria-label="题组 JSON"
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
        />
      ) : (
        <>
          <label>
            题组标题
            <input
              value={draft.title}
              onChange={(e) =>
                setDraft({ ...draft, title: e.target.value })
              }
            />
          </label>
          {draft.cards.map((q, i) => (
            <details className="draft-card" key={q.id} open={i === 0}>
              <summary>
                <span>{String(i + 1).padStart(2, "0")}</span>
                {q.prompt}
                <small>{kinds[q.kind]}</small>
                {draft.editorial?.reviewedCards?.[q.id] !== reviewedCardFingerprint(q) &&
                  <small>未自动审阅</small>}
                {selfCitedCardCount([q], data.sources) > 0 && <small>仅有导入题目引用</small>}
              </summary>
              <label>
                问题
                <textarea
                  rows={3}
                  value={q.prompt}
                  onChange={(e) =>
                    patchCard(i, "prompt", e.target.value)
                  }
                />
              </label>
              <div className="two-col">
                <label>
                  主题
                  <input
                    value={q.topic}
                    onChange={(e) =>
                      patchCard(i, "topic", e.target.value)
                    }
                  />
                </label>
                <label>
                  学习目标
                  <input
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
                ...(q.kind === "open" ? ["rubric"] : []),
              ].map((key) => (
                <label key={key}>
                  {
                    {
                      answer: "答案",
                      hint: "提示",
                      explanation: "讲解",
                      misconception: "易错点",
                      rubric: "评分标准",
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
              ))}
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
                    />
                    正确选项
                  </label>
                  <input
                    aria-label={"选项 " + o.id}
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
                    aria-label={"选项解析 " + o.id}
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
                    onClick={() => patchCard(i, "options", q.options.filter((_, index) => index !== oi))}>
                    删除这个选项
                  </button>
                </div>
              ))}
              {["quiz", "multi"].includes(q.kind) && <button type="button"
                disabled={(q.options?.length || 0) >= 6}
                onClick={() => patchCard(i, "options", [...(q.options || []),
                  { id: crypto.randomUUID(), text: "", correct: false, explanation: "" }])}>
                ＋ 添加选项（{q.options?.length || 0}/6）
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
              >
                从草稿移除此题
              </button>
              <div className="citations">
                {q.citations?.map((c, j) => (
                  <div key={j}>
                    <label>
                      引用来源
                      <select
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
                    <label>
                      逐字原文引用
                      <textarea
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
                        placeholder="从原文复制能支持答案的段落"
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
                        ?.title || "原文"}
                      <blockquote>{c.quote}</blockquote>
                    </button>
                    <button type="button" className="danger-text"
                      onClick={() => patchCard(i, "citations", q.citations.filter((_, index) => index !== j))}>
                      删除这条引用
                    </button>
                  </div>
                ))}
                <button type="button" disabled={!data.sources.length}
                  onClick={() => patchCard(i, "citations", [...(q.citations || []),
                    { sourceId: data.sources[0].id, quote: "" }])}>
                  ＋ 添加原文引用
                </button>
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
          >
            ＋ 添加闪卡
          </button>
        </>
      )}
      <div className="sticky-actions">
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
        >
          保存并校验
        </button>
        <button
          className="primary"
          disabled={busy || updatingDraft || staleDraft || missingDraft || activeReview}
          title={activeReview ? "先完成或结束原题组的学习" : undefined}
          onClick={async () => {
            let d;
            try {
              d = jsonMode ? parseDraft(draftText) : draft;
            } catch (e) {
              setError("JSON 格式不正确：" + e.message);
              return;
            }
            await act("draft.save", { deck: d }, async (saved) => {
              openDraft(saved);
              const published = await call("draft.publish", {
                id: saved.id,
                draftVersion: saved.draftVersion,
              });
              clearRecovery();
              if (published.rejectedDraft) openDraft(published.rejectedDraft);
              else setPage("library");
              const editingPublished = !!saved.editingDeckId;
              const acceptedNotice = editingPublished
                ? `${published.accepted} 题已写入原题组`
                : `${published.accepted} 题已发布`;
              const rejectedNotice = editingPublished
                ? `${published.rejected} 题的修改留在草稿，原题组中已有的题不会被覆盖。可选择让后台修题。`
                : `${published.rejected} 题留待处理。可选择让后台修题。`;
              setNotice(published.rejected
                ? published.accepted
                  ? `${acceptedNotice}${published.unchecked ? `，其中 ${published.unchecked} 题未自动审阅` : ""}；${rejectedNotice}`
                  : editingPublished
                    ? `${published.rejected} 题的修改暂未通过检查，原题组中已有的题不会被覆盖；修改已留在草稿。可选择让后台修题。`
                    : `${published.rejected} 题暂未通过发布检查，已留在草稿。可选择让后台修题。`
                : published.unchecked
                  ? `${editingPublished ? "题组已更新" : "题组已发布"}，其中 ${published.unchecked} 题未经过模型审阅。`
                  : editingPublished ? "题组已更新，可以继续学习。" : "题组已发布，可以开始学习。");
            });
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
            ? updatingDraft ? "确认删除并停止任务（无法撤销）" : "确认删除草稿（无法撤销）"
            : updatingDraft ? "删除草稿并停止任务" : "删除草稿"}
        </button>
      </div>
    </section>
  );
}
