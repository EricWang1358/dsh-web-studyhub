import { ui, uiFormat, uiLocale, getUiLanguage } from "./i18n.js";
import { uiRich } from "./i18n-rich.jsx";
import React, { useEffect, useMemo, useState } from "react";
import Markdown from "./Markdown.jsx";
import SkeletonCanvas from "./SkeletonCanvas.jsx";
import SkeletonSpine from "./SkeletonSpine.jsx";
import css from "./skeleton.css";
import { useInjectCss } from "./shared.js";
import { groupPrompt } from "./topic-group-prompt.js";
import { designSkeletonPrompt, extendSkeletonPrompt } from "./agent-prompts/skeleton.js";
import PageScope, { usePageScope } from './PageScope.jsx';
import { Button, Chip, ConfirmDialog, DisclosureToggle, InlineMessage, PageHeader, Panel, SegmentedControl, foldLabel } from "./components/index.js";
import { courseGroupRows, classifySkeletonError, openSkeleton, focusSurvivesCourse } from "./skeleton-groups.js";

/* 知识骨架页：同一主题常散在多个题组里。左边按主题名跨题组合并列出，
   多选后可以先做零 token 的质量检测，再把整组交给主会话设计骨架、
   修空洞解析、补关联（难度高，走对话里的 agent，不走后台轻量请求）。
   保存的骨架显示在下方，可按节点或整体开一轮练习。 */

