/* global document, window */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { launchChromium } from '../scripts/qa/browser.mjs';

const compile = (contents, options) => build({ stdin: { contents, resolveDir: process.cwd(), loader: 'jsx' }, bundle: true, write: false,
  loader: { '.css': 'text' }, logLevel: 'silent', ...options });
const compiled = await compile(`export { default as Markdown } from './ui/Markdown.jsx'; export { default as FlipCard } from './ui/FlipCard.jsx'; export { default as EnBlock } from './ui/EnBlock.jsx'; export { setUiLanguage } from './ui/i18n.js';`,
  { platform: 'node', format: 'cjs', external: ['react', 'react-dom'] });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { Markdown, FlipCard, EnBlock, setUiLanguage } = module.exports;
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

test('an ordered list keeps its start number: items cut apart by paragraphs (an AI block\'s 「1. 2. 3.」) read 1, 2, 3, not 1, 1, 1', () => {
  const html = render('1. 第一条\n\n说明一段。\n\n2. 第二条\n\n说明。\n\n3. 第三条');
  assert.deepEqual([...html.matchAll(/<ol(?: start="(\d+)")?>/g)].map(match => match[1] ?? '1'), ['1', '2', '3']);
  assert.match(render('1. a\n2. b'), /<ol><li>a<\/li><li>b<\/li><\/ol>/, 'a list from 1 has no start attribute');
  assert.match(render('4) d\n5) e'), /<ol start="4">/, 'the 4) form too');
  assert.match(render('3、 丙'), /<ol start="3">/, 'and 3、');
  assert.match(render('- a\n- b'), /<ul><li>a/, 'a bullet list has none');
  assert.match(render('1. a\n   2. nested'), /<ol start="2">/, 'a nested list keeps its own start');
});

test('fenced code blocks show normalized language tag and copy button only outside button containers', () => {
  setUiLanguage('zh');
  const python = render('```Python title=demo\nx = 1\nprint(x)\n```');
  assert.match(python, /<div class="md-code-block">/);
  assert.match(python, /<span class="md-code-lang">python<\/span>/);
  assert.match(python, /<button[^>]*class="[^"]*md-code-copy[^"]*"[^>]*aria-label="复制代码"[^>]*>复制<\/button>/);
  assert.match(python, /<pre class="md-code"><code>x = 1\nprint\(x\)<\/code><\/pre>/);

  const tilde = render('~~~  SQL  \nSELECT 1;\n~~~');
  assert.match(tilde, /<span class="md-code-lang">sql<\/span>/);

  const noLang = render('```\nplain line\n```');
  assert.doesNotMatch(noLang, /md-code-lang/);
  assert.match(noLang, /md-code-copy/);

  const emptyNoLang = render('```\n```');
  assert.doesNotMatch(emptyNoLang, /md-code-head|md-code-copy/);

  const emptyWithLang = render('```js\n```');
  assert.match(emptyWithLang, /<span class="md-code-lang">js<\/span>/);
  assert.doesNotMatch(emptyWithLang, /md-code-copy/);

  const insideButton = render('```python\nx = 1\n```', { links: false });
  assert.match(insideButton, /<pre class="md-code"><code>x = 1<\/code><\/pre>/);
  assert.doesNotMatch(insideButton, /<button|md-code-copy/);
});

