/* Before/after of one flow: two diagrams side by side (stacked on a narrow screen) and a plain-words box that must say
   原来 / 现在 / 对你有什么好处. renderCompare({ title, actors?, before, after, plain, diff?, lang? }) -> HTML (no <style>; COMPARE_CSS is the style).
   before and after are sequence specs ({ title?, actors?, steps, notes?, groups? }). Marks are computed from step ids (diffSequences) when
   any step has an id (then every step needs one; a step's own kind wins); with no ids anywhere, or "diff": false, kinds are by hand. */
import { renderSequence } from "./sequence.mjs";
import { esc, withBreaks } from "./text.mjs";

/** The three parts every comparison has to say in plain words, and the one that is optional. */
export const PLAIN_FIELDS = [["原来", "原来是怎样的"], ["现在", "现在是怎样的"], ["对你有什么好处", "对学习者的好处"]];
export const TECH_FIELD = "技术上改了什么";

const isSelf = (step) => !!step.self || step.from === (step.to ?? step.from);
const sameFlow = (a, b) => a.text === b.text && a.from === b.from && (a.to ?? a.from) === (b.to ?? b.from) && !!a.reply === !!b.reply && isSelf(a) === isSelf(b);

/** The ids that keep their place: of the steps both lists have, the longest run that is in the same order in both. The rest were moved. */
function stableIds(beforeIds, afterIds) {
  const where = new Map(afterIds.map((id, i) => [id, i]));
  const shared = beforeIds.filter((id) => where.has(id));
  const at = shared.map((id) => where.get(id));
  const best = at.map(() => 1), from = at.map(() => -1);
  for (let i = 0; i < at.length; i++) for (let j = 0; j < i; j++) if (at[j] < at[i] && best[j] + 1 > best[i]) { best[i] = best[j] + 1; from[i] = j; }
  const stable = new Set();
  let k = best.indexOf(Math.max(0, ...best));
  for (; k >= 0; k = from[k]) stable.add(shared[k]);
  return stable;
}

/** Mark two step lists against each other. Steps are matched by `id`:
 *  only in `after` -> added, only in `before` -> removed; same id but a different text, from, to, reply or self flag, or moved to another
 *  place in the order -> changed (in both lists); else same. A step that already has a `kind` keeps it.
 *  Returns { before, after } as new step lists; the inputs are not touched. */
export function diffSequences(beforeSteps, afterSteps) {
  const index = (steps, name) => {
    const map = new Map();
    steps.forEach((step, i) => {
      if (step?.id == null || step.id === "") throw new Error(`diffSequences: ${name}[${i}] has no id`);
      const id = String(step.id);
      if (map.has(id)) throw new Error(`diffSequences: ${name}[${i}] repeats the id "${id}"`);
      map.set(id, step);
    });
    return map;
  };
  const before = index(beforeSteps, "before"), after = index(afterSteps, "after");
  const mark = (step, kind) => ({ ...step, kind: step.kind ?? kind });
  const stable = stableIds([...before.keys()], [...after.keys()]);
  const kindOf = (step, other, missing) => {
    const id = String(step.id);
    if (!other.has(id)) return missing;
    return stable.has(id) && sameFlow(step, other.get(id)) ? "same" : "changed";
  };
  return {
    before: beforeSteps.map((step) => mark(step, kindOf(step, after, "removed"))),
    after: afterSteps.map((step) => mark(step, kindOf(step, before, "added"))),
  };
}

function paragraphs(value, name) {
  const list = (Array.isArray(value) ? value : [value]).filter((item) => typeof item === "string" || typeof item === "number").map((item) => String(item).trim()).filter(Boolean);
  if (!list.length) throw new Error(`renderCompare: plain.${name} is missing or empty`);
  return list.flatMap((item) => item.split(/\n{2,}/)).map((item) => `<p>${withBreaks(item.trim())}</p>`).join("");
}

/** Throws (naming the field) when one of the three plain-words parts is missing or empty. Returns the paragraphs as HTML. */
export function validatePlain(plain) {
  if (!plain || typeof plain !== "object") throw new Error("renderCompare: plain is missing; it needs 原来, 现在 and 对你有什么好处");
  const parts = PLAIN_FIELDS.map(([field, meaning]) => {
    try { return [field, meaning, paragraphs(plain[field], field)]; } catch { throw new Error(`renderCompare: plain.${field} is missing or empty (${meaning})`); }
  });
  const tech = plain[TECH_FIELD] == null || plain[TECH_FIELD] === "" ? "" : paragraphs(plain[TECH_FIELD], TECH_FIELD);
  return { parts, tech };
}

const CAPTIONS = {
  zh: { before: "原来", after: "现在", hint: "图比屏幕宽的话，在图上左右滑动就能看全。" },
  en: { before: "Before", after: "After", hint: "If a diagram is wider than the screen, swipe it sideways to see all of it." },
};

