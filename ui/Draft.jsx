import React from "react";
import { kinds } from "./shared.js";

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
  setDraft,
  draftText,
  setDraftText,
  jsonMode,
  setJsonMode,
  openDraft,
  clearRecovery,
  setPage,
  setNotice,
  setError,
  setModal,
  blankCard,
  patchCard,
  parseDraft,
}) {
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">REVIEW BEFORE YOU LEARN</div>
          <h1>审阅草稿</h1>
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
      {draft.editorial && (
        <div className="quality-note">
          <p>
            {draft.editorial.summary}
            <br />
            <small>
              已完成模型审阅，请核对原文。模型审阅不能保证事实完全正确。
            </small>
          </p>
        </div>
      )}
      {draft.quality?.warnings?.map((w, i) => (
        <p className="warning" key={i}>
          {w}
        </p>
      ))}
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
                      type="checkbox"
                      checked={o.correct}
                      onChange={(e) =>
                        patchCard(
                          i,
                          "options",
                          q.options.map((x, j) =>
                            j === oi
                              ? { ...x, correct: e.target.checked }
                              : x,
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
                </div>
              ))}
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
                  </div>
                ))}
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
          disabled={busy}
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
          disabled={busy}
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
              await call("draft.publish", {
                id: saved.id,
                draftVersion: saved.draftVersion,
              });
              clearRecovery();
              setPage("library");
              setNotice("题组已发布，可以开始学习。");
            });
          }}
        >
          保存并发布 →
        </button>
        <button
          className="danger-text"
          disabled={busy}
          onClick={() =>
            act(
              "draft.delete",
              { id: draft.id, draftVersion: draft.draftVersion },
              () => {
                clearRecovery();
                setPage("library");
              },
            )
          }
        >
          删除草稿
        </button>
      </div>
    </section>
  );
}
