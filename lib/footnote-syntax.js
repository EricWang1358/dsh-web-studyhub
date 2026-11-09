/* The two lines of footnote syntax of the 复习全书's Markdown that both the book's writer (lib/book-footnotes.js) and the page made from an export
   (ui/book/book-html.js) read. Here and not in lib/book-footnotes.js, which reaches modules that need Node (the browser build cannot bundle them). Pure. */

/** A definition line; a chat writing Chinese may type the full-width colon. */
export const DEFINITION = /^\[\^([\w-]{1,44})\][:：][ \t]*(.*)$/;

/** The label line of the 出处 list (either language), which the writer takes out and puts back with the footnotes. */
export const isLabelLine = line => /^\*\*(出处|Sources)\*\*$/.test(line.trim());
