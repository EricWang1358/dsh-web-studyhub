import { ui, uiFormat, errorMessage } from "./i18n.js";
import { uiRich } from "./i18n-rich.jsx";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import css from "./views.css";
import chartCss from "./charts/charts.css";
import { useInjectCss } from "./shared.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import { RubricSkills } from "./CaseResult.jsx";
import PageScope, { courseMatcher, decksInCourse, scopedAttemptsOf, usePageScope, useShowInactive, scopeArgs } from './PageScope.jsx';
import { useCourseActive } from './CourseActive.jsx';
import { FocusDurationPanel, ForecastPanel, MasteryPanel, TrendPanel } from "./charts/DashboardCharts.jsx";
import { shortDeckTitles } from "./charts/chart-math.js";
import { ModelUsage } from "./TokenUsage.jsx";
import { Badge, Button, EmptyState, ErrorState, Icon, LoadingState, PageHeader, Tooltip } from "./components/index.js";
import { useStudy } from "./study-context.jsx";
import { MEASURES, THIN_DATA, enoughAnswers } from "./mastery-terms.js";
import LazySealAlbumTrigger from "./seal-press/LazySealAlbumTrigger.jsx";

const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

/* 学习统计仪表盘（v0.4 契约 §2）。所有统计来自 call("stats")；data prop 只
   用于展示当前到期概览（data.today）。热力图为 CSS grid；三张图（每日平均分、
   未来 14 天到期复习、掌握度）在 ui/charts/ 下，纯内联 SVG。样式在
   ui/views.css（与 Exam / WrongBook 共用）和 ui/charts/charts.css。 */

/* 0 = 无作答；其余按 count 占峰值比例分 4 档强度（共 5 档）。 */
function heatLevel(count, max) {
  if (!count) return 0;
  return Math.min(4, 1 + Math.floor(((count - 1) / Math.max(1, max)) * 4));
}

/** Roving-focus navigation for the 7-row column-major activity heatmap (1 Tab stop total). */
export function nextHeatmapIndex(current, key, length, rows = 7) {
  if (!Number.isInteger(length) || length <= 0) return null;
  const idx = Number.isInteger(current) ? Math.max(0, Math.min(length - 1, current)) : length - 1;
  switch (key) {
    case "ArrowDown": return Math.min(length - 1, idx + 1);
    case "ArrowUp": return Math.max(0, idx - 1);
    case "ArrowRight": return Math.min(length - 1, idx + rows);
    case "ArrowLeft": return Math.max(0, idx - rows);
    case "Home": return 0;
    case "End": return length - 1;
    default: return null;
  }
}

/* "Including inactive courses" only when parked courses exist inside the page's scope (the stats say `included` for any view that left nothing out). */
const showsParked = (data, course) => (data?.focus?.courses || []).some((item) => item?.active === false && (item.count ?? 0) > 0) && course === "*";

/* Weak-topic rows: the topic first; course (only when several courses are
   shown) and a shortened deck name as secondary text. Decks of one course
   usually share "Course｜…｜90题" - show only the part that tells them apart. */
function weakRows(weak, course) {
  const byCourse = new Map();
  weak.forEach((w, i) => byCourse.set(w.course ?? "", [...(byCourse.get(w.course ?? "") || []), i]));
  const short = [];
  for (const indexes of byCourse.values()) {
    const titles = shortDeckTitles(indexes.map((i) => weak[i].deckTitle));
    indexes.forEach((i, k) => { short[i] = titles[k]; });
  }
  return weak.map((w, i) => ({
    ...w,
    detail: [course === "*" && w.course ? w.course : "", short[i], uiFormat("当前薄弱 {0} 题", [w.wrong])]
      .filter(Boolean).join(" · "),
  }));
}

/* One 30-day rate of the hero: the numeral (— with no answers, 数据不足 with fewer than the minimum, else the percentage), its name and how many answers
   it stands on. The name and its hover explanation come from ui/mastery-terms.js, the one place the words of these numbers are said. */
function RateTile({ measure, rate, answers, minimum, markClass }) {
  const thin = rate != null && !enoughAnswers(answers, minimum);
  return (
    <Tooltip layer content={ui(measure.hint)}>
      <div tabIndex={0}>
        {thin ? <strong className="is-thin">{ui(THIN_DATA)}</strong>
          : <strong>{rate == null ? "—" : rate}<small>{rate == null ? "" : "%"}</small></strong>}
        <span className="dash-rate__label"><i className={markClass ? `dash-rate ${markClass}` : "dash-rate"} />{uiFormat("{0} · {1} 次", [ui(measure.label), answers ?? 0])}</span>
      </div>
    </Tooltip>
  );
}

