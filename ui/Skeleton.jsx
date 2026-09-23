import React, { useEffect, useMemo, useState } from "react";
import Markdown from "./Markdown.jsx";
import SkeletonCanvas from "./SkeletonCanvas.jsx";
import css from "./skeleton.css";
import { useInjectCss } from "./shared.js";

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
  return Number.isFinite(d.getTime()) ? d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
};

function groupPrompt({ mode, topicCount, ungrouped }) {
  if (mode === "merge")
    return (
      `学习库里有 ${ungrouped} 个主题还没归入主题组，请帮我归并：\n` +
      "1. 用 study_workspace 的 skeleton.topics（payload 为 {\"compact\": true, \"samples\": 1}）读取主题；返回的 groups.groups 是已有主题组，groups.ungrouped 是还没归入的主题 key。\n" +
      "2. 能放进已有组的，沿用那个组的 title；放不进的新建组（组名是知识域名称，≤20 字，description 一句话说明范围）。\n" +
      "3. 用 topic.groups.save 保存，payload 为 {\"mode\": \"merge\", \"groups\": [{title, description?, topics: [主题 key]}]}，只提交这些新主题。不要修改题目本身。\n" +
      "4. 最后告诉我它们分别归到了哪里。"
    );
  return (
    `学习库的主题太碎了（共 ${topicCount} 个，很多只有 1–2 题），请帮我按知识域归并成主题组：\n` +
    "1. 用 study_workspace 的 skeleton.topics（payload 为 {\"compact\": true, \"samples\": 1}）读取全部主题的 key、名称、题数、所在题组和一条示例题干。\n" +
    "2. 归并成 12–30 个主题组：同一概念的不同叫法、中英文混写、被拆开的细主题（例如「XX 的定义」「XX 的计算」「XX 例题」「XX 与 YY 的区别」）放进同一组；按课程里的知识域划分（例如可用性度量与计算、冗余与容错、安全与风险、架构描述与视图、架构方法论、集成与通信……以实际主题为准）。组名用学习者熟悉的说法（≤20 字），description 用一句话说明范围。每个主题只进一个组；实在归不进去的放进「其他」组。\n" +
    "3. 用 topic.groups.save 保存，payload 为 {\"mode\": \"replace\", \"groups\": [{title, description, topics: [主题 key]}]}。这只是题目之上的分组，不要修改题目本身。\n" +
    "4. 最后列出分了哪些组、每组大概多少题。"
  );
}

const EXTEND_ASK = {
  contrast: (term, text) => `把概念「${term}」和「${text}」做对比，讲清它们的关键差异和容易混淆的地方。`,
  enrich: (term, text) => `补充或修正概念「${term}」${text ? `：${text}` : "：含义、关键特征和它与其他概念的关系是否准确、完整。"}`,
  cards: (term, text) => `为概念「${term}」补能真正练到它的题${text ? `：${text}` : "（理解、辨析或场景应用，不要只背名词）。"}`,
};

/** Ask the conversation to extend one skeleton incrementally (new concepts, relations, cards). */
function extendPrompt({ skeleton, nodeId, term, intent, text }) {
  const want = intent && EXTEND_ASK[intent] ? EXTEND_ASK[intent](term, text) : text;
  return (
    `请扩展知识骨架「${skeleton.title}」（id: ${skeleton.id}）${nodeId ? `，从节点 ${nodeId}「${term}」出发` : ""}：\n${want}\n\n` +
    "做法：\n" +
    "1. 用 study_workspace 的 skeleton.get（payload 为 {\"id\": \"" + skeleton.id + "\"}）读当前骨架；需要的概念已经在骨架里就复用它的节点。\n" +
    "2. 不在骨架里的概念：先用 card.search 查题库有没有相关题，用 source.search 查资料依据；再用 skeleton.patch 的 node.add 加节点（meaning 依据资料，资料里没有的明确写是补充知识），挂到合适的上位概念（parent），用 attributes 写 2–5 条关键特征，让差异在类图里一眼可见。\n" +
    "3. 用 relation.add 加关系（对比用 contrasts，note 写一句最关键的差异；因果用 causes，前置用 prerequisite）。有动态过程的差异可以用 sequence.add 补一条时序。\n" +
    "4. 题库里没有能练到这个概念或这层关系的题时补题：用 capture 加题（对比、辨析优先 kind: \"quiz\"，deckId 用骨架里相关题所在的题组），再用 skeleton.patch 的 node.cards 把新题挂到对应节点；有前置关系的题用 card.link 关联。\n" +
    "5. 骨架的所有修改都用 skeleton.patch 增量提交（ops 可以一次提交多步，note 写一句这次改了什么），不要整份重写；面板会实时刷新并高亮变化。最后用几句话告诉我加了什么、补了哪些题。"
  );
}

