import { ui, uiFormat, uiLocale } from "./i18n.js";
import React, { useState } from "react";
import Markdown from "./Markdown.jsx";
import { reviewedCardFingerprint, reviewedCardStatus } from "../lib/review-integrity.js";
import { selfCitedCardCount } from "../lib/source-provenance.js";

/* 题组管理视图：编辑先进入草稿（deck.edit → openDraft），归档/暂停/标记
   与目录移动就地生效。managedDeck 由 App 在进入本视图时 deck.get 取得。 */
export default function Manage({
  call,
  busy,
  act,
  openDraft,
  setPage,
  setNotice,
  managedDeck,
  decks = [],
  sources,
  setManagedDeck,
  folderDraft,
  setFolderDraft,
}) {
  const [targetId, setTargetId] = useState("");
  const [splitTitle, setSplitTitle] = useState("");
  const [splitTopics, setSplitTopics] = useState([]);
  const topics = [...new Set(managedDeck.cards.map((c) => c.topic || ui("未分类")))];
  const peers = decks.filter((d) => d.id !== managedDeck.id && !d.systemKind && !d.archived);
  const deckIndex = decks.findIndex((d) => d.id === managedDeck.id);
  const siblings = decks.filter((d) => (d.folder || "") === (managedDeck.folder || ""));
  const siblingIndex = siblings.findIndex((d) => d.id === managedDeck.id);
  const moveOrder = (delta) => {
    const ids = decks.map((d) => d.id);
    const other = decks.findIndex((d) => d.id === siblings[siblingIndex + delta]?.id);
    [ids[deckIndex], ids[other]] = [ids[other], ids[deckIndex]];
    act("deck.reorder", { ids }, () => setNotice(ui("题组顺序已保存")));
  };
  const unreviewed = reviewedCardStatus(managedDeck)?.changed ?? managedDeck.editorial?.uncheckedAtPublish ?? 0;
  const selfCited = selfCitedCardCount(managedDeck.cards, sources);
  const marks = managedDeck.editorial?.reviewedCards;
  return (
    <section className="page">
      <h1>{managedDeck.title}</h1>
      {managedDeck.originalTitle && managedDeck.originalTitle !== managedDeck.title &&
        <p className="muted">{ui("导入原标题：")}{managedDeck.originalTitle}</p>}
      {managedDeck.systemKind === "slain" && <p className="muted">{ui("本工作区唯一的斩题组。这里的题不参与复习，作答历史和复习进度保留，可恢复到原题组。")}</p>}
      {managedDeck.systemKind !== "slain" && <p className="muted">{ui("编辑先进入草稿；重新发布时，未改动题目保留复习进度，内容变更的题目重新开始调度。历史作答始终保留。")}</p>}
      {managedDeck.systemKind !== "slain" && (unreviewed > 0 || selfCited > 0) && (
        <p className="quality-note warning" role="status">
          {unreviewed > 0 && uiFormat("{0} 题尚未自动审阅。学习时可正常作答，发现问题可点题目标记或 👎 交给后台修题。", [unreviewed])}
          {selfCited > 0 && uiFormat(" {0} 题只引用导入题目自身；请先在草稿中换成原始资料引用。", [selfCited])}
        </p>
      )}
      <div className="deck-actions">
        <button
          disabled={busy || managedDeck.systemKind === "slain"}
          onClick={() =>
            act("deck.edit", { id: managedDeck.id }, openDraft)
          }
        >{ui("编辑题组")}</button>
        <button
          disabled={busy || managedDeck.systemKind === "slain"}
          onClick={() =>
            act(
              "deck.archive",
              { id: managedDeck.id, archived: !managedDeck.archived },
              async () =>
                setManagedDeck(
                  await call("deck.get", { id: managedDeck.id }),
                ),
            )
          }
        >
          {managedDeck.archived ? ui("恢复题组") : ui("归档题组并结束练习")}
        </button>
        <button onClick={() => setPage("library")}>{ui("返回学习库")}</button>
      </div>
      <form
        className="binding-inline folder-form"
        onSubmit={(e) => {
          e.preventDefault();
          act(
            "deck.move",
            { id: managedDeck.id, folder: folderDraft },
            (moved) => {
              setManagedDeck({ ...managedDeck, folder: moved.folder });
              setFolderDraft(moved.folder);
              setNotice(moved.folder ? uiFormat("已放入目录「{0}」",[moved.folder]) : ui("已移到目录顶层"));
            },
          );
        }}
      >
        <input
          aria-label={ui("所在目录")}
          value={folderDraft}
          onChange={(e) => setFolderDraft(e.target.value)}
          placeholder={ui("所在目录，例如：设计模式 / 第 4 章（留空为顶层）")}
        />
        <button disabled={busy || folderDraft === (managedDeck.folder || "")}>{ui("保存目录")}</button>
      </form>
      {!managedDeck.systemKind && !managedDeck.archived && <div className="deck-organization">
        <h2>{ui("整理题组")}</h2>
        <p className="muted">{ui("合并保留全部题目；拆分按主题移动。题目复习记录和前置题关联会一起保留。")}</p>
        <div className="deck-actions">
          <button type="button" disabled={busy || siblingIndex <= 0} onClick={() => moveOrder(-1)}>{ui("上移题组")}</button>
          <button type="button" disabled={busy || siblingIndex < 0 || siblingIndex >= siblings.length - 1} onClick={() => moveOrder(1)}>{ui("下移题组")}</button>
        </div>
        <form className="binding-inline folder-form" onSubmit={(e) => {
          e.preventDefault();
          if (!targetId || !window.confirm(uiFormat('将「{0}」的 {1} 道题全部并入目标题组？来源题组会移除。', [managedDeck.title, managedDeck.cards.length]))) return;
          act("deck.merge", { sourceIds: [managedDeck.id], targetId }, (result) => {
            setPage("library"); setNotice(uiFormat("已合并 {0} 道题，全部保留",[result.moved]));
          });
        }}>
          <select aria-label={ui("合并到题组")} value={targetId} onChange={(e) => setTargetId(e.target.value)}>
            <option value="">{ui("选择合并目标")}</option>
            {peers.map((d) => <option key={d.id} value={d.id}>{d.title}（{d.folder || ui("顶层")}）</option>)}
          </select>
          <button disabled={busy || !targetId}>{ui("合并到目标题组")}</button>
        </form>
        {topics.length > 1 && <form onSubmit={(e) => {
          e.preventDefault();
          if (!splitTopics.length || splitTopics.length === topics.length) return;
          act("deck.split", { id: managedDeck.id, title: splitTitle, topics: splitTopics }, async (result) => {
            setManagedDeck(await call("deck.get", { id: managedDeck.id }));
            setSplitTopics([]); setSplitTitle("");
            setNotice(uiFormat("已拆出 {0} 道题到新题组",[result.moved]));
          });
        }}>
          <h3>{ui("按主题拆分")}</h3>
          <div className="deck-actions">{topics.map((topic) => <label key={topic}>
            <input type="checkbox" checked={splitTopics.includes(topic)} onChange={(e) => setSplitTopics((old) => e.target.checked ? [...old, topic] : old.filter((x) => x !== topic))} /> {topic}
          </label>)}</div>
          <div className="binding-inline folder-form">
            <input aria-label={ui("新题组名称")} value={splitTitle} onChange={(e) => setSplitTitle(e.target.value)} placeholder={ui("新题组名称")} />
            <button disabled={busy || !splitTitle.trim() || !splitTopics.length || splitTopics.length === topics.length}>{ui("拆出所选主题")}</button>
          </div>
        </form>}
      </div>}
      {!managedDeck.cards.length && <p className="muted">{managedDeck.systemKind === "slain" ? ui("斩题组为空。练习时点击“斩”，题目会收纳到这里。") : ui("当前题组没有题目。已斩的题可从斩题组恢复。")}</p>}
      {managedDeck.cards.map((card) => (
        <article className="deck" key={card.id}>
          <small>
            {card.topic} · {card.kind}
            {card.suspended ? ui(" · 已暂停") : ""}
            {marks && marks[card.id] !== reviewedCardFingerprint(card) ? ui(" · 未自动审阅") : ""}
            {selfCitedCardCount([card], sources) ? ui(" · 仅有导入题目引用") : ""}
          </small>
          <Markdown className="md-title" text={card.prompt} />
          {card.flag && <p className="muted">{ui("标记：")}{card.flag}</p>}
          {card.slain && <p className="muted">{ui("原题组：")}{card.slain.deckTitle} · {new Date(card.slain.at).toLocaleDateString(uiLocale())}</p>}
          <div className="deck-actions">
            <button disabled={busy} onClick={() => act(
              managedDeck.systemKind === "slain" ? "card.restore" : "card.slay",
              { deckId: managedDeck.id, cardId: card.id },
              async (result) => {
                setManagedDeck(await call("deck.get", { id: managedDeck.id }));
                setNotice(managedDeck.systemKind === "slain" ? uiFormat("已恢复到「{0}」",[result.title]) : ui("已移入斩题组，不再参与复习，可在斩题组恢复。"));
              },
            )}>{managedDeck.systemKind === "slain" ? ui("恢复原题组") : ui("斩")}</button>
            <button
              disabled={busy || managedDeck.systemKind === "slain"}
              onClick={() =>
                act(
                  "card.suspend",
                  {
                    deckId: managedDeck.id,
                    cardId: card.id,
                    suspended: !card.suspended,
                  },
                  async () =>
                    setManagedDeck(
                      await call("deck.get", { id: managedDeck.id }),
                    ),
                )
              }
            >
              {card.suspended ? ui("恢复学习") : ui("暂停此题")}
            </button>
            {card.flag && (
              <button
                disabled={busy}
                onClick={() =>
                  act(
                    "card.flag",
                    {
                      deckId: managedDeck.id,
                      cardId: card.id,
                      reason: "",
                    },
                    async () =>
                      setManagedDeck(
                        await call("deck.get", {
                          id: managedDeck.id,
                        }),
                      ),
                  )
                }
              >{ui("清除标记")}</button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
