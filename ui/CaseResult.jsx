import React from "react";
import { ui, uiFormat } from "./i18n.js";
import { useInjectCss } from "./shared.js";
import Markdown from "./Markdown.jsx";
import { Button, Disclosure, InlineMessage, Panel, Spinner } from "./components/index.js";
import { rubricSkills } from "../lib/case-study.js";
import css from "./case-result.css";

/* The result of rubric grading (WP12): marks per criterion with the quotes
   that earned them, the missing points and a concrete rewrite; flags for
   recommendations without a case anchor and for assumption chains. Used in
   review (one question), in the case paper report and, as skill dimensions,
   in 错题与待巩固 and 统计. */

const marks = (value) => Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
const percent = (ratio) => `${Math.round(Math.max(0, Math.min(1, ratio || 0)) * 100)}%`;
export const bandLabel = (band) => ({ excellent: ui("优秀"), good: ui("良好"), pass: ui("及格"), weak: ui("待加强") })[band] || "";
const noteLabel = (note) => note === "unanswered" ? ui("这道题没有作答，按 0 分计。") : note === "not-scored" ? ui("评分助手没有给这一项打分，按 0 分计。") : "";

function Bar({ ratio, label }) {
  return <span className="rubric-bar" role="img" aria-label={label}><span style={{ width: percent(ratio) }} /></span>;
}

/** One graded answer, criterion by criterion. */
export function RubricResult({ rubric, title, compact = false }) {
  useInjectCss(css, "study-case-result");
  if (!rubric) return null;
  return (
    <section className={"rubric-result" + (compact ? " is-compact" : "")} aria-label={title || ui("批改结果")}>
      <header className="rubric-result__head">
        <p className="rubric-score"><strong>{marks(rubric.total)}</strong><span>{uiFormat("/ {0} 分", [marks(rubric.max)])}</span></p>
        <div className="rubric-result__summary">
          {rubric.band && <span className={`rubric-band band-${rubric.band}`}>{bandLabel(rubric.band)}</span>}
          {rubric.summary && <p>{rubric.summary}</p>}
        </div>
      </header>
      <ol className="rubric-rows">
        {(rubric.criteria || []).map((criterion) => (
          <li className={"rubric-row" + (criterion.ratio < 0.6 ? " is-weak" : "")} key={criterion.id}>
            <div className="rubric-row__head">
              <strong>{criterion.label}</strong>
              <span className="rubric-row__score">{uiFormat("{0}/{1} 分", [marks(criterion.score), marks(criterion.max)])}</span>
            </div>
            <Bar ratio={criterion.max ? criterion.score / criterion.max : 0}
              label={uiFormat("{0}：{1}/{2} 分", [criterion.label, marks(criterion.score), marks(criterion.max)])} />
            {criterion.note && <p className="rubric-note">{noteLabel(criterion.note)}</p>}
            {criterion.evidence?.length > 0 && <div className="rubric-block rubric-evidence">
              <small>{ui("得分依据（引自你的回答）")}</small>
              {criterion.evidence.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}
            </div>}
            {criterion.missing?.length > 0 && <div className="rubric-block rubric-missing">
              <small>{ui("遗漏的要点")}</small>
              <ul>{criterion.missing.map((point, index) => <li key={point.id || index}>{point.text}</li>)}</ul>
            </div>}
            {criterion.suggestion && <div className="rubric-block rubric-suggestion">
              <small>{ui("可以这样改写")}</small>
              <p>{criterion.suggestion}</p>
            </div>}
          </li>
        ))}
      </ol>
      {rubric.unanchored?.length > 0 && <section className="rubric-flags">
        <h4>{ui("没有落到案例上的建议")}</h4>
        <ul>{rubric.unanchored.map((item, index) => <li key={index}>
          <q>{item.quote}</q>
          <span className="rubric-flags__hint">{ui("可以用案例里的这句话支撑：")}</span>
          <q className="rubric-cue">{item.cue}</q>
        </li>)}</ul>
      </section>}
      {rubric.assumptions?.length > 0 && <section className="rubric-flags">
        <h4>{ui("假设链")}</h4>
        <ul>{rubric.assumptions.map((item, index) => <li key={index} className={item.stated ? "is-stated" : "is-missing"}>
          <span className="rubric-flags__hint">{item.stated ? ui("你写出了假设：") : ui("案例没有说明，应该先写出假设：")}</span>
          <strong>{item.gap}</strong>
          {item.quote && <q>{item.quote}</q>}
          {item.suggestion && <p>{item.suggestion}</p>}
        </li>)}</ul>
      </section>}
    </section>
  );
}

const minutes = (ms) => Math.round((ms || 0) / 60000);
const statusLabel = (status) => ({ graded: ui("已批改"), pending: ui("批改中"), unanswered: ui("未作答") })[status] || "";