/** Specs for the two diagrams, marks computed when the steps carry ids. */
export function compareSpecs({ actors, before, after, diff }) {
  const need = (spec, name) => {
    if (!spec || !Array.isArray(spec.steps)) throw new Error(`renderCompare: ${name}.steps is missing`);
    if (!spec.actors && !actors) throw new Error(`renderCompare: ${name}.actors is missing (give actors on ${name} or at the top level)`);
  };
  need(before, "before"); need(after, "after");
  // marks come from ids: all steps need one (a step without it cannot be told "added" from "moved"); with no ids at all, kinds are by hand
  const noId = (step) => step?.id == null || step.id === "";
  const missing = [["before", before.steps], ["after", after.steps]].flatMap(([side, list]) => list.map((step, i) => noId(step) ? `${side} step ${i + 1}` : null).filter(Boolean));
  const anyId = [...before.steps, ...after.steps].some((step) => !noId(step));
  const compute = diff === true || (diff !== false && anyId);
  if (compute && missing.length) throw new Error(`renderCompare: ${missing[0]} has no id${missing.length > 1 ? ` (and ${missing.length - 1} more)` : ""}; marks are worked out from ids, so give every step on both sides one (or set "diff": false and give each step its kind)`);
  const marked = compute ? diffSequences(before.steps, after.steps) : { before: before.steps, after: after.steps };
  return [{ actors, ...before, steps: marked.before }, { actors, ...after, steps: marked.after }];
}

export function renderCompare({ title, actors, before, after, plain, diff, lang = "zh-CN", colWidth }) {
  if (!title || typeof title !== "string") throw new Error("renderCompare: title is missing");
  const { parts, tech } = validatePlain(plain);
  const words = CAPTIONS[String(lang).startsWith("zh") ? "zh" : "en"];
  const [beforeSpec, afterSpec] = compareSpecs({ actors, before, after, diff });
  // two diagrams share one row, so the lifelines sit closer than in a lone diagram
  const crowd = Math.max(beforeSpec.actors?.length ?? 0, afterSpec.actors?.length ?? 0);
  // five or more lifelines do not fit twice in one row: the diagrams stack and get the roomy default spacing
  const stack = crowd >= 5;
  const options = { lang: String(lang).startsWith("zh") ? "zh" : "en", embedStyle: false, colWidth: colWidth ?? (stack ? undefined : crowd <= 3 ? 165 : 140), noteWidth: stack ? undefined : 140 };
  const draw = (side, spec) => {
    try { return renderSequence({ title: `${title} · ${words[side]}`, ...spec }, options); } catch (error) {
      throw new Error(`renderCompare: ${side} ${error.message.replace(/^renderSequence: /, "").replace(/steps\[(\d+)\]/g, (_, k) => `step ${Number(k) + 1}`)}`);
    }
  };
  const pane = (side, spec) => `<figure class="rk-pane rk-pane--${side}"><figcaption>${esc(words[side])}</figcaption><div class="rk-scroll">${draw(side, spec)}</div></figure>`;
  const items = parts.map(([field, meaning, body], i) => `<div class="rk-plain__item rk-plain__item--${i}"><h4>${esc(field)}<small>${esc(meaning)}</small></h4>${body}</div>`).join("");
  const details = tech ? `<details class="rk-tech"><summary>${esc(TECH_FIELD)}</summary>${tech}</details>` : "";
  return `<section class="rk-compare${stack ? " rk-compare--stack" : ""}" aria-label="${esc(title)}"><div class="rk-compare__cols">${pane("before", beforeSpec)}${pane("after", afterSpec)}</div><p class="rk-hint">${esc(words.hint)}</p><div class="rk-plain">${items}</div>${details}</section>`;
}

export const COMPARE_CSS = `
.rk-compare{display:grid;gap:1rem;width:100%}
.rk-compare__cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,500px),1fr));gap:1rem;align-items:start}
.rk-compare--stack .rk-compare__cols{grid-template-columns:100%}
.rk-compare--stack .rk-seq{max-width:none !important}
.rk-pane{margin:0;min-width:0}
.rk-pane figcaption{font-weight:700;margin:0 0 .35rem;font-size:.95rem}
.rk-pane--before figcaption::before{content:"◀ "}
.rk-pane--after figcaption::before{content:"▶ "}
.rk-scroll{overflow-x:auto;border-radius:10px;border:1px solid var(--dk-line,#d0d7de)}
.rk-hint{display:none;margin:0;font-size:.8rem;opacity:.75}
@media (max-width:640px){.rk-hint{display:block}}
.rk-plain{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,240px),1fr));gap:.75rem}
.rk-plain__item{border:1px solid var(--dk-line,#d0d7de);border-radius:10px;padding:.7rem .9rem;background:var(--dk-card,#f6f8fa)}
.rk-plain__item h4{margin:0 0 .3rem;font-size:1rem}
.rk-plain__item h4 small{display:block;font-weight:400;font-size:.75rem;opacity:.7}
.rk-plain__item p{margin:.3rem 0;line-height:1.6;font-size:.9em}
.rk-plain__item--2{border-color:var(--dk-accent,#1a7f37);border-width:2px}
.rk-tech{border:1px dashed var(--dk-line,#d0d7de);border-radius:10px;padding:.5rem .9rem}
.rk-tech summary{cursor:pointer;font-weight:600}
`.trim();
