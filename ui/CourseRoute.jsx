import { ui, uiFormat } from "./i18n.js";
import { uiRich } from "./i18n-rich.jsx";
import React from "react";
import { TERMS } from "./mastery-terms.js";
import { Button, Tooltip } from "./components/index.js";

/* 课程进度：课程按题组顺序排成一章一章。进度条每一段是一章（按题量占宽），学过的部分填色。
   找题、挑题练在「总纲」页（ui/outline/）：按资料的章节排开这门课的题，它取代了首页原来折叠的课程路线列表。 */

/** `onShowOutline` opens the 总纲 page (absent when the host has not the components it needs). */
export default function CourseRoute({ route, onShowOutline }) {
  if (!route?.chapters?.length) return null;
  const chapter = route.current === null ? null : route.chapters[route.current];
  return (
    <div className="course-route">
      <p className="course-route-head">
        <span className="course-route-label">{ui("课程进度")}</span>
        {chapter
          ? <span>{uiRich("第 {0} / {1} 章 · {2} · 本章 {3}/{4}", route.current + 1, route.chapters.length, <strong>{chapter.title}</strong>, chapter.learned, chapter.total)}</span>
          : <span>{uiFormat("{0} 章全部学过", [route.chapters.length])}</span>}
        <Tooltip layer anchorClassName="course-route-total" content={ui(TERMS.learned.hint)}><span tabIndex={0}>{uiFormat("学过 {0} / {1} 题", [route.learned, route.cards])}</span></Tooltip>
      </p>
      <div className="course-route-bar" role="img" aria-label={uiFormat("学过 {0} / {1} 题", [route.learned, route.cards])}>
        {route.chapters.map((c) => (
          <span key={c.deckId} className={`is-${c.status}`} style={{ flexGrow: c.total }} title={`${c.title} · ${c.learned}/${c.total}`}>
            <i style={{ width: `${Math.round((c.learned / c.total) * 100)}%` }} />
          </span>
        ))}
      </div>
      {onShowOutline && (
        <p className="course-route-outline">
          <Button variant="link" size="sm" icon="list" onClick={onShowOutline}>{ui("总纲")}</Button>
          <span>{ui("按资料的章节找题、挑题练")}</span>
        </p>
      )}
    </div>
  );
}
