import { open } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { pageText } from "./pdf-text.js";

export const MAX_PDF_BYTES = 8 * 1024 * 1024;
export const MAX_REQUEST_BYTES = 12 * 1024 * 1024;

// Read only an explicitly supplied file. Never execute document content or fetch URLs.
export async function extractPdf(input) {
  if (!!input.path === !!input.dataBase64)
    throw new Error("Provide exactly one PDF path or dataBase64");
  let bytes;
  const filename = path.basename(input.filename || input.path || "document.pdf");
  if (input.path) {
    if (!path.isAbsolute(input.path)) throw new Error("PDF 文件路径必须是绝对路径");
    const file = await open(input.path, "r");
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_PDF_BYTES)
        throw new Error("请选择不超过 8 MB 的 PDF 文件");
      // A bounded read also protects against a file growing after stat().
      bytes = Buffer.alloc(MAX_PDF_BYTES + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      bytes = bytes.subarray(0, offset);
    } finally { await file.close(); }
  } else {
    if (typeof input.dataBase64 !== "string" || input.dataBase64.length > Math.ceil(MAX_PDF_BYTES / 3) * 4 ||
        input.dataBase64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.dataBase64))
      throw new Error("PDF 文件无效或超过 8 MB");
    bytes = Buffer.from(input.dataBase64, "base64");
  }
  if (bytes.length > MAX_PDF_BYTES || !bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    throw new Error("文件不是有效 PDF，或超过 8 MB");
  const documentId = createHash("sha256").update(bytes).digest("hex");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assets = new URL("../../", import.meta.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const assetPath = (dir) => fileURLToPath(new URL(dir + "/", assets)).replaceAll("\\", "/");
  const loading = getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true,
    cMapUrl: assetPath("cmaps"),
    standardFontDataUrl: assetPath("standard_fonts"),
    wasmUrl: assetPath("wasm"),
    useWorkerFetch: false,
  });
  try {
    const pdf = await loading.promise;
    if (pdf.numPages > 200) throw new Error("PDF 超过 200 页，请先按章节拆分");
    const pages = input.pages ?? Array.from({ length: pdf.numPages }, (_, i) => i + 1);
    if (!Array.isArray(pages) || !pages.length || pages.some((n) => !Number.isInteger(n) || n < 1 || n > pdf.numPages))
      throw new Error(`页码超出 PDF 范围（共 ${pdf.numPages} 页），请重新选择`);
    const selectedPages = [...new Set(pages)].sort((a, b) => a - b);
    const sources = [], skippedPages = [], sparsePages = [];
    let chars = 0;
    for (const number of selectedPages) {
      const page = await pdf.getPage(number);
      const content = await page.getTextContent();
      const { text, warnings } = pageText(content.items, page.getViewport({ scale: 1 }));
      page.cleanup();
      const textChars = text.replace(/\s/g, "").length;
      if (textChars < 12) { skippedPages.push(number); continue; }
      const sparseText = textChars < 100;
      if (sparseText) sparsePages.push(number);
      chars += text.length;
      if (chars > 600000) throw new Error("所选 PDF 页面的文字超过 600,000 字符，请减少页数");
      // Version the extracted source, not the PDF identity. Existing citations
      // keep their original text when the same file is imported with a new parser.
      sources.push({ id: `pdf-${documentId}-text2-p${number}`, title: `${filename} · p.${number}`, text,
        document: { id: documentId, filename, page: number, totalPages: pdf.numPages, extractionVersion: 2, sparseText, warnings } });
    }
    if (!sources.length) throw new Error(`所选 ${selectedPages.length} 页均未提取到足够文字（第 ${skippedPages.join("、")} 页）。若是扫描件，请先 OCR 后重新导入；本次没有保存资料。`);
    return { documentId, filename, totalPages: pdf.numPages, selectedPages, sources, skippedPages, sparsePages,
      warnings: [
        ...(skippedPages.length ? [`Pages ${skippedPages.join(", ")} have insufficient text and were skipped. Images and diagrams require visual review or OCR.`] : []),
        ...(sparsePages.length ? [`Pages ${sparsePages.join(", ")} have very little extractable text. Check whether the main content is an image and needs OCR.`] : []),
      ],
      notice: "Text extraction does not interpret diagrams, formulas or reading order; review extracted pages before generating." };
  } finally { await loading.destroy(); }
}
