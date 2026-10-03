import { id } from "./util.js";
import { draftShapeErrors, quoteFound, validateDeck } from "./domain.js";
import { normalizeEditableDraftCard } from "./draft-fields.js";
import { isJsonCardSource, JSON_CARD_SOURCE } from "./source-provenance.js";
import { hasTitle } from "./document-title.js";
import { repairTexEscapes, restoreTexControlChars } from "./tex-text.js";

export const MAX_JSON_IMPORT_CHARS = 500_000;

/** Prepare everything before the caller writes either the source or the draft. */
export function prepareJsonImport(text, existingSources = []) {
  if (typeof text !== "string" || !text.trim()) throw new Error("请粘贴 JSON 或选择 JSON/TXT 文件");
  if (text.length > MAX_JSON_IMPORT_CHARS) throw new Error("导入内容不能超过 500,000 字符");
  const raw = text.replace(/^\uFEFF/, "").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let input;
  // A valid user-authored JSON file is authoritative, including real tabs and newlines.
  try { input = JSON.parse(raw); }
  catch (error) {
    // LaTeX that was not double-escaped for JSON (\( \alpha) is repaired; any other error stays an error.
    const repaired = repairTexEscapes(raw);
    try { if (repaired === raw) throw error; input = restoreTexControlChars(JSON.parse(repaired)); }
    catch { throw new Error(`JSON 格式错误：${error.message}`); }
  }
  if (!input || Array.isArray(input) || typeof input !== "object") throw new Error("JSON 顶层必须是包含 title 和 cards 的对象");
  if (!Array.isArray(input.cards) || !input.cards.length) throw new Error("cards 必须包含至少一道题");
  if (input.folder !== undefined && typeof input.folder !== "string") throw new Error("folder 必须为字符串");
  if (input.course !== undefined && (typeof input.course !== "string" || input.course.trim().length > 200))
    throw new Error("course 必须是不超过 200 字的字符串");
  const source = { id: id(), title: `JSON 导入：${typeof input.title === "string" ? input.title : "未命名"}`,
    text: raw, provenance: JSON_CARD_SOURCE, createdAt: new Date().toISOString() };
  let unmatchedCitations = 0;
  const cards = input.cards.map((q, i) => {
    if (!q || Array.isArray(q) || typeof q !== "object") throw new Error(`第 ${i + 1} 题必须是对象`);
    const card = { id: id() };
    for (const key of ["kind", "topic", "objective", "prompt", "answer", "hint", "explanation", "misconception", "rubric", "options", "cloze"]) {
      if (q[key] !== undefined) card[key] = structuredClone(q[key]);
    }
    const matched = [];
    if (q.citations !== undefined && !Array.isArray(q.citations)) unmatchedCitations++;
    for (const ref of Array.isArray(q.citations) ? q.citations : []) {
      const quote = typeof ref?.quote === "string" ? ref.quote.trim() : "";
      const candidates = quote.length >= 12 ? existingSources.filter((candidate) =>
        !isJsonCardSource(candidate) &&
        (!ref?.sourceId || candidate.id === ref.sourceId) &&
        (!ref?.sourceTitle || hasTitle(candidate, ref.sourceTitle)) &&
        quoteFound(candidate.text, quote)) : [];
      if (candidates.length !== 1) { unmatchedCitations++; continue; }
      if (!matched.some((item) => item.sourceId === candidates[0].id && item.quote === quote))
        matched.push({ sourceId: candidates[0].id, quote });
    }
    card.importedFromJson = true;
    card.citations = matched;
    return normalizeEditableDraftCard(card);
  });
  // Keep the original import as provenance, without treating a question as its own evidence.
  source.text = input.cards.map((q) => JSON.stringify(q, null, 2)).join("\n\n");
  const deck = { id: id(), title: input.title, folder: input.folder || "",
    ...(input.course !== undefined ? { course: input.course.trim() } : {}),
    cards, createdAt: source.createdAt, draftVersion: 1 };
  const shapeErrors = draftShapeErrors(deck);
  if (shapeErrors.length) throw new Error(`导入结构错误：\n${shapeErrors.join("\n")}`);
  const report = validateDeck(deck, [source, ...existingSources]);
  deck.quality = { ...report, warnings: [...report.warnings,
    ...(unmatchedCitations ? [`${unmatchedCitations} 条外部引用未能唯一匹配学习库资料，已跳过；原始内容仍保存在导入资料中。`] : [])] };
  return { source, deck };
}
