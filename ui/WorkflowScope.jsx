/* What the guided flow studies and where it came from: the course line with an
   in-place course switcher, the readable references, and the shared note for a
   failed model call. Split out of WorkflowPortal so each piece renders (and is
   tested) on its own. */
import React, { useState } from "react";
import { ui, uiFormat } from "./i18n.js";
import Markdown from "./Markdown.jsx";
import { useInjectCss } from "./shared.js";
import { Button, ConfirmDialog } from "./components/index.js";
import css from "./workflow-scope.css";

const PICKED = { route: "课程路线的这一批", none: "学习库里还没有相关的题目", ai: "AI 选的范围", match: "按名称匹配的范围", course: "没找到直接相关的主题，先学当前课程" };
const courseName = (name) => name || ui("未分类课程");
const clip = (text, n) => { const s = String(text || "").trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

/* The scope sentence: which course the topics come from, and how they were chosen. */
function scopeSentence(session, course, total, goal) {
  const name = courseName(course);
  if (session.pickedBy === "course") return uiFormat("「{0}」里没找到与「{1}」直接相关的主题，先学这门课的内容", [name, clip(goal, 24)]);
  if (session.pickedBy === "match") return uiFormat("在「{0}」课程里按名称匹配了 {1} 个主题", [name, total]);
  return uiFormat("在「{0}」课程里为你选了 {1} 个主题", [name, total]);
}

/* What this session covers, so the learner can see what was picked and from where. */
export function ScopeBar({ session, resources, disabled, onRescope, onStartNew }) {
  useInjectCss(css, "study-workflow-scope");
  const [asking, setAsking] = useState(null);
  const topics = resources.scopeTopics || [];
  if (!topics.length && !session.pickedBy) return null;
  const total = resources.scopeTopicCount || topics.length;
  const shown = topics.slice(0, 4).join("、");
  const course = session.course?.name;
  const named = typeof course === "string" && ["ai", "match", "course"].includes(session.pickedBy);
  const fallback = ["course", "none"].includes(session.pickedBy);
  const courses = resources.courses || [];
  const canSwitch = !!session.goal && !!session.course && session.pickedBy !== "route" && courses.some((item) => item.name !== course);
  const hint = canSwitch && !disabled ? resources.hint : null;
  const choose = (next) => {
    if (next === course) return;
    if (resources.rescope?.allowed === false) setAsking(next);
    else onRescope?.(next);
  };
  const topicLine = shown ? (total > 4 ? uiFormat("{0} 等 {1} 个主题", [shown, total]) : shown) : "";
  return <div className="wf-scope">
    <p className={`wf-scope-line${fallback ? " is-fallback" : ""}`} title={topics.join("、")}>
      {named ? <span>{scopeSentence(session, course, total, session.goal)}</span>
        : <span>{ui(PICKED[session.pickedBy]) || ui("本次范围")}{topicLine ? "：" : ""}{!named && topicLine}</span>}
      {resources.cardCount > 0 && <span className="wf-scope-count"><span aria-hidden="true"> · </span>{uiFormat("{0} 题", [resources.cardCount])}</span>}
    </p>
    {named && topicLine && <p className="wf-scope-topics" title={(resources.scopeDecks || []).join("、")}>{session.pickedBy === "course" ? ui("先从这些主题学起：") : ""}{topicLine}</p>}
    {session.aiFailed && <p className="wf-scope-note">{ui("模型暂时不可用，已按名称匹配主题")}</p>}
    {canSwitch && !disabled && <div className="wf-scope-actions">
      <label className="wf-course-switch"><span>{ui("换课程")}</span>
        <select aria-label={ui("换课程")} value={course} onChange={(event) => choose(event.target.value)}>
          {courses.map((item) => <option key={item.name} value={item.name}>{item.name === course ? uiFormat("{0}（当前）", [courseName(item.name)]) : courseName(item.name)}</option>)}
        </select>
      </label>
      {hint && <p className="wf-scope-hint">{uiFormat("「{0}」可能更相关", [courseName(hint.course)])} · <Button variant="link" size="sm" onClick={() => choose(hint.course)}>{ui("切换到这门课")}</Button></p>}
    </div>}
    {asking !== null && <ConfirmDialog tone="primary" title={ui("换课程要开始新的学习")} cancelLabel={ui("先不换")}
      confirmLabel={uiFormat("为「{0}」开始新的学习", [courseName(asking)])} onClose={() => setAsking(null)}
      onConfirm={() => { const next = asking; setAsking(null); onStartNew?.(next); }}>
      <p>{ui("这次学习已经有练习作答，换课程会把记录混在一起。可以为另一门课开始一次新的学习，这次的记录会原样保留。")}</p>
    </ConfirmDialog>}
  </div>;
}

/* One bank-imported card, compactly: what it asks, the answer on request, where it is from. */
function ReadingCard({ card }) {
  return <div className="wf-ref-card">
    <p className="wf-ref-prompt">{card.prompt}</p>
    {card.answer && <details className="wf-ref-answer"><summary>{ui("看答案")}</summary><p>{card.answer}</p></details>}
    {card.deck && <cite>{card.deck}</cite>}
  </div>;
}

export const Readings = React.memo(function Readings({ resources }) {
  useInjectCss(css, "study-workflow-scope");
  const titles = new Map((resources.sources || []).map((source) => [source.id, source.title]));
  if (!resources.readings?.length) return <p className="muted">{ui("本次范围还没有关联资料。可以请主对话围绕这个主题补充讲解，或把自己的资料写在笔记里。")}</p>;
  return <details className="wf-readings"><summary>{ui("参考已有题解与引用材料")} <span className="muted">{uiFormat("{0} 条", [resources.readings.length])}</span></summary>
    <p className="muted small">{ui("这些是所选范围内的现有内容，可请主对话整理成连贯讲解。")}</p>
    {resources.readings.map((reading, index) => <article key={`${reading.deckId}:${reading.cardId}`}>
      <h4>{index + 1}. {reading.topic || ui("参考材料")}</h4>
      {reading.card && <ReadingCard card={reading.card} />}
      <Markdown text={reading.explanation} />
      {reading.citations?.map((citation, ci) => <blockquote key={ci}><Markdown text={citation.quote} /><cite>{`${titles.get(citation.sourceId) || ui("关联资料")}${citation.locator ? ` · ${citation.locator}` : ""}`}</cite></blockquote>)}
    </article>)}
  </details>;
});
