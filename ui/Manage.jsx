import { ui, uiFormat, uiLocale } from "./i18n.js";
import React, { useState } from "react";
import Markdown from "./Markdown.jsx";
import { useInjectCss } from "./shared.js";
import css from "./manage.css";
import { reviewedCardFingerprint, reviewedCardStatus } from "../lib/review-integrity.js";
import { selfCitedCardCount } from "../lib/source-provenance.js";
import { Badge, Banner, Button, ConfirmDialog, PageHeader, Panel, useToast } from "./components/index.js";

/** The question before a merge removes the source deck: an in-app confirmation (host webviews may block the browser's own). */
export function MergeDeckDialog({ deck, target, onConfirm, onClose }) {
  return <ConfirmDialog title={uiFormat("合并到「{0}」？", [target.title])} confirmLabel={ui("合并到目标题组")}
    description={uiFormat("将「{0}」的 {1} 道题全部并入目标题组？来源题组会移除。", [deck.title, deck.cards.length])}
    onConfirm={onConfirm} onClose={onClose} />;
}

/* 题组管理视图：编辑先进入草稿（deck.edit → openDraft），归档/暂停/标记
   与目录移动就地生效。managedDeck 由 App 在进入本视图时 deck.get 取得。 */
export default function Manage({
  call,
  busy,
  act,
  openDraft,
  setPage,
  managedDeck,
  decks = [],
  sources,
  setManagedDeck,
  folderDraft,
  setFolderDraft,
  onRemoveDeck,
}) {
  useInjectCss(css, "study-manage");
  const toast = useToast();
  const [targetId, setTargetId] = useState("");
  const [merging, setMerging] = useState(false);
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
    act("deck.reorder", { ids }, () => toast.success(ui("题组顺序已保存")));
  };
  const unreviewed = reviewedCardStatus(managedDeck)?.changed ?? managedDeck.editorial?.uncheckedAtPublish ?? 0;
  const selfCited = selfCitedCardCount(managedDeck.cards, sources);
  const marks = managedDeck.editorial?.reviewedCards;
  const slainView = managedDeck.systemKind === "slain";
  const splitReady = !!splitTitle.trim() && splitTopics.length > 0 && splitTopics.length < topics.length;
  return (
    <section className="page manage-page">
      <PageHeader className="manage-head" back={{ label: ui("返回学习库"), onClick: () => setPage("library") }} title={managedDeck.title}
        description={slainView ? ui("本工作区唯一的斩题组。这里的题不参与复习，作答历史和复习进度保留，可恢复到原题组。")
          : ui("编辑先进入草稿；重新发布时，未改动题目保留复习进度，内容变更的题目重新开始调度。历史作答始终保留。")}
        actions={<>
          <Button variant="primary" disabled={busy || slainView} onClick={() => act("deck.edit", { id: managedDeck.id }, openDraft)}>{ui("编辑题组")}</Button>
          <Button disabled={busy || slainView}
            onClick={() => act("deck.archive", { id: managedDeck.id, archived: !managedDeck.archived },
              async () => setManagedDeck(await call("deck.get", { id: managedDeck.id })))}>
            {managedDeck.archived ? ui("恢复题组") : ui("归档题组并结束练习")}
          </Button>
          {managedDeck.archived && !managedDeck.systemKind && <Button variant="danger" disabled={busy}
            onClick={() => onRemoveDeck(managedDeck.id)}>{ui("永久删除")}</Button>}
        </>}>
        <div className="manage-meta">
          <Badge size="sm">{uiFormat("{0} 题", [managedDeck.cards.length])}</Badge>
          {managedDeck.archived && <Badge size="sm" tone="warning">{ui("已归档")}</Badge>}
        </div>
        {managedDeck.originalTitle && managedDeck.originalTitle !== managedDeck.title &&
          <p className="muted">{ui("导入原标题：")}{managedDeck.originalTitle}</p>}
      </PageHeader>
      {!slainView && (unreviewed > 0 || selfCited > 0) && (
        <Banner tone="warning" role="status">
          {unreviewed > 0 && <p>{uiFormat("{0} 题尚未自动审阅。学习时可正常作答，发现问题可点题目标记或 👎 交给后台修题。", [unreviewed])}</p>}
          {selfCited > 0 && <p>{uiFormat("{0} 题只引用导入题目自身；请先在草稿中换成原始资料引用。", [selfCited])}</p>}
        </Banner>
      )}
      <form
        className="manage-folder"
        onSubmit={(e) => {
          e.preventDefault();
          act(
            "deck.move",
            { id: managedDeck.id, folder: folderDraft },
            (moved) => {
              setManagedDeck({ ...managedDeck, folder: moved.folder });
              setFolderDraft(moved.folder);
              toast.success(moved.folder ? uiFormat("已放入目录「{0}」",[moved.folder]) : ui("已移到目录顶层"));
            },
          );
        }}
      >
        <label className="manage-label" htmlFor="manage-folder-input">{ui("所在目录")}</label>
        <div className="manage-row">
          <input
            id="manage-folder-input"
            value={folderDraft}
            onChange={(e) => setFolderDraft(e.target.value)}
            placeholder={ui("所在目录，例如：设计模式 / 第 4 章（留空为顶层）")}
          />
          <Button disabled={busy || folderDraft === (managedDeck.folder || "")} type="submit">{ui("保存目录")}</Button>
        </div>
      </form>
      {!managedDeck.systemKind && !managedDeck.archived && <Panel className="manage-panel" title={ui("整理题组")}
        description={ui("合并保留全部题目；拆分按主题移动。题目复习记录和前置题关联会一起保留。")}>
        <div className="manage-section">
          <span className="manage-label">{ui("题组顺序")}</span>
          <div className="manage-row manage-row--pair">
            <Button disabled={busy || siblingIndex <= 0} onClick={() => moveOrder(-1)}>{ui("上移题组")}</Button>
            <Button disabled={busy || siblingIndex < 0 || siblingIndex >= siblings.length - 1} onClick={() => moveOrder(1)}>{ui("下移题组")}</Button>
          </div>
        </div>
        <form className="manage-section" onSubmit={(e) => {
          e.preventDefault();
          if (targetId) setMerging(true);
        }}>
          <label className="manage-label" htmlFor="manage-merge-target">{ui("合并到题组")}</label>
          <div className="manage-row">
            <select id="manage-merge-target" value={targetId} onChange={(e) => setTargetId(e.target.value)}>
              <option value="">{ui("选择合并目标")}</option>
              {peers.map((d) => <option key={d.id} value={d.id}>{d.title}（{d.folder || ui("顶层")}）</option>)}
            </select>
            <Button disabled={busy || !targetId} type="submit">{ui("合并到目标题组")}</Button>
          </div>
        </form>
        {topics.length > 1 && <form className="manage-section" onSubmit={(e) => {
          e.preventDefault();
          if (!splitReady) return;
          act("deck.split", { id: managedDeck.id, title: splitTitle, topics: splitTopics }, async (result) => {
            setManagedDeck(await call("deck.get", { id: managedDeck.id }));
            setSplitTopics([]); setSplitTitle("");
            toast.success(uiFormat("已拆出 {0} 道题到新题组",[result.moved]));
          });
        }}>
          <span className="manage-label">
            {ui("按主题拆分")}
            <small>{uiFormat("已选 {0} / {1} 个主题", [splitTopics.length, topics.length])}</small>
          </span>
          <div className="manage-topics">{topics.map((topic) => <label key={topic} className="manage-topic">
            <input type="checkbox" checked={splitTopics.includes(topic)} onChange={(e) => setSplitTopics((old) => e.target.checked ? [...old, topic] : old.filter((x) => x !== topic))} />
            <span>{topic}</span>
          </label>)}</div>
          <div className="manage-row">
            <input aria-label={ui("新题组名称")} value={splitTitle} onChange={(e) => setSplitTitle(e.target.value)} placeholder={ui("新题组名称")} />
            <Button disabled={busy || !splitReady} type="submit">{ui("拆出所选主题")}</Button>
          </div>
        </form>}
      </Panel>}
      {merging && targetId && <MergeDeckDialog deck={managedDeck} target={peers.find((d) => d.id === targetId) || { title: "" }}
        onClose={() => setMerging(false)} onConfirm={async () => {
          const result = await act("deck.merge", { sourceIds: [managedDeck.id], targetId }, (moved) => {
            setPage("library"); toast.success(uiFormat("已合并 {0} 道题，全部保留", [moved.moved]));
          }, { rethrow: true });
          if (result === undefined) throw new Error(ui("另一个操作还在进行，请稍后重试。"));
        }} />}
      {!managedDeck.cards.length && <p className="muted">{slainView ? ui("斩题组为空。练习时点击“斩”，题目会收纳到这里。") : ui("当前题组没有题目。已斩的题可从斩题组恢复。")}</p>}
      <div className="manage-cards">
        {managedDeck.cards.map((card) => (
          <Panel as="article" density="compact" className={`manage-card${card.suspended ? " is-suspended" : ""}`} key={card.id}>
            <div className="manage-card__body">
              <div className="manage-card__meta">
                <Badge size="sm">{card.topic || ui("未分类")}</Badge>
                <span>{card.kind}</span>
                {card.suspended && <Badge size="sm" tone="warning">{ui("已暂停")}</Badge>}
                {marks && marks[card.id] !== reviewedCardFingerprint(card) && <Badge size="sm" tone="warning">{ui("未自动审阅")}</Badge>}
                {selfCitedCardCount([card], sources) > 0 && <Badge size="sm" tone="warning">{ui("仅有导入题目引用")}</Badge>}
              </div>
              <Markdown className="md-title manage-card__prompt" text={card.prompt} />
              {card.flag && <p className="muted">{ui("标记：")}{card.flag}</p>}
              {card.slain && <p className="muted">{ui("原题组：")}{card.slain.deckTitle} · {new Date(card.slain.at).toLocaleDateString(uiLocale())}</p>}
            </div>
            <div className="manage-card__actions">
              <Button disabled={busy} onClick={() => act(
                slainView ? "card.restore" : "card.slay",
                { deckId: managedDeck.id, cardId: card.id },
                async (result) => {
                  setManagedDeck(await call("deck.get", { id: managedDeck.id }));
                  toast.success(slainView ? uiFormat("已恢复到「{0}」",[result.title]) : ui("已移入斩题组，不再参与复习，可在斩题组恢复。"));
                },
              )}>{slainView ? ui("恢复原题组") : ui("斩")}</Button>
              <Button
                disabled={busy || slainView}
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
              </Button>
              {card.flag && (
                <Button
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
                >{ui("清除标记")}</Button>
              )}
            </div>
          </Panel>
        ))}
      </div>
    </section>
  );
}
