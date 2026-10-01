import { ui, uiFormat } from "./i18n.js";
import React, { useState } from "react";
import CourseField, { parseCourses } from './CourseField.jsx';
import { usePageScope } from './PageScope.jsx';
import { FileDrop, InlineMessage } from './components/index.js';
import { fileToBase64, plainImportError, MAX_DOCUMENT_BYTES } from './ImportHub.jsx';

/** What happened to the chosen pages, in sentences that never contradict each other (P25). */
export function pdfImportSummary(result) {
  const extracted = result.sourceIds?.length ?? result.sources?.length ?? 0;
  const skipped = result.skippedPages || [], sparse = result.sparsePages || [];
  const chosen = result.selectedPages?.length ?? extracted + skipped.length;
  const pages = list => list.join(ui("、"));
  const lines = [uiFormat("所选 {0} 页中，{1} 页已保存为可出题的文字（新保存 {2} 页，已导入过的页沿用原记录）。", [chosen, extracted, result.added ?? 0])];
  if (sparse.length) lines.push(uiFormat("其中第 {0} 页文字很少，可能只有页眉、页脚或标题；请核对正文是否为图片，需要时先 OCR 再重新导入。", [pages(sparse)]));
  if (skipped.length) lines.push(uiFormat("第 {0} 页没有可提取的文字，已跳过。若是扫描页，请先 OCR 后重新导入。", [pages(skipped)]));
  return lines;
}

function parsePages(text) {
  const selected = [];
  for (const part of text.split(/[,，]/)) {
    const match = part.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    const start = Number(match?.[1]), end = Number(match?.[2] ?? match?.[1]);
    if (!match || start < 1 || end < start || end > 200) throw new Error(ui("页码格式如 2-8, 11，范围为 1–200。"));
    for (let n = start; n <= end; n++) selected.push(n);
  }
  return selected;
}

/* A PDF with an optional page range. Saved through materials.document.import,
   so the original file is kept and the pages open as one document. */
export default function PdfImport({ busy, act, onImported, data, courseText, onCourseTextChange, defaultCourse }) {
  const [storedCourses, setStoredCourses] = usePageScope(data?.root, 'pdf-import-courses', defaultCourse ?? data?.focus?.course ?? '');
  const courses = courseText ?? storedCourses, setCourses = onCourseTextChange || setStoredCourses;
  const [reading, setReading] = useState(null);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");
  const [pages, setPages] = useState("");
  const [fullText, setFullText] = useState({});
  async function importFile([file]) {
    if (!file) return;
    setError(""); setResult(null); setReading(file.name);
    try {
      const selected = pages.trim() ? parsePages(pages) : [];
      const value = await act("materials.document.import", { filename: file.name, dataBase64: await fileToBase64(file), courses: parseCourses(courses),
        ...(selected.length ? { pages: selected } : {}) }, undefined, { rethrow: true });
      if (!value) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
      if (!value.sourceIds?.length) throw new Error(ui("没有读到可用的文字，可能是扫描件或图片。请先做文字识别（OCR）再导入。"));
      const records = new Map((value.document?.sources || []).map(source => [source.id, source]));
      const previews = value.sourceIds.map(id => records.get(id)).filter(Boolean)
        .map(({ text, ...source }) => ({ ...source, chars: text.length, preview: text.slice(0, 300) }));
      setResult({ ...value, sources: previews });
      onImported?.(value.sourceIds);
    } catch (failure) { setError(plainImportError(failure)); }
    finally { setReading(null); }
  }
  return <div className="pdf-import">
    <strong>{ui("PDF / 讲义 → 新题")}</strong>
    <p className="muted">{ui("按页提取并保留出处，导入后可取消勾选封面、目录或不想练的页面。扫描件需先 OCR；图表与公式请核对原文。")}</p>
    <CourseField value={courses} onChange={setCourses} courses={data?.focus?.courses} multiple disabled={busy || !!reading} />
    <label>{ui("导入页码（可选）")}<input value={pages} onChange={(e) => setPages(e.target.value)} placeholder={ui("全部页面；或 2-8, 11")} disabled={busy || !!reading} /></label>
    <FileDrop compact accept={[".pdf"]} maxBytes={MAX_DOCUMENT_BYTES} busy={!!reading} disabled={busy && !reading}
      label={reading ? ui("正在提取 PDF…") : ui("把 PDF 拖到这里")} hint={ui("最多 8 MB / 200 页")} buttonLabel={ui("选择 PDF")}
      onFiles={accepted => void importFile(accepted)} />
    {error && <InlineMessage>{error}</InlineMessage>}
    {result && <div role="status">
      {pdfImportSummary(result).map((line, index) => <p key={index} className={index ? "warning" : undefined}>{line}</p>)}
      <p className="muted">{ui("出题只会使用已提取的文字。图片、图表和公式未被理解；生成前请对照原 PDF 核对下方预览。")}</p>
      {result.sources.some((s) => s.document?.warnings?.length) && <p className="warning">{ui("部分页面存在分栏、旋转或分散文字，提取顺序需要对照原 PDF 核对。")}</p>}
      <details><summary>{ui("查看逐页提取预览")}</summary>{result.sources.map((s) => {
        const shown = fullText[s.id] ?? s.preview;
        return <div key={s.id}>
          <strong>{s.title}</strong>
          {s.document?.warnings?.length > 0 && <p className="warning">{ui("本页含分散文字区域或旋转文字，请对照原 PDF 核对；提取顺序不能代表箭头、表格或分栏的语义关系。")}</p>}
          {s.document?.sparseText && <p className="warning">{ui("本页文字偏少；预览可能遗漏图片中的正文。")}</p>}
          <pre className="pdf-extracted-text">{shown}</pre>
          {shown.length < s.chars && <>
            <small>{ui("当前显示 ")}{shown.length} / {s.chars}{ui(" 字符，后文尚未显示。")}</small>{" "}
            <button type="button" disabled={busy} onClick={() => act("source.get", { id: s.id, offset: fullText[s.id]?.length || 0, limit: 60000 }, (page) =>
              setFullText((texts) => ({ ...texts, [s.id]: (texts[s.id] || "") + page.text }))) }>
              {fullText[s.id] ? ui("继续读取后文") : ui("查看完整提取文字")}
            </button>
          </>}
        </div>;
      })}</details>
    </div>}
  </div>;
}
