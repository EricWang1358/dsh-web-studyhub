import React, { useCallback, useEffect, useMemo, useState } from "react";
import css from "./views.css";

/* 学习统计仪表盘（v0.4 契约 §2）。所有统计来自 call("stats")；data prop 只
   用于展示当前到期概览（data.today）。热力图为 26 列 × 7 行 = 182 天的
   CSS grid，趋势线为 SVG polyline。样式在 ui/views.css，注入方式与
   Exam / WrongBook 相同：<style data-study-views> 按标记去重注入一次。 */

function useInjectViewsCss() {
  useEffect(() => {
    if (document.querySelector("style[data-study-views]")) return;
    const el = document.createElement("style");
    el.setAttribute("data-study-views", "");
    el.textContent = css;
    document.head.appendChild(el);
  }, []);
}

/* 0 = 无作答；其余按 count 占峰值比例分 4 档强度（共 5 档）。 */
function heatLevel(count, max) {
  if (!count) return 0;
  return Math.min(4, 1 + Math.floor(((count - 1) / Math.max(1, max)) * 4));
}

/* 每日平均分趋势：横轴为有作答的日子，纵轴 0–5 分，附整分网格线。 */
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
  const points = trend
    .map((d, i) => `${x(i).toFixed(1)},${y(d.avg).toFixed(1)}`)
    .join(" ");
  return (
    <svg
      className="dash-trend"
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label="每日平均分趋势（0 到 5 分）"
    >
      {[0, 1, 2, 3, 4, 5].map((s) => (
        <g key={s}>
          <line className="dash-trend-grid" x1={L} x2={W - R} y1={y(s)} y2={y(s)} />
          <text className="dash-trend-label" x={L - 6} y={y(s) + 3} textAnchor="end">
            {s}
          </text>
        </g>
      ))}
      {n > 1 && <polyline className="dash-trend-line" points={points} />}
      {trend.map((d, i) => (
        <circle key={d.date} className="dash-trend-dot" cx={x(i)} cy={y(d.avg)} r={3}>
          <title>{`${d.date} · 平均 ${d.avg} 分 · 作答 ${d.count} 次`}</title>
        </circle>
      ))}
    </svg>
  );
}

export default function Dashboard({ call, data, onStartScope }) {
  useInjectViewsCss();
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
  const maxCount = useMemo(
    () => heat.reduce((m, d) => Math.max(m, d.count || 0), 0),
    [heat],
  );
  const today = data?.today;

  return (
    <section className="dash">
      <div className="section-heading">
        <h2>
          学习统计 {stats && <span>{totals.attempts ?? 0}</span>}
        </h2>
        <div className="section-heading-actions">
          <button onClick={load} disabled={loading}>
            {loading ? "统计中…" : "刷新"}
          </button>
        </div>
      </div>

      {err && <p className="dash-error">{err}</p>}
      {loading && !stats && <p className="muted">正在统计学习记录…</p>}

      {stats && (
        <>
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
              <strong>{totals.correctRate ?? 0}%</strong>
              <small>正确率</small>
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
            <div className="eyebrow">每日平均分 · 0–5</div>
            {trend.length ? (
              <Trend trend={trend} />
            ) : (
              <p className="muted">
                还没有作答记录，完成第一次学习后这里会出现趋势线。
              </p>
            )}
          </div>

          <div className="dash-card">
            <div className="eyebrow">
              薄弱主题{weak.length ? ` · 前 ${weak.length}` : ""}
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
                      错 {w.wrong} / 答 {w.attempts}
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
              <p className="muted">最近没有明显薄弱的主题，继续保持。</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
