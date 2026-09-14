import React from "react";
import Icon from "./Icon.jsx";

/* 资料视图：sourceForm（添加资料的表单 JSX，定义在 App，与弹窗共用）
   通过 prop 传入。删除走 source.remove，内容查看交给 source 弹窗。 */
export default function Sources({ data, busy, act, setModal, sourceForm }) {
  return (
    <section className="page">
      <div className="page-heading">
        <div>
          <h1>资料</h1>
          <p className="muted">
            题目从这里生长。原文与引用一直保留。
          </p>
        </div>
        <button
          className="primary"
          onClick={() => setModal({ type: "add" })}
        >
          ＋ 添加资料
        </button>
      </div>
      {!data.sources.length ? (
        <div className="empty">
          <h2>还没有资料</h2>
          <p>支持 PDF、粘贴文本、Markdown 和 TXT 文件。</p>
          {sourceForm}
        </div>
      ) : (
        data.sources.map((s) => (
          <article className="source-row" key={s.id}>
            <button
              className="source-main"
              onClick={() => setModal({ type: "source", source: s })}
            >
              <Icon>▤</Icon>
              <span>
                <strong>{s.title}</strong>
                <small>
                  {s.text.length.toLocaleString()} 字符 ·{" "}
                  {s.document ? (s.document.extractionVersion === 2 ? "排版提取 v2 · " : "旧版提取，建议重新导入 · ") : ""}
                  {s.text.slice(0, 80)}
                </small>
              </span>
            </button>
            <button
              disabled={busy}
              onClick={() => act("source.remove", { id: s.id })}
            >
              移除
            </button>
          </article>
        ))
      )}
    </section>
  );
}