export function StatsView({
  stats, course = "*", data, localDecks, board, focusToday, boardReadOnly = false,
  onEditTimeLog, onRemoveTimeLog, onOpenToday,
  onStartScope, onLibrary, onCreate, onSources, onManageCourses, onOpenWorkflowSession, onOpenWorkflowArchive,
}) {
  const { busy } = useStudy();
  const decks = localDecks ?? decksInCourse(data, course);
  const scopedAttempts = useMemo(() => scopedAttemptsOf(data, course, decks), [data, decks, course]);
  const historicalFlows = useMemo(() => {
    const list = data?.workflowSessions;
    if (!Array.isArray(list) || !list.length) return [];
    const matchCourse = courseMatcher(data, course);
    return list.filter((item) => course === "*" || matchCourse(item?.course || ""));
  }, [data, course]);
  const totalWorkflowSessions = Number.isInteger(data?.workflowSessionTotal)
    ? data.workflowSessionTotal
    : (data?.workflowSessions?.length || 0);
  const truncatedWorkflowHistory = totalWorkflowSessions > (data?.workflowSessions?.length || 0);
  const totals = stats?.totals || {},
    heat = stats?.heatmap || [],
    trend = stats?.trend || [],
    weak = weakRows(stats?.weakTopics || [], course);
  const maxCount = heat.reduce((m, d) => Math.max(m, d.count || 0), 0);
  /* Show the weeks since the learner started (at least 12), not half a year
     of empty squares. Slicing on whole weeks keeps weekday rows aligned. */
  const firstActive = heat.findIndex((d) => d.count),
    minDays = 12 * 7,
    heatStart = Math.max(0, Math.min(firstActive < 0 ? heat.length : Math.floor(firstActive / 7) * 7,
      heat.length - minDays)),
    shownHeat = heat.slice(heatStart);
  const broken = !(totals.streak > 0) && totals.activeDays > 0;
  const practiseScope = (scope) => {
    if (!busy && onStartScope && Array.isArray(scope) && scope.length) onStartScope(scope.slice(0, 200));
  };
  const casePracticeCards = useMemo(() => {
    if (Array.isArray(stats?.caseScope) && stats.caseScope.length > 0) return stats.caseScope.slice(0, 200);
    const collected = [];
    for (const deck of decks || []) {
      if (deck?.archived) continue;
      if (Array.isArray(deck.cards)) {
        for (const card of deck.cards) {
          if (card?.suspended) continue;
          if (deck.format === "case-study" || card.kind === "case" || card.kind === "open" || (Array.isArray(card.rubricCriteria) && card.rubricCriteria.length > 0)) {
            collected.push({ deckId: deck.id, cardId: card.id });
            if (collected.length >= 200) return collected;
          }
        }
      } else if (deck?.format === "case-study" && deck.available !== 0) {
        collected.push({ deckId: deck.id });
        if (collected.length >= 200) return collected;
      }
    }
    return collected;
  }, [stats?.caseScope, decks]);
  const mergedWeakCards = useMemo(() => {
    if (Array.isArray(stats?.weakScope) && stats.weakScope.length) return stats.weakScope.slice(0, 200);
    const seen = new Set();
    const list = [];
    for (const row of weak) {
      for (const ref of row.cards || []) {
        const key = `${ref.deckId}\u0000${ref.cardId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        list.push(ref);
        if (list.length >= 200) return list;
      }
    }
    return list;
  }, [stats?.weakScope, weak]);
  const heatRef = useRef(null);
  const [activeHeatIndex, setActiveHeatIndex] = useState(-1);
  const rovingHeatIndex = shownHeat.length
    ? (activeHeatIndex >= 0 && activeHeatIndex < shownHeat.length ? activeHeatIndex : shownHeat.length - 1)
    : -1;
  const heatWeeks = Math.round(shownHeat.length / 7);
  const heatActiveDays = shownHeat.reduce((count, day) => count + ((day.count || 0) > 0 ? 1 : 0), 0);
  const heatTotalCount = shownHeat.reduce((sum, day) => sum + (day.count || 0), 0);
  const heatBaseLabel = uiFormat("近 {0} 周的每日作答次数热力图", [heatWeeks]);
  const heatLabel = heatTotalCount > 0
    ? uiFormat("{0}：{1}，用方向键查看每天记录", [heatBaseLabel, uiFormat("{0} 个活跃日 · 累计作答 {1} 次", [heatActiveDays, heatTotalCount])])
    : heatBaseLabel;
  const handleHeatKeyDown = (event) => {
    if (!shownHeat.length) return;
    const cellEl = event.target?.closest?.("[data-heat-index]");
    const current = cellEl ? Number(cellEl.dataset.heatIndex) : rovingHeatIndex;
    const next = nextHeatmapIndex(current, event.key, shownHeat.length, 7);
    if (next == null) return;
    event.preventDefault();
    setActiveHeatIndex(next);
    heatRef.current?.querySelector?.(`[data-heat-index="${next}"]`)?.focus?.();
  };
  useIsomorphicLayoutEffect(() => {
    if (heatRef.current) heatRef.current.scrollLeft = heatRef.current.scrollWidth;
  }, [shownHeat.length]);

  return (
    <>
      {!totals.attempts && <EmptyState icon="list" title={ui("还没有作答记录")} description={ui("开始学习后，这里会显示作答热力、分数趋势和薄弱主题。")}>
        <EmptyStudyActions data={{ ...data, decks }} onStart={() => onStartScope((decks || []).map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
          onCreate={onCreate} onSources={onSources} />
      </EmptyState>}
      <div className="dash-hero" data-tour="dashboard-summary">
        {/* The focal numeral is the streak; once the streak is broken it is the learner's active days instead of a giant 0, and the broken streak
            becomes one quiet line (#573). With no active day at all there is nothing positive to show, so the streak stays. */}
        <div className="dash-streak" data-focal={broken ? "active-days" : "streak"}>
          <strong>{broken ? totals.activeDays : totals.streak ?? 0}</strong>
          <span>{broken ? ui("活跃天数") : ui("天连续学习")}</span>
          <p className="dash-summary">
            {broken ? <span>{uiRich("累计作答 {0} 次", <b>{totals.attempts ?? 0}</b>)}</span>
              : <span>{uiRich("{0} 个活跃日 · 累计作答 {1} 次", <b>{totals.activeDays ?? 0}</b>, <b>{totals.attempts ?? 0}</b>)}</span>}
            <span>{uiRich("到期待复习 {0} 题", <b>{totals.due ?? 0}</b>)}</span>
            {broken && <span className="dash-streak-note">{ui("今天学一题，就开始新的连续学习")}</span>}
          </p>
        </div>
        <div className="dash-heat-wrap">
          <div
            ref={heatRef}
            className="dash-heat"
            role="group"
            aria-label={heatLabel}
            onKeyDown={handleHeatKeyDown}
          >
            {shownHeat.map((d, index) => {
              const cellLabel = d.count ? uiFormat("{0} · 作答 {1} 次", [d.date, d.count]) : uiFormat("{0} · 无作答", [d.date]);
              return (
                <Tooltip
                  key={d.date}
                  layer
                  group="dash-heat"
                  anchorClassName={"dash-heat-cell l" + heatLevel(d.count, maxCount)}
                  content={cellLabel}
                >
                  <span
                    tabIndex={index === rovingHeatIndex ? 0 : -1}
                    data-heat-index={index}
                    aria-label={cellLabel}
                    onFocus={() => setActiveHeatIndex(index)}
                  />
                </Tooltip>
              );
            })}
          </div>
          <div className="dash-heat-legend" aria-hidden="true">
            <span>{uiFormat("近 {0} 周", [heatWeeks])}</span>
            <span className="dash-heat-scale">{ui("少")}{[0, 1, 2, 3, 4].map((l) => (
                <i key={l} className={"dash-heat-cell l" + l} />
              ))}{ui("多")}</span>
          </div>
        </div>
      </div>

      {/* Rubric skills over time (WP12), weakest first, scoped to the active course. */}
      <RubricSkills attempts={scopedAttempts} onPractice={onStartScope && casePracticeCards.length ? () => practiseScope(casePracticeCards) : undefined} />

      <div className="dash-split">
        <section className="dash-section" data-weak-cleared={totals.attempts > 0 && !weak.length ? "true" : undefined}>
          <h2 className="dash-section__head">
            <span>{ui("需要补强")}{weak.length ? <small>{" · "}{uiFormat("前 {0}", [weak.length])}</small> : null}</span>
            {totals.attempts > 0 && !weak.length && <Badge size="sm" tone="success" className="dash-section__badge">{ui("已清零")}</Badge>}
            {onStartScope && weak.length > 1 && mergedWeakCards.length > 0 && (
              <Button variant="link" size="sm" iconEnd="arrow-right" className="dash-section__action" lock={busy} onClick={() => practiseScope(mergedWeakCards)}>
                {ui("合并练薄弱题")}
              </Button>
            )}
          </h2>
          {weak.length ? (
            <ul className="dash-weak">
              {weak.map((w) => (
                <li key={w.deckId + ":" + w.topic} className="dash-weak-row">
                  <span className="dash-weak-name">
                    <strong>{w.topic || ui("未分类")}</strong>
                    <small>{w.detail}</small>
                  </span>
                  <Button variant="link" size="sm" iconEnd="arrow-right" className="dash-weak-start" lock={busy}
                    onClick={() =>
                      practiseScope(w.cards?.length ? w.cards : [
                        w.topic ? { deckId: w.deckId, topic: w.topic } : { deckId: w.deckId },
                      ])
                    }
                  >{ui("练这个主题")}</Button>
                </li>
              ))}
            </ul>
          ) : totals.attempts ? (
            <p className="dash-weak-clear" role="status" data-testid="dash-weak-clear">
              <Icon className="sh-icon--inline" name="check" />
              <span>{ui("最近没有明显薄弱的主题，继续保持。")}</span>
            </p>
          ) : (
            <p className="muted">{ui("开始练习后，这里会显示需要补强的主题。")}</p>
          )}
        </section>

        <section className="dash-section dash-metrics">
          <h2>{ui("判分与自评")}<small>{" · "}{ui("近 30 天")}</small></h2>
          <div className="dash-rates">
            <RateTile measure={MEASURES.gradedRate} rate={totals.gradedRate} answers={totals.gradedAttempts} minimum={stats?.mastery?.minAnswers} />
            <RateTile measure={MEASURES.selfRate} rate={totals.selfRate} answers={totals.selfAttempts} minimum={stats?.mastery?.minAnswers} markClass="self" />
          </div>
          {totals.oralAttempts > 0 && (
            <p className="dash-footnote muted">{uiFormat("口头 AI 评估 · {0} 次，其中回答扎实 {1} 次；不计入客观题通过率。", [totals.oralAttempts, totals.oralStrong ?? 0])}</p>
          )}
        </section>

        <div className="dash-charts" data-tour="dashboard-charts">
          <TrendPanel trend={trend} today={stats?.today} />
          <ForecastPanel forecast={stats?.forecast} onStart={onStartScope} parked={{ included: stats?.inactive?.included === true && showsParked(data, course), onManage: onManageCourses }} />
          <MasteryPanel mastery={stats?.mastery} onStartScope={onStartScope} />
          {board && (
            <FocusDurationPanel
              board={board}
              today={focusToday}
              readOnly={boardReadOnly}
              onEditLog={onEditTimeLog}
              onRemoveLog={onRemoveTimeLog}
              onOpenToday={onOpenToday}
            />
          )}
          {(historicalFlows.length > 0 || (truncatedWorkflowHistory && onOpenWorkflowArchive)) && (onOpenWorkflowSession || onOpenWorkflowArchive) && (
            <section className="dash-section dash-workflows" aria-label={ui("历史学习流记录（只读）")}>
              <details className="dash-fold">
                <summary className="dash-fold__summary">
                  <span>{ui("历史学习流记录")}</span>
                  <span className="dash-fold__meta">
                    {totalWorkflowSessions > historicalFlows.length && course === "*"
                      ? uiFormat("最近 {0} / 共 {1} 条 · 只读", [historicalFlows.length, totalWorkflowSessions])
                      : ui("只读")}
                  </span>
                </summary>
                <div className="dash-fold__body">
                  <p className="muted small">{ui("学习流已退役，现由每门课的「学法」与主会话带学替代；此前的学习记录保留供随时查阅。")}</p>
                  {historicalFlows.length > 0 ? (
                    <ul className="dash-weak">
                      {historicalFlows.map((item) => (
                        <li key={item.id} className="dash-weak-row">
                          <span className="dash-weak-name">
                            <strong>{item.topic || item.title || ui("学习记录")}</strong>
                            <small>{[course === "*" && item.course ? item.course : "", item.title, item.updatedAt ? item.updatedAt.slice(0, 10) : ""].filter(Boolean).join(" · ")}</small>
                          </span>
                          {onOpenWorkflowSession && (
                            <Button variant="link" size="sm" iconEnd="arrow-right" className="dash-weak-start" onClick={() => onOpenWorkflowSession(item.id)}>
                              {ui("查看记录")}
                            </Button>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="muted small">{uiFormat("当前范围在最近 {0} 条中暂无匹配记录，可打开全部 {1} 条历史记录查看。", [data?.workflowSessions?.length || 0, totalWorkflowSessions])}</p>
                  )}
                  {onOpenWorkflowArchive && (
                    <p className="dash-footnote">
                      <Button variant="link" size="sm" iconEnd="arrow-right" onClick={onOpenWorkflowArchive}>
                        {totalWorkflowSessions > historicalFlows.length
                          ? uiFormat("查看全部历史记录（共 {0} 条）", [totalWorkflowSessions])
                          : ui("查看全部历史记录")}
                      </Button>
                    </p>
                  )}
                </div>
              </details>
            </section>
          )}
        </div>
      </div>
    </>
  );
}

export default function Dashboard({
  data, board, focusToday, boardReadOnly = false, onRefreshBoard, onEditTimeLog, onRemoveTimeLog, onOpenToday,
  onStartScope, onLibrary, onCreate, onSources, onAudioUsage, onOpenWorkflowSession, onOpenWorkflowArchive,
}) {
  const { call } = useStudy();
  useInjectCss(css, "study-views");
  useInjectCss(chartCss, "study-dash-charts");
  const [course, setCourse] = usePageScope(data?.root, 'dashboard', data?.focus?.course ?? '*');
  const [showInactive, setShowInactive] = useShowInactive(data?.root, 'dashboard');
  const courseActive = useCourseActive();
  const scopeKey = JSON.stringify(scopeArgs(course, showInactive));
  const [savedStats, setStats] = useState(null),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState("");
  const seq = useRef(0);
  const stats = savedStats?.course === scopeKey ? savedStats.value : null;
  const localDecks = decksInCourse(data, course, showInactive);

  const refreshBoardRef = useRef(onRefreshBoard);
  refreshBoardRef.current = onRefreshBoard;

  const load = useCallback(async () => {
    const request = ++seq.current;
    setLoading(true);
    setErr("");
    refreshBoardRef.current?.();
    try {
      const value = await call('stats', scopeArgs(course, showInactive));
      if (request === seq.current) setStats({ course: scopeKey, value });
    } catch (e) {
      if (request === seq.current) setErr(errorMessage(e));
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [call, course, showInactive, scopeKey]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="page dash">
      {/* 刷新 ends the title's row; the scope picker sits under both (#573). */}
      <PageHeader title={ui("学习统计")} actionsOnTitleRow
        scope={<PageScope courses={data?.focus?.courses} value={course} onChange={setCourse} showInactive={showInactive} onShowInactive={setShowInactive} />}
        actions={<>
          <LazySealAlbumTrigger />
          <Button variant="quiet" onClick={load} busy={loading} busyLabel={ui("统计中…")}>{ui("刷新")}</Button>
        </>} />

      {err && <ErrorState error={err} onRetry={load} />}
      {loading && !stats && <LoadingState label={ui("正在统计学习记录…")} />}

      {stats && (
        <StatsView stats={stats} course={course} data={data} localDecks={localDecks}
          board={board} focusToday={focusToday} boardReadOnly={boardReadOnly}
          onEditTimeLog={onEditTimeLog} onRemoveTimeLog={onRemoveTimeLog} onOpenToday={onOpenToday}
          onStartScope={onStartScope} onLibrary={onLibrary} onCreate={onCreate} onSources={onSources} onManageCourses={courseActive?.manage} onOpenWorkflowSession={onOpenWorkflowSession} onOpenWorkflowArchive={onOpenWorkflowArchive} />
      )}
      {/* What the study model used, by feature (WP27); the library's own ledger, not the course view. */}
      <details className="dash-fold dash-usage-fold">
        <summary className="dash-fold__summary">
          <span>{ui("模型用量")}</span>
          <span className="dash-fold__meta">{ui("跨课程汇总")}</span>
        </summary>
        <div className="dash-fold__body">
          <ModelUsage onAudio={onAudioUsage} />
        </div>
      </details>
    </section>
  );
}
