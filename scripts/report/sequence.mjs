/* Sequence diagrams as inline SVG (no fonts, scripts or network; colours are CSS variables that follow light/dark).
   renderSequence({ title, actors: [{ id, label }], steps: [{ from, to, text, kind?, note?, reply?, self? }], notes?, groups? }, options) -> "<svg ...>".
   kind marks a step against an earlier version of the flow: same | added (green, "＋") | changed (orange, "～") | removed (red, dashed, struck through, "－").
   options: { lang: "zh" | "en" (legend and description words), colWidth, noteWidth, embedStyle (default true), standalone (adds xmlns) }. */
import { esc } from "./text.mjs";
import { BADGES, FONT, LABELS, LINE, SMALL, SMALL_LINE, layout } from "./sequence-layout.mjs";

export { layout, normalize, KINDS } from "./sequence-layout.mjs";

const LIGHT = { bg: "#ffffff", ink: "#1f2328", muted: "#59636e", line: "#8c959f", soft: "#f6f8fa", added: "#1a7f37", "added-bg": "#dafbe1", changed: "#b35900", "changed-bg": "#fff1e0", removed: "#cf222e", "removed-bg": "#ffebe9" };
const DARK = { bg: "#0d1117", ink: "#e6edf3", muted: "#9198a1", line: "#6e7681", soft: "#161b22", added: "#3fb950", "added-bg": "#12261e", changed: "#f0883e", "changed-bg": "#2d1f10", removed: "#ff7b72", "removed-bg": "#2d1517" };
const vars = (palette) => Object.entries(palette).map(([name, value]) => `--rk-${name}:${value}`).join(";");

/** The light colour variables, for a page that has to force them (print). */
export const SEQUENCE_LIGHT_VARS = vars(LIGHT);

/** The styles every diagram needs. Class names all start with rk-, so they can sit in a page that has other styles. */
export function sequenceCss() {
  return [
    `.rk-seq{${vars(LIGHT)};background:var(--rk-bg);color:var(--rk-ink);border-radius:10px;font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei","Noto Sans CJK SC",sans-serif;display:block}`,
    `@media (prefers-color-scheme:dark){:root:not([data-theme="light"]) .rk-seq{${vars(DARK)}}}`,
    `:root[data-theme="dark"] .rk-seq{${vars(DARK)}}`,
    `.rk-seq text{fill:var(--rk-ink)}`,
    `.rk-seq .rk-t{paint-order:stroke;stroke:var(--rk-bg);stroke-width:4px;stroke-linejoin:round}`,
    `.rk-seq .rk-k-added .rk-t,.rk-seq .rk-k-changed .rk-t{font-weight:600}`,
    `.rk-seq .rk-k-removed .rk-t{fill:var(--rk-removed);stroke:none;text-decoration:line-through;text-decoration-thickness:1px}`,
    `.rk-seq .rk-k-same{--rk-c:var(--rk-muted);--rk-cbg:var(--rk-soft)}`,
    `.rk-seq .rk-k-added{--rk-c:var(--rk-added);--rk-cbg:var(--rk-added-bg)}`,
    `.rk-seq .rk-k-changed{--rk-c:var(--rk-changed);--rk-cbg:var(--rk-changed-bg)}`,
    `.rk-seq .rk-k-removed{--rk-c:var(--rk-removed);--rk-cbg:var(--rk-removed-bg)}`,
    `.rk-seq .rk-line{fill:none;stroke:var(--rk-c);stroke-width:1.6}`,
    `.rk-seq .rk-k-added .rk-line,.rk-seq .rk-k-changed .rk-line,.rk-seq .rk-k-removed .rk-line{stroke-width:2.2}`,
    `.rk-seq .rk-dash{stroke-dasharray:6 4}`,
    `.rk-seq .rk-head{fill:var(--rk-c);stroke:none}`,
    `.rk-seq .rk-head.rk-open{fill:none;stroke:var(--rk-c);stroke-width:1.6}`,
    `.rk-seq .rk-badge{fill:var(--rk-c)}`,
    `.rk-seq .rk-badge-t{fill:var(--rk-bg);font-size:12px;font-weight:700;text-anchor:middle}`,
    `.rk-seq .rk-box{fill:var(--rk-cbg,var(--rk-soft));stroke:var(--rk-c,var(--rk-line));stroke-width:1}`,
    `.rk-seq .rk-actor{fill:var(--rk-soft);stroke:var(--rk-line)}`,
    `.rk-seq .rk-actor-t{font-weight:600;text-anchor:middle}`,
    `.rk-seq .rk-life{stroke:var(--rk-line);stroke-width:1;stroke-dasharray:3 4;opacity:.7}`,
    `.rk-seq .rk-guide{stroke:var(--rk-line);stroke-width:1;stroke-dasharray:2 3;fill:none}`,
    `.rk-seq .rk-frame{fill:none;stroke:var(--rk-line);stroke-width:1}`,
    `.rk-seq .rk-tab{fill:var(--rk-soft);stroke:var(--rk-line)}`,
    `.rk-seq .rk-small{font-size:${SMALL}px}`,
    `.rk-seq .rk-leg-t{fill:var(--rk-muted);font-size:${SMALL}px}`,
  ].join("\n");
}

