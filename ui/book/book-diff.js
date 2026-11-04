/* Line diff and timestamp formatting for the review book's read-only version history panel (#489). Pure, bounded, no I/O. */

const CONTEXT = 2;
const LCS_CELLS_MAX = 160_000;
const DIFF_ROWS_MAX = 240;

const splitLines = text => {
  const normalized = String(text ?? '').replace(/\r\n?/g, '\n');
  return normalized ? normalized.split('\n') : [];
};

function collapseContext(ops) {
  const changed = ops.map((op, index) => (op.kind !== 'same' ? index : -1)).filter(index => index >= 0);
  if (!changed.length) return [];
  const keep = new Array(ops.length).fill(false);
  for (const at of changed) {
    for (let i = Math.max(0, at - CONTEXT); i <= Math.min(ops.length - 1, at + CONTEXT); i += 1) keep[i] = true;
  }
  const out = [];
  let index = 0;
  while (index < ops.length) {
    if (keep[index]) {
      out.push(ops[index]);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < ops.length && !keep[end]) end += 1;
    out.push({ kind: 'skip', count: end - index });
    index = end;
  }
  return out;
}

/** Compares `older` (a historical version) against `current` (the live file text).
    Returns `{ identical, added, removed, rows, truncated }` where each row is `{ kind: 'same' | 'del' | 'add', text }` or `{ kind: 'skip', count }`. */
export function diffLines(older, current) {
  const a = splitLines(older), b = splitLines(current);
  if (a.length === b.length && a.every((line, index) => line === b[index])) {
    return { identical: true, added: 0, removed: 0, rows: [], truncated: false };
  }
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length - 1, endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA -= 1;
    endB -= 1;
  }
  const midA = a.slice(start, endA + 1), midB = b.slice(start, endB + 1);
  let midOps;
  if (midA.length * midB.length <= LCS_CELLS_MAX) {
    const cols = midB.length + 1;
    const dp = new Int32Array((midA.length + 1) * cols);
    for (let i = midA.length - 1; i >= 0; i -= 1) {
      for (let j = midB.length - 1; j >= 0; j -= 1) {
        dp[i * cols + j] = midA[i] === midB[j] ? dp[(i + 1) * cols + (j + 1)] + 1 : Math.max(dp[(i + 1) * cols + j], dp[i * cols + (j + 1)]);
      }
    }
    midOps = [];
    let i = 0, j = 0;
    while (i < midA.length && j < midB.length) {
      if (midA[i] === midB[j]) { midOps.push({ kind: 'same', text: midA[i] }); i += 1; j += 1; }
      else if (dp[(i + 1) * cols + j] >= dp[i * cols + (j + 1)]) { midOps.push({ kind: 'del', text: midA[i] }); i += 1; }
      else { midOps.push({ kind: 'add', text: midB[j] }); j += 1; }
    }
    while (i < midA.length) { midOps.push({ kind: 'del', text: midA[i] }); i += 1; }
    while (j < midB.length) { midOps.push({ kind: 'add', text: midB[j] }); j += 1; }
  } else {
    midOps = [...midA.map(text => ({ kind: 'del', text })), ...midB.map(text => ({ kind: 'add', text }))];
  }
  const ops = [
    ...a.slice(0, start).map(text => ({ kind: 'same', text })),
    ...midOps,
    ...a.slice(endA + 1).map(text => ({ kind: 'same', text })),
  ];
  let added = 0, removed = 0;
  for (const op of midOps) {
    if (op.kind === 'add') added += 1;
    else if (op.kind === 'del') removed += 1;
  }
  const collapsed = collapseContext(ops);
  const truncated = collapsed.length > DIFF_ROWS_MAX;
  return { identical: false, added, removed, rows: truncated ? collapsed.slice(0, DIFF_ROWS_MAX) : collapsed, truncated };
}
