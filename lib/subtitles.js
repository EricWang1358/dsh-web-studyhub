import { parseStoredJson } from "./util.js";

/* Subtitle files (Bilibili BCC JSON, SRT, WebVTT, "[00:01:02.300] text" lines) as timed cues, and the cues
 * as transcript paragraphs labelled with their start time. The labels stay out
 * of the text the models see; the finished document puts them in front of
 * both the original and the translated paragraph. */

export const SUBTITLE_EXTENSIONS = [".srt", ".vtt", ".json", ".txt"];
const MAX_BYTES = 8 * 1024 * 1024;

const seconds = (stamp) => {
  const match = String(stamp).trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
  if (!match) return null;
  const [, h = 0, m, s, ms = "0"] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
};
const tidy = (text) => String(text ?? "").replace(/<[^>]*>/g, "").replace(/\{\\[^}]*\}/g, "").replace(/&nbsp;/g, " ")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();

/** Timed text blocks of SRT and WebVTT (a line "start --> end", then the text lines). */
function timedBlocks(text) {
  const cues = [];
  for (const block of text.split(/\n\s*\n/)) {
    const lines = block.split("\n"), at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [from, rest = ""] = lines[at].split("-->"), start = seconds(from), end = seconds(rest.trim().split(/\s+/)[0]);
    const body = tidy(lines.slice(at + 1).join(" "));
    if (start !== null && body) cues.push({ start, end: end ?? start, text: body });
  }
  return cues;
}

/**
 * One cue per "[hh:mm:ss.mmm] text" line. The end is not written down: it is
 * estimated from the text length and capped by the next start, so a pause in
 * speech still shows as a gap.
 */
function stampedLines(text) {
  const cues = [];
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*\[([\d:.,]+)\]\s*(.*)$/), start = match ? seconds(match[1]) : null, body = match ? tidy(match[2]) : "";
    if (start !== null && body) cues.push({ start, end: start, text: body });
  }
  cues.forEach((cue, index) => {
    const spoken = cue.start + 1 + cue.text.length * 0.3;
    cue.end = Math.min(spoken, cues[index + 1]?.start ?? spoken);
  });
  return cues;
}

/** Cues `{start, end, text}` in time order. Throws with a readable reason when the file is not a subtitle. */
export function parseSubtitles(raw, filename = "") {
  const text = String(raw ?? "").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (text.length > MAX_BYTES) throw new Error("字幕文件太大（超过 8MB）");
  let cues;
  // "[00:00:01.000] text" also starts with "[": only an object, or an array of objects, is JSON.
  if (/\.json$/i.test(filename) || /^\s*(\{|\[\s*\{)/.test(text)) {
    let value;
    try { value = parseStoredJson(text); } catch { throw new Error("字幕 JSON 无法解析"); }
    const body = Array.isArray(value) ? value : value?.body;
    if (!Array.isArray(body)) throw new Error("不是 B 站字幕 JSON：缺少 body 列表");
    cues = body.map((cue) => ({ start: Number(cue?.from), end: Number(cue?.to), text: tidy(cue?.content) }))
      .filter((cue) => Number.isFinite(cue.start) && cue.text).map((cue) => ({ ...cue, end: Number.isFinite(cue.end) ? cue.end : cue.start }));
  } else cues = text.includes("-->") ? timedBlocks(text) : stampedLines(text);
  if (!cues.length) throw new Error("字幕文件里没有找到带时间戳的字幕");
  return cues.sort((a, b) => a.start - b.start);
}

export const clockLabel = (value) => {
  const total = Math.max(0, Math.floor(value)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  return `[${h ? `${h}:${String(m).padStart(2, "0")}` : m}:${String(s).padStart(2, "0")}]`;
};
const CJK = /[㐀-鿿]/, CLOSED = /[.!?。？！，,；;：:…"”)）]$/;

/**
 * Cues joined into paragraphs of about `target` characters, broken at a cue
 * end; a pause of `pause` seconds ends a paragraph early once it has some
 * length. Unpunctuated Chinese cues (AI subtitles) are joined with "，".
 */
export function cueParagraphs(cues, { target = 600, pause = 4 } = {}) {
  const paragraphs = [], labels = [];
  let current = "", label = "", last = null;
  const flush = () => { if (current) { paragraphs.push(current); labels.push(label); } current = ""; };
  for (const cue of cues) {
    if (current && (current.length >= target || (cue.start - last.end >= pause && current.length >= target / 3))) flush();
    if (!current) { label = clockLabel(cue.start); current = cue.text; }
    else current += CLOSED.test(current) ? (CJK.test(current.at(-1)) || CJK.test(cue.text[0]) ? "" : " ") + cue.text
      : (CJK.test(current.at(-1)) ? "，" : " ") + cue.text;
    last = cue;
  }
  flush();
  return { paragraphs, labels, seconds: cues.length ? Math.round(Math.max(...cues.map((cue) => cue.end))) : 0 };
}
