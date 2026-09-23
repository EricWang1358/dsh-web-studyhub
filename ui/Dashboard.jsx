import React, { useCallback, useEffect, useState } from "react";
import css from "./views.css";
import { useInjectCss } from "./shared.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";

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
      aria-label="客观判分与自评的每日平均分趋势（0 到 5 分）"
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
          {d.gradedAvg != null && <circle className="dash-trend-dot" cx={x(i)} cy={y(d.gradedAvg)} r={3}>
            <title>{`${d.date} · 客观判分平均 ${d.gradedAvg} 分 · ${d.gradedCount} 次`}</title>
          </circle>}
          {d.selfAvg != null && <circle className="dash-trend-dot self" cx={x(i)} cy={y(d.selfAvg)} r={3}>
            <title>{`${d.date} · 自评平均 ${d.selfAvg} 分 · ${d.selfCount} 次`}</title>
          </circle>}
        </React.Fragment>
      ))}
    </svg>
  );
}

export default function Dashboard({ call, data, busy, onStartScope, onLibrary, onCreate, onSources }) {
  useInjectCss(css, "study-views");
  const [stats, setStats] = useState(null),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      setStats(await call("stats"));
    } catch (e) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }, [call]);
  useEffect(() => {
    load();
  }, [load]);

  const totals = stats?.totals || {},
    heat = stats?.heatmap || [],
    trend = stats?.trend || [],
    weak = stats?.weakTopics || [];
  const maxCount = heat.reduce((m, d) => Math.max(m, d.count || 0), 0);
  const today = data?.today;

  return (
    <section className="page dash">
      <div className="page-heading">
        <div>
          <h1>学习统计</h1>
          <p className="muted">连续学习、作答热力、分数趋势和薄弱主题。</p>
        </div>
        <button onClick={load} disabled={loading}>
          {loading ? "统计中…" : "刷新"}
        </button>
      </div>

      {err && <p className="dash-error">{err}</p>}
      {loading && !stats && <p className="muted">正在统计学习记录…</p>}

      {stats && (
        <>
          {!totals.attempts && <div className="empty dash-empty">
            <span className="empty-icon">◔</span>
            <h2>还没有作答记录</h2>
            <p className="muted">开始学习后，这里会显示作答热力、分数趋势和薄弱主题。</p>
            <EmptyStudyActions data={data} busy={busy} onStart={() => onStartScope([])} onLibrary={onLibrary}
              onCreate={onCreate} onSources={onSources} />
          </div>}
          <div className="dash-totals">
            <div className="dash-total">
              <strong>{totals.streak ?? 0}</strong>
              <small>连续学习 · 天</small>
            </div>
            <div className="dash-total">
              <strong>{totals.activeDays ?? 0}</strong>
              <small>活跃天数</small>
            </div>
            <div className="dash-total">
              <strong>{totals.attempts ?? 0}</strong>
              <small>累计作答</small>
            </div>
            <div className="dash-total">
              <strong>{totals.gradedRate == null ? "—" : `${totals.gradedRate}%`}</strong>
              <small title="近 30 天单选、多选、填空及考试的自动判分，不含本轮队尾重练">客观题通过率 · {totals.gradedAttempts ?? 0} 次</small>
            </div>
            <div className="dash-total">
              <strong>{totals.selfRate == null ? "—" : `${totals.selfRate}%`}</strong>
              <small title="近 30 天闪卡和开放问答的掌握程度自评，3 分及以上算达标">自评达标率 · {totals.selfAttempts ?? 0} 次</small>
            </div>
            <div className="dash-total">
              <strong>{totals.due ?? 0}</strong>
              <small>到期待复习</small>
            </div>
          </div>

          {today && (
            <p className="muted dash-today">
              当前队列概览：到期 {today.due ?? 0} · 薄弱 {today.weak ?? 0} · 新题{" "}
              {today.new ?? 0}
              {today.size != null ? ` · 共 ${today.size} 题` : ""}
            </p>
          )}

          <div className="dash-card">
            <div className="eyebrow">作答热力 · 近 182 天</div>
            <div
              className="dash-heat"
              role="img"
              aria-label="近 182 天的每日作答次数热力图"
            >
              {heat.map((d) => (
                <span
                  key={d.date}
                  className={"dash-heat-cell l" + heatLevel(d.count, maxCount)}
                  title={
                    d.count ? `${d.date} · 作答 ${d.count} 次` : `${d.date} · 无作答`
                  }
                />
              ))}
            </div>
            <div className="dash-heat-legend" aria-hidden="true">
              <span>少</span>
              {[0, 1, 2, 3, 4].map((l) => (
                <i key={l} className={"dash-heat-cell l" + l} />
              ))}
              <span>多</span>
            </div>
          </div>

          <div className="dash-card">
            <div className="eyebrow">每日平均分 · 客观判分与自评分别统计</div>
            {trend.length ? (
              <>
                <Trend trend={trend} />
                <div className="dash-trend-legend"><span><i />客观判分</span><span><i className="self" />自评</span></div>
              </>
            ) : (
              <p className="muted">
                完成第一次学习后，这里会出现趋势线。
              </p>
            )}
          </div>

          <div className="dash-card">
            <div className="eyebrow">
              当前薄弱主题{weak.length ? ` · 前 ${weak.length}` : ""}
            </div>
            {weak.length ? (
              <ul className="dash-weak">
                {weak.map((w) => (
                  <li key={w.deckId + ":" + w.topic} className="dash-weak-row">
                    <span className="dash-weak-name">
                      <strong>{w.topic || "未分类"}</strong>
                      <small>{w.deckTitle}</small>
                    </span>
                    <span className="dash-weak-meta">
                      当前薄弱 {w.wrong} 题
                    </span>
                    <button
                      onClick={() =>
                        onStartScope([
                          w.topic ? { deckId: w.deckId, topic: w.topic } : { deckId: w.deckId },
                        ])
                      }
                    >
                      练这个主题
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="muted">{totals.attempts
                ? "最近没有明显薄弱的主题，继续保持。"
                : "开始练习后，这里会显示需要补强的主题。"}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