const n = (value) => Math.round(value * 10) / 10;
const BADGE_SIZE = 16;

function lines(textLines, x, top, lineHeight, size, extra = "") {
  const tspans = textLines.map((text, i) => `<tspan x="${n(x)}" y="${n(top + i * lineHeight + lineHeight - (size >= FONT ? 5 : 4.5))}">${esc(text)}</tspan>`).join("");
  return `<text${extra} font-size="${size}">${tspans}</text>`;
}

const badge = (kind, x, y) => kind === "same" ? ""
  : `<rect class="rk-badge" x="${n(x)}" y="${n(y)}" width="${BADGE_SIZE}" height="${BADGE_SIZE}" rx="4"/><text class="rk-badge-t" x="${n(x + BADGE_SIZE / 2)}" y="${n(y + 12.5)}">${BADGES[kind]}</text>`;

function head(x, y, dir, open) {
  const d = open ? `M${n(x - 9 * dir)},${n(y - 5)} L${n(x)},${n(y)} L${n(x - 9 * dir)},${n(y + 5)}` : `M${n(x)},${n(y)} L${n(x - 8 * dir)},${n(y - 4.5)} L${n(x - 8 * dir)},${n(y + 4.5)} Z`;
  return `<path class="rk-head${open ? " rk-open" : ""}" d="${d}"/>`;
}

function stepMarkup(row) {
  const dashed = row.reply || row.kind === "removed";
  const attrs = ` data-step="${row.index}" data-kind="${row.kind}"${row.id ? ` data-id="${esc(row.id)}"` : ""}`;
  let arrow;
  if (row.self) {
    const top = row.loopTop, bottom = row.y;
    arrow = `<path class="rk-line${dashed ? " rk-dash" : ""}" d="M${n(row.ax)},${n(top)} H${n(row.ax + 28)} V${n(bottom)} H${n(row.ax + (row.reply ? 9 : 8))}"/>${head(row.ax, bottom, -1, row.reply)}`;
  } else {
    const dir = row.bx >= row.ax ? 1 : -1;
    arrow = `<path class="rk-line${dashed ? " rk-dash" : ""}" d="M${n(row.ax)},${n(row.y)} H${n(row.bx - dir * (row.reply ? 9 : 8))}"/>${head(row.bx, row.y, dir, row.reply)}`;
  }
  let out = `<g class="rk-step rk-k-${row.kind}"${attrs}>${arrow}`;
  if (row.badge) out += badge(row.kind, row.badge.x, row.badge.y);
  out += lines(row.lines, row.textX, row.box.y, LINE, FONT, ' class="rk-t"');
  if (row.callout) {
    const { box, guideFrom } = row.callout;
    if (!row.self) out += `<path class="rk-guide" d="M${n(guideFrom + 12)},${n(row.y)} H${n(box.x)}"/>`;
    out += `<g class="rk-callout"><rect class="rk-box" x="${n(box.x)}" y="${n(box.y)}" width="${n(box.width)}" height="${n(box.height)}" rx="6"/>${lines(row.callout.lines, box.x + 10, box.y + 4, SMALL_LINE, SMALL, ' class="rk-small"')}</g>`;
  }
  return `${out}</g>`;
}

function legendMarkup(legend) {
  return `<g class="rk-legend">${legend.items.map(({ kind, x, y, label }) => {
    const cy = y + 12, dashed = kind === "removed";
    const sample = `<path class="rk-line${dashed ? " rk-dash" : ""}" d="M${n(x)},${n(cy)} H${n(x + 26)}"/>${head(x + 32, cy, 1, false)}`;
    const tag = kind === "same" ? "" : badge(kind, x + 38, cy - 8);
    const textX = x + 38 + (kind === "same" ? 0 : 24);
    return `<g class="rk-leg rk-k-${kind}" data-legend="${kind}">${sample}${tag}<text class="rk-leg-t" x="${n(textX)}" y="${n(cy + 4)}">${esc(label)}</text></g>`;
  }).join("")}</g>`;
}

