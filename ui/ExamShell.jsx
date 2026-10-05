import React, { useId, useState } from "react";
import { ui, uiFormat } from "./i18n.js";
import { useInjectCss } from "./shared.js";
import PageScope from "./PageScope.jsx";
import { Badge, Button, PageHeader, Panel, SegmentedControl } from "./components/index.js";
import { formatDateTime } from "./format.js";
import { filterRecent } from "./exam-format.js";
import { QUESTION_COUNT } from "../lib/limits.js";
import css from "./exam-setup.css";

/* 模拟考试 shell (WP25): the page header with the one 考试形式 switch, the
   setup card all three formats share (怎么考 · settings · start footer), the
   题数 field and the recent-exams list of every format. */

export function formatOptions() {
  return [
    { value: "written", label: ui("选择题笔试"), icon: "check" },
    { value: "case", label: ui("案例分析卷"), icon: "file" },
    { value: "oral", label: ui("口头面试"), icon: "audio" },
  ];
}
const TAGS = () => ({ written: ui("选择题"), case: ui("案例"), oral: ui("口头") });

/** Title, the shared 课程范围 and the 考试形式 switch. `data-tour="exam-case"` keeps the tour's anchor on the switch. */
export function ExamHeader({ courses, course, onCourse, format, onFormat, showInactive, onShowInactive }) {
  useInjectCss(css, "study-exam-setup");
  return (
    <PageHeader title={ui("模拟考试")} className="es-header"
      description={ui("选一种考试形式，在限定时间里完成；交卷或结束后看成绩、反馈和薄弱点。")}
      scope={<PageScope courses={courses} value={course} onChange={onCourse} showInactive={showInactive} onShowInactive={onShowInactive} />}>
      <div className="es-controls">
        <div className="es-format">
          <span className="es-label">{ui("考试形式")}</span>
          <SegmentedControl label={ui("考试形式")} value={format} onChange={onFormat} options={formatOptions()} data-tour="exam-case" />
        </div>
      </div>
    </PageHeader>
  );
}

/**
 * The one setup card: what the exam is, 怎么考 (numbered steps), its settings,
 * and a footer with the summary line and the single start button.
 */
export function ExamSetupCard({ title, intro, steps = [], children, summary, action, className = "", ...rest }) {
  useInjectCss(css, "study-exam-setup");
  const how = useId();
  return (
    <section className={`es-sheet ${className}`.trim()} {...rest}>
      <header className="es-head">
        <h2 className="es-title">{title}</h2>
        {intro && <p className="es-intro">{intro}</p>}
      </header>
      <div className="es-body">
        <div className="es-how">
          <h3 id={how}>{ui("怎么考")}</h3>
          <ol aria-labelledby={how}>
            {steps.map((step, index) => <li className="es-step" key={index}><span className="es-num" aria-hidden="true">{index + 1}</span><span>{step}</span></li>)}
          </ol>
        </div>
        <div className="es-settings">{children}</div>
      </div>
      <footer className="es-foot">
        <p className="es-summary" role="status">{summary}</p>
        {action}
      </footer>
    </section>
  );
}

/** 题数: a few presets and a free number, clamped to [min, max]. */
export function CountField({ label = ui("题数"), value, onChange, presets = [], min = QUESTION_COUNT.min, max = QUESTION_COUNT.max, hint }) {
  const clamp = (raw) => {
    const n = Math.round(Number(raw));
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : value;
  };
  const [draft, setDraft] = useState(String(value));
  return (
    <div className="es-count">
      <span className="es-label">{label}</span>
      <div className="es-count__row">
        {presets.length > 0 && <SegmentedControl size="sm" label={label} value={value} onChange={(next) => { setDraft(String(next)); onChange(next); }}
          options={presets.map((preset) => ({ value: preset, label: String(preset) }))} />}
        <label className="es-count__custom">{ui("自定义")}
          <input type="number" min={min} max={max} value={draft} inputMode="numeric"
            onChange={(event) => { setDraft(event.target.value); if (event.target.value !== "") onChange(clamp(event.target.value)); }}
            onBlur={() => setDraft(String(value))} />
        </label>
      </div>
      {hint && <small className="es-hint">{hint}</small>}
    </div>
  );
}

function Row({ item, onOpen, busy }) {
  const tags = TAGS();
  const score = item.kind === "oral"
    ? (item.assessed ? uiFormat("{0} 题回答扎实", [item.strong]) : ui("尚未评估"))
    : item.kind === "case" ? uiFormat("{0}%", [Math.round(item.scorePct ?? 0)])
      : uiFormat("{0}% · {1}/{2} 题", [Math.round(item.scorePct ?? 0), item.correct ?? 0, item.total ?? 0]);
  const detail = [formatDateTime(item.submittedAt, "day"), item.course || (item.role ? item.role : ""), item.decks?.join("、")].filter(Boolean).join(" · ");
  return (
    <li className="es-recent__row">
      <Badge className="es-kind" tone={item.kind === "case" ? "info" : "neutral"}>{tags[item.kind]}</Badge>
      <span className="es-recent__text"><strong>{score}</strong>{detail && <small>{detail}</small>}</span>
      <Button size="sm" variant="secondary" disabled={busy} onClick={() => onOpen(item)}>{ui("查看报告")}</Button>
    </li>
  );
}

/** 最近考试 of all three formats, filtered to the current one with a 全部 toggle. */
export function RecentExams({ items = [], format, filter, onFilter, onOpen, busy = false }) {
  useInjectCss(css, "study-exam-setup");
  const [own, setOwn] = useState("format");
  const mode = filter ?? own, choose = onFilter ?? setOwn;
  if (!items.length) return null;
  const shown = filterRecent(items, mode === "all" ? "all" : format);
  const names = { written: ui("还没有选择题笔试记录。"), case: ui("还没有案例分析卷记录。"), oral: ui("还没有口头面试记录。") };
  return (
    <Panel className="es-recent" aria-label={ui("最近考试")}>
      <div className="es-recent__head">
        <h2>{ui("最近考试")}</h2>
        <SegmentedControl size="sm" label={ui("显示范围")} value={mode} onChange={choose}
          options={[{ value: "format", label: TAGS()[format] }, { value: "all", label: ui("全部") }]} />
      </div>
      {shown.length
        ? <ul className="es-recent__list">{shown.map((item) => <Row key={`${item.kind}:${item.runId}`} item={item} onOpen={onOpen} busy={busy} />)}</ul>
        : <p className="es-recent__empty">{names[format]} <Button size="sm" variant="link" onClick={() => choose("all")}>{ui("查看全部")}</Button></p>}
    </Panel>
  );
}
