import { ui, uiFormat } from "./i18n.js";
import React, { useEffect, useState } from "react";

/* 音频转写设置：Gemini 免费密钥 → Groq（可选）→ Gemini 付费密钥，按这个顺序用。
   密钥只写入用户目录下的 audio.json，不进学习库、备份或快照；这里只能看到
   「已保存」和末四位。 */

const REPORT = (item) => (item.ok ? ui("可用") : item.configured === false ? ui("未配置") : uiFormat("不可用：{0}", [item.message]));

export default function AudioSettings({ busy, act, call, setNotice }) {
  const [view, setView] = useState(null), [report, setReport] = useState(null);
  const [freeKey, setFreeKey] = useState(""), [groqKey, setGroqKey] = useState(""), [paidKey, setPaidKey] = useState("");
  // Loaded with call(), not act(): act is single-flight and the settings page already loads 陪学 through it.
  useEffect(() => {
    let alive = true;
    call("audio.settings.get", {}).then((value) => alive && setView(value), () => {});
    return () => { alive = false; };
  }, [call]);
  if (!view) return null;
  const save = (patch, message) => act("audio.settings.set", patch, (next) => {
    setView(next); setFreeKey(""); setGroqKey(""); setPaidKey(""); setReport(null); setNotice(message || ui("音频设置已保存"));
  }, { refreshAfter: false });
  const keyField = (label, hint, value, setValue, field, placeholder = ui("粘贴 AI Studio 的 API 密钥")) => (
    <label>{label}
      <input type="password" autoComplete="off" spellCheck={false} value={value} onChange={(e) => setValue(e.target.value)}
        placeholder={view[field].set ? uiFormat("已保存 {0}；留空则不改", [view[field].hint]) : placeholder} />
      <small className="muted">{hint}</small>
      {view[field].set && <button type="button" className="link-btn" disabled={busy}
        onClick={() => save({ [field]: "" }, ui("已清除这把密钥"))}>{ui("清除已保存的密钥")}</button>}
    </label>
  );
  const modelField = (field, label) => <label>{ui(label)}
    <input key={view[field]} defaultValue={view[field]} disabled={busy}
      onBlur={(event) => event.target.value.trim() !== view[field] && save({ [field]: event.target.value.trim() })} />
  </label>;
  return (
    <fieldset>
      <legend>{ui("音频转写（Gemini / Groq）")}</legend>
      <p className="muted">{ui("每个请求按这个顺序试：Gemini 免费密钥 → Groq（可选，也有免费额度）→ Gemini 付费密钥；都不行才报错。两把 Gemini 密钥要来自两个不同的 Google Cloud 项目：开通计费的项目会失去免费额度。")}</p>
      <form onSubmit={(e) => {
        e.preventDefault();
        save({ ...(freeKey.trim() ? { freeKey: freeKey.trim() } : {}), ...(groqKey.trim() ? { groqKey: groqKey.trim() } : {}), ...(paidKey.trim() ? { paidKey: paidKey.trim() } : {}) });
      }}>
        {keyField(ui("免费额度密钥"), ui("来自没有开通计费的项目。免费额度下 Google 可能用内容改进产品并由人工审阅；欧盟、瑞士、英国地区不可用。"), freeKey, setFreeKey, "freeKey")}
        {keyField(ui("Groq 密钥（可选）"), ui("在 console.groq.com 创建。Groq 的免费额度用来转写（Whisper）和处理文本；每分钟和每天都有上限，用完自动改用付费密钥。选了「只用付费密钥」时不会使用。"), groqKey, setGroqKey, "groqKey", ui("粘贴 Groq 的 API 密钥（gsk_…）"))}
        {keyField(ui("付费密钥"), ui("来自开通计费并充值的项目。余额用完时请求会失败，不会自动降回免费。"), paidKey, setPaidKey, "paidKey")}
        <p className="muted">{ui("密钥只保存在你的用户目录（~/.dsh/study/audio.json），不会进入学习库、备份或对话。请不要把密钥贴到对话里。")}</p>
        <button className="primary" disabled={busy || (!freeKey.trim() && !groqKey.trim() && !paidKey.trim())}>{ui("保存密钥")}</button>{" "}
        <button type="button" disabled={busy || (!view.freeKey.set && !view.groqKey.set && !view.paidKey.set)}
          onClick={() => act("audio.test", {}, setReport, { refreshAfter: false })}>{ui("验证密钥")}</button>
        {report && <p role="status">{ui("免费密钥：")}{REPORT(report.free)}{ui(" · Groq 密钥：")}{REPORT(report.groq)}{ui(" · 付费密钥：")}{REPORT(report.paid)}</p>}
      </form>
      <details>
        <summary>{ui("高级")}</summary>
        {modelField('liveModel', '课堂实时转写模型')}
        {view.textProvider !== 'host' && modelField('liveTranslateModel', '课堂实时翻译模型')}
        <label>{ui('上下文校正推理强度')}<select value={view.liveCorrectionReasoning || 'low'} disabled={busy}
          onChange={event => save({ liveCorrectionReasoning: event.target.value })}>
          <option value="low">{ui('低（优先速度）')}</option><option value="default">{ui('模型默认')}</option>
        </select></label>
        {modelField('transcribeModel', '转写模型')}
        <label>{ui("校对与翻译用哪个模型")}
          <select value={view.textProvider} disabled={busy} onChange={(e) => save({ textProvider: e.target.value })}>
            <option value="auto">{ui("自动（有对话模型就用它，否则用 Gemini）")}</option>
            <option value="gemini">{ui("Gemini（同样先免费后付费）")}</option>
            <option value="host">{ui("对话当前使用的模型")}</option>
          </select>
        </label>
        {view.textProvider !== 'host' && modelField('textModel', 'Gemini 文本模型')}
        {modelField('groqTranscribeModel', 'Groq 转写模型')}
        {view.textProvider !== 'host' && modelField('groqTextModel', 'Groq 文本模型')}
        <label>{ui("同时处理几个录音")}
          <select value={view.audioConcurrency ?? 2} disabled={busy} onChange={(e) => save({ audioConcurrency: Number(e.target.value) })}>
            {[1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count === 2 ? uiFormat("{0} 个（默认）", [count]) : uiFormat("{0} 个", [count])}</option>)}
          </select>
          <small className="muted">{ui("多余的录音排队等候。同时处理的越多，越容易碰到免费密钥的每分钟限流（会自动等待或改用付费密钥）；同一个录音不会被同时转写两次。")}</small>
        </label>
        <label>{ui("每次请求最长")}
          <select value={view.partMinutes ?? 59} disabled={busy} onChange={(e) => save({ partMinutes: Number(e.target.value) })}>
            {[[59, "59 分钟（推荐：请求最少，最省免费额度）"], [45, "45 分钟"], [30, "30 分钟"], [20, "20 分钟"], [10, "10 分钟"]].map(([minutes, label]) =>
              <option key={minutes} value={minutes}>{ui(label)}</option>)}
          </select>
          <small className="muted">{ui("录音不超过这个长度就整段发送；更长时按最少的段数平均切开，尽量在停顿处。若长录音经常等不到回应，可以调小。")}</small>
        </label>
        <label>{ui("转写风格")}
          <select value={view.mode} disabled={busy} onChange={(e) => save({ mode: e.target.value })}>
            <option value="SMART">{ui("整理（去掉口头禅和重复，自动分段）")}</option>
            <option value="VERBATIM">{ui("逐字（保留每个字）")}</option>
          </select>
        </label>
      </details>
    </fieldset>
  );
}
