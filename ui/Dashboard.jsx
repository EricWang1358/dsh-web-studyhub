import { ui, uiFormat } from "./i18n.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import css from "./views.css";
import { useInjectCss } from "./shared.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import PageScope, { decksInCourse, usePageScope } from './PageScope.jsx';

/* 学习统计仪表盘（v0.4 契约 §2）。所有统计来自 call("stats")；data prop 只
   用于展示当前到期概览（data.today）。热力图为 26 列 × 7 行 = 182 天的
   CSS grid，趋势线为 SVG polyline。样式在 ui/views.css，与 Exam / WrongBook
   共用：<style data-study-views> 按标记去重注入一次。 */

/* 0 = 无作答；其余按 count 占峰值比例分 4 档强度（共 5 档）。 */
function heatLevel(count, max) {
  if (!count) return 0;
  return Math.min(4, 1 + Math.floor(((count - 1) / Math.max(1, max)) * 4));
}

/* 客观判分与自评分开画，横轴为有作答的日子，纵轴 0–5 分。 */
function Trend({ trend }) {
  const W = 600,
    H = 170,
    L = 34,
    R = 12,
    T = 14,
    B = 14;
  const plotW = W - L - R,
    plotH = H - T - B;
  const n = trend.length;
  const x = (i) => (n <= 1 ? L + plotW / 2 : L + (i * plotW) / (n - 1));
  const y = (avg) => T + (1 - avg / 5) * plotH;
  const points = (key) => trend
    .map((d, i) => d[key] == null ? null : `${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`)
    .filter(Boolean).join(" ");
  return (
    <svg
      className="dash-trend"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={ui("客观判分与自评的每日平均分趋势（0 到 5 分）")}
    >
      {[0, 1, 2, 3, 4, 5].map((s) => (
        <g key={s}>
          <line className="dash-trend-grid" x1={L} x2={W - R} y1={y(s)} y2={y(s)} />
          <text className="dash-trend-label" x={L - 6} y={y(s) + 3} textAnchor="end">
            {s}
          </text>
        </g>
      ))}
      {trend.filter((d) => d.gradedAvg != null).length > 1 &&
        <polyline className="dash-trend-line" points={points("gradedAvg")} />}
      {trend.filter((d) => d.selfAvg != null).length > 1 &&
        <polyline className="dash-trend-line self" points={points("selfAvg")} />}
      {trend.map((d, i) => (
        <React.Fragment key={d.date}>
          {d.gradedAvg != null && <circle className="dash-trend-dot" cx={x(i)} cy={y(d.gradedAvg)} r={6}>
            <title>{uiFormat("{0} · 客观判分平均 {1} 分 · {2} 次", [d.date, d.gradedAvg, d.gradedCount])}</title>
          </circle>}
          {d.selfAvg != null && <circle className="dash-trend-dot self" cx={x(i)} cy={y(d.selfAvg)} r={6}>
            <title>{uiFormat("{0} · 自评平均 {1} 分 · {2} 次", [d.date, d.selfAvg, d.selfCount])}</title>
          </circle>}
        </React.Fragment>
      ))}
    </svg>
  );
}

export default function Dashboard({ call, data, busy, onStartScope, onLibrary, onCreate, onSources }) {
  useInjectCss(css, "study-views");
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

  const totals = stats?.totals || {},
    heat = stats?.heatmap || [],
    trend = stats?.trend || [],
    weak = stats?.weakTopics || [];
  const maxCount = heat.reduce((m, d) => Math.max(m, d.count || 0), 0);
  /* Show the weeks since the learner started (at least 12), not half a year
     of empty squares. Slicing on whole weeks keeps weekday rows aligned. */
  const firstActive = heat.findIndex((d) => d.count),
    minDays = 12 * 7,
    heatStart = Math.max(0, Math.min(firstActive < 0 ? heat.length : Math.floor(firstActive / 7) * 7,
      heat.length - minDays)),
    shownHeat = heat.slice(heatStart);

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
        <>
          {!totals.attempts && <div className="empty dash-empty">
            <span className="empty-icon">◔</span>
            <h2>{ui("还没有作答记录")}</h2>
            <p className="muted">{ui("开始学习后，这里会显示作答热力、分数趋势和薄弱主题。")}</p>
            <EmptyStudyActions data={{ ...data, decks: localDecks }} busy={busy} onStart={() => onStartScope(localDecks.map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
              onCreate={onCreate} onSources={onSources} />
          </div>}
          <div className="dash-hero">
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
                        <small>{uiFormat("{0} · 当前薄弱 {1} 题", [w.deckTitle, w.wrong])}</small>
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

            <section className="dash-section dash-accuracy">
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
              <p className="muted">{uiFormat('口头 AI 评估 · {0} 次，其中回答扎实 {1} 次；不计入客观题通过率。', [totals.oralAttempts ?? 0, totals.oralStrong ?? 0])}</p>
              {trend.length ? (
                <figure className="dash-trend-figure">
                  <figcaption>{ui("每日平均分 · 0–5 分")}</figcaption>
                  <Trend trend={trend} />
                </figure>
              ) : (
                <p className="muted">{ui("完成第一次学习后，这里会出现每日平均分的趋势线。")}</p>
              )}
            </section>
          </div>
        </>
      )}
    </section>
  );
}
