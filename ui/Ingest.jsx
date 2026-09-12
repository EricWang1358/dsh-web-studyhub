import React, { useState } from "react";

const KINDS = [
  ["auto", "自动识别", "有选项保持单选/多选，没有选项做成问答闪卡"],
  ["flashcard", "闪卡", "一律做成问答闪卡"],
  ["quiz", "单选 MQ", "一律做成单选，没有选项的补干扰项"],
  ["multi", "多选", "一律做成多选"],
  ["open", "开放问答", "需要论述的题，附评分标准"],
];
const MISTAKES = [
  ["auto", "按我标注的", "标了自己选错的才记为错题"],
  ["all", "全部当错题", "这批都是错题记录，全部优先复习"],
  ["none", "都不算错题", "只是收集题目"],
];

/** Setup for recording questions straight from the conversation. */
export default function Ingest({ data, busy, start }) {
  const [target, setTarget] = useState(data.decks.find((d) => !d.archived)?.id || "new"),
    [title, setTitle] = useState(""),
    [folder, setFolder] = useState(""),
    [kind, setKind] = useState("auto"),
    [mistakes, setMistakes] = useState("auto");
  const decks = data.decks.filter((d) => !d.archived);
  const newDeck = target === "new";
  return (
    <form
      className="ingest-setup"
      onSubmit={(e) => {
        e.preventDefault();
        start({
          ...(newDeck ? { deckTitle: title.trim(), folder } : { deckId: target }),
          kind,
          mistakes,
        });
      }}
    >
      <p className="muted">
        刷题软件、Canvas 错题记录、截图都可以直接贴进对话。开启后这段对话里贴的题会自动录入，不需要先整理成文档；贴的原文会作为这些题的资料保存。
      </p>
      <fieldset>
        <legend>01 / 放进哪个题组</legend>
        <label>
          题组
          <select value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="new">＋ 新建题组</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.folder ? `${d.folder} › ` : ""}
                {d.title}
              </option>
            ))}
          </select>
        </label>
        {newDeck && (
          <div className="two-col">
            <label>
              题组名称
              <input
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="例如：SWE5006 Canvas 错题"
              />
            </label>
            <label>
              所在目录（可选）
              <input
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
                placeholder="例如：SWE5006 / Module 3"
              />
            </label>
          </div>
        )}
      </fieldset>
      <fieldset>
        <legend>02 / 题型</legend>
        <div className="choice-grid">
          {KINDS.map(([id, label, note]) => (
            <button
              type="button"
              key={id}
              className={kind === id ? "kind selected" : "kind"}
              aria-pressed={kind === id}
              title={note}
              onClick={() => setKind(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <small>{KINDS.find(([id]) => id === kind)[2]}</small>
      </fieldset>
      <fieldset>
        <legend>03 / 错题怎么记</legend>
        <div className="choice-grid three">
          {MISTAKES.map(([id, label, note]) => (
            <button
              type="button"
              key={id}
              className={mistakes === id ? "kind selected" : "kind"}
              aria-pressed={mistakes === id}
              title={note}
              onClick={() => setMistakes(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <small>{MISTAKES.find(([id]) => id === mistakes)[2]}。错题会记为「薄弱」，学习路径优先出。</small>
      </fieldset>
      {!data.modelReady && (
        <p className="warning">当前会话没有可用模型，录题需要模型整理题目。</p>
      )}
      <button className="primary wide" disabled={busy || !data.modelReady || (newDeck && !title.trim())}>
        开始录题 → 去对话里粘贴
      </button>
    </form>
  );
}
