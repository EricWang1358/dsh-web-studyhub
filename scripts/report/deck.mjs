/* One self-contained HTML deck from a small JSON description.
   deck: { title, subtitle?, lang? ("zh-CN"), toc? (true), slides: [{ type, ... }] }
   slide types:  title { title, subtitle?, meta? }          section { title, subtitle? }
                 bullets { title, items: [text | { text, sub: [text] }] }    text { title, paragraphs: [text] }
                 compare { title, actors?, before, after, plain, diff? }      (see compare.mjs)
                 table { title, columns: [text], rows: [[text]], caption? }
                 images { title, items: [{ src, alt, caption?, label? }] }    (src is a file next to the deck json, or a data: URI)
                 stats { title, items: [{ label, before, after, unit?, better? ("lower" | "higher"), note? }] }
   Text may use **bold** and `code`. Everything is escaped; no <script> or link from the author can reach the page. */
import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { renderCompare } from "./compare.mjs";
import { deckCss } from "./deck-style.mjs";
import { DECK_SCRIPT, THEME_SNIPPET } from "./deck-script.mjs";
import { esc, inline, withBreaks } from "./text.mjs";

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml" };
export const SLIDE_TYPES = ["title", "section", "bullets", "text", "compare", "table", "images", "stats"];

const WORDS = {
  zh: { toc: "目录", prev: "上一张", next: "下一张", theme: "切换深浅色", full: "全屏", fewer: "少了", more: "多了", sameNum: "没有变化", intro: "开头" },
  en: { toc: "Contents", prev: "Previous slide", next: "Next slide", theme: "Switch light/dark", full: "Fullscreen", fewer: "down", more: "up", sameNum: "no change", intro: "Start" },
};

const bad = (index, slide, message) => { throw new Error(`deck: slides[${index}] (${slide?.type ?? "?"}): ${message}`); };
const list = (index, slide, field) => { if (!Array.isArray(slide[field]) || !slide[field].length) bad(index, slide, `${field} must be a non-empty list`); return slide[field]; };

function validate(deck) {
  if (!deck || typeof deck !== "object") throw new Error("deck: the deck must be an object");
  if (!deck.title || typeof deck.title !== "string") throw new Error("deck: title is missing");
  if (!Array.isArray(deck.slides) || !deck.slides.length) throw new Error("deck: slides must be a non-empty list");
  deck.slides.forEach((slide, i) => {
    if (!slide || !SLIDE_TYPES.includes(slide.type)) bad(i, slide, `type must be one of ${SLIDE_TYPES.join(", ")}`);
    if (!slide.title || typeof slide.title !== "string") bad(i, slide, "title is missing");
  });
}

/** Read every image the deck names; returns Map(src -> data URI). A missing file or a missing alt text stops the build. */
async function loadImages(deck, baseDir) {
  const found = new Map();
  for (const [i, slide] of deck.slides.entries()) {
    if (slide.type !== "images") continue;
    for (const [k, item] of list(i, slide, "items").entries()) {
      if (!item?.src || typeof item.src !== "string") bad(i, slide, `items[${k}].src is missing`);
      if (!item.alt || typeof item.alt !== "string" || !item.alt.trim()) bad(i, slide, `items[${k}].alt is missing (every image needs a description for screen readers)`);
      if (found.has(item.src)) continue;
      if (item.src.startsWith("data:image/")) { found.set(item.src, item.src); continue; }
      const mime = MIME[extname(item.src).toLowerCase()];
      if (!mime) bad(i, slide, `items[${k}].src "${item.src}" is not a png, jpg, gif, webp or svg image`);
      let bytes;
      try { bytes = await readFile(isAbsolute(item.src) ? item.src : resolve(baseDir, item.src)); } catch { bad(i, slide, `items[${k}].src "${item.src}" cannot be read next to the deck file`); }
      found.set(item.src, `data:${mime};base64,${bytes.toString("base64")}`);
    }
  }
  return found;
}

const bulletList = (items) => `<ul>${items.map((item) => typeof item === "string" || typeof item === "number" ? `<li>${inline(item)}</li>`
  : `<li>${inline(item?.text ?? "")}${Array.isArray(item?.sub) && item.sub.length ? bulletList(item.sub) : ""}</li>`).join("")}</ul>`;

function statCard(item, words) {
  const { label, before, after, unit = "", better = "lower", note } = item ?? {};
  const numeric = typeof before === "number" && typeof after === "number";
  let delta = "";
  if (numeric) {
    const diff = after - before;
    const good = diff === 0 || (better === "higher" ? diff > 0 : diff < 0);
    const text = diff === 0 ? words.sameNum : `${diff < 0 ? "↓ " : "↑ "}${diff < 0 ? words.fewer : words.more} ${Math.abs(diff)}${unit ? ` ${unit}` : ""}`;
    delta = `<div class="dk-stat__delta${good ? "" : " is-worse"}">${esc(text)}</div>`;
  }
  return `<div class="dk-stat"><div class="dk-stat__label">${inline(label ?? "")}</div><div class="dk-stat__num"><s>${esc(before)}</s><span class="dk-arrow" aria-hidden="true">→</span>${esc(after)}${unit ? `<small> ${esc(unit)}</small>` : ""}</div>${delta}${note ? `<div class="dk-meta">${inline(note)}</div>` : ""}</div>`;
}

