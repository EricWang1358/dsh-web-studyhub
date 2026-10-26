import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareStudyMath, safeStudyImage, splitStudyMath } from '../ui/study-media.js';
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

test('notes as people write them: spaced dollars, a unit after a number, bare LaTeX environments; prose and currency stay prose', () => {
  const raws = (text) => prepareStudyMath(text).formulas.map((formula) => formula.raw);
  assert.deepEqual(raws('力 $ F = ma $，加速度 $ a=\\frac{F}{m} $。'), ['$ F = ma $', '$ a=\\frac{F}{m} $']);
  assert.deepEqual(raws('质量为5$kg$的物体，速度$v$和5$m/s$'), ['$kg$', '$v$', '$m/s$']);
  assert.deepEqual(raws('令 $ x $ 为位移'), ['$ x $']);
  const equation = '\\begin{equation}\nF=ma\n\\end{equation}';
  assert.deepEqual(prepareStudyMath(`前文\n${equation}\n后文`).formulas.map((formula) => [formula.raw, formula.display]), [[equation, true]]);
  const align = '\\begin{align}\nF&=ma\\\\ E&=mc^2\n\\end{align}';
  assert.equal(renderStudyFormula(align, true).includes('<math'), true);
  assert.deepEqual(prepareStudyMath('矩阵 \\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix} 如上').formulas.map((formula) => formula.display), [false]);
  // Prose, currency and look-alikes are not formulas.
  for (const prose of ['价格$5和$10', 'costs $ 5 and $ 10 each', '5$ and 6$ total', '$x $ 和 $ y$', 'a$b$c', '`\\begin{equation}`', '\\begin{foo} x \\end{foo}', '$ 和 $', '(5$)',
    '预算：广告5$k，人员10$k。', '汇率1$USD=7.1$CNY', 'Budget:5$k/10$k', '%1$s and %2$s', 'Budget: 5$k for ads and 10$k for staff.', 'It costs 5$USD now, was 3$USD.', 'Revenue grew from 2$M to 7$M in a year', '单价 5$M 元，总价 7$M','Revenue = $ 500 + $ 300 = $ 800','$ 5 * 3 = $ 15', 'save $ 100 / month and $ 200 / year', 'cost $ 5 > $ 3', '收入 $ 100 + $ 200，合计', '$ 1,000 + $ 2,000', '| A | $ 5 | $ 1 |'])
    assert.deepEqual(raws(prose), [], prose);
  // Money glued to its number (no space, as Chinese is written) must not swallow the real formula after it.
  assert.deepEqual(raws('投资5$M的项目，速度$v$'), ['$v$']);
  assert.deepEqual(raws('月薪10$k，求$x$'), ['$x$']);
  assert.deepEqual(raws('长度为$ x = 5$cm，宽为$y$'), ['$y$']);
  // Money with a space after the sign must not swallow the real formula after it.
  assert.deepEqual(raws('price $ 5 + tax, then solve $x^2=4$.'), ['$x^2=4$']);
  // Reading and writing agree: the pieces of a text join back to the text.
  const mixed = '力 $ F = ma $，5$kg$，\\begin{equation}a=b\\end{equation}尾';
  assert.equal(splitStudyMath(mixed).map((piece) => (typeof piece === 'string' ? piece : piece.raw)).join(''), mixed);
});

test('physics and siunitx commands KaTeX does not know are written out, so the note draws; the rest still falls back to its source', () => {
  for (const source of ['\\dv{x}{t}', '\\pdv{f}{x}', '\\SI{3}{m/s}', '\\unit{m/s}', '\\upmu\\mathrm{m}', '\\mbox{m}', '\\vb{F}', 'a\\label{x}', '\\abs{x}', '\\norm{x}', '\\eqref{x}', '\\mathbbm{1}'])
    assert.match(renderStudyFormula(source, false), /<math/, source);
  assert.equal(renderStudyFormula('\\qty(\\frac{a}{b})', false), null, 'a command with no stand-in is shown as written');
  // A stand-in that cannot be sure of its arguments shows the source instead of drawing something else.
  for (const source of ['\\dv{x}', '\\dv[2]{x}{t}', '\\pdv{f}{x}{y}', '\\dv{x} = 2', '\\SI[round=1]{3}{m/s}', '\\abs*{x}']) assert.equal(renderStudyFormula(source, false), null, source);
  // siunitx numbers and units: only plain ones are drawn as they stand; 1.6e-19 is a power of ten, 3+-0.1 a ±, a dot in a unit a product.
  for (const source of ['\\SI{3}{m/s}', '\\SI{9.8}{m/s^2}', '\\SI{-3.5}{kg}', '\\si{N m}', '\\unit{kg}']) assert.match(renderStudyFormula(source, false), /<math/, source);
  for (const source of ['\\SI{1.6e-19}{C}', '\\SI{3e8}{m/s}', '\\SI{9.8+-0.1}{m/s^2}', '\\SI{1,5}{kg}', '\\SI{3x4}{m}', '\\unit{m.s^{-1}}', '\\si{kg.m/s^2}', '\\SI{3}{\\meter\\per\\second}']) assert.equal(renderStudyFormula(source, false), null, source);
  // Commands whose package meaning is not the plain text they would give are left out: the source shows, nothing else is drawn.
  for (const source of ['\\ev{x}', '\\ev{A}{\\psi}', '\\va{a}', '\\vu{x}', '\\ang{30;15;10}', '\\num{3e8}']) assert.equal(renderStudyFormula(source, false), null, source);
  // The space the lexer drops after a control word stays: an argument is not glued into another command.
  const flat = (html) => html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '');
  assert.equal(flat(renderStudyFormula('\\abs{F \\cdot s}', false)), '∣F⋅s∣');
  assert.match(renderStudyFormula('\\abs{\\sin h}', false), /<mi>sin<\/mi>[\s\S]*<mi>h<\/mi>/, '\\sin h keeps its h');
  assert.doesNotMatch(renderStudyFormula('\\abs{x \\in t}', false), /∫/, '\\in t is not \\int');
  // A command that draws nothing takes its argument with it.
  const plain = (html) => html.replace(/<annotation[\s\S]*?<\/annotation>/g, '').replace(/<[^>]+>/g, '');
  assert.equal(plain(renderStudyFormula('\\label{eq:newton}F = ma', false)), 'F=ma');
  assert.equal(plain(renderStudyFormula('\\require{physics}\\vb{F}=m\\vb{a}', false)), 'F=ma');
  assert.equal(plain(renderStudyFormula('\\dv{x}{t}', false)), 'dxdt');
  // Where there is a document and no MathML (an old Chromium) the source is shown instead of a garbled drawing.
  const saved = { document: globalThis.document, unknown: globalThis.HTMLUnknownElement, mathml: globalThis.MathMLElement };
  globalThis.HTMLUnknownElement = class {};
  globalThis.document = { createElement: () => new globalThis.HTMLUnknownElement() };
  try {
    assert.equal(renderStudyFormula('x^2', false), null);
    globalThis.MathMLElement = class {};
    assert.match(renderStudyFormula('x^2', false), /<math/, 'a browser that has MathML keeps the drawing');
  } finally {
    for (const [key, value] of [['document', saved.document], ['HTMLUnknownElement', saved.unknown], ['MathMLElement', saved.mathml]]) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
  }
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
