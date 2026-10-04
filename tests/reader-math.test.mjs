/* Formulas in the text reader (阅读): drawn like on the cards, while the text that selection, find, the link
   underlines and translation count stays exactly the stored text. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseFragment } from 'parse5';
import { splitStudyMath } from '../ui/study-media.js';

const compiled = await build({ stdin: { contents: `
  export { default as ReadingSections } from './ui/document-preview/reader/ReadingSections.jsx';
  export { readingSections } from './ui/document-preview/reader/text-sections.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { ReadingSections, readingSections } = module.exports;

/** What selection / find / links count in rendered markup: the text outside every data-study-marker. */
const countedText = html => {
  let text = '';
  const walk = node => {
    if (node.attrs?.some(attribute => attribute.name === 'data-study-marker')) return;
    if (node.nodeName === '#text') text += node.value;
    node.childNodes?.forEach(walk);
  };
  walk(parseFragment(html));
  return text;
};
const joined = pieces => pieces.map(piece => typeof piece === 'string' ? piece : piece.raw).join('');
const STORED = String.raw`全连接层前向：$z = Wx + b$，损失 $L = \frac{1}{2}(a - y)^2$。` + '\n\n'
  + String.raw`未配平：$\ce{Fe + O2 -> Fe2O3}$。另一例：\(x_i\) 与` + '\n$$\\delta = (a - y) \\odot \\sigma\'(z)$$\n\n'
  + '价格 $5 and $10，代码 `$x$` 不是公式。';

test('splitting finds the formulas and gives the stored text back unchanged', () => {
  const pieces = splitStudyMath(STORED), formulas = pieces.filter(piece => typeof piece !== 'string');
  assert.equal(joined(pieces), STORED);
  assert.deepEqual(formulas.map(item => item.source), ['z = Wx + b', String.raw`L = \frac{1}{2}(a - y)^2`, String.raw`\ce{Fe + O2 -> Fe2O3}`, 'x_i', String.raw`\delta = (a - y) \odot \sigma'(z)`]);
  assert.deepEqual(formulas.map(item => item.display), [false, false, false, false, true]);
  assert.deepEqual(splitStudyMath('no formulas here'), ['no formulas here']);
  assert.deepEqual(splitStudyMath(''), []);
});

test('the reader draws each formula as a marker and keeps its source as the counted text', () => {
  const sections = readingSections({ paged: false, sources: [{ id: 's', text: STORED }], text: STORED });
  const html = renderToStaticMarkup(React.createElement(ReadingSections, { sections, labelOf: () => '' }));
  assert.equal((html.match(/class="reader-math(?: reader-math--display)?"/g) || []).length, 5);
  assert.equal((html.match(/class="reader-math reader-math--display"/g) || []).length, 1);
  assert.match(html, /<span class="reader-math__view" data-study-marker="true"><span class="katex"><math/);
  const counted = countedText(html);
  for (const formula of splitStudyMath(STORED).filter(piece => typeof piece !== 'string')) assert.ok(counted.includes(formula.raw), formula.raw);
  assert.match(counted, /价格 \$5 and \$10/, 'currency stays text');
  assert.doesNotMatch(html, /reader-math[^"]*"><span[^>]*>\$x\$/, 'code is never a formula');
});

test('a Markdown heading line reads as a heading with its # hidden, also when the text follows on the next line', () => {
  const stored = '# 反向传播公式\n全连接层前向：$z = Wx + b$。\n\n## 化学方程式配平\n\n#hashtag 不是标题';
  const [section] = readingSections({ paged: false, sources: [{ id: 's', text: stored }], text: stored });
  assert.deepEqual(section.paragraphs.map(item => [item.kind, item.text]), [['heading', '# 反向传播公式'], ['prose', '全连接层前向：$z = Wx + b$。'],
    ['heading', '## 化学方程式配平'], ['prose', '#hashtag 不是标题']]);
  const html = renderToStaticMarkup(React.createElement(ReadingSections, { sections: [section], labelOf: () => '' }));
  assert.match(html, /<h4 class="reader-p reader-p--heading"><span class="reader-bracket" aria-hidden="true"># <\/span>反向传播公式<\/h4>/, 'the # stays in the text, hidden like a transcript 【】');
  const [page] = readingSections({ paged: true, sources: [{ id: 'p', text: '# 第一章\n正文' }] });
  assert.equal(page.heading, '第一章', 'the outline lists the page heading without its #');
});

test('a line that is just a formula is body text, not a heading (a heading would set it larger, with a heading gap)', () => {
  const stored = String.raw`前向传播如下` + '\n\n' + String.raw`$$\delta = x$$` + '\n\n' + String.raw`$a = b$` + '\n\n结尾说明文字在这里。';
  const [section] = readingSections({ paged: false, sources: [{ id: 's', text: stored }], text: stored });
  assert.deepEqual(section.paragraphs.map(item => item.kind), ['heading', 'prose', 'prose', 'prose']);
});