function slideBody(slide, i, ctx) {
  const { words, images, lang } = ctx;
  const heading = `<h2>${inline(slide.title)}</h2>`;
  switch (slide.type) {
    case "title": return `<h1>${inline(slide.title)}</h1>${slide.subtitle ? `<p class="dk-sub">${inline(slide.subtitle)}</p>` : ""}${slide.meta ? `<p class="dk-meta">${inline(slide.meta)}</p>` : ""}`;
    case "section": return `<h2>${inline(slide.title)}</h2>${slide.subtitle ? `<p class="dk-sub">${inline(slide.subtitle)}</p>` : ""}`;
    case "bullets": return `${heading}${bulletList(list(i, slide, "items"))}`;
    case "text": return `${heading}${list(i, slide, "paragraphs").map((p) => `<p>${withBreaks(p)}</p>`).join("")}`;
    case "compare": return `${heading}${renderCompare({ ...slide, lang })}`;
    case "table": {
      const columns = list(i, slide, "columns"), rows = list(i, slide, "rows");
      rows.forEach((row, r) => { if (!Array.isArray(row) || row.length !== columns.length) bad(i, slide, `rows[${r}] must have ${columns.length} cells`); });
      return `${heading}<div class="dk-tablebox"><table class="dk-table">${slide.caption ? `<caption>${inline(slide.caption)}</caption>` : ""}<thead><tr>${columns.map((c) => `<th scope="col">${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${row.map((cell, c) => `<td data-label="${esc(columns[c])}">${withBreaks(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
    }
    case "images": return `${heading}<div class="dk-figs">${list(i, slide, "items").map((item) => `<figure class="dk-fig"><img src="${images.get(item.src)}" alt="${esc(item.alt)}" loading="lazy">${item.caption || item.label ? `<figcaption>${item.label ? `<span class="dk-tag">${esc(item.label)}</span>` : ""}${inline(item.caption ?? "")}</figcaption>` : ""}</figure>`).join("")}</div>`;
    case "stats": return `${heading}<div class="dk-stats">${list(i, slide, "items").map((item) => statCard(item, words)).join("")}</div>`;
    default: return heading;
  }
}

/** The contents slide: sections with the slides under them, or a flat list when the deck has no sections. */
function tocSlide(entries, words) {
  const sections = entries.filter((e) => e.type === "section");
  const link = (e) => `<span class="dk-n">${e.id.slice(1)}</span><a href="#${e.id}">${inline(e.title)}</a>`;
  const body = sections.length
    ? (() => {
        const groups = [];
        let open = null;
        for (const e of entries) {
          if (e.type === "title") continue;
          if (e.type === "section") { open = { head: e, rest: [] }; groups.push(open); } else { if (!open) { open = { head: null, rest: [] }; groups.push(open); } open.rest.push(e); }
        }
        return groups.map((g) => `<li>${g.head ? link(g.head) : esc(words.intro)}${g.rest.length ? `<ol>${g.rest.map((e) => `<li>${link(e)}</li>`).join("")}</ol>` : ""}</li>`).join("");
      })()
    : entries.filter((e) => e.type !== "title").map((e) => `<li>${link(e)}</li>`).join("");
  return `<h2>${esc(words.toc)}</h2><ul class="dk-toc">${body}</ul>`;
}

/** Build the whole page. baseDir is where relative image paths start (the folder of the deck json). */
export async function renderDeck(deck, { baseDir = process.cwd() } = {}) {
  validate(deck);
  const lang = typeof deck.lang === "string" && deck.lang ? deck.lang : "zh-CN";
  const words = WORDS[lang.startsWith("zh") ? "zh" : "en"];
  const images = await loadImages(deck, baseDir);
  const withToc = deck.toc !== false && deck.slides.length > 2;
  const authored = deck.slides.map((slide, i) => ({ slide, i }));
  const order = withToc ? [...(deck.slides[0].type === "title" ? authored.slice(0, 1) : []), { toc: true }, ...authored.slice(deck.slides[0].type === "title" ? 1 : 0)] : authored;
  const entries = order.map((item, n) => item.toc ? { id: `s${n + 1}`, type: "toc", title: words.toc } : { id: `s${n + 1}`, type: item.slide.type, title: item.slide.title });
  const ctx = { words, images, lang };
  const html = order.map((item, n) => {
    const e = entries[n];
    const inner = item.toc ? tocSlide(entries.filter((x) => x.type !== "toc"), words) : slideBody(item.slide, item.i, ctx);
    return `<section class="dk-slide dk-t-${e.type}" id="${e.id}" aria-roledescription="slide" aria-label="${n + 1} / ${order.length}: ${esc(e.title)}"><div class="dk-inner">${inner}</div></section>`;
  }).join("\n");
  const page = `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(deck.title)}</title>
<script>${THEME_SNIPPET}</script>
<style>${deckCss()}</style>
</head>
<body>
<header class="dk-bar"><span class="dk-bar__title">${esc(deck.title)}</span><span class="dk-count" id="dk-count">1 / ${order.length}</span>
<button type="button" id="dk-prev" aria-label="${esc(words.prev)}">←</button><button type="button" id="dk-next" aria-label="${esc(words.next)}">→</button>
<button type="button" id="dk-theme" aria-label="${esc(words.theme)}" title="${esc(words.theme)}">◐</button><button type="button" id="dk-full" aria-label="${esc(words.full)}" title="${esc(words.full)} (f)">⛶</button></header>
<div class="dk-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${order.length}" aria-valuenow="1"><i></i></div>
<main>
${html}
</main>
<script>${DECK_SCRIPT}</script>
</body>
</html>
`;
  assertSelfContained(page);
  return page;
}

/** The finished page must not fetch anything: no src/href/url()/@import to another host. Text the author wrote is escaped, so it cannot match. */
export function assertSelfContained(html) {
  const loads = /(?:\b(?:src|href|action|poster)\s*=\s*["']?\s*(?:https?:)?\/\/|url\(\s*["']?\s*(?:https?:)?\/\/|@import)/i;
  const hit = loads.exec(html);
  if (hit) throw new Error(`deck: the page would load something from outside (${hit[0]}...)`);
}
