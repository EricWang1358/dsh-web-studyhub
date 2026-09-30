import { createHash } from "node:crypto";
import { buildDocuments } from "./transcript.js";

/* Turning live segments into study sources: an excerpt the learner selected
   (to generate questions from), or the whole class as a bilingual transcript. */

export const clock = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(total / 3600), m = Math.floor(total / 60) % 60, s = total % 60;
  const two = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`;
};
export function defaultTitle(date = new Date()) {
  const two = (n) => String(n).padStart(2, "0");
  return `课堂实录 ${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}`;
}
export const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 8);

/**
 * The text of a selection, with the time it was said and, when asked for,
 * the Chinese translation under each sentence. Questions can quote either.
 */
export function excerptText(title, segments, { includeChinese = true } = {}) {
  const lines = [`《${title}》课堂片段（${clock(segments[0].t)}–${clock(segments.at(-1).t)}）`, ""];
  for (const segment of segments) {
    lines.push(`[${clock(segment.t)}] ${segment.en}`);
    if (includeChinese && segment.zh && segment.zh !== segment.en) lines.push(segment.zh);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Group consecutive segments into chunks of about `size` characters of English. */
function grouped(segments, size) {
  const groups = [];
  let current = [], chars = 0;
  for (const segment of segments) {
    current.push(segment);
    chars += segment.en.length;
    if (chars >= size) { groups.push(current); current = []; chars = 0; }
  }
  if (current.length) groups.push(current);
  return groups;
}
/** English paragraphs of about 700 characters, for the proofreading pass. */
export const paragraphsOf = (segments) => grouped(segments, 700).map((group) => group.map((s) => s.en).join(" "));

/**
 * Parts for the bilingual document, built from what the class already has:
 * no model call, so it costs nothing. Titles are time ranges.
 */
export function quickParts(segments) {
  return grouped(segments, 3500).map((partSegments, index) => {
    const paragraphs = grouped(partSegments, 700);
    const range = `${clock(partSegments[0].t)}–${clock(partSegments.at(-1).t)}`;
    return {
      titleZh: `第 ${index + 1} 段 · ${range}`, titleEn: `Segment ${index + 1} · ${range}`,
      english: paragraphs.map((group) => group.map((s) => s.en).join(" ")),
      chinese: paragraphs.map((group) => group.map((s) => s.zh || "（这句没有译文）").join("")),
    };
  });
}
export const quickDocuments = (title, segments) =>
  buildDocuments({ filename: title, titleEn: "Live Class Transcript", parts: quickParts(segments) });
