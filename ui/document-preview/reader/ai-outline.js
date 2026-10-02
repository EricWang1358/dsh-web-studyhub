/* The reader side of the AI outline (materials.outline.*): where a kept outline's entries are in what the reader has
   drawn, and the small state machine of the "让 AI 帮你" flow. A kept entry carries an anchor { sourceId, offset, quote,
   ordinal } over the stored text: `quote` is the first characters of its block with the spaces left out, `ordinal` which
   occurrence of them it is. The drawn text (Markdown or HTML rendered, or the paragraphs of a text source) is the stored
   text up to its spaces, so the same occurrence is found there, and the nearest block element of it becomes the target
   of the entry (data-ai-outline-id, read by useReadingPosition like data-outline-id). An entry whose place cannot be
   found is left out of the outline rather than guessed. */

const BLOCKS = 'h1,h2,h3,h4,h5,h6,p,li,pre,blockquote,td,th,dt,dd';
export const AI_ATTRIBUTE = 'data-ai-outline-id';
const SHORTER = [24, 12];

/** The visible text of a container without spaces, with the DOM position of every character. */
function compactMap(container) {
  const walker = container.ownerDocument.createTreeWalker(container, 4), nodes = [], at = [], offsets = [];
  let text = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('[data-study-marker]')) continue;
    const value = node.textContent;
    nodes.push(node);
    for (let index = 0; index < value.length; index += 1) {
      if (/\s/.test(value[index])) continue;
      text += value[index]; at.push(nodes.length - 1); offsets.push(index);
    }
  }
  return { text, nodes, at, offsets };
}

const occurrences = (text, quote) => {
  const found = [];
  for (let at = text.indexOf(quote); quote && at >= 0; at = text.indexOf(quote, at + 1)) found.push(at);
  return found;
};

function rangeAt(container, map, start, length) {
  const last = Math.min(map.text.length - 1, start + length - 1), range = container.ownerDocument.createRange();
  range.setStart(map.nodes[map.at[start]], map.offsets[start]);
  range.setEnd(map.nodes[map.at[last]], map.offsets[last] + 1);
  return range;
}

/**
 * The DOM range of each entry's first characters, found by its anchor; entries that cannot be found are missing from the
 * result. Entries are looked for in order, never before the one found just above.
 * @returns Map<entry index, Range>
 */
export function locateEntries(root, entries) {
  const found = new Map();
  if (!root) return found;
  const pages = [...root.querySelectorAll('[data-study-source]')], maps = new Map();
  const mapOf = sourceId => {
    const container = pages.length ? pages.find(page => page.dataset.studySource === sourceId) : root;
    if (!container) return null;
    if (!maps.has(container)) maps.set(container, { container, map: compactMap(container), floor: 0 });
    return maps.get(container);
  };
  entries.forEach((entry, index) => {
    const anchor = entry.anchor, home = anchor && mapOf(anchor.sourceId);
    if (!home || !anchor.quote) return;
    const { map } = home;
    for (const length of [anchor.quote.length, ...SHORTER.filter(size => size < anchor.quote.length)]) {
      const quote = anchor.quote.slice(0, length), list = occurrences(map.text, quote);
      const start = length === anchor.quote.length && list[anchor.ordinal] >= home.floor ? list[anchor.ordinal] : list.find(position => position >= home.floor);
      if (start === undefined) continue;
      found.set(index, rangeAt(home.container, map, start, length));
      home.floor = start + 1;
      return;
    }
  });
  return found;
}

/** The block a range starts in, or null when that block is the whole text container (a <pre> of plain text). */
function blockOf(range, root) {
  const start = range.startContainer, element = (start.nodeType === 1 ? start : start.parentElement)?.closest(BLOCKS);
  return element && root.contains(element) && !element.hasAttribute('data-study-text') ? element : null;
}

/**
 * Tag the drawn text for a kept outline and list its entries: [{ id, level, title, kind, range, tagged }] in order.
 * `tagged` is false when the place is known but has no block of its own to scroll to (jump with the range).
 */
export function applyOutline(root, entries) {
  if (!root) return [];
  root.querySelectorAll(`[${AI_ATTRIBUTE}]`).forEach(element => element.removeAttribute(AI_ATTRIBUTE));
  const located = locateEntries(root, entries), items = [];
  entries.forEach((entry, index) => {
    const range = located.get(index);
    if (!range) return;
    const id = `ai-${index}`, element = blockOf(range, root), tagged = !!element && !element.hasAttribute(AI_ATTRIBUTE);
    if (tagged) element.setAttribute(AI_ATTRIBUTE, id);
    else if (element) return; // two entries on one block: the first keeps it
    items.push({ id, level: entry.level, title: entry.title, kind: entry.kind, range, tagged });
  });
  return items;
}

export const clearOutlineTags = root => root?.querySelectorAll(`[${AI_ATTRIBUTE}]`).forEach(element => element.removeAttribute(AI_ATTRIBUTE));

/* ---------- the "让 AI 帮你" flow ---------- */

export const ASSIST_IDLE = Object.freeze({ phase: 'idle' });

/**
 * The state a materials.outline.suggest result puts the flow in.
 * Phases: ready (priced, waiting for the learner), nomodel, empty, proposal, rejected.
 */
export function assistFromResult(result) {
  if (result?.available === false || result?.status === 'unavailable') return { phase: 'nomodel' };
  if (result?.status === 'empty') return { phase: 'empty' };
  if (result?.status === 'estimate') return result.modelAvailable ? { phase: 'ready', coverage: result.coverage, estimate: result.estimate } : { phase: 'nomodel', coverage: result.coverage };
  if (result?.status === 'proposed') return { phase: 'proposal', entries: result.entries, usage: result.usage, coverage: result.coverage, warnings: result.warnings || [] };
  if (result?.status === 'rejected') return { phase: 'rejected', code: result.code, usage: result.usage, coverage: result.coverage };
  return { phase: 'failed', message: '' };
}

/** idle → estimating → ready → running → proposal | rejected | failed; nothing here starts a model call by itself. */
export function assistReducer(state, action) {
  switch (action.type) {
    case 'estimate': return { phase: 'estimating' };
    case 'run': return { phase: 'running', coverage: state.coverage, estimate: state.estimate };
    case 'saving': return { ...state, saving: true };
    case 'result': return assistFromResult(action.result);
    case 'error': return { phase: 'failed', message: String(action.message || '') };
    case 'reset': return ASSIST_IDLE;
    default: return state;
  }
}

/** Which of the plain messages a rejection code gets. */
export function rejectionKind(code) {
  if (code === 'not-json') return 'format';
  if (code === 'empty') return 'empty';
  if (code === 'misplaced' || code === 'ungrounded') return 'grounding';
  return 'structure';
}
