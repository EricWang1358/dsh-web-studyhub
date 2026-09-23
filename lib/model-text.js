/* Models sometimes JSON-escape a string value twice, so an answer arrives with
   literal `\n` sequences instead of line breaks and renders as one run-on line
   ("…完成。\n\n## 对应本题…"). Repair only text that is clearly that case: no
   real newline anywhere, plus a literal paragraph break or a Markdown block
   marker right after a literal `\n`. A lone `printf("\n")` stays untouched.
   Dependency-free: shared by the service and the UI bundle. */
const BLOCK_AFTER_ESCAPED_NEWLINE = /\\n(?:\\n|#{1,6} |[-*+] |\d+[.)] |> |\|)/;

export function unescapeModelText(text) {
  if (typeof text !== "string" || text.includes("\n") || !BLOCK_AFTER_ESCAPED_NEWLINE.test(text))
    return text;
  return text.replace(/\\r\\n|\\n|\\t|\\"/g, (m) => (m === "\\t" ? "\t" : m === '\\"' ? '"' : "\n"));
}
