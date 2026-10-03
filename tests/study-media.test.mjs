import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStudyMath, safeStudyImage } from '../ui/study-media.js';
import { renderStudyFormula } from '../ui/study-math-render.js';

test('formulas survive model newline repair, HTML-looking TeX and code unchanged', () => {
  const source = String.raw`Text\n\n## Heading\n$\nabla f + \nu$ and \(x_i < y_i\).`;
  const parsed = prepareStudyMath(source);
  assert.match(parsed.value, /\n\n## Heading\n/);
  assert.equal(parsed.formulas[0].source, String.raw`\nabla f + \nu`);
  assert.equal(parsed.formulas[1].source, 'x_i < y_i');
  const code = String.raw`\n\n## Heading\n` + '`' + String.raw`\nabla $x$` + '`';
  assert.match(prepareStudyMath(code).value, /`\\nabla \$x\$`/);
  assert.equal(prepareStudyMath('```tex\n$x$\n```').formulas.length, 0);
  assert.equal(prepareStudyMath('$$unclosed').formulas.length, 0);
  assert.equal(prepareStudyMath('$2 x + 1$').formulas[0].source, '2 x + 1');
});

test('local native MathML supports fractions, alignment and chemistry without fonts or executable markup', () => {
  for (const source of [String.raw`\frac{x_i^2}{\sqrt{2}}`, String.raw`\begin{aligned}a&=1\\b&=2\end{aligned}`, String.raw`\ce{2H2(g) + O2(g) -> 2H2O(l)}`, String.raw`\ce{Fe^{3+} + SCN- <=> FeSCN^{2+}}`, String.raw`\pu{1.5 mol L-1}`]) {
    const html = renderStudyFormula(source, true);
    assert.match(html, /<math[^>]*display="block"/);
    assert.doesNotMatch(html, /katex-html|<img|<script|<link/);
  }
  const chemistry = renderStudyFormula(String.raw`\ce{2H2 + O2 -> 2H2O}`, false);
  assert.match(chemistry, /<msub>/);
  assert.match(chemistry, /→/);
});

test('untrusted or invalid TeX fails visibly instead of executing links or macros', () => {
  for (const source of [String.raw`\href{javascript:alert(1)}{click}`, String.raw`\includegraphics{https://example.org/track.png}`, String.raw`\htmlClass{evil}{x}`, String.raw`\notACommand`, String.raw`\def\loop{\loop}\loop`]) {
    const html = renderStudyFormula(source, false);
    assert.ok(html === null || !/<a\b|<img\b|<script\b|class="evil"|href="javascript:/.test(html));
  }
});

test('image sources accept absolute web URLs and reject ambient paths and active schemes', () => {
  assert.equal(safeStudyImage('https://example.org/figure.png'), 'https://example.org/figure.png');
  for (const source of ['javascript:alert(1)', 'data:image/svg+xml,<svg/>', 'file:///secret.png', 'C:\\private.png', '../figure.png', '/assets/figure.png', '//example.org/x.png', 'https://user:secret@example.org/x.png', 'https://example.org/\nx.png']) assert.equal(safeStudyImage(source), null);
});
