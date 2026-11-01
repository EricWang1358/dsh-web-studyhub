import { mineruBlock } from './converted-document.js';
import { dshSystemTokens } from './token-estimate.js';

/* What the learner may change in a converted book before it is imported (导入前先让我改, issue #54). The merged content list (the one shape both MinerU and Marker
   end in, lib/mineru-merge.js) stays what it is: an edit replaces the text of a block or removes the block, and every block keeps its `page_idx`, so the document import
   (lib/converted-document.js) projects it onto the same pages it would have. `edits` maps a block's index to its new text, or to null when it is removed. Pure. */

/** The field of a block that holds its words, or null for a block that can only be removed (a table is HTML, a picture has only captions). */
function fieldOf(item) {
  const type = String(item?.type || '');
  if (type === 'table' || type === 'image') return null;
  if (type === 'list') return 'list_items';
  if (type === 'code') return 'code_body';
  return typeof item?.text === 'string' ? 'text' : null;
}
const wordsOf = (item, field) => (field === 'list_items' ? (Array.isArray(item.list_items) ? item.list_items.join('\n') : '') : String(item[field] ?? ''));

/** The blocks to show: only those that reach a page (a running head never reaches a model). { index, page (1-based), type, text, editable }. */
export function editableBlocks(content) {
  const blocks = [];
  content.forEach((item, index) => {
    const reached = item && typeof item === 'object' ? mineruBlock(item) : null;
    if (!reached) return;
    const field = fieldOf(item);
    blocks.push({ index, page: Number(item.page_idx) + 1, type: String(item.type || 'text'), text: field ? wordsOf(item, field) : reached.text, editable: !!field });
  });
  return blocks;
}

/* A line of typed text must not read as the start of another page of the book (Marker's Markdown is cut at these lines). */
const PAGE_LINE = /^[ \t]*\{\d+\}-{20,}[ \t]*$/gm;
const PAGE_COMMENT = /<!--\s*page\s*[:=]?\s*\d+\s*-->/gi;
const typed = text => String(text).replace(/\r\n?/g, '\n').replace(PAGE_LINE, '').replace(PAGE_COMMENT, '');

/** The content list with the edits applied. A removed block keeps its page, as a block the import drops. Emptied text is a removal; words for a block without words change nothing. */
export function applyEdits(content, edits = {}) {
  return content.map((item, index) => {
    if (!Object.hasOwn(edits, index)) return item;
    const edit = edits[index], field = fieldOf(item), words = typeof edit === 'string' ? typed(edit) : null;
    if (edit === null || (field && words !== null && !words.trim())) return { type: 'discarded', page_idx: item.page_idx };
    if (!field || words === null) return item;
    return { ...item, [field]: field === 'list_items' ? words.split('\n').map(line => line.trim()).filter(Boolean) : words };
  });
}

/** Edits as they can be kept: only what is really an edit of a block the learner can see. */
export function cleanEdits(content, edits) {
  if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw new Error('edits must map a block index to its new text, or to null to remove it');
  const shown = new Map(editableBlocks(content).map(block => [String(block.index), block])), kept = {};
  for (const [index, edit] of Object.entries(edits)) {
    const block = shown.get(index);
    if (!block || (edit !== null && typeof edit !== 'string')) continue;
    if (edit === null || (block.editable && edit !== block.text)) kept[index] = edit;
  }
  return kept;
}

const readText = content => content.map(item => (item && typeof item === 'object' ? mineruBlock(item)?.text ?? '' : '')).join('');

/** What the edits take out of what a model would read: characters and estimated tokens, by the measure of the token estimates (never below zero: an edit may also add words). */
export function savedBy(content, edits = {}) {
  const before = readText(content), after = readText(applyEdits(content, edits));
  return { chars: Math.max(0, before.length - after.length), tokens: Math.max(0, dshSystemTokens(before) - dshSystemTokens(after)) };
}