function chatPrompt({ scope, lint, topics, update }) {
  const counts = lint
    ? Object.entries(lint.counts).filter(([, n]) => n).map(([code, n]) => `${lint.labels[code]} ${n} 题`).join("；") || "没有发现散装问题"
    : "（还没做质量检测，skeleton.context 会带上每道题的检测结果）";
  return (
    (update ? `请更新知识骨架「${update.title}」（id: ${update.id}），` : "请为下面这组题做一份「知识骨架」，") +
    "把散装的名词串成结构，并修掉只能死记的题：\n" +
    `主题：${topics.join("、")}\n` +
    `范围 scope：${JSON.stringify(scope)}\n` +
    `质量检测：${counts}\n\n` +
    "步骤：\n" +
    "1. 用 study_workspace 的 skeleton.context（payload 为 {\"scope\": 上面的 scope}）读题目、每题的检测结果和引用原文片段；需要更多依据时用 source.search，不要逐份翻资料。\n" +
    "2. 设计一份骨架，会画成可交互的 UML 类图 + 时序图，并配文字阐述：\n" +
    "   · 类图（nodes + relations）：每个名词是一个类，写一句含义 meaning 和 2–5 条关键特征 attributes；「是一种」用 parent（泛化），「是…的组成部分」用 part-of，「导致」用 causes，「学它之前要懂」用 prerequisite，「是…的例子」用 example-of，容易混的用 contrasts。不同题组里的同一个名词合并成一个节点，节点挂上对应题目的 {deckId, cardId}。classNote 用文字讲清这张结构图怎么读。\n" +
    "   · 时序图（sequences，最多 4 条）：把动态过程画出来，比如故障如何一步步传导、请求如何流转、机制如何生效。participants 是参与者（能对应节点就填 node），steps 按时间顺序写 from→to 的 message，kind 取 call / return / async；每条写 explanation 讲清因果。纯静态的概念可以不画时序图。\n" +
    "   · overview 写一段总览和一条好记的主线，把两张图串起来。\n" +
    `3. 用 skeleton.save 保存（payload 为 {"skeleton": {${update ? `"id": "${update.id}", ` : ""}title, scope, overview, classNote, nodes, relations, sequences}}）。\n` +
    "4. 按检测结果修题：只重复选项文字的解析改成「是什么 + 和谁有关、为什么对/错」；考课件页码或列表归属的题干改成考含义或关系；用 card.update 保存并写清 reason。有因果或前置关系的题用 card.link 关联。不要改动原文不支持的答案。\n" +
    "5. 最后用几句话告诉我骨架的主线，以及改了哪些题。"
  );
}

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
          <button type="button" className="sk-mini" onClick={() => onPractice(n.cards)} title="练这个节点关联的题">
            练 {n.cards.length} 题
          </button>
        )}
        {children.has(n.id) && <ul className="sk-tree">{render(n.id, depth + 1)}</ul>}
      </li>
    ));
  return <ul className="sk-tree sk-root">{render("", 0)}</ul>;
}

