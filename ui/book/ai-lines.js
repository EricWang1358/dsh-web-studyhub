/* The lines an AI task or a deletion leaves in a point of the review book (docs/review-book.md "AI blocks"), placed by the same rules as the blocks
   themselves (ui/book/point-parts.js pointView), so a line stands exactly where its block will be and the block that lands takes its place without moving
   anything: 「AI 正在写 · 约 1 分钟 · 取消」 while a task runs (its failure, with the reason and 重试, in the same place), and 「已删除这段 · 撤销」 for a few
   seconds where a deleted block was. Pure, no React, no DOM; nothing here writes to the book.

   A line: { kind: 'writing' | 'failed' | 'undo', id (the block's id: a task's blockId, a deleted block's id), heading (the point's hid), mode, words, title
   (the point's title: a 加一段's block is about it), after (a follow-up continues that block), replace (重新生成 writes that block again), index (undo: where
   the block was among the point's blocks), block (undo: the deleted block), error (failed: the reason) }. */

const squash = text => String(text ?? '').replace(/\s+/g, ' ').trim();

/** What a task's block will say it is about (lib/course-book-ai-text.js aiBlock: the words, quotes off, at most 120 characters; a 加一段 is about the title). */
export const aboutOf = (mode, words, title) => squash(mode === 'here' ? title : words).replace(/[「」“”]/g, '').slice(0, 120);

/** The block a line stands for, as aiBlocks would read it once written (no text yet), with the line on it. */
function lineBlock(line) {
  if (line.kind === 'undo') return { ...line.block, line };
  // Its own id (a 重新生成's failure stands under the block of the same id).
  return { id: `${line.id}:${line.kind}`, at: line.mode === 'here' ? `h:${line.heading}` : 'line', state: 'new', mode: line.mode || 'explain', ask: '', about: aboutOf(line.mode, line.words, line.title),
    first: '', body: '', raw: '', line };
}

/**
 * The point's blocks (aiBlocks of its own file) with its lines among them -> { blocks, rewriting: Map<block id, line> }. A task's line goes where its block
 * will go: right under the block a follow-up continues, else last (a new block is written at the end of the own file); a deleted block's line where the block
 * was. A line whose block is already in the file is not drawn (the block took its place). 重新生成 keeps the old block until the new one lands: no line, the
 * block is in `rewriting` (its failure is a line right under it).
 */
export function withLines(blocks, lines = []) {
  const list = [...blocks], ids = new Set(blocks.map(block => block.id)), rewriting = new Map();
  for (const line of lines) {
    if (line.kind === 'undo') {
      if (ids.has(line.id) || !line.block) continue;
      list.splice(Math.max(0, Math.min(line.index ?? list.length, list.length)), 0, lineBlock(line));
      continue;
    }
    if (line.replace && ids.has(line.replace)) {
      if (line.kind === 'writing') { rewriting.set(line.replace, line); continue; }
      list.splice(list.findIndex(block => block.id === line.replace) + 1, 0, lineBlock({ ...line, after: line.replace }));
      continue;
    }
    if (ids.has(line.id)) continue;
    const parent = line.after ? list.findIndex(block => block.id === line.after) : -1;
    if (parent >= 0) list.splice(parent + 1, 0, lineBlock(line));
    else list.push(lineBlock(line));
  }
  return { blocks: list, rewriting };
}

/** The lines of one point (`lines`: every line of the page). */
export const linesOf = (lines, hid) => (lines || []).filter(line => line.heading === hid);
