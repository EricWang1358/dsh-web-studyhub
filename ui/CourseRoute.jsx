import { ui, uiFormat } from "./i18n.js";
import { uiRich } from "./i18n-rich.jsx";
import React from "react";
import { TERMS } from "./mastery-terms.js";
import { Button } from "./components/index.js";
import { joinMeta, formatIndex } from './format.js';

/* 课程路线：课程按题组顺序排成一章一章。进度条每一段是一章（按题量占宽），
   学过的部分填色；展开后能看到每一章学到哪里，并从任意一章开始。 */

const STATUS = { done: "已学完", current: "正在学", started: "学了一部分", upcoming: "未开始" };

export default function CourseRoute({ route, busy, onStartChapter }) {
  if (!route?.chapters?.length) return null;
  const chapter = route.current === null ? null : route.chapters[route.current];
  return (
    <div className="course-route">
      <p className="course-route-head">
        <span className="course-route-label">{ui("课程进度")}</span>
        {chapter
          ? <span>{uiRich("第 {0} / {1} 章 · {2} · 本章 {3}/{4}", route.current + 1, route.chapters.length, <strong>{chapter.title}</strong>, chapter.learned, chapter.total)}</span>
          : <span>{uiFormat("{0} 章全部学过", [route.chapters.length])}</span>}
        <span className="course-route-total" title={ui(TERMS.learned.hint)}>{uiFormat("学过 {0} / {1} 题", [route.learned, route.cards])}</span>
      </p>
      <div className="course-route-bar" role="img" aria-label={uiFormat("学过 {0} / {1} 题", [route.learned, route.cards])}>
        {route.chapters.map((c) => (
          <span key={c.deckId} className={`is-${c.status}`} style={{ flexGrow: c.total }} title={`${c.title} · ${c.learned}/${c.total}`}>
            <i style={{ width: `${Math.round((c.learned / c.total) * 100)}%` }} />
          </span>
        ))}
      </div>
      <details className="course-route-list">
        <summary>{uiFormat("课程路线 · {0} 章", [route.chapters.length])}</summary>
        <ol>
          {route.chapters.map((c, i) => (
            <li key={c.deckId} className={`is-${c.status}`}>
              <span className="course-route-dot" aria-hidden="true" />
              <span className="course-route-title">{/^\d/.test(c.title) ? c.title : `${formatIndex(i + 1)} · ${c.title}`}</span>
              <span className="course-route-meta">
                {joinMeta([ui(STATUS[c.status]), `${c.learned}/${c.total}`, c.weak ? uiFormat("{0} 道薄弱", [c.weak]) : ""])}
              </span>
              {c.learned < c.total && (
                <Button variant="link" size="sm" disabled={busy} onClick={() => onStartChapter(c.deckId)}>
                  {c.status === "current" ? ui("接着学") : ui("从这一章学")}
                </Button>
              )}
            </li>
          ))}
        </ol>
        <p className="muted small">{ui("章的顺序就是学习库里题组的顺序，可以在「管理题组」用「上移题组 / 下移题组」调整。")}</p>
      </details>
    </div>
  );
}
