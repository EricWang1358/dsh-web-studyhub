import React, { useRef, useState } from "react";
import { kinds } from "./shared.js";
import { importExample, importPrompt } from "./json-prompts.js";

export default function JsonImport({ busy, act, setPage, setNotice }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("mixed");
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const fileRead = useRef(0);
  async function readFile(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++fileRead.current;
    setReading(true);
    setMessage("");
    try {
      if (!/\.(json|txt)$/i.test(file.name)) throw new Error("请选择 .json 或 .txt 文件");
      if (file.size > 2_000_000) throw new Error("文件不能超过 2 MB");
      const value = await file.text();
      if (value.length > 500_000) throw new Error("导入内容不能超过 500,000 字符");
      if (request === fileRead.current) setText(value);
    } catch (error) { if (request === fileRead.current) setMessage(error.message); }
    finally { if (request === fileRead.current) setReading(false); }
  }
  return <div>
    <p className="muted">粘贴 JSON 或读取 JSON/TXT 文件（TXT 内也需为 JSON）。支持五种题型混合导入，每组至少 1 题，不限制题目总数。导入无需模型，保存为草稿后审阅发布。</p>
    <fieldset>
      <legend>01 / 各题型 JSON 提示词</legend>
      <label>题型<select value={kind} onChange={(e) => { setKind(e.target.value); setMessage(""); }}>{Object.entries({ mixed: "混合题型（一次复制全部）", ...kinds }).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>复制给 AI，追加你的资料与出题要求<textarea readOnly rows={8} value={importPrompt(kind, kinds[kind])} /></label>
      <button type="button" onClick={async () => {
        try { await navigator.clipboard.writeText(importPrompt(kind, kinds[kind])); setMessage("提示词已复制"); }
        catch { setMessage("无法访问剪贴板，请在上方文本框中手动复制提示词"); }
      }}>复制提示词</button>
      <details><summary>查看 JSON 格式示例</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{importExample(kind)}</pre></details>
    </fieldset>
    <form onSubmit={(e) => {
      e.preventDefault();
      act("draft.import", { text }, (deck) => {
        setNotice(`已导入「${deck.title}」共 ${deck.cards.length} 题，请在待审阅列表核对答案并发布。`);
        setPage("library");
      });
    }}>
      <fieldset><legend>02 / 导入题组</legend>
        <label>读取 JSON / TXT 文件<input type="file" accept=".json,.txt,application/json,text/plain" disabled={busy || reading} onChange={readFile} /></label>
        <label>JSON 内容<textarea rows={14} required value={text} disabled={busy || reading} onChange={(e) => setText(e.target.value)} placeholder={'{"title":"题组名称","cards":[...]}'} /></label>
        <p className="muted">外部导入不会执行模型质量审阅。引用保存的是导入内容，请自行核对答案与解析。</p>
        <button className="primary" disabled={busy || reading || !text.trim()}>{reading ? "正在读取文件…" : "校验并导入草稿 →"}</button>
      </fieldset>
    </form>
    {message && <p role="status">{message}</p>}
  </div>;
}
