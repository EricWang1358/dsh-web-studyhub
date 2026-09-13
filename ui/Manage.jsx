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
      <p className="muted">
        编辑先进入草稿；重新发布时，未改动题目保留复习进度，内容变更的题目重新开始调度。历史作答始终保留。
      </p>
      <div className="deck-actions">
        <button
          disabled={busy}
          onClick={() =>
            act("deck.edit", { id: managedDeck.id }, openDraft)
          }
        >
          编辑题组
        </button>
        <button
          disabled={busy}
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
      {managedDeck.cards.map((card) => (
        <article className="deck" key={card.id}>
          <small>
            {card.topic} · {card.kind}
            {card.suspended ? " · 已暂停" : ""}
          </small>
          <Markdown className="md-title" text={card.prompt} />
          {card.flag && <p className="muted">标记：{card.flag}</p>}
          <div className="deck-actions">
            <button
              disabled={busy}
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
