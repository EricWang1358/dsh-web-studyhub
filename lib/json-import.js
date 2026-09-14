import { id } from "./util.js";
import { validateDeck } from "./domain.js";

export const MAX_JSON_IMPORT_CHARS = 500_000;

/** Prepare everything before the caller writes either the source or the draft. */
export function prepareJsonImport(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("请粘贴 JSON 或选择 JSON/TXT 文件");
  if (text.length > MAX_JSON_IMPORT_CHARS) throw new Error("导入内容不能超过 500,000 字符");
  const raw = text.replace(/^\uFEFF/, "").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let input;
  try { input = JSON.parse(raw); } catch (error) { throw new Error(`JSON 格式错误：${error.message}`); }
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("JSON 顶层必须是包含 title 和 cards 的对象");
  if (!Array.isArray(input.cards) || !input.cards.length) throw new Error("cards 必须包含至少一道题");
  if (input.folder !== undefined && typeof input.folder !== "string") throw new Error("folder 必须为字符串");
  const source = { id: id(), title: `JSON 导入：${typeof input.title === "string" ? input.title : "未命名"}`, text: raw, createdAt: new Date().toISOString() };
  const cards = input.cards.map((q, i) => {
    if (!q || Array.isArray(q) || typeof q !== "object") throw new Error(`第 ${i + 1} 题必须是对象`);
    if (q.options !== undefined && (!Array.isArray(q.options) || q.options.some((o) => !o || typeof o !== "object" || Array.isArray(o)))) throw new Error(`第 ${i + 1} 题：options 必须为选项对象数组`);
    const card = { id: id() };
    for (const key of ["kind", "topic", "objective", "prompt", "answer", "hint", "explanation", "misconception", "rubric", "options", "cloze"]) {
      if (q[key] !== undefined) card[key] = structuredClone(q[key]);
    }
    card.citations = [{ sourceId: source.id, quote: JSON.stringify(q, null, 2) }];
    return card;
  });
  // Use a canonical JSON source so citations also match minified input.
  source.text = input.cards.map((q) => JSON.stringify(q, null, 2)).join("\n\n");
  const deck = { id: id(), title: input.title, folder: input.folder || "", cards, createdAt: source.createdAt, draftVersion: 1 };
  const report = validateDeck(deck, [source]);
  if (report.errors.length) throw new Error(`导入校验失败：\n${report.errors.join("\n")}`);
  deck.quality = { ...report, warnings: [...report.warnings, "外部 JSON 导入：引用仅保留导入内容，尚未经过模型审阅，请核对答案与解析。"] };
  return { source, deck };
}