const RELATION_LABEL = {
  "part-of": "属于",
  causes: "导致",
  contrasts: "对比",
  prerequisite: "前置",
  "example-of": "例子",
  related: "相关",
};
const pairKey = (deckId, topic) => `${deckId}\u0000${topic}`;
const fromKey = (key) => {
  const [deckId, topic] = key.split("\u0000");
  return { deckId, topic };
};
const ago = (at) => {
  const d = new Date(at);
  return Number.isFinite(d.getTime()) ? d.toLocaleString(uiLocale(), { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
};

function NodeTree({ skeleton, onPractice }) {
  const children = useMemo(() => {
    const map = new Map();
    for (const n of skeleton.nodes) {
      const parent = n.parent && skeleton.nodes.some((x) => x.id === n.parent) ? n.parent : "";
      if (!map.has(parent)) map.set(parent, []);
      map.get(parent).push(n);
    }
    return map;
  }, [skeleton]);
  const render = (parent, depth) =>
    (children.get(parent) || []).map((n) => (
      <li key={n.id} className="sk-node" style={{ "--depth": depth }}>
        <div className="sk-node-body">
          <strong>{n.term}</strong>
          <span className="sk-node-meaning">{n.meaning}</span>
        </div>
        {n.cards.length > 0 && (
          <Button size="sm" className="sk-mini" onClick={() => onPractice(n.cards)} title={ui("练这个节点关联的题")}>{uiFormat("练 {0} 题", [n.cards.length])}</Button>
        )}
        {children.has(n.id) && <ul className="sk-tree">{render(n.id, depth + 1)}</ul>}
      </li>
    ));
  return <ul className="sk-tree sk-root">{render("", 0)}</ul>;
}

export default function Skeleton({ call, data, busy, askInChat, onPractice, focusId, onFocus }) {
  useInjectCss(css, "study-skeleton");
  const [course, setCourse] = usePageScope(data?.root, 'skeleton', data?.focus?.course ?? '*');
  const [saved, setSaved] = useState(null);
  const [topics, setTopics] = useState(null),
    [groupView, setGroupView] = useState(null),
    [byGroup, setByGroup] = useState(true),
    [query, setQuery] = useState(""),
    [picked, setPicked] = useState(() => new Set()),
    [open, setOpen] = useState(() => new Set()),
    [lint, setLint] = useState(null),
    [issueFilter, setIssueFilter] = useState(""),
    [pending, setPending] = useState(""),
    [sent, setSent] = useState(false),
    [viewing, setViewing] = useState(null),
    [confirmDelete, setConfirmDelete] = useState(false),
    [extendText, setExtendText] = useState(""),
    [skView, setSkView] = useState("spine"),
    [error, setError] = useState(""),
    // The skeleton the user had open was deleted or is not in this course: a muted note, never an error.
    [stale, setStale] = useState(false),
    [reload, setReload] = useState(0),
    [loadFailed, setLoadFailed] = useState(false);
  // Any failure that is not "the skeleton is gone" is shown in plain language; a gone skeleton is released quietly.
  const fail = (e) => {
    const result = classifySkeletonError(e);
    if (result.kind === "stale") { setStale(true); onFocus(null); } else setError(result.text);
  };
  const chooseCourse = (next) => {
    setCourse(next);
    setStale(false);
    setError("");
    // The open skeleton stays only when the new course lists it.
    if (focusId) focusSurvivesCourse(call, focusId, next).then((keep) => { if (!keep) onFocus(null); });
  };

  useEffect(() => {
    let live = true;
    setTopics(null);
    setLoadFailed(false);
    Promise.all([call('skeleton.topics', { course }), call('skeleton.list', { course })])
      .then(([r, list]) => {
        if (!live) return;
        setTopics(r.topics);
        setGroupView(r.groups);
        setSaved({ course, skeletons: list.skeletons });
      })
      .catch((e) => {
        if (!live) return;
        setTopics([]);
        setGroupView(null);
        setLoadFailed(true);
        setError(classifySkeletonError(e).text);
      });
    return () => {
      live = false;
    };
  }, [call, course, data?.revision, reload]);
  useEffect(() => { setPicked(new Set()); setLint(null); }, [course]);
  const savedSkeletons = saved?.course === course ? saved.skeletons : [];
  // A directly opened object remains visible even when outside the browsing filter.
  const listedSkeletons = focusId && !savedSkeletons.some(item => item.id === focusId)
    ? [...savedSkeletons, ...(data?.skeletons || []).filter(item => item.id === focusId)] : savedSkeletons;

  // Re-read the open skeleton when the conversation saves a new version.
  const focusVersion = data?.skeletons?.find((k) => k.id === focusId)?.updatedAt;
  useEffect(() => {
    if (!focusId) {
      setViewing(null);
      return;
    }
    let live = true;
    openSkeleton(call, focusId).then((result) => {
      if (!live) return;
      if (result.skeleton) return setViewing(result.skeleton);
      setViewing(null);
      if (result.stale) {
        setStale(true);
        onFocus(null);
      } else setError(result.error.text);
    });
    return () => {
      live = false;
    };
    // onFocus is the page's setter; it must not restart the read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, focusId, focusVersion]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (topics || []).filter((t) => !q || t.topic.toLowerCase().includes(q) || t.decks.some((d) => d.deckTitle.toLowerCase().includes(q)));
  }, [topics, query]);
  // Groups are stored library-wide: only those with members in this course count and show.
  const courseRows = useMemo(() => courseGroupRows({ topics, groupView, query: "", shown: topics || [] }), [topics, groupView]);
  const groups = useMemo(() => courseRows.filter((row) => !row.loose), [courseRows]);
  const grouped = byGroup && groups.length > 0;
  // Group rows: this course's saved groups plus an 未归入 bucket; a search keeps groups
  // whose title matches (all members) or that contain matching topics (those members).
  const groupRows = useMemo(() => courseGroupRows({ topics, groupView, query, shown }), [topics, groupView, query, shown]);
  const scope = useMemo(() => [...picked].map(fromKey), [picked]);
  const pickedTopics = useMemo(() => [...new Set(scope.map((x) => x.topic))], [scope]);
  const pickedCards = useMemo(
    () => (topics || []).reduce((n, t) => n + t.decks.filter((d) => picked.has(pairKey(d.deckId, d.topic))).reduce((m, d) => m + d.count, 0), 0),
    [topics, picked],
  );
  const pickedDecks = new Set(scope.map((x) => x.deckId)).size;

  const toggle = (keys, on) => {
    setStale(false);
    setError("");
    setPicked((prev) => {
      const next = new Set(prev);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      return next;
    });
    setLint(null);
    setSent(false);
  };

  async function runLint() {
    setPending("lint");
    setError("");
    try {
      setLint(await call("skeleton.lint", { scope }));
      setIssueFilter("");
    } catch (e) {
      fail(e);
    } finally {
      setPending("");
    }
  }

  const toggleFold = (key) => setOpen((prev) => {
    const next = new Set(prev);
    next.has(key) ? next.delete(key) : next.add(key);
    return next;
  });

  const renderTopic = (t) => {
    const keys = t.decks.map((d) => pairKey(d.deckId, d.topic));
    const on = keys.filter((k) => picked.has(k)).length;
    const expanded = open.has(t.key);
    return (
      <li key={t.key} className={on ? "picked" : ""}>
        <div className="sk-topic-row">
          <DisclosureToggle open={expanded} label={foldLabel(expanded, t.topic)} onToggle={() => toggleFold(t.key)} />
          <input
            type="checkbox"
            aria-label={uiFormat("选择主题 {0}", [t.topic])}
            checked={on === keys.length}
            ref={(el) => {
              if (el) el.indeterminate = on > 0 && on < keys.length;
            }}
            onChange={(e) => toggle(keys, e.target.checked)}
          />
          <button
            type="button"
            className="sk-topic-name"
            aria-expanded={expanded}
            onClick={() => toggleFold(t.key)}
          >
            <span className="sk-topic-title">{t.topic}</span>
            {t.decks.length > 1 && <span className="sk-badge">{uiFormat("跨 {0} 个题组", [t.decks.length])}</span>}
            <small>{uiFormat("{0} 题", [t.count])}</small>
          </button>
        </div>
        {expanded && (
          <ul className="sk-decks">
            {t.decks.map((d) => {
              const key = pairKey(d.deckId, d.topic);
              return (
                <li key={key}>
                  <label>
                    <input type="checkbox" checked={picked.has(key)} onChange={(e) => toggle([key], e.target.checked)} />
                    <span>{d.folder ? `${d.folder} / ` : ""}{d.deckTitle}</span>
                    <small>{uiFormat("{0} 题", [d.count])}</small>
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </li>
    );
  };

  const lintCards = lint ? lint.cards.filter((c) => (issueFilter ? c.issues.includes(issueFilter) : c.issues.length)) : [];

  return (
    <section className="page skeleton-page">
      <PageHeader title={ui("知识骨架")} description={ui("同一个主题常常散在好几个题组里。选好主题，先做质量检测，再交给对话把名词串成结构、修掉只能死记的题。")}
        scope={<PageScope courses={data?.focus?.courses} value={course} onChange={chooseCourse} />} />
      {error && (
        <InlineMessage tone="error" boxed className="sk-msg" action={{ label: ui("重试"), onClick: () => { setError(""); setReload((n) => n + 1); } }}>{error}</InlineMessage>
      )}
      {stale && !error && <p className="muted small sk-stale" role="status">{ui("之前打开的骨架已删除或不在这门课程中。")}</p>}

      <div className="sk-layout">
        <Panel as="div" density="compact" className="sk-panel sk-picker">
          <div className="sk-panel-head">
            <strong>{ui("选择主题")}</strong>
            <small className="muted">
              {topics && !loadFailed ? uiFormat("{0} 个主题", [topics.length]) : ""}
              {loadFailed ? "" : groups.length ? uiFormat(" · {0} 个主题组", [groups.length]) : ui(" · 同名主题已跨题组合并")}
            </small>
          </div>
          <div className="sk-group-bar">
            {groups.length > 0 && (
              <SegmentedControl size="sm" label={ui("主题视图")} value={byGroup ? "group" : "all"} onChange={(next) => setByGroup(next === "group")}
                options={[{ value: "group", label: ui("主题组") }, { value: "all", label: ui("全部主题") }]} />
            )}
            {topics && !groups.length && !loadFailed && (
              <button
                type="button"
                className="sk-mini sk-ai"
                title={ui("主题太碎时，交给对话按知识域归并成主题组（不改题目）")}
                onClick={() => askInChat(groupPrompt({ mode: "replace", topicCount: topics.length, course }, getUiLanguage()))}
              >{ui("✦ AI 归并主题")}</button>
            )}
            {groups.length > 0 && groupView.ungrouped.length > 0 && (
              <button
                type="button"
                className="sk-mini sk-ai"
                onClick={() => askInChat(groupPrompt({ mode: "merge", ungrouped: groupView.ungrouped.length, course }, getUiLanguage()))}
              >{uiFormat("归并新增 {0} 个", [groupView.ungrouped.length])}</button>
            )}
            {groups.length > 0 && (
              <button
                type="button"
                className="sk-mini"
                title={course === "*" ? ui("让对话重新归并全部主题，替换现有主题组") : ui("让对话只重新归并这门课程的主题，其他课程的主题组保持不变")}
                onClick={() => askInChat(groupPrompt({ mode: "replace", topicCount: topics.length, course }, getUiLanguage()))}
              >{ui("重新归并")}</button>
            )}
          </div>
          <input
            className="sk-search"
            type="search"
            placeholder={ui("搜索主题或题组…")}
            value={query}
            onChange={(e) => { setStale(false); setQuery(e.target.value); }}
          />
          {!topics ? (
            <p className="muted small">{ui("正在读取主题…")}</p>
          ) : loadFailed ? (
            <p className="muted small">{ui("主题暂时读不出来，点上面的「重试」再试一次。")}</p>
          ) : !(grouped ? groupRows.length : shown.length) ? (
            <p className="muted small">{topics.length ? ui("没有匹配的主题。") : ui("这门课程里还没有题目。先用资料出题，有了题目才能整理成知识骨架。")}</p>
          ) : (
            grouped ? (
            <ul className="sk-topics sk-groups">
              {groupRows.map((g) => {
                const keys = g.members.flatMap((m) => m.decks.map((d) => pairKey(d.deckId, d.topic)));
                const on = keys.filter((k) => picked.has(k)).length;
                const expanded = open.has("g:" + g.id) || (query.trim() && g.searchHit);
                const cards = g.members.reduce((n, m) => n + m.count, 0);
                return (
                  <li key={g.id} className={"sk-group" + (on ? " picked" : "") + (g.loose ? " loose" : "")}>
                    <div className="sk-topic-row">
                      <DisclosureToggle open={!!expanded} label={foldLabel(!!expanded, g.title)} onToggle={() => toggleFold("g:" + g.id)} />
                      <input
                        type="checkbox"
                        aria-label={uiFormat("选择主题组 {0}", [g.title])}
                        checked={keys.length > 0 && on === keys.length}
                        ref={(el) => {
                          if (el) el.indeterminate = on > 0 && on < keys.length;
                        }}
                        onChange={(e) => toggle(keys, e.target.checked)}
                      />
                      <button
                        type="button"
                        className="sk-topic-name"
                        aria-expanded={!!expanded}
                        title={g.description || g.title}
                        onClick={() => toggleFold("g:" + g.id)}
                      >
                        <span className="sk-topic-title sk-group-title">{g.title}</span>
                        <span className="sk-badge dim">{uiFormat("{0} 个主题", [g.members.length])}</span>
                        <small>{uiFormat("{0} 题", [cards])}</small>
                      </button>
                    </div>
                    {expanded && (
                      <>
                        {g.description && <p className="sk-group-desc">{g.description}</p>}
                        <ul className="sk-topics nested">{g.members.map(renderTopic)}</ul>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            ) : (
            <ul className="sk-topics">
              {shown.map(renderTopic)}
            </ul>
            )
          )}
        </Panel>

        <Panel as="div" density="compact" className="sk-panel sk-work">
          <div className="sk-panel-head">
            <strong>{ui("已选")}</strong>
            <small className="muted">
              {picked.size ? uiFormat("{0} 个主题 · {1} 个题组 · {2} 道题", [pickedTopics.length, pickedDecks, pickedCards]) : ui("在左边勾选主题")}
            </small>
            {picked.size > 0 && (
              <Button variant="link" size="sm" className="sk-link" onClick={() => toggle([...picked], false)}>{ui("清空")}</Button>
            )}
          </div>
          {pickedTopics.length > 0 && (
            <div className="sk-chips">
              {pickedTopics.slice(0, 12).map((t) => (
                <span key={t} className="sk-chip">{t}</span>
              ))}
              {pickedTopics.length > 12 && <span className="sk-chip dim">+{pickedTopics.length - 12}</span>}
            </div>
          )}
          <div className="sk-actions">
            <Button disabled={!picked.size || !!pending} onClick={runLint}>
              {pending === "lint" ? ui("检测中…") : ui("质量检测")}
            </Button>
            <Button variant="primary"
              disabled={!picked.size || pickedCards > 200}
              title={pickedCards > 200 ? ui("一次最多 200 道题") : ui("在对话里设计骨架并修题")}
              onClick={() => {
                setStale(false);
                askInChat(designSkeletonPrompt({ scope, lint, topics: pickedTopics }));
                setSent(true);
              }}
            >{ui("在对话中生成骨架")}</Button>
          </div>
          {pickedCards > 200 && <p className="sk-warn">{ui("一次最多 200 道题，请少选几个主题。")}</p>}
          {sent && (
            <p className="muted small sk-note">{ui("已交给对话。agent 保存后骨架会出现在下方，修过的题会进信箱。")}</p>
          )}

          {lint && (
            <div className="sk-lint">
              <div className="sk-lint-summary">
                <span>
                  {lint.flagged ? uiRich("{0} / {1} 道题有散装问题", <strong>{lint.flagged}</strong>, lint.total) : uiFormat("{0} 道题都没发现散装问题", [lint.total])}
                </span>
                {lint.flagged > 0 && (
                  <Button size="sm" className="sk-mini" disabled={busy} onClick={() => onPractice(lint.cards.filter((c) => c.issues.length))}>{ui("只练这些题")}</Button>
                )}
              </div>
              <div className="sk-filters" role="group" aria-label={ui("按问题筛选")}>
                <Chip selected={!issueFilter} onClick={() => setIssueFilter("")}>{uiFormat("全部问题 {0}", [lint.flagged])}</Chip>
                {Object.entries(lint.counts).map(([code, n]) => (
                  <Chip key={code} selected={issueFilter === code} disabled={!n} onClick={() => setIssueFilter(code)}>{lint.labels[code]} {n}</Chip>
                ))}
              </div>
              <ul className="sk-lint-list">
                {lintCards.slice(0, 60).map((c) => (
                  <li key={c.cardId}>
                    <span className="sk-lint-prompt" title={c.prompt}>{c.prompt}</span>
                    <small className="muted">{c.deckTitle} · {c.topic}</small>
                    <span className="sk-issues">
                      {c.issues.map((code) => (
                        <span key={code} className={"sk-issue i-" + code}>{lint.labels[code]}</span>
                      ))}
                    </span>
                  </li>
                ))}
                {lintCards.length > 60 && <li className="muted small">{uiFormat("还有 {0} 道…", [lintCards.length - 60])}</li>}
              </ul>
            </div>
          )}
        </Panel>
      </div>

      <div className="section-heading">
        <h2>{ui("已保存的骨架")}{" "}<span>{listedSkeletons.length}</span>
        </h2>
      </div>
      {!listedSkeletons.length ? (
        <p className="muted small" data-tour="skeleton-main">{ui("还没有骨架。选好主题后点「在对话中生成骨架」。")}</p>
      ) : (
        <div className="sk-saved" data-tour="skeleton-main">
          <ul className="sk-saved-list">
            {listedSkeletons.map((k) => (
              <li key={k.id}>
                <button type="button" className={"sk-saved-item" + (k.id === focusId ? " on" : "")} onClick={() => { setStale(false); onFocus(k.id === focusId ? null : k.id); }}>
                  <strong>{k.title}</strong>
                  <small className="muted">
                    {[uiFormat("{0} 个概念 · {1} 条关系", [k.nodes, k.relations]), k.sequences ? uiFormat("{0} 条时序", [k.sequences]) : "", uiFormat("{0} 题", [k.cardIds.length]), uiFormat("{0} 个题组", [k.decks]), ago(k.updatedAt)].filter(Boolean).join(" · ")}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {viewing && (
            <article className="sk-view" aria-label={uiFormat("骨架：{0}", [viewing.title])}>
              <header className="sk-view-head">
                <h3>{viewing.title}</h3>
                <div className="sk-actions">
                  <Button variant="primary"
                    disabled={busy}
                    onClick={() => onPractice(viewing.nodes.flatMap((n) => n.cards))}
                  >{ui("练整个骨架")}</Button>
                  <Button
                    onClick={() =>
                      askInChat(designSkeletonPrompt({ scope: viewing.scope, lint: null, topics: [...new Set(viewing.scope.map((x) => x.topic).filter(Boolean))], update: viewing }))
                    }
                  >{ui("在对话中更新")}</Button>
                  <button
                    type="button"
                    className="sk-danger"
                    disabled={!!pending}
                    title={ui("只删骨架，题目不受影响")}
                    onClick={() => setConfirmDelete(true)}
                  >
                    {ui("删除")}
                  </button>
                </div>
              </header>
              {confirmDelete && <ConfirmDialog title={uiFormat("删除骨架「{0}」？", [viewing.title])} description={ui("只删骨架，题目不受影响。")}
                confirmLabel={ui("删除")} onClose={() => setConfirmDelete(false)}
                onConfirm={async () => {
                  setPending("delete");
                  try {
                    await call("skeleton.delete", { id: viewing.id });
                    onFocus(null);
                  } finally {
                    setPending("");
                  }
                }} />}
              {viewing.overview && <Markdown text={viewing.overview} className="sk-overview" />}
              <form
                className="sk-extend-row"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (!extendText.trim()) return;
                  askInChat(extendSkeletonPrompt({ skeleton: viewing, text: extendText.trim() }));
                  setExtendText("");
                }}
              >
                <input
                  value={extendText}
                  onChange={(ev) => setExtendText(ev.target.value)}
                  placeholder={ui("告诉对话怎么扩展，例如：加上 CAP 定理，并和 BASE 对比；为 RPO/RTO 补两道计算题")}
                  aria-label={ui("在对话中扩展这个骨架")}
                />
                <Button type="submit" disabled={!extendText.trim()}>{ui("✦ 发到对话")}</Button>
              </form>
              {/* 脉络 reads in learning order; 结构图 keeps every relation. */}
              <SegmentedControl size="sm" className="sk-view-switch" label={ui("骨架视图")} value={skView} onChange={setSkView}
                options={[{ value: "spine", label: ui("脉络") }, { value: "canvas", label: ui("结构图") }]} />
              {skView === "spine" ? (
                <SkeletonSpine skeleton={viewing} onPractice={onPractice} />
              ) : (
                <SkeletonCanvas
                  skeleton={viewing}
                  onPractice={onPractice}
                  onAsk={(ask) => askInChat(extendSkeletonPrompt({ skeleton: viewing, ...ask }))}
                />
              )}
              <details className="sk-text">
                <summary>{ui("文字版：概念释义与关系")}</summary>
                <NodeTree skeleton={viewing} onPractice={onPractice} />
                {viewing.relations.length > 0 && (
                  <ul className="sk-relations">
                    {viewing.relations.map((r, i) => {
                      const term = (nodeId) => viewing.nodes.find((n) => n.id === nodeId)?.term || nodeId;
                      return (
                        <li key={i}>
                          <span>{term(r.from)}</span>
                          <span className={"sk-rel r-" + r.type}>{RELATION_LABEL[r.type] || r.type}</span>
                          <span>{term(r.to)}</span>
                          {r.note && <small className="muted">{r.note}</small>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </details>
            </article>
          )}
        </div>
      )}
    </section>
  );
}
