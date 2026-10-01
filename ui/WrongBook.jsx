import { ui, uiFormat } from "./i18n.js";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import css from "./views.css";
import { useInjectCss, plainPrompt } from "./shared.js";
import EmptyStudyActions from "./EmptyStudyActions.jsx";
import PageScope, { decksInCourse, usePageScope } from './PageScope.jsx';

const PAGE_SIZE = 100;

/* 跨题库待巩固题。数据来自 call("wrongbook")，按题组分组
   展示；客观答错与自评未掌握分开标记，练习都通过 onPractice(scope) 交给主会话，
   由它用 review.start {mode:"path", scope} 开一轮练习。样式与 Dashboard /
   Exam 共用 ui/views.css，注入 <style data-study-views> 按标记去重。 */

export default function WrongBook({ call, data, busy, onPractice, onLibrary, onCreate, onSources }) {
  useInjectCss(css, "study-views");
  const [course, setCourse] = usePageScope(data?.root, 'wrongbook', data?.focus?.course ?? '*');
  const [page, setPage] = useState(0);
  const [result, setResult] = useState(null),
    [loading, setLoading] = useState(true),
    [err, setErr] = useState("");
  const seq = useRef(0);
  const current = result?.course === course ? result : null;
  const items = current?.items;
  const counts = current?.counts || { total: 0, graded: 0, self: 0, oral: 0 };
  const localDecks = decksInCourse(data, course);

  const load = useCallback(async (requestedPage = 0) => {
    const request = ++seq.current;
    setLoading(true);
    setErr("");
    try {
      let targetPage = requestedPage;
      let res = await call("wrongbook", { course, offset: targetPage * PAGE_SIZE, limit: PAGE_SIZE });
      if (targetPage > 0 && !res?.items?.length) {
        targetPage = Math.max(0, Math.ceil((res?.total || 0) / PAGE_SIZE) - 1);
        res = await call("wrongbook", { course, offset: targetPage * PAGE_SIZE, limit: PAGE_SIZE });
      }
      if (request !== seq.current) return;
      setResult({ course, counts: { total: res?.total ?? res?.items?.length ?? 0,
        graded: res?.gradedTotal ?? res?.items?.filter((item) => item.assessment === "graded").length ?? 0,
        self: res?.selfTotal ?? res?.items?.filter((item) => item.assessment === "self").length ?? 0,
        oral: res?.oralTotal ?? 0 },
      // Keep this guard for older service versions that still return suspended cards.
        items: (res?.items || []).filter((it) => it && it.deckId && it.cardId && !it.suspended) });
      setPage(targetPage);
    } catch (e) {
      if (request === seq.current) setErr(e.message || String(e));
    } finally {
      if (request === seq.current) setLoading(false);
    }
  }, [call, course]);
  useEffect(() => {
    load(0);
  }, [load]);

  /* 服务端已按 lastAt 降序；这里只做按题组的稳定分组，保持组内顺序。 */
  const groups = useMemo(() => {
    const map = new Map();
    for (const it of items || []) {
      if (!map.has(it.deckId))
        map.set(it.deckId, {
          deckId: it.deckId,
          deckTitle: it.deckTitle || it.deckId,
          rows: [],
        });
      map.get(it.deckId).rows.push(it);
    }
    return [...map.values()];
  }, [items]);
  const total = items?.length || 0;
  const hasMore = counts.total > PAGE_SIZE;

  return (
    <section className="page wb">
      <div className="page-heading">
        <div>
          <h1>{ui("错题与待巩固")}</h1>
          <PageScope courses={data?.focus?.courses} value={course} onChange={setCourse} />
          <p className="muted">
            {counts.total ? uiFormat('客观答错 {0} 题 · 自评未掌握 {1} 题 · 口头评估待巩固 {2} 题。', [counts.graded, counts.self, counts.oral]) : ui('客观答错、自评未掌握或口头评估待巩固的题会收在这里。')}
          </p>
        </div>
        <div className="section-heading-actions">
          <button onClick={() => load(page)} disabled={busy || loading}>{ui("刷新")}</button>
          <button
            className="primary"
            disabled={busy || loading || !total}
            title={hasMore ? ui("把本页的待巩固题按学习路径重新练一遍") : ui("把这些待巩固题按学习路径重新练一遍")}
            onClick={() =>
              onPractice(items.map((i) => ({ deckId: i.deckId, cardId: i.cardId })))
            }
          >
            {hasMore ? ui("重练本页") : ui("重练全部")} ({total})
          </button>
        </div>
      </div>

      {err && <p className="wb-error">{items ? uiFormat("读取失败，仍显示上次结果：{0}", [err]) : err}</p>}
      {loading && !items && <p className="muted">{ui("正在读取待巩固题…")}</p>}

      {items && !counts.total && (
        <div className="empty wb-empty">
          <span className="empty-icon">✓</span>
          <h2>{data?.attempts?.length ? ui("目前没有待巩固的题") : ui("还没有练习记录")}</h2>
          <p className="muted">{data?.attempts?.length
            ? ui("客观答错或自评未掌握的题会出现在这里，方便集中重练。")
            : ui("完成一次学习后，答错或自评未掌握的题会收在这里。")}</p>
          <EmptyStudyActions data={{ ...data, decks: localDecks }} busy={busy} onStart={() => onPractice(localDecks.map(deck => ({ deckId: deck.id })))} onLibrary={onLibrary}
            onCreate={onCreate} onSources={onSources} />
        </div>
      )}

      {groups.map((g) => (
        <div key={g.deckId} className="wb-group">
          <div className="wb-group-head">
            <strong>{g.deckTitle}</strong>
            <small className="muted">{g.rows.length}{ui(" 题")}</small>
          </div>
          <ul className="wb-rows">
            {g.rows.map((it) => (
              <li key={it.cardId} className="wb-row">
                <span className="wb-topic" title={it.topic || ui("未分类")}>
                  {it.topic || ui("未分类")}
                </span>
                <span className="wb-prompt" title={plainPrompt(it.prompt)}>
                  {plainPrompt(it.prompt)}
                </span>
                <span className={"wb-grade" + (it.assessment === "graded" ? "" : " self")}
                  title={it.assessment === 'oral' ? ui('最近一次口头 AI 评估：需要巩固') : uiFormat("最近一次{0} {1} 分", [ui(it.assessment === "graded" ? "客观判分" : "自评"), it.lastGrade])}>
                  {it.assessment === 'oral' ? ui('口头评估') : it.assessment === "graded" ? ui("答错") : ui("未掌握")}
                </span>
                <button
                  disabled={busy}
                  aria-label={uiFormat("练习 {0}：{1}", [it.topic || "未分类", it.prompt])}
                  onClick={() => onPractice([{ deckId: it.deckId, cardId: it.cardId }])}
                >{ui("练")}</button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {items && hasMore && <nav className="wb-pages" aria-label={ui("待巩固题分页")}>
        <span>{ui("第 ")}{page * PAGE_SIZE + 1}–{page * PAGE_SIZE + total}{ui(" 题 / 共 ")}{counts.total}{ui(" 题")}</span>
        <button type="button" disabled={busy || loading || page === 0} onClick={() => load(page - 1)}>{ui("上一页")}</button>
        <button type="button" disabled={busy || loading || (page + 1) * PAGE_SIZE >= counts.total}
          onClick={() => load(page + 1)}>{ui("下一页")}</button>
      </nav>}
    </section>
  );
}
