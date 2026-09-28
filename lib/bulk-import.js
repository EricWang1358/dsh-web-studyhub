import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { MAX_JSON_IMPORT_CHARS } from "./json-import.js";

/* Bulk JSON import for the main session: read question-bank files straight
   from disk instead of pasting them through the conversation in chunks.
   Reading happens here; the library write happens per file in the service. */

export const MAX_IMPORT_FILES = 50;
const MAX_FILE_BYTES = MAX_JSON_IMPORT_CHARS * 4;
const EXTENSIONS = new Set([".json", ".txt"]);

async function readBounded(file) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("不是文件");
    if (info.size > MAX_FILE_BYTES) throw new Error("文件过大（单个文件最多 50 万字符）");
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    return bytes.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Files named by `path` / `paths` (absolute; a folder means its .json files) or inline `text`. */
export async function readImportFiles(a = {}) {
  if (typeof a.text === "string") {
    if (a.path || a.paths) throw new Error("text 与 path/paths 只能二选一");
    return [{ name: "粘贴内容", text: a.text }];
  }
  const listed = a.paths ?? (a.path ? [a.path] : []);
  if (!Array.isArray(listed) || !listed.length) throw new Error("请提供 path、paths 或 text");
  const files = [];
  for (const entry of listed) {
    if (typeof entry !== "string" || !path.isAbsolute(entry)) throw new Error(`路径必须是绝对路径：${entry}`);
    const info = await stat(entry).catch(() => null);
    if (!info) throw new Error(`找不到：${entry}`);
    if (info.isDirectory()) {
      const names = (await readdir(entry)).filter((name) => path.extname(name).toLowerCase() === ".json")
        .sort((x, y) => x.localeCompare(y, "zh-CN", { numeric: true }));
      files.push(...names.map((name) => path.join(entry, name)));
    } else {
      if (!EXTENSIONS.has(path.extname(entry).toLowerCase())) throw new Error(`只能导入 .json 或 .txt 文件：${entry}`);
      files.push(entry);
    }
  }
  if (!files.length) throw new Error("文件夹里没有 .json 文件");
  if (files.length > MAX_IMPORT_FILES) throw new Error(`一次最多导入 ${MAX_IMPORT_FILES} 个文件`);
  const out = [];
  for (const file of [...new Set(files)]) {
    try {
      out.push({ name: path.basename(file), path: file, text: await readBounded(file) });
    } catch (error) {
      out.push({ name: path.basename(file), path: file, error: error.message });
    }
  }
  return out;
}

/** Accept the panel's {title, folder?, cards} format, or a bare card array titled by its file. */
export function normalizeImportText(text, name) {
  const raw = String(text).replace(/^﻿/, "").trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
  let input;
  try { input = JSON.parse(raw); } catch (error) { throw new Error(`JSON 格式错误：${error.message}`); }
  const fallback = String(name || "").replace(/\.(json|txt)$/i, "").trim() || "导入题组";
  if (Array.isArray(input)) input = { title: fallback, cards: input };
  else if (input && typeof input === "object" && (typeof input.title !== "string" || !input.title.trim())) input = { ...input, title: fallback };
  return JSON.stringify(input);
}

/** Same question, whatever the spacing, punctuation or case. */
export const cardKey = (card) =>
  String(card?.cloze?.text || card?.prompt || "").toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
export const sameTitle = (a, b) => String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