/** A short hash, so the title and description ids are the same for the same spec and differ between specs on one page. */
function hash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** The text a screen reader gets: who takes part and what happens, step by step. */
function describe(plan, lang) {
  const names = LABELS[lang], labelOf = new Map(plan.spec.actors.map((actor) => [actor.id, actor.label]));
  const zh = lang === "zh";
  const parts = plan.spec.steps.map((step, i) => {
    const mark = step.kind === "same" ? "" : (zh ? `（${names[step.kind]}）` : ` (${names[step.kind]})`);
    const who = step.self ? labelOf.get(step.from) : `${labelOf.get(step.from)}${zh ? "到" : " to "}${labelOf.get(step.to)}`;
    return `${i + 1}. ${who}${zh ? "：" : ": "}${step.text}${mark}`;
  });
  const people = plan.spec.actors.map((actor) => actor.label).join(zh ? "、" : ", ");
  return `${zh ? `参与方：${people}。共 ${parts.length} 步。` : `Participants: ${people}. ${parts.length} steps. `}${parts.join(zh ? "；" : "; ")}`;
}

export function renderSequence(spec, options = {}) {
  const plan = layout(spec, options);
  const lang = options.lang === "en" ? "en" : "zh";
  const title = plan.spec.title || (lang === "zh" ? "时序图" : "Sequence diagram");
  const id = `rk-${hash(JSON.stringify(plan.spec))}`;
  const { width, height } = plan;
  const parts = [];
  parts.push(`<svg class="rk-seq"${options.standalone ? ' xmlns="http://www.w3.org/2000/svg"' : ""} role="img" aria-labelledby="${id}-t ${id}-d" viewBox="0 0 ${n(width)} ${n(height)}" width="${n(width)}" height="${n(height)}" style="width:100%;max-width:${n(width)}px;min-width:${Math.round(width * 0.72)}px;height:auto" font-family="system-ui,sans-serif">`);
  parts.push(`<title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(describe(plan, lang))}</desc>`);
  if (options.embedStyle !== false) parts.push(`<style>${sequenceCss()}</style>`);
  parts.push(`<g class="rk-groups">${plan.frames.map((frame) => `<g><rect class="rk-frame" x="${n(frame.box.x)}" y="${n(frame.box.y)}" width="${n(frame.box.width)}" height="${n(frame.box.height)}" rx="6"/><rect class="rk-tab" x="${n(frame.box.x)}" y="${n(frame.box.y)}" width="${n(frame.tab.width)}" height="${frame.tab.height}" rx="4"/><text class="rk-small" font-size="${SMALL}" font-weight="600" x="${n(frame.box.x + 8)}" y="${n(frame.box.y + 13)}">${esc(frame.label)}</text></g>`).join("")}</g>`);
  parts.push(`<g class="rk-lifelines">${plan.actors.map((a) => `<line class="rk-life" x1="${n(a.x)}" y1="${n(plan.lifeTop)}" x2="${n(a.x)}" y2="${n(plan.lifeBottom)}"/>`).join("")}</g>`);
  parts.push(`<g class="rk-actors">${plan.actors.map((a) => `<rect class="rk-actor" x="${n(a.box.x)}" y="${n(a.box.y)}" width="${n(a.box.width)}" height="${n(a.box.height)}" rx="6" data-actor="${esc(a.id)}"/>${lines(a.lines, a.x, a.box.y + 6, LINE, FONT, ' class="rk-actor-t"')}`).join("")}</g>`);
  parts.push(`<g class="rk-notes">${plan.noteRows.map((note) => `<g class="rk-note rk-k-${note.kind}" data-kind="${note.kind}"><rect class="rk-box" x="${n(note.box.x)}" y="${n(note.box.y)}" width="${n(note.box.width)}" height="${n(note.box.height)}" rx="6"/>${lines(note.lines, note.box.x + 8, note.box.y + 3, SMALL_LINE, SMALL, ' class="rk-small"')}</g>`).join("")}</g>`);
  parts.push(`<g class="rk-steps">${plan.rows.map(stepMarkup).join("")}</g>`);
  if (plan.legend) parts.push(legendMarkup(plan.legend));
  parts.push("</svg>");
  return parts.join("");
}
