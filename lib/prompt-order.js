/* The ORDER of a generation prompt (plan, blueprint, author, review, patch), one place for all of them.
   A provider (DeepSeek and others) serves a prompt from cache only up to the longest prefix IDENTICAL to an earlier request's, and bills the rest at the full input price. So the stable text
   goes first and everything that changes from call to call (the count, the plan so far, the candidate, ids, a correction or re-ask) goes after it:

     instructions first (the default)       instruction text  ·  REQUEST DATA:  ·  { stable fields, sources, per-call fields..., count }
     sources first (OFF, see below)         REQUEST DATA:  ·  { sources, stable fields, per-call fields..., count }  ·  instruction text

   In both layouts `count` is the LAST field of the data and no instruction text contains it, and a correction or re-ask is appended at the very end (so the prompt it corrects is an
   unchanged prefix). Only the order of text and of fields is decided here: no field is added or dropped (the payload of each stage is the stage's own business).

   WHY INSTRUCTIONS FIRST, even for a big source block (measured with the real pipeline and the fake model, the provider cache simulated on system text + prompt, as the request is sent):
   every stage has its own system text, which opens the request, so two DIFFERENT stages of a part never share the sources that follow; what is shared is the same stage across the parts
   of a run. With the instructions first, those parts share the instructions, the stable fields and (when their sources are the same text) the source block; with the sources first they
   share the source block only when the sources are the same, and nothing when each part has its own pages (a 300 000-character text planned in four groups: 26.0K tokens read from cache
   with the instructions first, 6.8K with the sources first). Sources first pays only when the stage system text no longer leads the request: then every stage of one part opens with
   the same bytes (the same 300 000-character run: 64.7% of the input from cache instead of 6.9%). That needs the gateway to put the stage's system text behind the sources (the
   child agent's request in lib/generation-agent.js, and the system role of a direct call), which is a change of what is sent as system, not of order inside a prompt. The layout is
   built and tested so that switching it on is one line (`promptOrder.sourcesFirst`), the threshold being the size of the biggest stage instruction block plus a margin. */

export const REQUEST_DATA = 'REQUEST DATA:\n';

/** A source block bigger than this leads the prompt, once `promptOrder.sourcesFirst` is on: the sources are then the biggest stable thing a prompt has (the author's instruction block is about 10 000 characters). */
export const LEAD_SOURCE_CHARS = 12000;

/** The layout switch. Off: the instructions lead whatever the size of the sources (see above for why). */
export const promptOrder = { sourcesFirst: false };

/** Whether the sources of a call lead its prompt. One answer per set of sources, so every stage of a part chooses the same layout. */
export const leadsWithSources = (sources) => promptOrder.sourcesFirst && Array.isArray(sources) && sources.length > 0 && JSON.stringify(sources).length > LEAD_SOURCE_CHARS;

/** The data of a call as JSON, its fields in the order the layout needs: `before` (stable across the calls of a request), the `sources`, then `after` (what varies per call, `count` last). */
const dataJson = ({ lead, before, sources, after }) => JSON.stringify(lead ? { sources, ...before, ...after } : { ...before, sources, ...after });

/** The prompt of a stage: `instruction` (no marker, no count in it), the data, and `tail` (a correction, at the very end). */
export function stagePrompt({ instruction, sources, before = {}, after = {}, tail = '' }) {
  const lead = leadsWithSources(sources), json = dataJson({ lead, before, sources, after });
  return lead ? `${REQUEST_DATA}${json}\n\n${instruction}${tail}` : `${instruction}\n${REQUEST_DATA}${json}${tail}`;
}

/** The payload of a stage that has no instruction text of its own (the review: its instructions are the system text and fields of the data). */
export function dataPayload({ sources, before = {}, after = {} }) {
  const lead = leadsWithSources(sources), json = dataJson({ lead, before, sources, after });
  return lead ? `${REQUEST_DATA}${json}` : json;
}

/** `payload` (from dataPayload) with one more field at the END of its data: the prompt stays a prefix of the new one, and it is still one JSON value. */
export function withField(payload, key, value) {
  const marked = payload.startsWith(REQUEST_DATA), data = JSON.parse(marked ? payload.slice(REQUEST_DATA.length) : payload);
  return `${marked ? REQUEST_DATA : ''}${JSON.stringify({ ...data, [key]: value })}`;
}

/** The listed fields of `object` that are set, in that order. */
export const pick = (object, keys) => Object.fromEntries(keys.filter((key) => object?.[key] !== undefined).map((key) => [key, object[key]]));
