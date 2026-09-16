import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";

/* 资料视图：sourceForm（添加资料的表单 JSX，定义在 App，与弹窗共用）
   通过 prop 传入。删除走 source.remove，内容查看交给 source 弹窗。
   资料按创建日期（本地时区）分组，新的在前，各组默认收起；没有日期的旧资料
   由服务端按引用它的题组推断（createdAtInferred），仍无从推断的归入「日期未知」。 */

const UNKNOWN = "unknown";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* Attachment imports can be titled with their absolute path; the list shows
   the file name and keeps the full path in the tooltip. */
const displayTitle = (title) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(title))
    ? String(title).replace(/^.*[\\/]/, "")
    : title;

function dayLabel(key) {
  if (key === UNKNOWN) return "日期未知";
  const today = new Date(),
    yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === dayKey(today)) return "今天";
  if (key === dayKey(yesterday)) return "昨天";
  const [y, m, d] = key.split("-").map(Number),
    date = new Date(y, m - 1, d);
  return `${y === today.getFullYear() ? "" : `${y} 年 `}${m} 月 ${d} 日 · ${WEEKDAYS[date.getDay()]}`;
}

function groupByDay(sources) {
  const groups = new Map();
  for (const s of sources) {
    const t = Date.parse(s.createdAt);
    const key = Number.isFinite(t) ? dayKey(new Date(t)) : UNKNOWN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const titleOrder = (a, b) =>
    String(a.title).localeCompare(String(b.title), "zh-CN", { numeric: true });
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : b.localeCompare(a)))
    .map(([key, rows]) => ({
      key,
      // Newest first within a day; one import's pages share a timestamp, so
      // they fall back to natural title order (p.5 before p.10).
      rows: rows.sort(
        (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || titleOrder(a, b),
      ),
      inferred: rows.every((r) => r.createdAtInferred),
      chars: rows.reduce((n, r) => n + r.text.length, 0),
    }));
}

export default function Sources({ data, busy, act, setModal, sourceForm }) {
  const groups = useMemo(() => groupByDay(data.sources), [data.sources]);
  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const allOpen = groups.length > 0 && groups.every((g) => open.has(g.key));

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>资料</h1>
          <p className="muted">
            题目从这里生长。原文与引用一直保留。
            {data.sources.length > 0 &&
              ` 共 ${data.sources.length} 份，按创建日期分为 ${groups.length} 组。`}
          </p>
        </div>
        <div className="section-heading-actions">
          {groups.length > 1 && (
            <button
              onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
            >
              {allOpen ? "全部收起" : "全部展开"}
            </button>
          )}
          <button className="primary" onClick={() => setModal({ type: "add" })}>
            ＋ 添加资料
          </button>
        </div>
      </div>
      {!data.sources.length ? (
        <div className="empty">
          <h2>还没有资料</h2>
          <p>支持 PDF、粘贴文本、Markdown 和 TXT 文件。</p>
          {sourceForm}
        </div>
      ) : (
        groups.map((g) => {
          const expanded = open.has(g.key);
          return (
            <div key={g.key} className={"source-group" + (expanded ? " open" : "")}>
              <button
                className="source-group-head"
                aria-expanded={expanded}
                onClick={() => toggle(g.key)}
              >
                <span className="source-group-caret" aria-hidden="true">
                  ▸
                </span>
                <strong>{dayLabel(g.key)}</strong>
                {g.inferred && (
                  <span
                    className="source-group-tag"
                    title="这些资料保存时没有记录日期，按最早引用它们的题组推断"
                  >
                    推断
                  </span>
                )}
                <small className="muted">
                  {g.rows.length} 份 · {g.chars.toLocaleString()} 字符
                </small>
              </button>
              {expanded &&
                g.rows.map((s, i) => (
                  <article className="source-row" key={s.id} style={{ "--i": Math.min(i, 12) }}>
                    <button
                      className="source-main"
                      onClick={() => setModal({ type: "source", source: s })}
                    >
                      <Icon>▤</Icon>
                      <span>
                        <strong title={s.title}>{displayTitle(s.title)}</strong>
                        <small>
                          {s.text.length.toLocaleString()} 字符 ·{" "}
                          {s.document ? (s.document.extractionVersion === 2 ? "排版提取 v2 · " : "旧版提取，建议重新导入 · ") : ""}
                          {s.text.slice(0, 80)}
                        </small>
                      </span>
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => act("source.remove", { id: s.id })}
                    >
                      移除
                    </button>
                  </article>
                ))}
            </div>
          );
        })
      )}
    </section>
  );
}
