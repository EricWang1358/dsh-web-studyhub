/**
 * The questions-within-an-answer ("问中问") of one selection, as plain data: the nodes, the limits and the rules for
 * when a click asks the model and when it only jumps to what is already there. No React, no storage: the owner of
 * the selection keeps the state and drops it when the selection changes.
 */
export const MAX_DEPTH = 3, MAX_NODES = 8, THREAD_ANCESTORS = 3, LABEL_MAX = 24;

export const emptyThread = () => ({ nodes: [] });
export const ROOT = null;

export const nodeOf = (thread, id) => thread.nodes.find(node => node.id === id);
export const childrenOf = (thread, parentId) => thread.nodes.filter(node => node.parentId === parentId);
/** 1 for an answer to the first-level question, 2 for its children, and so on. */
export function depthOf(thread, id) {
  let depth = 0;
  for (let node = nodeOf(thread, id); node; node = nodeOf(thread, node.parentId)) depth += 1;
  return depth;
}
/** The nodes from the first-level answer down to `id`, oldest first. */
export function pathOf(thread, id) {
  const path = [];
  for (let node = nodeOf(thread, id); node; node = nodeOf(thread, node.parentId)) path.unshift(node);
  return path;
}
/** What one step is called in the path: the term it came from, the quick question it started from, else the question itself, shortened. */
export function stepLabel(node) {
  if (node.term) return node.term;
  if (node.label) return node.label;
  const question = String(node.question || '').replace(/\s+/g, ' ').trim();
  return question.length > LABEL_MAX ? `${question.slice(0, LABEL_MAX - 1)}…` : question;
}
/** "没听懂 › ELK": what was asked at each step. */
export const pathLabel = (thread, id) => pathOf(thread, id).map(stepLabel).join(' › ');

/** Only the answered ancestors go to the model as context; at most three, oldest first, as `{ question, answer }`. */
export const threadFor = (thread, parentId) => pathOf(thread, parentId).filter(node => node.status === 'answered')
  .slice(-THREAD_ANCESTORS).map(({ question, answer }) => ({ question, answer }));

/**
 * Decide what a request to ask under `parentId` does. `{ action: 'open', node }` jumps to a node that already exists
 * for the same term under the same parent (no second model call); `{ action: 'refuse', reason }` says why not;
 * `{ action: 'ask' }` is allowed. `reason` is a key the UI turns into a plain sentence.
 */
export function planAsk(thread, { parentId = ROOT, term = '' } = {}) {
  if (term) {
    const same = childrenOf(thread, parentId).find(node => node.term === term);
    if (same) return { action: 'open', node: same };
  }
  if (parentId !== ROOT) {
    const parent = nodeOf(thread, parentId);
    if (!parent) return { action: 'refuse', reason: 'missing' };
    if (parent.status === 'asking') return { action: 'refuse', reason: 'busy' };
    if (depthOf(thread, parentId) >= MAX_DEPTH) return { action: 'refuse', reason: 'depth' };
  }
  if (thread.nodes.length >= MAX_NODES) return { action: 'refuse', reason: 'nodes' };
  return { action: 'ask' };
}

/** Add an answer being waited for. The caller made sure `planAsk` said `ask`. */
export const addNode = (thread, node) => ({ nodes: [...thread.nodes, { term: '', answer: '', error: '', ...node, status: 'asking' }] });
const patch = (thread, id, fields) => ({ nodes: thread.nodes.map(node => node.id === id ? { ...node, ...fields } : node) });
export const answerNode = (thread, id, answer) => patch(thread, id, { status: 'answered', answer, error: '' });
export const failNode = (thread, id, error) => patch(thread, id, { status: 'failed', error });
/** Retry the same node in place: the question and its place in the path stay. */
export const retryNode = (thread, id) => patch(thread, id, { status: 'asking', error: '' });
/** Collapsed answers stay in the thread; this is only a view flag. */
export const toggleNode = (thread, id) => patch(thread, id, { collapsed: !nodeOf(thread, id)?.collapsed });
/** Open the node and everything above it, so a jump to an existing answer lands on something visible. */
export const revealNode = (thread, id) => {
  const path = new Set(pathOf(thread, id).map(node => node.id));
  return { nodes: thread.nodes.map(node => path.has(node.id) && node.collapsed ? { ...node, collapsed: false } : node) };
};