/** The report of a case paper: per-question marks, the three weakest criteria with practice, and the pacing. */
export function CaseReport({ report, busy, onDrills, onAgain, onPracticeDeck, onRetryGrading, gradingErrors = [] }) {
  useInjectCss(css, "study-case-result");
  const paper = report?.case;
  if (!paper) return null;
  const graded = paper.questions.filter((question) => question.status === "graded").length;
  return (
    <div className="case-report">
      <div className="case-report__hero">
        <p className="rubric-score"><strong>{marks(paper.total)}</strong><span>{uiFormat("/ {0} 分", [marks(paper.max)])}</span></p>
        <div>
          <strong>{paper.pending ? uiFormat("已批改 {0}/{1} 题，其余正在后台批改", [graded, paper.questions.length]) : ui("全部批改完成")}</strong>
          <p className="muted">{uiFormat("阅读 {0} 分钟 · 作答 {1} 分钟", [minutes(paper.pacing.readingMs), minutes(paper.pacing.writingMs)])}
            {paper.handwriting ? uiFormat(" · 录入 {0} 分钟（不计入考试时间）", [minutes(paper.pacing.transcribeMs)]) : ""}</p>
          {paper.pending > 0 && <p className="case-report__pending" role="status"><Spinner size="sm" />{ui("批改结果会自动出现在这里，也会进信箱。")}</p>}
          {gradingErrors.length > 0 && <InlineMessage tone="error" action={onRetryGrading ? { label: ui("重新提交批改"), onClick: onRetryGrading } : undefined}>{gradingErrors.join("；")}</InlineMessage>}
        </div>
      </div>
      <section className="case-report__section">
        <h2>{ui("各题得分")}</h2>
        <ol className="case-report__questions">
          {paper.questions.map((question) => {
            const pace = paper.pacing.rows.find((row) => row.cardId === question.cardId);
            return <li key={question.cardId} className={`is-${question.status}`}>
              <span className="case-report__n">{uiFormat("第 {0} 题", [question.n])}</span>
              <span className="case-report__prompt">{question.prompt}</span>
              <span className="case-chip">{statusLabel(question.status)}</span>
              <span className="case-report__marks">{question.total === null ? "—" : marks(question.total)}<small>{uiFormat("/{0}", [marks(question.marks)])}</small></span>
              {pace && <small className={"case-report__pace" + (pace.status === "over" ? " is-over" : "")}>
                {uiFormat("用时 {0}/{1} 分钟", [minutes(pace.spentMs), minutes(pace.budgetMs)])}</small>}
            </li>;
          })}
        </ol>
        {paper.pacing.unanswered.length > 0 && <InlineMessage tone="warning">{uiFormat("{0} 道题没有作答：漏答一道就丢掉它的全部分数，先保证每题都写到。", [paper.pacing.unanswered.length])}</InlineMessage>}
        {paper.pacing.overBudget.length > 0 && <p className="muted">{uiFormat("{0} 道题超出建议用时；按每分约 {1} 分钟分配时间更稳。", [paper.pacing.overBudget.length, paper.pacing.writingMinutes && paper.max ? marks(paper.pacing.writingMinutes / paper.max) : 3])}</p>}
      </section>
      {paper.weakest.length > 0 && <section className="case-report__section">
        <h2>{ui("最需要加强的评分项")}</h2>
        <ol className="case-report__weak">
          {paper.weakest.map((item) => <li key={`${item.cardId}:${item.criterionId}`}>
            <div>
              <strong>{item.label}</strong>
              <small>{uiFormat("第 {0} 题 · {1}/{2} 分", [item.n, marks(item.score), marks(item.max)])}</small>
            </div>
            {onDrills && <Button size="sm" variant="secondary" disabled={busy} onClick={() => onDrills([`${item.cardId}:${item.criterionId}`])}>{ui("针对练习")}</Button>}
          </li>)}
        </ol>
      </section>}
      <div className="case-report__actions">
        {onDrills && <Button variant="primary" icon="sparkle" disabled={busy || !paper.weakest.length} onClick={() => onDrills()}>{ui("把薄弱项变成练习")}</Button>}
        {onAgain && <Button variant="secondary" disabled={busy} onClick={onAgain}>{ui("再来一个同类案例")}</Button>}
        {onPracticeDeck && <Button variant="quiet" disabled={busy} onClick={onPracticeDeck}>{ui("逐题复习这套案例")}</Button>}
      </div>
      {paper.questions.some((question) => question.status === "graded") && <Disclosure summary={ui("逐题批改详情")}>
        {paper.questions.filter((question) => question.rubric).map((question) => (
          <div key={question.cardId} className="case-report__detail">
            <h3>{uiFormat("第 {0} 题", [question.n])}</h3>
            <Markdown text={question.prompt} />
            <RubricResult rubric={question.rubric} compact />
          </div>
        ))}
      </Disclosure>}
    </div>
  );
}

/** Rubric criteria as skills over time (case linkage, assumptions, justification…), weakest first. */
export function RubricSkills({ attempts = [], onPractice, practiceLabel }) {
  useInjectCss(css, "study-case-result");
  const skills = rubricSkills(attempts);
  if (!skills.length) return null;
  return (
    <Panel className="rubric-skills" title={ui("案例分析能力")}
      description={ui("按评分项统计你在开放题和案例题上的得分率，最弱的在前。")}
      actions={onPractice ? <Button size="sm" variant="secondary" onClick={onPractice}>{practiceLabel || ui("练案例题")}</Button> : null}>
      <ul className="rubric-skills__list">
        {skills.map((skill) => (
          <li key={skill.label}>
            <span className="rubric-skills__label">{skill.label}</span>
            <Bar ratio={skill.ratio} label={uiFormat("{0}：{1}", [skill.label, percent(skill.ratio)])} />
            <span className="rubric-skills__value">{percent(skill.ratio)}</span>
            <small className="rubric-skills__trend" aria-label={ui("最近几次的得分率")}>
              {skill.trend.map((ratio, index) => <i key={index} style={{ "--h": percent(ratio) }} />)}
              {uiFormat("{0} 次", [skill.count])}
            </small>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
