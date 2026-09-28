import React from "react";

/* 课程路线：课程按题组顺序排成一章一章。进度条每一段是一章（按题量占宽），
   学过的部分填色；展开后能看到每一章学到哪里，并从任意一章开始。 */

const STATUS = { done: "已学完", current: "正在学", started: "学了一部分", upcoming: "未开始" };

export default function CourseRoute({ route, busy, onStartChapter }) {
  if (!route?.chapters?.length) return null;
  const chapter = route.current === null ? null : route.chapters[route.current];
  return (
    <div className="course-route">
      <p className="course-route-head">
        <span className="course-route-label">课程进度</span>
        {chapter
          ? <span>第 {route.current + 1} / {route.chapters.length} 章 · <strong>{chapter.title}</strong> · 本章 {chapter.learned}/{chapter.total}</span>
          : <span>{route.chapters.length} 章全部学过</span>}
        <span className="course-route-total">已学 {route.learned} / {route.cards} 题</span>
      </p>
      <div className="course-route-bar" role="img" aria-label={`已学 ${route.learned} / ${route.cards} 题`}>
        {route.chapters.map((c) => (
          <span key={c.deckId} className={`is-${c.status}`} style={{ flexGrow: c.total }} title={`${c.title} · ${c.learned}/${c.total}`}>
            <i style={{ width: `${Math.round((c.learned / c.total) * 100)}%` }} />
          </span>
        ))}
      </div>
      <details className="course-route-list">
        <summary>课程路线 · {route.chapters.length} 章</summary>
        <ol>
          {route.chapters.map((c, i) => (
            <li key={c.deckId} className={`is-${c.status}`}>
              <span className="course-route-dot" aria-hidden="true" />
              <span className="course-route-title">{/^\d/.test(c.title) ? c.title : `${String(i + 1).padStart(2, "0")} · ${c.title}`}</span>
              <span className="course-route-meta">
                {STATUS[c.status]} · {c.learned}/{c.total}{c.weak ? ` · ${c.weak} 道薄弱` : ""}
              </span>
              {c.learned < c.total && (
                <button type="button" className="link-btn" disabled={busy} onClick={() => onStartChapter(c.deckId)}>
                  {c.status === "current" ? "接着学" : "从这一章学"}
                </button>
              )}
            </li>
          ))}
        </ol>
        <p className="muted small">章的顺序就是学习库里题组的顺序，可以在「整理与添加」里调整。</p>
      </details>
    </div>
  );
}
