/* The labels a whole-point AI block is written with (复习全书, ui/book/BookAiBlock.jsx): 「原文说：」, 「意思就是：」 and 「资料原文：」 at the start of a paragraph or
   a list item. After the block's text is drawn they are put in a span (`book-ai__label`, drawn quieter by ui/book/book.css), so the words after them read first.
   Only the drawn page changes: the Markdown, the file and the export are as they were, and `undo()` puts the text back. The caller draws the text fresh (a
   new React key) whenever it changes, so a span is only ever put on new text (the same rule as the dashed words, ui/book/ai-anchors.js). */

const NAMES = '原文说|意思就是|资料原文|The source says|In plain words|From the materials';
const LABEL = new RegExp(`^(?:${NAMES})\\s*[:：]\\s*`, 'i'), BARE = new RegExp(`^(?:${NAMES})\\s*[:：]?\\s*$`, 'i');

/** Mark the leading labels inside `root`. -> undo() */
export function markLabels(root) {
  const undo = [];
  if (!root) return () => {};
  for (const block of root.querySelectorAll('p, li')) {
    const strong = block.firstChild;
    // A bold label (**原文说：** …, **原文说**：…) is already set off: it is only quieted.
    if (strong?.nodeType === 1 && strong.tagName === 'STRONG' && BARE.test(strong.textContent)) {
      strong.classList.add('book-ai__label');
      undo.push(() => strong.classList.remove('book-ai__label'));
      continue;
    }
    const node = block.firstChild, found = node?.nodeType === 3 ? LABEL.exec(node.data) : null;
    if (!found) continue;
    const whole = node.data, span = block.ownerDocument.createElement('span'), rest = whole.slice(found[0].length);
    span.className = 'book-ai__label';
    span.textContent = found[0];
    node.data = rest;
    node.before(span);
    undo.push(() => { if (node.data === rest) { node.data = whole; span.remove(); } });
  }
  return () => undo.forEach(run => run());
}