test('citePreview wraps cite buttons in a Tooltip when present while keeping md-cite-keep intact', () => {
  const html = render('见定义[^1]。', { onCite: () => {}, citePreview: n => `第 ${n} 条摘录` });
  assert.match(html, /<span class="md-cite-keep">义<sup class="md-cite">[\s\S]*?<span[^>]*role="tooltip"[^>]*>第 1 条摘录<\/span>[\s\S]*?<\/sup>。<\/span>/);
  assert.match(html, /aria-describedby="/);

  const none = render('见定义[^1]。', { onCite: () => {}, citePreview: () => null });
  assert.doesNotMatch(none, /role="tooltip"|aria-describedby=/);
});

test('Markdown tables wrap with ScrollEdgeWrap and EnBlock avoids raw buttons across block and inline modes', () => {
  setUiLanguage('zh');
  const tableHtml = render('| A | B |\n| --- | --- |\n| 1 | 2 |');
  assert.match(tableHtml, /<div class="md-table-wrap"><div class="md-table"><table>/);

  const blockEn = renderToStaticMarkup(React.createElement(EnBlock, { text: 'Hello $x^2$' }));
  assert.doesNotMatch(blockEn, /<button/);
  assert.match(blockEn, /<div class="en-block"><span role="button" tabindex="0" class="en-block__toggle" aria-expanded="true" aria-label="收起译文">[\s\S]*?en-mark[^>]*>EN<\/span><\/span><div class="md md-compact">/);

  const inlineEn = renderToStaticMarkup(React.createElement(EnBlock, { text: 'alpha · beta', inline: true, className: 'extra' }));
  assert.doesNotMatch(inlineEn, /<button/);
  assert.match(inlineEn, /<p class="en-block en-inline-line extra"><span role="button" tabindex="0" class="en-block__toggle" aria-expanded="true" aria-label="收起译文">[\s\S]*?en-mark[^>]*>EN<\/span><\/span>alpha · beta<\/p>/);
});

test('code copy, table scroll edges, and local EN collapse work interactively in Chromium', { timeout: 60000 }, async t => {
  const bundle = await compile(`
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import Markdown from './ui/Markdown.jsx';
    import FlipCard from './ui/FlipCard.jsx';
    import markdownCss from './ui/markdown.css';
    import { setUiLanguage } from './ui/i18n.js';
    setUiLanguage('zh');
    window.__cardFlips = 0;
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async text => { window.__copied.push(text); } },
    });
    function App() {
      const [flipped, setFlipped] = React.useState(false);
      const card = { prompt: '中文题面', translation: { prompt: 'Front English prompt' } };
      const solution = { answer: '中文答案', translation: { answer: 'Back English answer' } };
      return <div className="study-app">
        <style>{markdownCss + '.narrow { width: 180px; } .md table td { white-space: nowrap; }'}</style>
        <Markdown text={'\`\`\`python\\nx = 1\\nprint(x)\\n\`\`\`\\n\\n| 列一 | 列二 | 列三 | 列四 |\\n| --- | --- | --- | --- |\\n| verylongcolumnone | verylongcolumntwo | verylongcolumnthree | verylongcolumnfour |'} className="narrow" />
        <FlipCard run={{ card, revealed: true, solution }} showBack={flipped} flipCard={() => { window.__cardFlips++; setFlipped(v => !v); }} enOn />
      </div>;
    }
    createRoot(document.getElementById('root')).render(<App />);
  `, { platform: 'browser', format: 'iife' });

  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 500, height: 800 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.md-code-copy').waitFor();

  await page.locator('.md-code-copy').click();
  await page.waitForFunction(() => document.querySelector('.md-code-copy')?.textContent?.includes('已复制'));
  assert.deepEqual(await page.evaluate(() => window.__copied), ['x = 1\nprint(x)']);

  const edgeAtStart = await page.evaluate(() => ({
    left: document.querySelector('.md-table-wrap')?.getAttribute('data-edge-left'),
    right: document.querySelector('.md-table-wrap')?.getAttribute('data-edge-right'),
  }));
  assert.deepEqual(edgeAtStart, { left: null, right: 'true' });

  await page.evaluate(() => {
    const scroller = document.querySelector('.md-table');
    scroller.scrollLeft = 40;
    scroller.dispatchEvent(new window.Event('scroll'));
  });
  await page.waitForFunction(() => document.querySelector('.md-table-wrap')?.getAttribute('data-edge-left') === 'true');
  assert.equal(await page.evaluate(() => document.querySelector('.md-table-wrap')?.getAttribute('data-edge-right')), 'true');

  await page.evaluate(() => {
    const scroller = document.querySelector('.md-table');
    scroller.scrollLeft = scroller.scrollWidth;
    scroller.dispatchEvent(new window.Event('scroll'));
  });
  await page.waitForFunction(() => !document.querySelector('.md-table-wrap')?.getAttribute('data-edge-right'));
  assert.equal(await page.evaluate(() => document.querySelector('.md-table-wrap')?.getAttribute('data-edge-left')), 'true');

  // Local EN toggle on FlipCard front does not flip the card and does not collapse back EN.
  const frontToggle = page.locator('.flip-front .en-block__toggle');
  await frontToggle.click();
  assert.equal(await frontToggle.getAttribute('aria-expanded'), 'false');
  assert.match(await frontToggle.innerText(), /EN[\s\S]*展开译文/);
  assert.equal(await page.locator('.flip-front .en-block .md-compact').count(), 0);
  assert.equal(await page.evaluate(() => window.__cardFlips), 0);
  assert.equal(await page.locator('.flip-back .en-block__toggle').getAttribute('aria-expanded'), 'true');
  assert.equal(await page.locator('.flip-back .en-block .md-compact').count(), 1);

  // Flip to back, then toggle back EN with Enter and Space without flipping the card.
  await page.locator('.flip-control').click({ force: true });
  assert.equal(await page.evaluate(() => window.__cardFlips), 1);
  const backToggle = page.locator('.flip-back .en-block__toggle');
  await backToggle.focus();
  await page.keyboard.press('Enter');
  assert.equal(await backToggle.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => window.__cardFlips), 1);
  await page.keyboard.press('Space');
  assert.equal(await backToggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await page.evaluate(() => window.__cardFlips), 1);
  assert.deepEqual(errors, []);
});