export default function Skeleton({ call, data, busy, askInChat, onPractice, focusId, onFocus }) {
  useInjectCss(css, "study-skeleton");
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
    [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    call("skeleton.topics")
      .then((r) => {
        if (!live) return;
        setTopics(r.topics);
        setGroupView(r.groups);
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [call, data?.revision]);

  // Re-read the open skeleton when the conversation saves a new version.
  const focusVersion = data?.skeletons?.find((k) => k.id === focusId)?.updatedAt;
  useEffect(() => {
    if (!focusId) {
      setViewing(null);
      return;
    }
    let live = true;
    call("skeleton.get", { id: focusId })
      .then((k) => live && setViewing(k))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [call, focusId, focusVersion]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (topics || []).filter((t) => !q || t.topic.toLowerCase().includes(q) || t.decks.some((d) => d.deckTitle.toLowerCase().includes(q)));
  }, [topics, query]);
  const groups = groupView?.groups || [];
  const grouped = byGroup && groups.length > 0;
  // Group rows: saved groups plus an 未归入 bucket; a search keeps groups whose
  // title matches (all members) or that contain matching topics (those members).
  const groupRows = useMemo(() => {
    if (!topics || !groupView?.groups.length) return [];
    const byKey = new Map(topics.map((x) => [x.key, x]));
    const q = query.trim().toLowerCase();
    const rows = [
      ...groupView.groups.map((g) => ({ ...g, members: g.topics.map((k) => byKey.get(k)).filter(Boolean) })),
      ...(groupView.ungrouped.length
        ? [{ id: "__ungrouped", title: "未归入主题组", description: "还没有归入任何主题组的主题", members: groupView.ungrouped.map((k) => byKey.get(k)).filter(Boolean), loose: true }]
        : []),
    ];
    return rows
      .map((g) => {
        if (!q) return g;
        const titleHit = g.title.toLowerCase().includes(q) || g.description.toLowerCase().includes(q);
        const members = titleHit ? g.members : g.members.filter((m) => shown.includes(m));
        return members.length ? { ...g, members, searchHit: !titleHit } : null;
      })
      .filter(Boolean);
  }, [topics, groupView, query, shown]);
  const scope = useMemo(() => [...picked].map(fromKey), [picked]);
  const pickedTopics = useMemo(() => [...new Set(scope.map((x) => x.topic))], [scope]);
  const pickedCards = useMemo(
    () => (topics || []).reduce((n, t) => n + t.decks.filter((d) => picked.has(pairKey(d.deckId, d.topic))).reduce((m, d) => m + d.count, 0), 0),
    [topics, picked],
  );
  const pickedDecks = new Set(scope.map((x) => x.deckId)).size;

  const toggle = (keys, on) => {
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
      setError(e.message);
    } finally {
      setPending("");
    }
  }

  const renderTopic = (t) => {
    const keys = t.decks.map((d) => pairKey(d.deckId, d.topic));
    const on = keys.filter((k) => picked.has(k)).length;
    const expanded = open.has(t.key);
    return (
      <li key={t.key} className={on ? "picked" : ""}>
        <div className="sk-topic-row">
          <input
            type="checkbox"
            aria-label={`选择主题 ${t.topic}`}
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
            onClick={() =>
              setOpen((prev) => {
                const next = new Set(prev);
                next.has(t.key) ? next.delete(t.key) : next.add(t.key);
                return next;
              })
            }
          >
            <span className="sk-caret" aria-hidden="true">▸</span>
            <span className="sk-topic-title">{t.topic}</span>
            {t.decks.length > 1 && <span className="sk-badge">跨 {t.decks.length} 个题组</span>}
            <small>{t.count} 题</small>
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
                    <small>{d.count} 题</small>
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
      <div className="page-heading">
        <div>
          <h1>知识骨架</h1>
          <p className="muted">
            同一个主题常常散在好几个题组里。选好主题，先做质量检测，再交给对话把名词串成结构、修掉只能死记的题。
          </p>
        </div>
      </div>
      {error && <p className="sk-error" role="alert">{error}</p>}

      <div className="sk-layout">
        <div className="sk-panel sk-picker">
          <div className="sk-panel-head">
            <strong>选择主题</strong>
            <small className="muted">
              {topics ? `${topics.length} 个主题` : ""}
              {groups.length ? ` · ${groups.length} 个主题组` : " · 同名主题已跨题组合并"}
            </small>
          </div>
          <div className="sk-group-bar">
            {groups.length > 0 && (
              <div className="sk-seg" role="group" aria-label="主题视图">
                <button type="button" className={byGroup ? "on" : ""} aria-pressed={byGroup} onClick={() => setByGroup(true)}>
                  主题组
                </button>
                <button type="button" className={!byGroup ? "on" : ""} aria-pressed={!byGroup} onClick={() => setByGroup(false)}>
                  全部主题
                </button>
              </div>
            )}
            {topics && !groups.length && (
              <button
                type="button"
                className="sk-mini sk-ai"
                title="主题太碎时，交给对话按知识域归并成主题组（不改题目）"
                onClick={() => askInChat(groupPrompt({ mode: "replace", topicCount: topics.length }))}
              >
                ✦ AI 归并主题
              </button>
            )}
            {groups.length > 0 && groupView.ungrouped.length > 0 && (
              <button
                type="button"
                className="sk-mini sk-ai"
                onClick={() => askInChat(groupPrompt({ mode: "merge", ungrouped: groupView.ungrouped.length }))}
              >
                ✦ 归并新增 {groupView.ungrouped.length} 个
              </button>
            )}
            {groups.length > 0 && (
              <button
                type="button"
                className="sk-mini"
                title="让对话重新归并全部主题，替换现有主题组"
                onClick={() => askInChat(groupPrompt({ mode: "replace", topicCount: topics.length }))}
              >
                重新归并
              </button>
            )}
          </div>
          <input
            className="sk-search"
            type="search"
            placeholder="搜索主题或题组…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {!topics ? (
            <p className="muted small">正在读取主题…</p>
          ) : !(grouped ? groupRows.length : shown.length) ? (
            <p className="muted small">没有匹配的主题。</p>
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
                      <input
                        type="checkbox"
                        aria-label={`选择主题组 ${g.title}`}
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
                        onClick={() =>
                          setOpen((prev) => {
                            const next = new Set(prev);
                            next.has("g:" + g.id) ? next.delete("g:" + g.id) : next.add("g:" + g.id);
                            return next;
                          })
                        }
                      >
                        <span className="sk-caret" aria-hidden="true">▸</span>
                        <span className="sk-topic-title sk-group-title">{g.title}</span>
                        <span className="sk-badge dim">{g.members.length} 个主题</span>
                        <small>{cards} 题</small>
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
        </div>

        <div className="sk-panel sk-work">
          <div className="sk-panel-head">
            <strong>已选</strong>
            <small className="muted">
              {picked.size ? `${pickedTopics.length} 个主题 · ${pickedDecks} 个题组 · ${pickedCards} 道题` : "在左边勾选主题"}
            </small>
            {picked.size > 0 && (
              <button type="button" className="sk-link" onClick={() => toggle([...picked], false)}>
                清空
              </button>
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
            <button type="button" disabled={!picked.size || !!pending} onClick={runLint}>
              {pending === "lint" ? "检测中…" : "质量检测"}
            </button>
            <button
              type="button"
              className="primary"
              disabled={!picked.size || pickedCards > 200}
              title={pickedCards > 200 ? "一次最多 200 道题" : "在对话里设计骨架并修题"}
              onClick={() => {
                askInChat(chatPrompt({ scope, lint, topics: pickedTopics }));
                setSent(true);
              }}
            >
              在对话中生成骨架
            </button>
          </div>
          {pickedCards > 200 && <p className="sk-warn">一次最多 200 道题，请少选几个主题。</p>}
          {sent && (
            <p className="muted small sk-note">
              已交给对话。agent 保存后骨架会出现在下方，修过的题会进信箱。
            </p>
          )}

          {lint && (
            <div className="sk-lint">
              <div className="sk-lint-summary">
                <span>
                  {lint.flagged ? <><strong>{lint.flagged}</strong> / {lint.total} 道题有散装问题</> : `${lint.total} 道题都没发现散装问题`}
                </span>
                {lint.flagged > 0 && (
                  <button type="button" className="sk-mini" disabled={busy} onClick={() => onPractice(lint.cards.filter((c) => c.issues.length))}>
                    只练这些题
                  </button>
                )}
              </div>
              <div className="sk-filters" role="group" aria-label="按问题筛选">
                <button type="button" className={"sk-filter" + (!issueFilter ? " on" : "")} onClick={() => setIssueFilter("")}>
                  全部问题 {lint.flagged}
                </button>
                {Object.entries(lint.counts).map(([code, n]) => (
                  <button
                    key={code}
                    type="button"
                    className={"sk-filter" + (issueFilter === code ? " on" : "")}
                    disabled={!n}
                    onClick={() => setIssueFilter(code)}
                  >
                    {lint.labels[code]} {n}
                  </button>
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
                {lintCards.length > 60 && <li className="muted small">还有 {lintCards.length - 60} 道…</li>}
              </ul>
            </div>
          )}
        </div>
      </div>

      <div className="section-heading">
        <h2>
          已保存的骨架 <span>{data?.skeletons?.length || 0}</span>
        </h2>
      </div>
      {!data?.skeletons?.length ? (
        <p className="muted small">还没有骨架。选好主题后点「在对话中生成骨架」。</p>
      ) : (
        <div className="sk-saved">
          <ul className="sk-saved-list">
            {data.skeletons.map((k) => (
              <li key={k.id}>
                <button type="button" className={"sk-saved-item" + (k.id === focusId ? " on" : "")} onClick={() => onFocus(k.id === focusId ? null : k.id)}>
                  <strong>{k.title}</strong>
                  <small className="muted">
                    {k.nodes} 个概念 · {k.relations} 条关系{k.sequences ? ` · ${k.sequences} 条时序` : ""} · {k.cardIds.length} 题 · {k.decks} 个题组 · {ago(k.updatedAt)}
                  </small>
                </button>
              </li>
            ))}
          </ul>
          {viewing && (
            <article className="sk-view" aria-label={`骨架：${viewing.title}`}>
              <header className="sk-view-head">
                <h3>{viewing.title}</h3>
                <div className="sk-actions">
                  <button
                    type="button"
                    className="primary"
                    disabled={busy}
                    onClick={() => onPractice(viewing.nodes.flatMap((n) => n.cards))}
                  >
                    练整个骨架
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      askInChat(chatPrompt({ scope: viewing.scope, lint: null, topics: [...new Set(viewing.scope.map((x) => x.topic).filter(Boolean))], update: viewing }))
                    }
                  >
                    在对话中更新
                  </button>
                  <button
                    type="button"
                    className="sk-danger"
                    disabled={!!pending}
                    title="只删骨架，题目不受影响"
                    onBlur={() => setConfirmDelete(false)}
                    onClick={async () => {
                      // Two taps instead of window.confirm, which host webviews may block.
                      if (!confirmDelete) return setConfirmDelete(true);
                      setConfirmDelete(false);
                      setPending("delete");
                      try {
                        await call("skeleton.delete", { id: viewing.id });
                        onFocus(null);
                      } catch (e) {
                        setError(e.message);
                      } finally {
                        setPending("");
                      }
                    }}
                  >
                    {confirmDelete ? "再点一次删除" : "删除"}
                  </button>
                </div>
              </header>
              {viewing.overview && <Markdown text={viewing.overview} className="sk-overview" />}
              <form
                className="sk-extend-row"
                onSubmit={(ev) => {
                  ev.preventDefault();
                  if (!extendText.trim()) return;
                  askInChat(extendPrompt({ skeleton: viewing, text: extendText.trim() }));
                  setExtendText("");
                }}
              >
                <input
                  value={extendText}
                  onChange={(ev) => setExtendText(ev.target.value)}
                  placeholder="告诉对话怎么扩展，例如：加上 CAP 定理，并和 BASE 对比；为 RPO/RTO 补两道计算题"
                  aria-label="在对话中扩展这个骨架"
                />
                <button type="submit" disabled={!extendText.trim()}>
                  ✦ 发到对话
                </button>
              </form>
              <SkeletonCanvas
                skeleton={viewing}
                onPractice={onPractice}
                onAsk={(ask) => askInChat(extendPrompt({ skeleton: viewing, ...ask }))}
              />
              <details className="sk-text">
                <summary>文字版：概念释义与关系</summary>
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
