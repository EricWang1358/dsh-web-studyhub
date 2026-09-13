import React, { useCallback, useEffect, useMemo, useState } from "react";
import css from "./views.css";
import { useInjectCss, plainPrompt } from "./shared.js";

/* 跨题库错题本（v0.4 契约 §4）。数据来自 call("wrongbook")，按题组分组
   展示；「练」与「重练全部错题」都通过 onPractice(scope) 交给主会话，
   由它用 review.start {mode:"path", scope} 开一轮练习。样式与 Dashboard /
   Exam 共用 ui/views.css，注入 <style data-study-views> 按标记去重。 */

export default function WrongBook({ call, busy, onPractice }) {
  useInjectCss(css, "study-views");
  const [items, setItems] = useState(null),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const res = await call("wrongbook");
      // suspended 的卡进不了练习池，直接从列表里滤掉，避免给出无效的「练」。
      setItems((res?.items || []).filter((it) => it && it.deckId && it.cardId && !it.suspended));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [call]);
  useEffect(() => {
    load();
  }, [load]);

  /* 服务端已按 lastAt 降序；这里只做按题组的稳定分组，保持组内顺序。 */
  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items || []) {
      if (!map.has(it.deckId))
        map.set(it.deckId, {
          deckId: it.deckId,
          deckTitle: it.deckTitle || it.deckId,
          rows: [],
        });
      map.get(it.deckId).rows.push(it);
    }
    return [...map.values()];
  }, [items]);
  const total = items?.length || 0;

  return (
    <section className="page wb">
      <div className="page-heading">
        <div>
          <h1>错题本</h1>
          <p className="muted">
            {total ? `跨题组收集的 ${total} 道错题，按题组分组。` : "答错的题会自动收进这里。"}
          </p>
        </div>
        <div className="section-heading-actions">
          <button onClick={load} disabled={busy || loading}>
            刷新
          </button>
          <button
            className="primary"
            disabled={busy || !total}
            title="把这些错题按学习路径重新练一遍"
            onClick={() =>
              onPractice(items.map((i) => ({ deckId: i.deckId, cardId: i.cardId })))
            }
          >
            重练全部错题 ({total})
          </button>
        </div>
      </div>

      {err && <p className="wb-error">{err}</p>}
      {loading && !items && <p className="muted">正在读取错题本…</p>}

      {items && !total && (
        <div className="empty wb-empty">
          <span className="empty-icon">✓</span>
          <h2>最近没有错题，保持这个节奏</h2>
          <p className="muted">答错的题会自动收进这里，方便集中重练。</p>
        </div>
      )}

      {groups.map((g) => (
        <div key={g.deckId} className="wb-group">
          <div className="wb-group-head">
            <strong>{g.deckTitle}</strong>
            <small className="muted">{g.rows.length} 题</small>
          </div>
          <ul className="wb-rows">
            {g.rows.map((it) => (
              <li key={it.cardId} className="wb-row">
                <span className="wb-topic" title={it.topic || "未分类"}>
                  {it.topic || "未分类"}
                </span>
                <span className="wb-prompt" title={plainPrompt(it.prompt)}>
                  {plainPrompt(it.prompt)}
                </span>
                <span className="wb-grade" title={`最近一次作答 ${it.lastGrade} 分`}>
                  错
                </span>
                <button
                  disabled={busy}
                  aria-label={`练习 ${it.topic || "未分类"}：${it.prompt}`}
                  onClick={() => onPractice([{ deckId: it.deckId, cardId: it.cardId }])}
                >
                  练
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
