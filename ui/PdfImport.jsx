import React, { useState } from "react";

export default function PdfImport({ busy, act, onImported }) {
  const [reading, setReading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [pages, setPages] = useState("");
  const [fullText, setFullText] = useState({});
  async function importFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError(""); setResult(null); setReading(true);
    try {
      if (file.size > 8 * 1024 * 1024) throw new Error("PDF 最大 8 MB，请先按章节拆分。");
      const selected = [];
      if (pages.trim()) {
        for (const part of pages.split(/[,，]/)) {
          const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
          const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
          if (!match || start < 1 || end < start || end > 200) throw new Error("页码格式如 2-8, 11，范围为 1–200。");
          for (let n = start; n <= end; n++) selected.push(n);
        }
      }
      const dataBase64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(",")[1]);
        reader.onerror = () => reject(new Error("读取文件失败，请重试。"));
        reader.readAsDataURL(file);
      });
      await act("source.import", { filename: file.name, dataBase64, ...(selected.length ? { pages: selected } : {}) }, (value) => {
        setResult(value); onImported(value.sourceIds);
      });
    } catch (e) { setError(e.message); }
    finally { setReading(false); }
  }
  return <div className="pdf-import">
    <strong>PDF / 讲义 → 新题</strong>
    <p className="muted">按页提取并保留出处，导入后可取消勾选封面、目录或不想练的页面。扫描件需先 OCR；图表与公式请核对原文。</p>
    <label>导入页码（可选）<input value={pages} onChange={(e) => setPages(e.target.value)} placeholder="全部页面；或 2-8, 11" disabled={busy || reading} /></label>
    <label>{reading ? "正在提取 PDF…" : "选择 PDF（最多 8 MB / 200 页）"}
      <input type="file" accept=".pdf,application/pdf" disabled={busy || reading} onChange={importFile} />
    </label>
    {error && <p role="alert" className="warning">{error}</p>}
    {result && <div role="status">
      <p>已选择 {result.sources.length} 页资料（新保存 {result.added} 页，重复页自动复用）。请核对下方提取预览。</p>
      {result.legacyPages > 0 && <p className="warning">其中 {result.legacyPages} 页已使用新版排版提取。旧版来源保留以保护已有题目的引用，本次选择的是新版。</p>}
      {result.skippedPages.length > 0 && <p className="warning">第 {result.skippedPages.join("、")} 页没有足够文字，已跳过。若是扫描页，请先 OCR 后重新导入。</p>}
      <details><summary>查看逐页提取预览</summary>{result.sources.map((s) => {
        const shown = fullText[s.id] ?? s.preview;
        return <div key={s.id}>
          <strong>{s.title}</strong>
          {s.document?.warnings?.length > 0 && <p className="warning">本页含分散文字区域或旋转文字，请对照原 PDF 核对；提取顺序不能代表箭头、表格或分栏的语义关系。</p>}
          <pre className="pdf-extracted-text">{shown}</pre>
          {shown.length < s.chars && <>
            <small>当前显示 {shown.length} / {s.chars} 字符，后文尚未显示。</small>{" "}
            <button type="button" disabled={busy} onClick={() => act("source.get", { id: s.id, offset: fullText[s.id]?.length || 0, limit: 60000 }, (page) =>
              setFullText((texts) => ({ ...texts, [s.id]: (texts[s.id] || "") + page.text }))) }>
              {fullText[s.id] ? "继续读取后文" : "查看完整提取文字"}
            </button>
          </>}
        </div>;
      })}</details>
    </div>}
  </div>;
}
