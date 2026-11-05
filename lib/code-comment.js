/* Is a `#` line a heading, or a comment in code that is not fenced? Converted material and pasted notes carry code without ``` fences, and Python (shell, R …)
   writes its comments as `# …`, which reads as a Markdown heading. The one rule, used by every place that reads headings out of text (lib/sections.js for
   the reader and the 小节 of a run, lib/converted-document.js for a converted book's outline): a `#` line is code when the nearest line above or below it
   that is not itself a `#` line, with no blank line in between, looks like code. A real heading stands apart from code (a blank line, prose, a list or a
   fence between them), so a heading directly above `x = 1` is the one case this reads as code. Pure, no Node modules: the browser bundle imports it. */

const CODE = [
  /^(?:\t| {2,})(?![-*+][ \t]|\d{1,3}[.)][ \t])\S/, //   indented, and not a list item
  /^(?:>>>|\.\.\.)(?:[ \t]|$)/, //                     an interpreter prompt
  /^(?:async[ \t]+)?(?:def|class)[ \t]+\w/,
  /^(?:import[ \t]+\w|from[ \t]+[\w.]+[ \t]+import\b)/,
  /^(?:for|while|if|elif|with|except)\b.*:[ \t]*$/, //  a block that opens: `for i in range(3):`
  /^(?:else|try|finally)[ \t]*:[ \t]*$/,
  /^(?:return|yield|raise)\b/,
  /^[A-Za-z_][\w.]*(?:\[[^\]]*\])?[ \t]*(?:\*\*|\/\/|<<|>>|[-+*/%&|^@])?=(?!=)/, //  an assignment: `x = 1`, `total += 1`, `a[0] = b`
  /^[A-Za-z_][\w.]*\(.*\)[ \t]*;?[ \t]*$/, //            a call on its own line: `print(y)`
];

/** Whether `line` looks like a line of code (see CODE). */
export const looksLikeCode = line => CODE.some(pattern => pattern.test(line));

/** The nearest line from the line around offset `at` in direction `step` (-1 up: `at` is that line's start; 1 down: its end) that is not a `#` line,
    and whether it is code; a blank line or the edge of the text ends the search (false). */
function codeNear(text, at, step) {
  for (;;) {
    let line;
    if (step < 0) {
      if (at <= 0) return false;
      const from = text.lastIndexOf('\n', at - 2) + 1;
      line = text.slice(from, at - 1); at = from;
    } else {
      const newline = text.indexOf('\n', at);
      if (newline < 0) return false;
      const to = text.indexOf('\n', newline + 1);
      at = to < 0 ? text.length : to; line = text.slice(newline + 1, at);
    }
    line = line.replace(/\r$/, '');
    if (!line.trim()) return false;
    if (!/^[ \t]*#/.test(line)) return looksLikeCode(line);
  }
}

/** Whether the `#` line of `text` from `start` to `end` (its line break excluded) is a comment in unfenced code rather than a heading. */
export const isCodeComment = (text, start, end) => codeNear(text, start, -1) || codeNear(text, end, 1);
