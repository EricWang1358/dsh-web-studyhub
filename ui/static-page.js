/* The shell every self-contained page the app saves as a file shares (the 速查表, ui/book/cheat-sheet-html.js, and the 复习全书 as one page,
   ui/book/book-html.js): the document, its viewport, its light colours and base style, and the two small helpers their markup needs. Inline style only,
   no script, no image, no address; the one font is the formulas', inlined, and only in a page that has a formula. Pure, no React.

   staticPage({ lang, title, css, body, mathCss }) -> the document; `css` follows BASE_CSS, `body` is the markup inside <body>. `mathCss`: the formula
   stylesheet with its fonts (ui/study-math-render.js MATH_CSS, woff2 data: URIs, #996), added only when the body draws a formula, so it reads offline. */

/** Text as it may stand in HTML (element text and double-quoted attributes). */
export const esc = value => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** KaTeX's markup without the MathML namespace address: an HTML parser reads <math> without it, and the file then names no address at all. */
export const withoutNamespace = mathml => String(mathml ?? '').replace(/ xmlns="[^"]*"/g, '');

/** The light page: colours as variables, no dark mode (the file is read on a screen and printed in the same colours). */
export const BASE_CSS = `:root{color-scheme:light;--ink:#15171a;--mute:#555b63;--line:#c9ced4;--soft:#f2f4f6;--accent:#1f4f8a;--mark:#fff3bf}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;padding:12px 16px 32px;font:14px/1.45 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--ink);background:#fff}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}`;

export const staticPage = ({ lang, title, css, body, mathCss = '' }) => `<!doctype html>
<html lang="${esc(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${css}${mathCss && String(body).includes('class="katex"') ? mathCss : ''}</style>
</head>
<body>
${body}
</body>
</html>
`;
