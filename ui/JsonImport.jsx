import React, { useRef, useState } from "react";
import { kinds } from "./shared.js";
import { importExample, importPrompt } from "./json-prompts.js";

export default function JsonImport({ busy, act, call, openDraft, setNotice }) {
  const [text, setText] = useState("");
  const [kind, setKind] = useState("mixed");
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const [proposal, setProposal] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [merge, setMerge] = useState(false);
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
      if (request === fileRead.current) { setText(value); setProposal(null); }
    } catch (error) { if (request === fileRead.current) setMessage(error.message); }
    finally { if (request === fileRead.current) setReading(false); }
  }
  return <div>
    <p className="muted">粘贴 JSON 或读取 JSON/TXT 文件（TXT 内也需为 JSON）。支持五种题型混合导入。导入时建议标题和课程，确认后保存草稿；发布时快速校验并直接开始学习。</p>
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
    <form onSubmit={async (e) => {
      e.preventDefault();
      if (!proposal) {
        setProposing(true);
        try { setProposal(await call("draft.import.propose", { text })); }
        catch (error) { setMessage(error.message); }
        finally { setProposing(false); }
      } else act("draft.import", { text, title: proposal.title, course: proposal.course,
        ...(merge && proposal.mergeTargetId ? { mergeTargetId: proposal.mergeTargetId } : {}) }, (deck) => {
          setNotice(`已导入「${deck.title}」共 ${deck.cards.length} 题。可检查后直接发布。`);
          openDraft(deck);
        });
    }}>
      <fieldset><legend>02 / 导入题组</legend>
        <label>读取 JSON / TXT 文件<input type="file" accept=".json,.txt,application/json,text/plain" disabled={busy || reading} onChange={readFile} /></label>
        <label>JSON 内容<textarea rows={14} required value={text} disabled={busy || reading} onChange={(e) => { setText(e.target.value); setProposal(null); }} placeholder={'{"title":"题组名称","cards":[...]}'} /></label>
        {proposal && <div className="import-proposal">
          <p className="muted">{proposal.method === "ai" ? "AI 建议，请确认或修改" : "初步整理建议，请确认或修改"} · 原标题：{proposal.originalTitle}</p>
          <label>短标题<input value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} /></label>
          <label>所属课程<input value={proposal.course} onChange={(e) => setProposal({ ...proposal, course: e.target.value, mergeTargetId: null })} /></label>
          {proposal.mergeTargetId && <label><input type="checkbox" checked={merge} onChange={(e) => setMerge(e.target.checked)} />发布时并入建议的同知识点题组（保留全部题和记录）</label>}
        </div>}
        <button className="primary" disabled={busy || reading || proposing || !text.trim()}>{reading ? "正在读取文件…" : proposing ? "正在整理建议…" : proposal ? "确认并导入草稿 →" : "检查并建议归类 →"}</button>
      </fieldset>
    </form>
    {message && <p role="status">{message}</p>}
  </div>;
}
