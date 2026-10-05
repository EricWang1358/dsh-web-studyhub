import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import React, { useRef, useState } from "react";
import { kinds } from "./shared.js";
import { importExample, importPrompt } from "./json-prompts.js";
import CourseField from './CourseField.jsx';
import { Button, Checkbox, FileDrop, InlineMessage, useToast } from './components/index.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import { useStudy } from './study-context.jsx';

export default function JsonImport({ data, openDraft }) {
  const { busy, act, call } = useStudy();
  const toast = useToast();
  const [text, setText] = useState("");
  const [kind, setKind] = useState("mixed");
  const [reading, setReading] = useState(false);
  const [message, setMessage] = useState("");
  const promptCopy = useCopyFeedback(() => importPrompt(kind, kinds[kind], getUiLanguage()));
  const [proposal, setProposal] = useState(null);
  const [proposing, setProposing] = useState(false);
  const [merge, setMerge] = useState(false);
  const fileRead = useRef(0);
  async function readFile([file]) {
    if (!file) return;
    const request = ++fileRead.current;
    setReading(true);
    setMessage("");
    try {
      if (!/\.(json|txt)$/i.test(file.name)) throw new Error(ui("请选择 .json 或 .txt 文件"));
      if (file.size > 2_000_000) throw new Error(ui("文件不能超过 2 MB"));
      const value = await file.text();
      if (value.length > 500_000) throw new Error(ui("导入内容不能超过 500,000 字符"));
      if (request === fileRead.current) { setText(value); setProposal(null); setMerge(false); }
    } catch (error) { if (request === fileRead.current) setMessage(error.message); }
    finally { if (request === fileRead.current) setReading(false); }
  }
  return <div>
    <p className="muted">{ui("粘贴 JSON 或读取 JSON/TXT 文件（TXT 内也需为 JSON）。支持五种题型混合导入。导入时建议标题和课程，确认后保存草稿；发布时快速校验并直接开始学习。")}</p>
    <fieldset>
      <legend>{ui("01 / 各题型 JSON 提示词")}</legend>
      <label>{ui("题型")}<select value={kind} onChange={(e) => { setKind(e.target.value); setMessage(""); }}>{Object.entries({ mixed: ui("混合题型（一次复制全部）"), ...kinds }).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label>{ui("复制给 AI，追加你的资料与出题要求")}<textarea readOnly rows={8} value={importPrompt(kind, kinds[kind], getUiLanguage())} /></label>
      <Button icon={promptCopy.copied ? "check" : undefined} onClick={async () => {
        setMessage("");
        if (!(await promptCopy.copy())) setMessage(ui("无法访问剪贴板，请在上方文本框中手动复制提示词"));
      }}>{promptCopy.copied ? ui("提示词已复制") : ui("复制提示词")}</Button>
      <details><summary>{ui("查看 JSON 格式示例")}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{importExample(kind, getUiLanguage())}</pre></details>
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
          toast.success(uiFormat("已导入「{0}」共 {1} 题。可检查后直接发布。",[deck.title,deck.cards.length]));
          openDraft(deck);
        });
    }}>
      <fieldset><legend>{ui("02 / 导入题组")}</legend>
        <FileDrop compact accept={[".json", ".txt"]} maxBytes={2_000_000} busy={reading} disabled={busy || proposing}
          label={ui("把 JSON 题组文件拖到这里")} hint={ui("JSON 或内容为 JSON 的 TXT · 最大 2 MB")} buttonLabel={ui("读取 JSON / TXT 文件")}
          onFiles={accepted => void readFile(accepted)} />
        <label>{ui("JSON 内容")}<textarea rows={14} required value={text} disabled={busy || reading || proposing} onChange={(e) => { setText(e.target.value); setProposal(null); setMerge(false); }} placeholder={ui("{\"title\":\"题组名称\",\"cards\":[...]}")} /></label>
        {proposal && <div className="import-proposal">
          <p className="muted">{uiFormat("{0} · 原标题：{1}", [proposal.method === "ai" ? ui("AI 建议，请确认或修改") : ui("初步整理建议，请确认或修改"), proposal.originalTitle])}</p>
          <label>{ui("短标题")}<input value={proposal.title} onChange={(e) => setProposal({ ...proposal, title: e.target.value })} /></label>
          <CourseField label={ui('所属课程')} courses={data?.focus?.courses || []} value={proposal.course}
            onChange={course => { setProposal({ ...proposal, course, mergeTargetId: null }); setMerge(false); }} />
          {proposal.mergeTargetId && <Checkbox checked={merge} onChange={setMerge} label={ui("发布时并入建议的同知识点题组（保留全部题和记录）")} />}
          {proposal.mergeTargetId && <p className="muted">{data?.decks?.find(deck => deck.id === proposal.mergeTargetId)?.title} · {proposal.course || ui('未分类')}</p>}
        </div>}
        <Button type="submit" variant="primary" busy={reading || proposing} busyLabel={reading ? ui("正在读取文件…") : ui("正在整理建议…")} disabled={busy || !text.trim()}>{proposal ? ui("确认并导入草稿 →") : ui("检查并建议归类 →")}</Button>
      </fieldset>
    </form>
    {message && <InlineMessage tone="error">{message}</InlineMessage>}
  </div>;
}
