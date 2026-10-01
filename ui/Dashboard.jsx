import { ui, uiFormat } from "./i18n.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import css from "./views.css";
import chartCss from "./charts/charts.css";
import { useInjectCss } from "./shared.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import { RubricSkills } from "./CaseResult.jsx";
import PageScope, { decksInCourse, usePageScope } from './PageScope.jsx';
import { ForecastPanel, MasteryPanel, TrendPanel } from "./charts/DashboardCharts.jsx";
import { shortDeckTitles } from "./charts/chart-math.js";
import { ModelUsage } from "./TokenUsage.jsx";

/* 学习统计仪表盘（v0.4 契约 §2）。所有统计来自 call("stats")；data prop 只
   用于展示当前到期概览（data.today）。热力图为 CSS grid；三张图（每日平均分、
   未来 14 天到期复习、掌握度）在 ui/charts/ 下，纯内联 SVG。样式在
   ui/views.css（与 Exam / WrongBook 共用）和 ui/charts/charts.css。 */

/* 0 = 无作答；其余按 count 占峰值比例分 4 档强度（共 5 档）。 */
function heatLevel(count, max) {
  if (!count) return 0;
  return Math.min(4, 1 + Math.floor(((count - 1) / Math.max(1, max)) * 4));
}

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

export function StatsView({ stats, course, data, busy, localDecks = [], onStartScope, onLibrary, onCreate, onSources }) {
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

  return (
    <>
      {!totals.attempts && <div className="empty dash-empty">
        <span className="empty-icon">◔</span>
        <h2>{ui("还没有作答记录")}</h2>
        <p className="muted">{ui("开始学习后，这里会显示作答热力、分数趋势和薄弱主题。")}</p>
        <EmptyStudyActions data={{ ...data, decks: localDecks }} busy={busy} onStart={() => onStartScope((localDecks || []).map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
          onCreate={onCreate} onSources={onSources} />
      </div>}
      {/* Rubric skills over time (WP12), weakest first. */}
      <RubricSkills attempts={data?.attempts} />
      <div className="dash-hero" data-tour="dashboard-summary">
        <div className="dash-streak">
          <strong>{totals.streak ?? 0}</strong>
          <span>{ui("天连续学习")}</span>
          <p className="dash-summary">
            <span><b>{totals.activeDays ?? 0}</b>{ui(" 个活跃日 · 累计作答 ")}<b>{totals.attempts ?? 0}</b>{ui(" 次")}</span>
            <span>{ui("到期待复习 ")}<b>{totals.due ?? 0}</b>{ui(" 题")}</span>
          </p>
        </div>
        <div className="dash-heat-wrap">
          <div
            className="dash-heat"
            role="img"
            aria-label={uiFormat("近 {0} 周的每日作答次数热力图", [Math.round(shownHeat.length / 7)])}
          >
            {shownHeat.map((d) => (
              <span
                key={d.date}
                className={"dash-heat-cell l" + heatLevel(d.count, maxCount)}
                title={
                  d.count ? uiFormat("{0} · 作答 {1} 次", [d.date, d.count]) : uiFormat("{0} · 无作答", [d.date])
                }
              />
            ))}
          </div>
          <div className="dash-heat-legend" aria-hidden="true">
            <span>{uiFormat("近 {0} 周", [Math.round(shownHeat.length / 7)])}</span>
            <span className="dash-heat-scale">{ui("少")}{[0, 1, 2, 3, 4].map((l) => (
                <i key={l} className={"dash-heat-cell l" + l} />
              ))}{ui("多")}</span>
          </div>
        </div>
      </div>

      <div className="dash-split">
        <section className="dash-section">
          <h2>{ui("需要补强")}{weak.length ? <small>{ui(" · 前 ")}{weak.length}</small> : null}</h2>
          {weak.length ? (
            <ul className="dash-weak">
              {weak.map((w) => (
                <li key={w.deckId + ":" + w.topic} className="dash-weak-row">
                  <span className="dash-weak-name">
                    <strong>{w.topic || ui("未分类")}</strong>
                    <small>{w.detail}</small>
                  </span>
                  <button
                    className="link-btn"
                    onClick={() =>
                      onStartScope([
                        w.topic ? { deckId: w.deckId, topic: w.topic } : { deckId: w.deckId },
                      ])
                    }
                  >{ui("练这个主题 →")}</button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">{totals.attempts
              ? ui("最近没有明显薄弱的主题，继续保持。")
              : ui("开始练习后，这里会显示需要补强的主题。")}</p>
          )}
        </section>

        <section className="dash-section dash-metrics">
          <h2>{ui("判分与自评")}<small>{ui(" · 近 30 天")}</small></h2>
          <div className="dash-rates">
            <div title={ui("近 30 天单选、多选、填空及考试的自动判分，不含本轮队尾重练")}>
              <strong>{totals.gradedRate == null ? "—" : totals.gradedRate}<small>{totals.gradedRate == null ? "" : "%"}</small></strong>
              <span><i />{uiFormat("客观题通过率 · {0} 次", [totals.gradedAttempts ?? 0])}</span>
            </div>
            <div title={ui("近 30 天闪卡和开放问答的掌握程度自评，3 分及以上算达标")}>
              <strong>{totals.selfRate == null ? "—" : totals.selfRate}<small>{totals.selfRate == null ? "" : "%"}</small></strong>
              <span><i className="self" />{uiFormat("自评达标率 · {0} 次", [totals.selfAttempts ?? 0])}</span>
            </div>
          </div>
          {totals.oralAttempts > 0 && (
            <p className="dash-footnote muted">{uiFormat("口头 AI 评估 · {0} 次，其中回答扎实 {1} 次；不计入客观题通过率。", [totals.oralAttempts, totals.oralStrong ?? 0])}</p>
          )}
        </section>

        <div className="dash-charts" data-tour="dashboard-charts">
          <TrendPanel trend={trend} today={stats?.today} />
          <ForecastPanel forecast={stats?.forecast} onStart={onStartScope} />
          <MasteryPanel mastery={stats?.mastery} />
        </div>
      </div>
    </>
  );
}

export default function Dashboard({ call, data, busy, onStartScope, onLibrary, onCreate, onSources, onAudioUsage }) {
  useInjectCss(css, "study-views");
  useInjectCss(chartCss, "study-dash-charts");
  const [course, setCourse] = usePageScope(data?.root, 'dashboard', data?.focus?.course ?? '*');
  const [savedStats, setStats] = useState(null),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState("");
  const seq = useRef(0);
  const stats = savedStats?.course === course ? savedStats.value : null;
  const localDecks = decksInCourse(data, course);

  const load = useCallback(async () => {
    const request = ++seq.current;
    setLoading(true);
    setErr("");
    try {
      const value = await call('stats', { course });
      if (request === seq.current) setStats({ course, value });
    } catch (e) {
      if (request === seq.current) setErr(e.message || String(e));
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [call, course]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="page dash">
      <div className="page-heading">
        <div>
          <h1>{ui("学习统计")}</h1>
          <PageScope courses={data?.focus?.courses} value={course} onChange={setCourse} />
        </div>
        <button className="ghost-btn" onClick={load} disabled={loading}>
          {loading ? ui("统计中…") : ui("刷新")}
        </button>
      </div>

      {err && <p className="dash-error">{err}</p>}
      {loading && !stats && <p className="muted">{ui("正在统计学习记录…")}</p>}

      {stats && (
        <StatsView stats={stats} course={course} data={data} busy={busy} localDecks={localDecks}
          onStartScope={onStartScope} onLibrary={onLibrary} onCreate={onCreate} onSources={onSources} />
      )}
      {/* What the study model used, by feature (WP27); the library's own ledger, not the course view. */}
      <ModelUsage call={call} onAudio={onAudioUsage} />
    </section>
  );
}
