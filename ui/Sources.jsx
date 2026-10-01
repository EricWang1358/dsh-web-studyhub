import { ui, uiFormat } from "./i18n.js";
import React, { useMemo, useState } from "react";
import Icon from "./Icon.jsx";
import { AudioJobs } from "./AudioImport.jsx";
import CourseField, { parseCourses } from './CourseField.jsx';
import PageScope, { usePageScope } from './PageScope.jsx';
import { sourceMatchesCourse } from '../lib/source-courses.js';

/* 资料视图：sourceForm（添加资料的表单 JSX，定义在 App，与弹窗共用）
   通过 prop 传入。删除走 source.remove，内容查看交给 source 弹窗。
   资料按创建日期（本地时区）分组，新的在前，各组默认收起；没有日期的旧资料
   由服务端按引用它的题组推断（createdAtInferred），仍无从推断的归入「日期未知」。 */

const UNKNOWN = "unknown";
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/* Attachment imports can be titled with their absolute path; the list shows
   the file name and keeps the full path in the tooltip. */
const displayTitle = (title) =>
  /^(?:[A-Za-z]:[\\/]|\\\\|\/)/.test(String(title))
    ? String(title).replace(/^.*[\\/]/, "")
    : title;

function dayLabel(key) {
  if (key === UNKNOWN) return ui("日期未知");
  const today = new Date(),
    yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (key === dayKey(today)) return ui("今天");
  if (key === dayKey(yesterday)) return ui("昨天");
  const [y, m, d] = key.split("-").map(Number),
    date = new Date(y, m - 1, d);
  return uiFormat("{0}{1} 月 {2} 日 · {3}", [y === today.getFullYear() ? "" : `${y} 年 `, m, d, WEEKDAYS[date.getDay()]]);
}

