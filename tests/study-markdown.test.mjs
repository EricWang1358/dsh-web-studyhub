import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const compiled = await build({ stdin: { contents: `export { default as Markdown } from './ui/Markdown.jsx'; export { default as FlipCard } from './ui/FlipCard.jsx';`, resolveDir: process.cwd() }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Markdown, FlipCard } = module.exports;
const render = (text, props = {}) => renderToStaticMarkup(React.createElement(Markdown, { text, ...props }));

test('study Markdown preserves math as one formula across newlines and formatting characters', () => {
  const html = render(String.raw`**Solve** $x_i^2 + \frac{1}{2}$ and \(\nabla f\).

$$
\begin{aligned}a&=1\\b&=2\end{aligned}
$$

\[\ce{2H2(g) + O2(g) -> 2H2O(l)}\]`);
  assert.equal((html.match(/class="md-math(?:"| )/g) || []).length, 4);
  assert.match(html, /<strong>Solve<\/strong>/);
  assert.doesNotMatch(html, /<em>/);
});

test('code, currency and unsafe markup keep their boundaries', () => {
  const html = render('Cost $5 and $10. Escaped \\$x$. `$x^2$ ![code](https://example.org/a.png)`\n\n```tex\n$$x^2$$\n<script>alert(1)</script>\n```\n\n<script>alert(2)</script> [bad](javascript:alert)');
  assert.doesNotMatch(html, /md-math|<img|<script|href="javascript:/);
  assert.match(html, /Cost \$5 and \$10/);
  assert.match(html, /\$\$x\^2\$\$/);
});

test('Markdown images use safe bounded sources and do not create controls inside choices', () => {
  const html = render('![Chart](https://example.org/a.png) ![bad](javascript:alert) ![private](file:///secret.png) ![html](data:text/html;base64,PHNjcmlwdD4=)', { links: false });
  assert.match(html, /<img[^>]*src="https:\/\/example.org\/a.png"/);
  assert.match(html, /alt="Chart"/);
  assert.match(html, /loading="lazy"/);
  assert.doesNotMatch(html, /<button|src="(?:javascript|file|data):/);
});

test('formula delimiters in URLs and image descriptions never rewrite media addresses or alt text', () => {
  const html = render('![Energy $E$](https://example.org/$x$.png) [formula $x$](https://example.org/?q=$x$) https://example.org/$y$.png ![Plot](<https://example.org/(v1)/$x$.png>)');
  assert.match(html, /src="https:\/\/example.org\/\$x\$\.png"/);
  assert.match(html, /alt="Energy \$E\$"/);
  assert.match(html, /href="https:\/\/example.org\/\?q=\$x\$"/);
  assert.match(html, /href="https:\/\/example.org\/\$y\$\.png"/);
  assert.match(html, /src="https:\/\/example.org\/\(v1\)\/\$x\$\.png"/);
  assert.equal((html.match(/class="md-math(?:"| )/g) || []).length, 1);
  assert.doesNotMatch(html, /[\uE000\uE001]/);
});

test('flashcard keeps a separate flip button and image control; hidden answers are never rendered early', () => {
  const card = { prompt: '![Question](https://example.org/q.png) $x^2$', translation: { prompt: '$y^2$', answer: 'SECRET EN ANSWER' } };
  const html = renderToStaticMarkup(React.createElement(FlipCard, { run: { card, revealed: false }, showBack: false, flipCard: () => {}, enOn: true }));
  assert.match(html, /class="flashcard"/);
  assert.match(html, /class="flip-control"/);
  assert.doesNotMatch(html, /SECRET EN ANSWER|<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
  const revealed = renderToStaticMarkup(React.createElement(FlipCard, { run: { card, revealed: true, solution: { answer: '$z^2$', translation: { answer: '$w^2$' } } }, showBack: true, flipCard: () => {}, enOn: true }));
  assert.equal((revealed.match(/class="md-math(?:"| )/g) || []).length, 5);
});

test('a 角标 is one no-wrap unit with the character before it and the full stop or closing mark after it, so a line never starts on the mark', () => {
  const cited = text => render(text, { onCite: () => {} });
  assert.match(cited('熵只增不减[^1]。下一句。'), /只增不<span class="md-cite-keep">减<sup class="md-cite">[\s\S]*?<\/sup>。<\/span>下一句。/);
  assert.match(cited('见「熵[^2]」，再看。'), /见「<span class="md-cite-keep">熵<sup class="md-cite">[\s\S]*?<\/sup>」，<\/span>再看。/);
  const word = cited('熵[^1]是无序度。');
  assert.match(word, /<span class="md-cite-keep">熵<sup class="md-cite">[\s\S]*?<\/sup><\/span>是无序度。/);
  assert.match(cited('The entropy[^3] grows.'), /entrop<span class="md-cite-keep">y<sup class="md-cite">[\s\S]*?<\/sup><\/span> grows\./);
  // Two marks in a row and a mark at the very start: every mark has a unit or stands where nothing can break before it.
  assert.equal((cited('甲[^1]乙[^2]。').match(/md-cite-keep/g) || []).length, 2);
  assert.match(cited('[^1]开头'), /<p><sup class="md-cite">[\s\S]*?<\/sup>开头/);
  // Right after an inline element (bold, a link, code, a formula) there is no character of its own to take along: the unit starts with a WORD JOINER (U+2060),
  // which forbids the break between the element and the mark, so the line never starts on the mark.
  assert.match(cited('**重点**[^1]。'), /<\/strong><span class="md-cite-keep">⁠<sup class="md-cite">[\s\S]*?<\/sup>。<\/span>/);
  assert.match(cited('`code`[^1]'), /<\/code><span class="md-cite-keep">⁠<sup class="md-cite">/);
  assert.match(cited('甲[^1][^2]'), /<\/sup><\/span><span class="md-cite-keep">⁠<sup class="md-cite">/, 'a second mark right after the first keeps to it');
  assert.doesNotMatch(render('熵[^1]。'), /md-cite/, 'without a handler a 角标 stays the text it was written as');
  assert.match(render('熵[^1]。'), /熵\[\^1\]。/);
});
