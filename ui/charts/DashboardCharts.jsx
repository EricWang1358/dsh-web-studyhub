import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, uiLabels } from '../i18n.js';
import { formatDateTime } from '../format.js';
import { Button, Icon, IconButton, NumberInput, Panel, ProgressBar, SegmentedControl, Tooltip } from '../components/index.js';
import { dateLabel, evenTicks, fillTrend, linePath, linearScale, niceTicks } from './chart-math.js';
import { MEASURES, THIN_DATA } from '../mastery-terms.js';
import { CARD_KIND_LIST } from '../../lib/card-kinds.js';
import { ACTUAL_MINUTES_MAX, summarizeFocusDuration } from '../../lib/board-model.js';

/* The dashboard's three charts, all plain inline SVG / CSS (no chart library):
   a wide score trend, a 14-day due forecast and mastery bars. Each draws at
   its real pixel width (ResizeObserver) so axis text stays at 12px+ instead of
   shrinking with a scaled viewBox, and each has its own empty state, an
   accessible title/description and a visually hidden data table. */

const NARROW = 520;
const SCORE_MAX = 5;

/** Measured width of the box the chart sits in; a sensible fallback before layout and in SSR. */
function useChartWidth(fallback = 640) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const measure = () => {
      const next = Math.floor(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Floating tooltip over the chart: the shared tooltip surface, laid out over the point it belongs to (components/overlays.css);
    aria-hidden because the same facts are in the aria-labels and the data table. */
function Tip({ tip, width }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 78), Math.max(78, width - 78));
  return (
    <div className={`sh-popover sh-tooltip sh-tooltip--point${tip.y < 64 ? ' is-below' : ''}`} aria-hidden="true" style={{ left, top: tip.y }}>
      <strong>{tip.title}</strong>
      {tip.lines.map((line, i) => <span key={i}>{line}</span>)}
    </div>
  );
}

