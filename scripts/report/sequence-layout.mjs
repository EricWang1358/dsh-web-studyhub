/* Geometry of a sequence diagram: validates a spec and puts every box and arrow at a coordinate.
   Pure data in, pure data out (no markup), so a test can check that no text box leaves its lifelines. renderSequence draws what this returns. */
import { textWidth, wrapText } from "./text.mjs";

export const KINDS = ["same", "added", "changed", "removed"];
export const BADGES = { added: "＋", changed: "～", removed: "－" };
export const LABELS = {
  zh: { same: "不变", added: "新增", changed: "调整", removed: "去掉" },
  en: { same: "Unchanged", added: "Added", changed: "Adjusted", removed: "Removed" },
};
export const FONT = 14, LINE = 20, SMALL = 13, SMALL_LINE = 18;
const MARGIN = 16, PAD = 10, BADGE_W = 22, MIN_COL = 110, GUTTER = 190;

const fail = (message) => { throw new Error(`renderSequence: ${message}`); };
const str = (value, where) => {
  if (typeof value !== "string" && typeof value !== "number") fail(`${where} must be text`);
  return String(value);
};

/** Check a spec and return a normalised copy; every error names the field that is wrong. */
export function normalize(spec) {
  if (!spec || typeof spec !== "object") fail("the spec must be an object");
  if (!Array.isArray(spec.actors) || !spec.actors.length) fail("actors must be a non-empty list");
  const seen = new Set();
  const actors = spec.actors.map((actor, i) => {
    const id = str(actor?.id, `actors[${i}].id`);
    if (seen.has(id)) fail(`actors[${i}].id "${id}" is used twice`);
    seen.add(id);
    return { id, label: actor.label == null ? id : str(actor.label, `actors[${i}].label`) };
  });
  if (!Array.isArray(spec.steps)) fail("steps must be a list");
  const check = (id, where) => { if (!seen.has(id)) fail(`${where} refers to the unknown actor "${id}"`); return id; };
  const kindOf = (kind, where) => {
    if (kind == null) return "same";
    if (!KINDS.includes(kind)) fail(`${where} must be one of ${KINDS.join(", ")}`);
    return kind;
  };
  const steps = spec.steps.map((step, i) => {
    const where = `steps[${i}]`;
    const from = check(str(step?.from, `${where}.from`), `${where}.from`), to = check(str(step.to ?? step.from, `${where}.to`), `${where}.to`);
    return { index: i, id: step.id == null ? null : String(step.id), from, to, text: str(step.text ?? "", `${where}.text`), kind: kindOf(step.kind, `${where}.kind`),
      note: step.note ? str(step.note, `${where}.note`) : "", reply: !!step.reply, self: !!step.self || from === to };
  });
  const notes = (spec.notes ?? []).map((note, i) => {
    const where = `notes[${i}]`;
    if (!Array.isArray(note?.over) || !note.over.length) fail(`${where}.over must list at least one actor`);
    const after = note.after == null ? steps.length - 1 : Number(note.after);
    if (!Number.isInteger(after) || after < -1 || after >= steps.length) fail(`${where}.after must be a step index (or -1 for before the first step)`);
    return { over: note.over.map((id, k) => check(str(id, `${where}.over[${k}]`), `${where}.over[${k}]`)), text: str(note.text ?? "", `${where}.text`), kind: kindOf(note.kind, `${where}.kind`), after };
  });
  const groups = (spec.groups ?? []).map((group, i) => {
    const where = `groups[${i}]`;
    const from = Number(group?.from), to = Number(group?.to);
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to >= steps.length) fail(`${where}.from/to must be step indexes with from <= to`);
    return { label: str(group.label ?? "", `${where}.label`), from, to };
  });
  return { title: spec.title == null ? "" : String(spec.title), actors, steps, notes, groups };
}

function defaultColumn(count) {
  return count <= 3 ? 260 : count === 4 ? 220 : count === 5 ? 190 : 170;
}

