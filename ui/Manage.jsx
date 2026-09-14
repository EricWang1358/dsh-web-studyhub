import React from "react";
import Markdown from "./Markdown.jsx";

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
  setManagedDeck,
  folderDraft,
  setFolderDraft,
}) {
  return (
    <section className="page">
      <h1>{managedDeck.title}</h1>
      {managedDeck.systemKind === "slain" && <p className="muted">本工作区唯一的斩题组。这里的题不参与复习，作答历史和复习进度保留，可恢复到原题组。</p>}
      {managedDeck.systemKind !== "slain" && <p className="muted">
        编辑先进入草稿；重新发布时，未改动题目保留复习进度，内容变更的题目重新开始调度。历史作答始终保留。
      </p>}
      <div className="deck-actions">
        <button
          disabled={busy || managedDeck.systemKind === "slain"}
          onClick={() =>
            act("deck.edit", { id: managedDeck.id }, openDraft)
          }
        >
          编辑题组
        </button>
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
          {managedDeck.archived ? "恢复题组" : "归档题组并结束练习"}
        </button>
        <button onClick={() => setPage("library")}>返回学习库</button>
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
              setNotice(moved.folder ? `已放入目录「${moved.folder}」` : "已移到目录顶层");
            },
          );
        }}
      >
        <input
          aria-label="所在目录"
          value={folderDraft}
          onChange={(e) => setFolderDraft(e.target.value)}
          placeholder="所在目录，例如：设计模式 / 第 4 章（留空为顶层）"
        />
        <button disabled={busy || folderDraft === (managedDeck.folder || "")}>
          保存目录
        </button>
      </form>
      {!managedDeck.cards.length && <p className="muted">{managedDeck.systemKind === "slain" ? "斩题组为空。练习时点击“斩”，题目会收纳到这里。" : "当前题组没有题目。已斩的题可从斩题组恢复。"}</p>}
      {managedDeck.cards.map((card) => (
        <article className="deck" key={card.id}>
          <small>
            {card.topic} · {card.kind}
            {card.suspended ? " · 已暂停" : ""}
          </small>
          <Markdown className="md-title" text={card.prompt} />
          {card.flag && <p className="muted">标记：{card.flag}</p>}
          {card.slain && <p className="muted">原题组：{card.slain.deckTitle} · {new Date(card.slain.at).toLocaleDateString("zh-CN")}</p>}
          <div className="deck-actions">
            <button disabled={busy} onClick={() => act(
              managedDeck.systemKind === "slain" ? "card.restore" : "card.slay",
              { deckId: managedDeck.id, cardId: card.id },
              async (result) => {
                setManagedDeck(await call("deck.get", { id: managedDeck.id }));
                setNotice(managedDeck.systemKind === "slain" ? `已恢复到「${result.title}」` : "已移入斩题组，不再参与复习，可在斩题组恢复。");
              },
            )}>{managedDeck.systemKind === "slain" ? "恢复原题组" : "斩"}</button>
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
              {card.suspended ? "恢复学习" : "暂停此题"}
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
              >
                清除标记
              </button>
            )}
          </div>
        </article>
      ))}
    </section>
  );
}