function groupByDay(sources) {
  const groups = new Map();
  for (const s of sources) {
    const t = Date.parse(s.createdAt);
    const key = Number.isFinite(t) ? dayKey(new Date(t)) : UNKNOWN;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }
  const titleOrder = (a, b) =>
    String(a.title).localeCompare(String(b.title), "zh-CN", { numeric: true });
  return [...groups.entries()]
    .sort(([a], [b]) => (a === UNKNOWN ? 1 : b === UNKNOWN ? -1 : b.localeCompare(a)))
    .map(([key, rows]) => ({
      key,
      // Newest first within a day; one import's pages share a timestamp, so
      // they fall back to natural title order (p.5 before p.10).
      rows: rows.sort(
        (a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")) || titleOrder(a, b),
      ),
      inferred: rows.every((r) => r.createdAtInferred),
      chars: rows.reduce((n, r) => n + r.text.length, 0),
    }));
}

export default function Sources({ data, busy, act, setModal, sourceForm, openAgent, onGenerate, onOpenSources, onLegacyRetry }) {
  const [scope, setScope] = usePageScope(data.root, 'sources', data.focus?.course ?? '*');
  const filtered = useMemo(() => data.sources.filter(source => sourceMatchesCourse(source, scope)), [data.sources, scope]);
  const groups = useMemo(() => groupByDay(filtered), [filtered]);
  const [open, setOpen] = useState(() => new Set());
  const [organizing, setOrganizing] = useState(false), [selected, setSelected] = useState([]);
  const [courseText, setCourseText] = useState(''), [proposals, setProposals] = useState(null);
  const selectedSources = data.sources.filter(source => selected.includes(source.id));
  const finish = () => { setProposals(null); setSelected([]); };
  const toggle = (key) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  const allOpen = groups.length > 0 && groups.every((g) => open.has(g.key));

  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>{ui("资料")}</h1>
          <p className="muted">{ui("题目从这里生长。原文与引用一直保留。")}{data.sources.length > 0 &&
              uiFormat(" 共 {0} 份，按创建日期分为 {1} 组。", [filtered.length, groups.length])}
          </p>
        </div>
        <div className="section-heading-actions">
          {groups.length > 1 && (
            <button
              onClick={() => setOpen(allOpen ? new Set() : new Set(groups.map((g) => g.key)))}
            >
              {allOpen ? ui("全部收起") : ui("全部展开")}
            </button>
          )}
          <button className="primary" onClick={() => setModal({ type: "add", course: scope === '*' ? '' : scope })}>{ui("＋ 添加资料")}</button>
        </div>
      </div>
      {data.sources.length > 0 && <>
        <PageScope value={scope} onChange={setScope} courses={data.focus?.courses} />
        <details className="source-organize" onToggle={event => {
          setOrganizing(event.currentTarget.open);
          if (event.currentTarget.open) setOpen(new Set(groups.map(group => group.key)));
        }}>
          <summary>{ui('整理课程归属')}</summary>
          <p className="muted">{ui('勾选资料后统一整理。只更改归属，原文与引用保持不变。')}</p>
          <p>{uiFormat('已选择 {0} 份资料', [selectedSources.length])}{' '}
            <button type="button" onClick={() => { setSelected(filtered.map(source => source.id)); setProposals(null); }}>{ui('选择当前范围')}</button>{' '}
            {selected.length > 0 && <button type="button" onClick={finish}>{ui('清空选择')}</button>}
          </p>
          <CourseField value={courseText} onChange={setCourseText} courses={data.focus?.courses} multiple disabled={busy} />
          <div className="source-organization-actions">
            <button disabled={busy || !selectedSources.length} onClick={() => act('source.courses.set', {
              assignments: selectedSources.map(source => ({ id: source.id, courses: parseCourses(courseText), expectedCourses: source.courses || [] })),
            }, finish)}>{ui('应用课程归属')}</button>
            <button disabled={busy || !data.modelReady || !selectedSources.length || selectedSources.length > 100}
              onClick={() => act('source.organize.suggest', { sourceIds: selectedSources.map(source => source.id) }, result =>
                setProposals(result.proposals.map(proposal => ({ ...proposal, include: true, courseText: proposal.courses.join('; ') }))))}>{ui('请 AI 建议')}</button>
          </div>
          {proposals && <div className="source-course-proposals">
            <p className="muted">{ui('建议尚未保存，可先修改课程，再确认应用。')}</p>
            {proposals.map(proposal => <div key={proposal.id}>
              <label className="source-proposal-select"><input type="checkbox" checked={proposal.include} disabled={busy}
                onChange={event => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, include: event.target.checked } : item))} />
                {uiFormat('采用建议：{0}', [displayTitle(proposal.title)])}</label>
              <CourseField label={displayTitle(proposal.title)} value={proposal.courseText} multiple courses={data.focus?.courses}
                onChange={courseText => setProposals(current => current.map(item => item.id === proposal.id ? { ...item, courseText } : item))} disabled={busy || !proposal.include} />
              <p className="muted">{proposal.reason}</p>
            </div>)}
            <button disabled={busy || !proposals.some(proposal => proposal.include)} onClick={() => act('source.courses.set', {
              assignments: proposals.filter(proposal => proposal.include).map(proposal => ({ id: proposal.id, courses: parseCourses(proposal.courseText), expectedCourses: proposal.expectedCourses })),
            }, finish)}>{ui('确认应用建议')}</button>
          </div>}
        </details>
        {!filtered.length && <p className="muted">{ui('这个范围还没有资料。可切换到全部课程查看。')}</p>}
      </>}
      <AudioJobs data={data} busy={busy} act={act} openAgent={openAgent} onOpenSources={onOpenSources} onLegacyRetry={onLegacyRetry} />
      {!data.sources.length ? (
        <div className="empty">
          <h2>{ui("还没有资料")}</h2>
          <p>{ui("支持 PDF、Markdown、HTML、TXT 与粘贴文本。")}</p>
          {sourceForm}
        </div>
      ) : (
        groups.map((g) => {
          const expanded = open.has(g.key);
          return (
            <div key={g.key} className={"source-group" + (expanded ? " open" : "")}>
              <button
                className="source-group-head"
                aria-expanded={expanded}
                onClick={() => toggle(g.key)}
              >
                <span className="source-group-caret" aria-hidden="true">
                  ▸
                </span>
                <strong>{dayLabel(g.key)}</strong>
                {g.inferred && (
                  <span
                    className="source-group-tag"
                    title={ui("这些资料保存时没有记录日期，按最早引用它们的题组推断")}
                  >{ui("推断")}</span>
                )}
                <small className="muted">
                  {g.rows.length}{ui(" 份 · ")}{g.chars.toLocaleString()}{ui(" 字符")}</small>
              </button>
              {expanded &&
                g.rows.map((s) => (
                  <article className="source-row" key={s.id}>
                    {organizing && <input type="checkbox" aria-label={uiFormat('选择资料：{0}', [displayTitle(s.title)])}
                      checked={selected.includes(s.id)} onChange={event => {
                        setSelected(current => event.target.checked ? [...current, s.id] : current.filter(id => id !== s.id)); setProposals(null);
                      }} />}
                    <button
                      className="source-main"
                      onClick={() => setModal({ type: "source", source: s })}
                    >
                      <Icon>▤</Icon>
                      <span>
                        <strong title={s.title}>{displayTitle(s.title)}</strong>
                        <small>{s.courses?.join(' · ') || ui('未分类')}{s.coursesInferred ? ui(' · 推断归属') : ''}
                          {s.usedBy?.length ? uiFormat(' · 用于 {0}', [s.usedBy.map(deck => deck.title).join(' · ')]) : ''}</small>
                        <small>
                          {s.text.length.toLocaleString()}{ui(" 字符 ·")}{" "}
                          {s.document?.format && s.document.format !== 'pdf' ? `${s.document.format.toUpperCase()} · ` : s.document ? (s.document.extractionVersion === 2 ? ui("排版提取 v2 · ") : ui("旧版提取，建议重新导入 · ")) : ""}
                          {s.document?.warnings?.length ? ui("排版待核对 · ") : ""}
                          {s.audio ? uiFormat("音频转写 · 校对 {0} 处 · ", [s.audio.corrections?.appliedCount ?? 0]) : ""}
                          {s.text.slice(0, 80)}
                        </small>
                      </span>
                    </button>
                    <details className="source-row-actions"><summary>{ui('更多')}</summary>
                      {onGenerate && <button disabled={busy} onClick={() => onGenerate([s.id])}>{ui('从这份资料补题')}</button>}
                      <button disabled={busy} onClick={() => act('source.remove', { id: s.id })}>{ui('移除')}</button>
                    </details>
                  </article>
                ))}
            </div>
          );
        })
      )}
    </section>
  );
}