function Empty({ title, children }) {
  return (
    <div className="dash-chart-empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

/* ── Trend ───────────────────────────────────────────────────────────── */

const RANGES = [30, 90];

export function TrendPanel({ trend = [], today }) {
  const [range, setRange] = useState(30);
  const [boxRef, width] = useChartWidth();
  const [active, setActive] = useState(null);
  const rows = fillTrend(trend, today, range);
  const studied = rows.filter((r) => r.gradedAvg != null || r.selfAvg != null);
  const narrow = width < NARROW;
  const height = narrow ? 180 : 220;
  const L = 34, R = 12, T = 14, B = 28;
  const x = linearScale([0, Math.max(1, rows.length - 1)], [L, width - R]);
  const y = linearScale([0, SCORE_MAX], [height - B, T]);
  const series = (key) => rows.map((r, i) => ({ x: x(i), y: r[`${key}Avg`] == null ? null : y(r[`${key}Avg`]) }));
  const graded = series('graded'), self = series('self');
  const ticks = evenTicks(rows.length, narrow ? 4 : 6);

  const show = (i) => setActive(i);
  const tip = active == null ? null : (() => {
    const r = rows[active];
    const lines = [];
    if (r.gradedAvg != null) lines.push(uiFormat('客观判分 平均 {0} 分 · {1} 次', [r.gradedAvg, r.gradedCount]));
    if (r.selfAvg != null) lines.push(uiFormat('自评 平均 {0} 分 · {1} 次', [r.selfAvg, r.selfCount]));
    const top = Math.min(...[r.gradedAvg, r.selfAvg].filter((v) => v != null).map((v) => y(v)));
    return lines.length ? { x: x(active), y: top - 8, title: r.date, lines } : null;
  })();

  const point = (kind, r, i, yy) => {
    const value = kind === 'graded' ? r.gradedAvg : r.selfAvg;
    const count = kind === 'graded' ? r.gradedCount : r.selfCount;
    const name = kind === 'graded' ? ui('客观判分') : ui('自评');
    return (
      <circle key={`${kind}${r.date}`} className={`dash-point ${kind}`} cx={x(i)} cy={yy} r={4.5} tabIndex={0}
        aria-label={uiFormat('{0} · {1} 平均 {2} 分 · {3} 次', [r.date, name, value, count])}
        onMouseEnter={() => show(i)} onFocus={() => show(i)} onBlur={() => setActive(null)} />
    );
  };

  return (
    <Panel className="dash-chart dash-trend-panel" headClassName="dash-chart__head" title={ui('每日平均分')}
      description={ui('0–5 分，只画有作答的日子；没作答的日子不连线')}
      actions={<SegmentedControl size="sm" label={ui('时间范围')} value={range} onChange={(v) => { setRange(v); setActive(null); }}
        options={RANGES.map((n) => ({ value: n, label: uiFormat('近 {0} 天', [n]) }))} />}>
      <ul className="dash-legend">
        <li><i className="dash-swatch graded" />{ui('客观判分')}</li>
        <li><i className="dash-swatch self" />{ui('自评')}</li>
      </ul>
      <div className="dash-chart-box" ref={boxRef}>
        {studied.length ? (
          <div className="dash-plot">
            <svg className="dash-svg" role="img" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
              aria-labelledby="dash-trend-title dash-trend-desc" onMouseLeave={() => setActive(null)}>
              <title id="dash-trend-title">{ui('每日平均分趋势')}</title>
              <desc id="dash-trend-desc">{ui('客观判分与自评的每日平均分趋势（0 到 5 分）')}</desc>
              {[0, 1, 2, 3, 4, 5].map((s) => (
                <g key={s}>
                  <line className="dash-grid" x1={L} x2={width - R} y1={y(s)} y2={y(s)} />
                  <text className="dash-axis" x={L - 8} y={y(s) + 4} textAnchor="end">{s}</text>
                </g>
              ))}
              {ticks.map((i, k) => (
                <text key={rows[i].date} className="dash-axis" x={x(i)} y={height - 8}
                  textAnchor={k === 0 ? 'start' : k === ticks.length - 1 ? 'end' : 'middle'}>{dateLabel(rows[i].date)}</text>
              ))}
              {active != null && <line className="dash-guide" x1={x(active)} x2={x(active)} y1={T} y2={height - B} />}
              <path className="dash-line graded" d={linePath(graded)} />
              <path className="dash-line self" d={linePath(self)} />
              {rows.map((r, i) => (r.gradedAvg != null || r.selfAvg != null) && (
                <rect key={r.date} className="dash-hit" x={x(i) - Math.max(6, (width - L - R) / rows.length / 2)} y={T}
                  width={Math.max(12, (width - L - R) / rows.length)} height={height - B - T} onMouseEnter={() => show(i)} />
              ))}
              {rows.map((r, i) => r.gradedAvg != null && point('graded', r, i, graded[i].y))}
              {rows.map((r, i) => r.selfAvg != null && point('self', r, i, self[i].y))}
            </svg>
            <Tip tip={tip} width={width} />
          </div>
        ) : trend.length ? (
          <Empty title={uiFormat('近 {0} 天没有作答记录', [range])}>{ui('试试更长的时间范围。')}</Empty>
        ) : (
          <Empty title={ui('完成第一次学习后，这里会出现每日平均分的趋势线。')} />
        )}
      </div>
      {studied.length > 0 && (
        <table className="sh-visually-hidden">
          <caption>{ui('每日平均分（客观判分与自评）')}</caption>
          <tbody>
            <tr><th scope="col">{ui('日期')}</th><th scope="col">{ui('客观判分')}</th><th scope="col">{ui('次数')}</th><th scope="col">{ui('自评')}</th><th scope="col">{ui('次数')}</th></tr>
            {studied.map((r) => (
              <tr key={r.date}><th scope="row">{r.date}</th><td>{r.gradedAvg ?? '—'}</td><td>{r.gradedCount}</td><td>{r.selfAvg ?? '—'}</td><td>{r.selfCount}</td></tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/* ── Due forecast ────────────────────────────────────────────────────── */

export function ForecastPanel({ forecast, onStart, parked }) {
  const [boxRef, width] = useChartWidth();
  // What the card counts: the active courses; what sits in parked ones (lib/course-active.js) is named, never silently dropped.
  const parkedCount = forecast?.hidden?.count || 0;
  const scopeNote = parkedCount ? uiFormat('仅有效课程 · 另有 {0} 题在未激活的课程里', [parkedCount]) : parked?.included ? ui('含未激活的课程') : '';
  const [active, setActive] = useState(null);
  const days = forecast?.days || [];
  const total = days.reduce((n, d) => n + d.count, 0);
  const later = forecast?.later || 0;
  const narrow = width < NARROW;
  const height = narrow ? 180 : 220;
  const L = 34, R = 8, T = 22, B = 28;
  const max = days.reduce((m, d) => Math.max(m, d.count), 0);
  const ticks = niceTicks(max, 4);
  const y = linearScale([0, ticks.at(-1)], [height - B, T]);
  const band = (width - L - R) / Math.max(1, days.length);
  const barW = Math.max(6, Math.min(36, band * 0.62));
  const labelAt = new Set(narrow ? evenTicks(days.length, 5) : days.map((_, i) => i));
  const today = days[0];
  const dayName = (d, i) => (i === 0 ? ui('今天') : dateLabel(d.date));
  const summary = (d, i) => (i === 0 ? uiFormat('今天（含逾期） · {0} 题', [d.count]) : uiFormat('{0} · {1} 题', [dateLabel(d.date), d.count]));
  const start = (d) => { if (onStart && d.cards?.length) onStart(d.cards); };

  const tip = active == null ? null : (() => {
    const d = days[active];
    const lines = [];
    if (active === 0 && d.overdue) lines.push(uiFormat('其中逾期 {0} 题', [d.overdue]));
    if (onStart && d.count) lines.push(active === 0 ? ui('点击开始复习') : ui('点击提前复习'));
    if (d.truncated) lines.push(uiFormat('一次最多开始 {0} 题', [d.cards.length]));
    return { x: L + band * (active + 0.5), y: y(d.count) - 6, title: summary(d, active), lines };
  })();

  return (
    <Panel className="dash-chart dash-forecast-panel" headClassName="dash-chart__head" title={ui('未来 14 天到期复习')}
      description={ui('按间隔重复排好的复习日，逾期的并入今天')}>
      <div className="dash-chart-box" ref={boxRef}>
        {total ? (
          <>
            <p className="dash-chart-summary">
              <span>{uiFormat('今天（含逾期）{0} 题', [today?.count || 0])}</span>
              <span>{uiFormat('未来 14 天共 {0} 题', [total])}</span>
              {later > 0 && <span>{uiFormat('更远的 {0} 题在 14 天之后', [later])}</span>}
            </p>
            <div className="dash-plot">
            <svg className="dash-svg" role="img" viewBox={`0 0 ${width} ${height}`} width={width} height={height}
              aria-labelledby="dash-forecast-title" onMouseLeave={() => setActive(null)}>
              <title id="dash-forecast-title">{uiFormat('未来 14 天每天到期的复习题数，共 {0} 题', [total])}</title>
              {ticks.map((t) => (
                <g key={t}>
                  <line className="dash-grid" x1={L} x2={width - R} y1={y(t)} y2={y(t)} />
                  <text className="dash-axis" x={L - 8} y={y(t) + 4} textAnchor="end">{t}</text>
                </g>
              ))}
              {days.map((d, i) => {
                const cx = L + band * (i + 0.5);
                const action = onStart && d.count > 0;
                const label = uiFormat('{0} · {1} 题', [i === 0 ? ui('今天（含逾期）') : dateLabel(d.date), d.count]);
                return (
                  <g key={d.date} className={`dash-bar${i === 0 ? ' today' : ''}${d.count ? '' : ' zero'}`}
                    {...(action ? { role: 'button', tabIndex: 0, 'aria-label': `${label} · ${i === 0 ? ui('开始复习') : ui('提前复习')}` } : {})}
                    onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)}
                    onClick={action ? () => start(d) : undefined}
                    onKeyDown={action ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); start(d); } } : undefined}>
                    <rect className="dash-bar-hit" x={cx - band / 2} y={T} width={band} height={height - B - T} />
                    <rect className="dash-bar-fill" x={cx - barW / 2} y={d.count ? y(d.count) : height - B - 2} width={barW}
                      height={d.count ? height - B - y(d.count) : 2} rx={3} />
                    {d.count > 0 && <text className="dash-bar-value" x={cx} y={y(d.count) - 6} textAnchor="middle">{d.count}</text>}
                  </g>
                );
              })}
              {days.map((d, i) => labelAt.has(i) && (
                <text key={`l${d.date}`} className={`dash-axis${i === 0 ? ' today' : ''}`} x={L + band * (i + 0.5)} y={height - 8} textAnchor="middle">{dayName(d, i)}</text>
              ))}
            </svg>
            <Tip tip={tip} width={width} />
            </div>
          </>
        ) : (
          <Empty title={ui('未来 14 天没有到期的复习')}>
            {later > 0
              ? uiFormat('更远的 {0} 题在 14 天之后到期。', [later])
              : ui('练习之后，系统会按记忆曲线排好复习日。')}
          </Empty>
        )}
      </div>
      {scopeNote && <p className="dash-scope-note">{scopeNote}
        {parkedCount > 0 && parked?.onManage && <> <Button variant="link" size="sm" onClick={parked.onManage}>{ui('管理课程')}</Button></>}</p>}
      {total > 0 && (
        <table className="sh-visually-hidden">
          <caption>{ui('未来 14 天到期复习')}</caption>
          <tbody>
            <tr><th scope="col">{ui('日期')}</th><th scope="col">{ui('题数')}</th></tr>
            {days.map((d, i) => <tr key={d.date}><th scope="row">{i === 0 ? `${d.date} ${ui('今天（含逾期）')}` : d.date}</th><td>{d.count}</td></tr>)}
          </tbody>
        </table>
      )}
    </Panel>
  );
}

/* ── Mastery ─────────────────────────────────────────────────────────── */

const LEVEL_NAME = uiLabels({ recall: '记忆', concept: '概念辨析', apply: '应用分析' });
const KIND_NAME = uiLabels({ ...Object.fromEntries(CARD_KIND_LIST.map((kind) => [kind.id, kind.short])), case: '案例' });
const tone = (rate) => (rate >= 70 ? 'success' : rate >= 50 ? 'warning' : 'error');

export function MasteryPanel({ mastery, defaultView = 'level' }) {
  const [view, setView] = useState(defaultView);
  const windowDays = mastery?.windowDays ?? 30;
  const rows = (view === 'level' ? mastery?.levels : mastery?.kinds) || [];
  const names = view === 'level' ? LEVEL_NAME : KIND_NAME;
  const answered = rows.reduce((n, r) => n + r.n, 0);
  return (
    <Panel className="dash-chart dash-mastery-panel" headClassName="dash-chart__head" title={ui(MEASURES.passRate.label)}
      description={uiFormat('近 {0} 天作答，3 分及以上算达标', [windowDays])}
      actions={<SegmentedControl size="sm" label={ui('统计维度')} value={view} onChange={setView}
        options={[{ value: 'level', label: ui('按认知层次') }, { value: 'kind', label: ui('按题型') }]} />}>
      {answered ? (
        <ul className="dash-mastery">
          {rows.map((r) => (
            <li key={r.id} className={`dash-mrow${r.enough ? '' : ' thin'}`}>
              <span className="dash-mname">{names[r.id]}</span>
              {r.enough
                ? <ProgressBar className="dash-mbar" tone={tone(r.rate)} label={uiFormat('{0}：{1}%', [names[r.id], r.rate])} value={r.rate} />
                : <span className="dash-mbar dash-mbar--empty" aria-hidden="true" />}
              <span className="dash-mvalue">
                {r.enough ? <b>{r.rate}%</b> : <em>{ui(THIN_DATA)}</em>}
                <small>{uiFormat('{0} 次作答', [r.n])}</small>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <div className="dash-chart-box">
          <Empty title={uiFormat('近 {0} 天还没有足够的作答', [windowDays])}>{ui('多做几道题，这里会显示各层次的达标率。')}</Empty>
        </div>
      )}
    </Panel>
  );
}

/* ── Focus duration (#859) ───────────────────────────────────────────── */

export function FocusDurationPanel({
  board, today, timeZone, nowMs, readOnly = false, onEditLog, onRemoveLog, onOpenToday,
}) {
  const [boxRef, width] = useChartWidth(440);
  const [active, setActive] = useState(null);
  const [editingId, setEditingId] = useState('');
  const [editingMinutes, setEditingMinutes] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);

  const summary = useMemo(
    () => summarizeFocusDuration(board, { now: nowMs, today, timeZone, windowDays: 7 }),
    [board, nowMs, today, timeZone],
  );
  const days = summary.days;
  const narrow = width < NARROW;
  const height = narrow ? 168 : 196;
  const L = 34, R = 8, T = 22, B = 28;
  const max = days.reduce((m, d) => Math.max(m, d.minutes), 0);
  const ticks = niceTicks(max, 4);
  const y = linearScale([0, ticks.at(-1)], [height - B, T]);
  const band = (width - L - R) / Math.max(1, days.length);
  const barW = Math.max(8, Math.min(36, band * 0.56));
  const lastIndex = days.length - 1;

  const dayTitle = (d, i) => (i === lastIndex
    ? uiFormat('今天 · {0} 分钟', [d.minutes])
    : uiFormat('{0} · {1} 分钟', [dateLabel(d.date), d.minutes]));
  const sessionCountText = (count) => {
    if (!count) return ui('无专注记录');
    return count === 1 ? ui('1 段专注记录') : uiFormat('{0} 段专注记录', [count]);
  };

  const tip = active == null || !days[active] ? null : (() => {
    const d = days[active];
    return {
      x: L + band * (active + 0.5),
      y: (d.minutes ? y(d.minutes) : height - B - 2) - 6,
      title: dayTitle(d, active),
      lines: [sessionCountText(d.sessions)],
    };
  })();

  const parsedEditMinutes = Number(editingMinutes);
  const validEditMinutes = Number.isInteger(parsedEditMinutes) && parsedEditMinutes >= 1 && parsedEditMinutes <= ACTUAL_MINUTES_MAX;

  const startEdit = (entry) => {
    setEditingId(entry.id);
    setEditingMinutes(String(entry.minutes));
  };

  const submitEdit = async (event, entry) => {
    event.preventDefault();
    if (readOnly || savingEdit || !validEditMinutes || !onEditLog) return;
    if (parsedEditMinutes === entry.minutes) {
      setEditingId('');
      return;
    }
    setSavingEdit(true);
    try {
      const ok = await onEditLog(entry, parsedEditMinutes);
      if (ok !== false) setEditingId('');
    } finally {
      setSavingEdit(false);
    }
  };

  const titleNode = (
    <span className="dash-focus__title-row">
      <span>{ui('专注时长')}</span>
      <Tooltip
        layer
        content={ui('只计算手动点击「开始专注」或「补记一段」的时长；数据仅保存在本机，不会上传。')}
      >
        <span className="dash-focus__help" tabIndex={0} role="img" aria-label={ui('专注时长说明')}>
          <Icon name="help" size={14} />
        </span>
      </Tooltip>
    </span>
  );

  const actionsNode = onOpenToday ? (
    <Button variant="quiet" size="sm" iconEnd="arrow-right" onClick={onOpenToday}>
      {ui('去今日')}
    </Button>
  ) : undefined;

  if (!summary.hasData) {
    return (
      <Panel className="dash-chart dash-focus-panel is-empty" headClassName="dash-chart__head" title={titleNode} actions={actionsNode}>
        <p className="dash-focus__empty-line">
          {ui('还没有专注记录。在「待办 → 今日」点击卡片上的「开始专注」后会记在这里。')}
        </p>
      </Panel>
    );
  }

  return (
    <Panel className="dash-chart dash-focus-panel" headClassName="dash-chart__head" title={titleNode} actions={actionsNode}>
      <p className="dash-chart-summary">
        <span data-focus-today-total>{uiFormat('今日已专注 {0} 分钟', [summary.todayMinutes])}</span>
        <span data-focus-week-total>{uiFormat('近 7 天共 {0} 分钟', [summary.weekMinutes])}</span>
      </p>
      <div className="dash-focus__grid">
        <div className="dash-chart-box dash-focus__chart" ref={boxRef}>
          <div className="dash-plot">
            <svg
              className="dash-svg"
              role="img"
              viewBox={`0 0 ${width} ${height}`}
              width={width}
              height={height}
              aria-labelledby="dash-focus-title"
              onMouseLeave={() => setActive(null)}
            >
              <title id="dash-focus-title">
                {uiFormat('近 7 天每日专注分钟数，共 {0} 分钟', [summary.weekMinutes])}
              </title>
              {ticks.map((t) => (
                <g key={t}>
                  <line className="dash-grid" x1={L} x2={width - R} y1={y(t)} y2={y(t)} />
                  <text className="dash-axis" x={L - 8} y={y(t) + 4} textAnchor="end">{t}</text>
                </g>
              ))}
              {days.map((d, i) => {
                const cx = L + band * (i + 0.5);
                const isToday = i === lastIndex;
                return (
                  <g
                    key={d.date}
                    className={`dash-bar${isToday ? ' today' : ''}${d.minutes ? '' : ' zero'}`}
                    tabIndex={0}
                    aria-label={`${dayTitle(d, i)} · ${sessionCountText(d.sessions)}`}
                    onMouseEnter={() => setActive(i)}
                    onFocus={() => setActive(i)}
                    onBlur={() => setActive(null)}
                  >
                    <rect className="dash-bar-hit" x={cx - band / 2} y={T} width={band} height={height - B - T} />
                    <rect
                      className="dash-bar-fill"
                      x={cx - barW / 2}
                      y={d.minutes ? y(d.minutes) : height - B - 2}
                      width={barW}
                      height={d.minutes ? height - B - y(d.minutes) : 2}
                      rx={3}
                    />
                    {d.minutes > 0 && (
                      <text className="dash-bar-value" x={cx} y={y(d.minutes) - 6} textAnchor="middle">
                        {d.minutes}
                      </text>
                    )}
                  </g>
                );
              })}
              {days.map((d, i) => {
                const isToday = i === lastIndex;
                return (
                  <text
                    key={`l${d.date}`}
                    className={`dash-axis${isToday ? ' today' : ''}`}
                    x={L + band * (i + 0.5)}
                    y={height - 8}
                    textAnchor="middle"
                  >
                    {isToday ? ui('今天') : dateLabel(d.date)}
                  </text>
                );
              })}
            </svg>
            <Tip tip={tip} width={width} />
          </div>
          <table className="sh-visually-hidden">
            <caption>{ui('专注时长')}</caption>
            <tbody>
              <tr>
                <th scope="col">{ui('日期')}</th>
                <th scope="col">{ui('专注分钟')}</th>
                <th scope="col">{ui('段数')}</th>
              </tr>
              {days.map((d, i) => (
                <tr key={d.date}>
                  <th scope="row">{i === lastIndex ? `${d.date} ${ui('今天')}` : d.date}</th>
                  <td>{d.minutes}</td>
                  <td>{d.sessions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="dash-focus__records">
          <h4 className="dash-focus__subhead">{ui('今日专注记录')}</h4>
          {summary.todayEntries.length > 0 ? (
            <ul className="dash-focus__logs" aria-label={ui('今日专注记录')}>
              {[...summary.todayEntries].reverse().map((entry) => {
                const timeText = entry.startedAt ? formatDateTime(entry.startedAt, 'time') : '';
                const isEditing = editingId === entry.id;
                return (
                  <li key={entry.id} className="dash-focus__log" data-focus-log-id={entry.id}>
                    {isEditing ? (
                      <form className="dash-focus__log-edit" onSubmit={(e) => submitEdit(e, entry)}>
                        <span className="dash-focus__log-title">{entry.cardTitle}</span>
                        <div className="dash-focus__log-edit-row">
                          <NumberInput
                            min={1}
                            max={ACTUAL_MINUTES_MAX}
                            step={1}
                            suffix={ui('分钟')}
                            aria-label={uiFormat('修改时长：{0}', [entry.cardTitle])}
                            value={editingMinutes}
                            onChange={(e) => setEditingMinutes(e.target.value)}
                          />
                          <Button type="submit" variant="primary" size="sm" busy={savingEdit} disabled={readOnly || savingEdit || !validEditMinutes}>
                            {ui('保存')}
                          </Button>
                          <Button variant="quiet" size="sm" onClick={() => setEditingId('')}>
                            {ui('取消')}
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <>
                        <div className="dash-focus__log-main">
                          {timeText && <span className="dash-focus__log-time">{timeText}</span>}
                          <span className="dash-focus__log-title">{entry.cardTitle}</span>
                        </div>
                        <div className="dash-focus__log-side">
                          <span className="dash-focus__log-mins">{uiFormat('{0} 分钟', [entry.minutes])}</span>
                          {!readOnly && onEditLog && (
                            <IconButton
                              icon={<Icon name="edit" size={14} />}
                              size="sm"
                              label={uiFormat('修改时长：{0}', [entry.cardTitle])}
                              onClick={() => startEdit(entry)}
                            />
                          )}
                          {!readOnly && onRemoveLog && (
                            <IconButton
                              icon={<Icon name="trash" size={14} />}
                              size="sm"
                              label={uiFormat('删除记录：{0}', [entry.cardTitle])}
                              onClick={() => onRemoveLog(entry)}
                            />
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="dash-focus__none">{ui('今天还没有专注记录。')}</p>
          )}
        </div>
      </div>
    </Panel>
  );
}