/** Lay a spec out. options: { colWidth (px between lifelines, at least 110) }. All numbers are SVG user units (px at 1:1). */
export function layout(input, options = {}) {
  const spec = normalize(input);
  const { actors, steps } = spec;
  const col = Math.max(MIN_COL, Math.round(options.colWidth ?? defaultColumn(actors.length)));
  const hasStepNotes = steps.some((step) => step.note);
  const noteWidth = hasStepNotes ? (options.noteWidth ?? GUTTER) : 0;
  const centre = new Map(actors.map((actor, i) => [actor.id, MARGIN + col * (i + 0.5)]));
  const last = actors[actors.length - 1].id;
  const selfOnLast = steps.some((step) => step.self && step.from === last);
  const right = MARGIN + col * actors.length + (selfOnLast ? Math.ceil(col * 0.9) : 0);
  const width = right + (hasStepNotes ? 12 + noteWidth : 0) + MARGIN;

  // actor boxes
  const boxW = Math.max(90, col - 28);
  const labels = actors.map((actor) => wrapText(actor.label, boxW - 16, FONT));
  const headH = Math.max(...labels.map((l) => l.lines.length)) * LINE + 14;
  const head = actors.map((actor, i) => ({ id: actor.id, x: centre.get(actor.id), box: { x: centre.get(actor.id) - boxW / 2, y: 10, width: boxW, height: headH }, lines: labels[i].lines }));
  const lifeTop = 10 + headH;

  // rows: steps and the notes that sit between them, top to bottom
  const startsAt = (index) => spec.groups.filter((g) => g.from === index);
  const endsAt = (index) => spec.groups.filter((g) => g.to === index);
  const rows = [];
  const noteRows = [];
  let cursor = lifeTop + 14;
  const addNotes = (after) => {
    for (const note of spec.notes.filter((n) => n.after === after)) {
      const xs = note.over.map((id) => centre.get(id)), left = Math.min(...xs), rightX = Math.max(...xs);
      const w = Math.min(rightX - left + col - 24, right - 8);
      const x = Math.max(4, Math.min(((left + rightX) / 2) - w / 2, right - w - 4));
      const text = wrapText(note.text, w - 16, SMALL);
      const h = text.lines.length * SMALL_LINE + 12;
      const row = { kind: note.kind, over: note.over, box: { x, y: cursor + 4, width: w, height: h }, lines: text.lines, top: cursor, bottom: cursor + h + 12 };
      noteRows.push(row);
      cursor = row.bottom;
    }
  };
  addNotes(-1);
  for (const step of steps) {
    const outer = startsAt(step.index).length;
    const top = cursor, y0 = top + outer * 22;
    const ax = centre.get(step.from), bx = centre.get(step.to);
    const badge = step.kind === "same" ? 0 : BADGE_W;
    const row = { index: step.index, id: step.id, kind: step.kind, reply: step.reply, self: step.self, from: step.from, to: step.to, top, ax, bx };
    if (step.self) {
      const room = step.from === last ? right - ax - 44 : col - 44;
      const text = wrapText(step.text, room - badge, FONT);
      const blockW = badge + text.width;
      const loopTop = y0 + 8;
      Object.assign(row, { y: loopTop + 20, loopTop, box: { x: ax + 36, y: y0 + 6, width: blockW, height: text.lines.length * LINE }, lines: text.lines, badge: badge ? { x: ax + 36, y: y0 + 7 } : null, textX: ax + 36 + badge });
      row.contentBottom = Math.max(loopTop + 20 + 8, y0 + 6 + text.lines.length * LINE + 4);
    } else {
      const left = Math.min(ax, bx), rightX = Math.max(ax, bx);
      const text = wrapText(step.text, rightX - left - 2 * PAD - badge, FONT);
      const blockW = badge + text.width;
      const x = (left + rightX) / 2 - blockW / 2;
      const h = text.lines.length * LINE;
      Object.assign(row, { y: y0 + 6 + h + 8, box: { x, y: y0 + 6, width: blockW, height: h }, lines: text.lines, badge: badge ? { x, y: y0 + 7 } : null, textX: x + badge });
      row.contentBottom = row.y + 10;
    }
    if (step.note) {
      const text = wrapText(step.note, noteWidth - 20, SMALL);
      const h = text.lines.length * SMALL_LINE + 12;
      const y = Math.max(row.top + 2, Math.min(row.y - h / 2, row.y + 6));
      row.callout = { box: { x: right + 12, y, width: noteWidth, height: h }, lines: text.lines, guideFrom: Math.max(ax, bx) };
      row.contentBottom = Math.max(row.contentBottom, y + h + 2);
    }
    row.bottom = row.contentBottom + 4 + endsAt(step.index).length * 8;
    rows.push(row);
    cursor = row.bottom;
    addNotes(step.index);
  }

  // group frames: outer ones start higher and end lower; nested ones are drawn narrower
  const frames = spec.groups.map((group) => {
    const first = rows[group.from], lastRow = rows[group.to];
    const containing = spec.groups.filter((o) => o !== group && o.from <= group.from && o.to >= group.to && (o.from < group.from || o.to > group.to)).length;
    const sameStart = startsAt(group.from).sort((a, b) => b.to - a.to), sameEnd = endsAt(group.to).sort((a, b) => (b.from - a.from));
    const y = first.top + sameStart.indexOf(group) * 22;
    const bottom = lastRow.contentBottom + 4 + sameEnd.indexOf(group) * 8;
    const tab = textWidth(group.label) * FONT + 16;
    return { label: group.label, depth: containing, box: { x: 6 + containing * 6, y, width: right - 12 - containing * 12, height: bottom - y }, tab: { width: Math.min(tab, right - 24), height: 18 } };
  });

  // legend: only the kinds that are in the diagram, and only when there is something to tell apart from "same"
  const used = new Set([...steps, ...spec.notes].map((item) => item.kind));
  const legendKinds = KINDS.filter((kind) => used.has(kind));
  const showLegend = legendKinds.some((kind) => kind !== "same");
  const bottomOfRows = cursor + 8;
  const legendTop = bottomOfRows + 8;
  let legend = null;
  if (showLegend) {
    const names = LABELS[options.lang === "en" ? "en" : "zh"];
    let x = MARGIN, y = legendTop;
    const items = legendKinds.map((kind) => {
      const w = 34 + (kind === "same" ? 0 : 24) + textWidth(names[kind]) * SMALL + 22;
      if (x > MARGIN && x + w > width - MARGIN) { x = MARGIN; y += 24; }
      const item = { kind, x, y, label: names[kind] };
      x += w;
      return item;
    });
    legend = { top: legendTop, items, height: y + 24 - legendTop };
  }
  const height = (legend ? legendTop + legend.height : bottomOfRows) + 10;
  return { spec, width, height, col, right, actors: head, lifeTop, lifeBottom: bottomOfRows, rows, noteRows, frames, legend, noteWidth };
}
