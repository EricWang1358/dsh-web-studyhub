import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { layout, renderSequence } from '../scripts/report/sequence.mjs';
import { diffSequences, renderCompare } from '../scripts/report/compare.mjs';
import { renderDeck } from '../scripts/report/deck.mjs';
import { buildDeck } from '../scripts/report/build.mjs';
import { assertSelfContained } from '../scripts/report/selfcheck.mjs';
import { textWidth, wrapText } from '../scripts/report/text.mjs';

/* The report kit (scripts/report): sequence diagrams as SVG, before/after comparisons, and one self-contained HTML deck.
   These tests check the markup and the geometry; scripts/report/shots.mjs is the real-browser look. */

const examples = fileURLToPath(new URL('../scripts/report/examples/', import.meta.url));
const actors = [{ id: 'you', label: '你' }, { id: 'page', label: '错题页' }, { id: 'unit', label: '公式显示' }];
const steps = [
  { from: 'you', to: 'page', text: '点开一道错题' },
  { from: 'page', to: 'unit', text: '把公式交给统一的公式显示', kind: 'added', note: '别的页面也用它' },
  { from: 'unit', to: 'page', text: '画好公式，交回来', reply: true, kind: 'changed' },
  { from: 'page', to: 'page', text: '原样摆出符号', self: true, kind: 'removed' },
];

test('a diagram holds every actor and every step text, and describes itself for screen readers', () => {
  const svg = renderSequence({ title: '错题页', actors, steps });
  assert.match(svg, /^<svg [^>]*role="img"/);
  assert.match(svg, /<title id="[^"]+">错题页<\/title><desc id="[^"]+">/);
  for (const actor of actors) assert.ok(svg.includes(`>${actor.label}</tspan>`), actor.label);
  for (const step of steps) assert.ok(svg.includes(step.text.slice(0, 4)), step.text);
  assert.match(svg, /<desc[^>]*>参与方：你、错题页、公式显示。共 4 步。1\. 你到错题页：点开一道错题；2\. /);
  assert.ok(!svg.includes('xmlns'), 'inline svg needs no namespace url');
  assert.ok(renderSequence({ actors, steps }, { standalone: true }).includes('xmlns="http://www.w3.org/2000/svg"'));
});

test('hostile text never becomes markup', () => {
  const evil = '<script>alert(1)</script><img src=x onerror="alert(2)">&';
  const svg = renderSequence({ title: evil, actors: [{ id: 'a"><x', label: evil }, { id: 'b', label: 'B' }], steps: [{ from: 'a"><x', to: 'b', text: evil, note: evil }],
    notes: [{ over: ['b'], text: evil }], groups: [{ label: evil, from: 0, to: 0 }] });
  assert.ok(!svg.includes('<script'));
  assert.ok(!svg.includes('<img'));
  assert.ok(!/<[a-z][^>]* onerror=/i.test(svg), 'no tag carries an event handler');
  assert.ok(svg.includes('data-actor="a&quot;&gt;&lt;x"'), 'an id with quotes stays inside its attribute');
  assert.ok(svg.includes('&lt;script&gt;'));
  assert.equal((svg.match(/<svg/g) ?? []).length, 1);
});

test('kinds carry a badge and a non-colour cue, and the legend names only the kinds that are present', () => {
  const svg = renderSequence({ actors, steps });
  for (const [kind, badge] of [['added', '＋'], ['changed', '～'], ['removed', '－']]) {
    assert.ok(svg.includes(`data-kind="${kind}"`), kind);
    assert.ok(svg.includes(`>${badge}</text>`), badge);
    assert.ok(svg.includes(`data-legend="${kind}"`), `legend ${kind}`);
  }
  assert.ok(svg.includes('line-through'), 'removed text is struck through');
  assert.match(svg, /rk-line rk-dash/);

  const onlyAdded = renderSequence({ actors, steps: [{ from: 'you', to: 'page', text: 'a' }, { from: 'page', to: 'you', text: 'b', kind: 'added', reply: true }] });
  assert.deepEqual([...onlyAdded.matchAll(/data-legend="(\w+)"/g)].map((m) => m[1]).sort(), ['added', 'same']);
  const plain = renderSequence({ actors, steps: [{ from: 'you', to: 'page', text: 'a' }] });
  assert.ok(!plain.includes('data-legend'), 'nothing to tell apart, no legend');
  assert.ok(renderSequence({ actors, steps }, { lang: 'en' }).includes('>Adjusted</text>'));
});

test('a long Chinese message between close lifelines wraps inside them and never overlaps the next row', () => {
  const long = '这是一条很长很长的中文消息，用来检查在两条靠得很近的生命线之间，文字是否会按字宽折行而不是伸出去。';
  assert.equal([...long].length >= 40, true);
  const spec = { actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], steps: [
    { from: 'a', to: 'b', text: long }, { from: 'b', to: 'a', text: long, reply: true, kind: 'added' }, { from: 'c', to: 'c', text: long, self: true, kind: 'removed' }, { from: 'c', to: 'a', text: long, kind: 'changed', note: long },
  ] };
  const plan = layout(spec, { colWidth: 110 });
  assert.equal(plan.col, 110);
  let previous = -Infinity;
  for (const row of plan.rows) {
    const { box } = row, left = Math.min(row.ax, row.bx), right = Math.max(row.ax, row.bx);
    if (row.self) assert.ok(box.x >= row.ax && box.x + box.width <= plan.right, `self text of step ${row.index} stays right of its lifeline and inside the picture`);
    else assert.ok(box.x >= left && box.x + box.width <= right, `step ${row.index} text ${Math.round(box.x)}..${Math.round(box.x + box.width)} inside ${left}..${right}`);
    for (const line of row.lines) assert.ok(textWidth(line) * 14 <= box.width + 0.01, 'every line fits the box');
    assert.ok(box.y >= previous, `step ${row.index} starts below the previous row`);
    assert.ok(box.y + box.height <= row.y + 1 || row.self, 'text sits above its arrow');
    assert.ok(row.callout === undefined || (row.callout.box.x >= plan.right && row.callout.box.x + row.callout.box.width <= plan.width), 'callout stays in the gutter');
    previous = row.bottom;
  }
  assert.ok(plan.rows[0].lines.length >= 5, 'long text takes several lines');
  const wider = layout(spec);
  assert.ok(wider.height < plan.height, 'wider lifelines need fewer lines');
  assert.ok(layout({ ...spec, steps: spec.steps.slice(0, 2) }).height < layout(spec).height, 'height grows with the number of steps');
});

test('wrapping keeps closing marks off the start of a line and cuts words that are too long', () => {
  const { lines } = wrapText('点开这一道错题，然后再看一遍解析。', 14 * 5, 14);
  for (const line of lines) assert.ok(!/^[，。、！？]/.test(line), line);
  assert.equal(lines.join(''), '点开这一道错题，然后再看一遍解析。');
  const long = wrapText('supercalifragilisticexpialidocious', 14 * 6, 14);
  assert.ok(long.lines.length > 1 && long.width <= 14 * 6 + 0.01);
  assert.deepEqual(wrapText('a\nb', 200, 14).lines, ['a', 'b']);
});

test('a spec with a wrong field is refused by name', () => {
  assert.throws(() => renderSequence({ actors, steps: [{ from: 'you', to: 'nobody', text: 'x' }] }), /steps\[0\]\.to refers to the unknown actor "nobody"/);
  assert.throws(() => renderSequence({ actors, steps: [{ from: 'you', to: 'page', text: 'x', kind: 'new' }] }), /steps\[0\]\.kind/);
  assert.throws(() => renderSequence({ actors: [], steps: [] }), /actors/);
  assert.throws(() => renderSequence({ actors, steps: [], groups: [{ label: 'g', from: 0, to: 2 }] }), /groups\[0\]/);
});

test('diffSequences marks added, removed, changed and unchanged steps by id', () => {
  const before = [{ id: 'open', from: 'a', to: 'b', text: 'open' }, { id: 'raw', from: 'b', to: 'b', text: 'show raw' }, { id: 'wide', from: 'b', to: 'b', text: 'too wide' }, { id: 'ask', from: 'a', to: 'b', text: 'ask', kind: 'changed' }];
  const after = [{ id: 'open', from: 'a', to: 'b', text: 'open' }, { id: 'draw', from: 'b', to: 'c', text: 'draw' }, { id: 'wide', from: 'b', to: 'b', text: 'fits now' }, { id: 'ask', from: 'a', to: 'b', text: 'ask' }];
  const marked = diffSequences(before, after);
  assert.deepEqual(marked.before.map((s) => s.kind), ['same', 'removed', 'changed', 'changed']);
  assert.deepEqual(marked.after.map((s) => s.kind), ['same', 'added', 'changed', 'same']);
  assert.ok(!('kind' in before[0]), 'inputs are left alone');
  assert.deepEqual(diffSequences([{ id: 'x', from: 'a', to: 'b', text: 't' }], [{ id: 'x', from: 'a', to: 'c', text: 't' }]).after[0].kind, 'changed');
  assert.throws(() => diffSequences([{ from: 'a', to: 'b', text: 't' }], []), /before\[0\] has no id/);
  assert.throws(() => diffSequences([{ id: 'x', text: '' }, { id: 'x', text: '' }], []), /repeats the id "x"/);
});

const flow = {
  title: '错题页公式与超框',
  actors,
  before: { steps: [{ id: 'open', from: 'you', to: 'page', text: '点开一道错题' }, { id: 'raw', from: 'page', to: 'page', text: '原样摆出符号' }] },
  after: { steps: [{ id: 'open', from: 'you', to: 'page', text: '点开一道错题' }, { id: 'draw', from: 'page', to: 'unit', text: '交给公式显示' }] },
  plain: { 原来: '公式是一堆符号。', 现在: '公式画好了。', 对你有什么好处: '不用自己翻译。', 技术上改了什么: '改用共用单元。' },
};

test('a comparison draws both flows with computed marks and the three plain-words parts', () => {
  const html = renderCompare(flow);
  assert.equal((html.match(/<svg /g) ?? []).length, 2);
  const [beforePane, afterPane] = html.split('rk-pane--after');
  assert.ok(beforePane.includes('data-kind="removed"') && !beforePane.includes('data-kind="added"'));
  assert.ok(afterPane.includes('data-kind="added"') && !afterPane.includes('data-kind="removed"'));
  for (const part of ['原来', '现在', '对你有什么好处']) assert.ok(html.includes(`<h4>${part}<small>`), part);
  assert.match(html, /<details class="rk-tech"><summary>技术上改了什么<\/summary><p>改用共用单元。<\/p><\/details>/);
  assert.ok(!renderCompare({ ...flow, plain: { ...flow.plain, 技术上改了什么: undefined } }).includes('<details'));
  assert.ok(renderCompare({ ...flow, lang: 'en' }).includes('Before'));
});

test('a comparison without 原来, 现在 or 对你有什么好处 is refused and the error names the field', () => {
  for (const field of ['原来', '现在', '对你有什么好处']) {
    for (const bad of [undefined, '', '   ', []]) assert.throws(() => renderCompare({ ...flow, plain: { ...flow.plain, [field]: bad } }), new RegExp(`plain\\.${field} is missing or empty`), `${field} = ${JSON.stringify(bad)}`);
  }
  assert.throws(() => renderCompare({ ...flow, plain: undefined }), /plain is missing/);
  assert.throws(() => renderCompare({ ...flow, title: '' }), /title is missing/);
  assert.throws(() => renderCompare({ ...flow, after: {} }), /after\.steps is missing/);
  assert.ok(renderCompare({ ...flow, plain: { ...flow.plain, 原来: ['一段。', '另一段。'] } }).includes('<p>另一段。</p>'));
});

test('the sample deck builds into one small offline file with every slide and the keyboard handler', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'report-kit-'));
  try {
    const out = join(dir, 'deck.html');
    const result = await buildDeck(join(examples, 'sample-deck.json'), out);
    const html = await readFile(out, 'utf8');
    const deck = JSON.parse(await readFile(join(examples, 'sample-deck.json'), 'utf8'));
    assert.ok((await stat(out)).size < 1024 * 1024, 'under 1 MB');
    assert.equal(result.bytes, Buffer.byteLength(html));
    assert.ok(!/https?:\/\//i.test(html), 'no web address anywhere in the page');
    assert.ok(!/<link\b|<iframe\b|<script[^>]+src=|@import/i.test(html));
    assert.equal((html.match(/<script>/g) ?? []).length, 2, 'inline scripts only');
    assert.equal((html.match(/class="dk-slide /g) ?? []).length, deck.slides.length + 1, 'every slide plus the contents');
    for (const slide of deck.slides) assert.ok(html.includes(slide.title), slide.title);
    assert.ok(html.startsWith('<!doctype html>\n<html lang="zh-CN">'));
    assert.equal((html.match(/<img src="data:image\/png;base64,/g) ?? []).length, 2, 'images are inlined');
    for (const key of ['ArrowRight', 'ArrowLeft', 'PageDown', 'PageUp', 'Home', 'End', 'requestFullscreen', 'addEventListener("keydown"']) assert.ok(html.includes(key), key);
    assert.ok(html.includes('scroll-snap-type') && html.includes('@media print') && html.includes('prefers-reduced-motion') && html.includes('prefers-color-scheme:dark'));
    assert.ok(html.includes('id="dk-count"') && html.includes('class="dk-progress"') && html.includes('原来是怎样的'));
    assert.ok(html.includes('href="#s3"'), 'contents link to the slides');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('deck text is escaped, languages follow the deck, and a bad slide is refused by position', async () => {
  const html = await renderDeck({ title: '<b>t</b>', lang: 'en', toc: false, slides: [
    { type: 'title', title: 'x <script>alert(1)</script>', subtitle: 'see https://example.com' },
    { type: 'bullets', title: 'b', items: ['**bold** and `code`', { text: 'parent', sub: ['child'] }] },
    { type: 'table', title: 't', columns: ['a', 'b'], rows: [['1', '<i>2</i>']] },
    { type: 'stats', title: 's', items: [{ label: 'clicks', before: 7, after: 5, unit: 'clicks' }, { label: 'worse', before: 1, after: 3, better: 'lower' }] },
    { type: 'text', title: 'p', paragraphs: ['one\ntwo'] }, { type: 'section', title: 'sec' },
  ] });
  assert.ok(html.includes('<html lang="en">'));
  assert.ok(!html.includes('<script>alert') && !html.includes('<i>2</i>') && !html.includes('<b>t</b>'));
  assert.ok(html.includes('<strong>bold</strong>') && html.includes('<code>code</code>'));
  assert.ok(html.includes('down 2 clicks') && html.includes('dk-stat__delta is-worse'));
  assert.ok(!html.includes('Contents'), 'toc: false leaves the contents out');
  assert.ok(html.includes('see https://example.com'), 'a link the author wrote stays as text');
  await assert.rejects(renderDeck({ title: 'd', slides: [{ type: 'title', title: 'a' }, { type: 'poem', title: 'b' }] }), /slides\[1\].*type must be one of/);
  await assert.rejects(renderDeck({ title: 'd', slides: [{ type: 'table', title: 'b', columns: ['a'], rows: [['1', '2']] }] }), /slides\[0\] \(table\): rows\[0\] must have 1 cells/);
  await assert.rejects(renderDeck({ title: 'd', slides: [{ type: 'images', title: 'b', items: [{ src: 'row-before.png' }] }] }, { baseDir: examples }), /items\[0\]\.alt is missing/);
  await assert.rejects(renderDeck({ title: 'd', slides: [{ type: 'images', title: 'b', items: [{ src: 'nope.png', alt: 'x' }] }] }, { baseDir: examples }), /nope\.png" cannot be read/);
  await assert.rejects(renderDeck({ title: 'd', slides: [] }), /slides must be a non-empty list/);
  await assert.rejects(renderDeck({ title: 'd', lang: 'en"><script>', slides: [{ type: 'title', title: 'a' }] }), /lang .* is not a language code/);
});

const ONE_PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const imageDeck = (item) => ({ title: 'd', slides: [{ type: 'images', title: 'pictures', items: [{ alt: 'a picture', ...item }] }] });

test('an image address cannot break out of its attribute or reach another host', async () => {
  await assert.rejects(renderDeck(imageDeck({ src: 'data:image/png;base64,AAAA" onerror="alert(1)' })), /slides\[0\] \(images\): items\[0\]\.src is a data: address that is not plain base64/);
  await assert.rejects(renderDeck(imageDeck({ src: 'data:image/png;base64,AAAA"><script>fetch("//x")</script>' })), /items\[0\]\.src is a data: address/);
  await assert.rejects(renderDeck(imageDeck({ src: 'data:text/html;base64,AAAA' })), /items\[0\]\.src is a data: address/);
  await assert.rejects(renderDeck(imageDeck({ src: 'https://example.com/a.png' })), /items\[0\]\.src "https:\/\/example\.com\/a\.png" (cannot be read|is outside)/);
  const html = await renderDeck(imageDeck({ src: ONE_PIXEL, alt: 'say "hi" <b>', label: '<i>x</i>', caption: '<script>1</script>' }));
  assert.ok(html.includes(`<img src="${ONE_PIXEL}" alt="say &quot;hi&quot; &lt;b&gt;">`));
  assert.ok(!html.includes('<script>1') && !html.includes('<i>x') && !html.includes('<b>'));
  assert.ok(!html.includes('loading="lazy"'), 'inlined images are not lazy, or a printout would be blank');
});

test('an image is read only from inside the deck folder, and only when its bytes are an image', async () => {
  const root = await mkdtemp(join(tmpdir(), 'report-kit-paths-'));
  try {
    const folder = join(root, 'deck'), outside = join(root, 'secret.png');
    await mkdir(join(folder, 'pics'), { recursive: true });
    const png = await readFile(join(examples, 'row-before.png'));
    await writeFile(outside, png);
    await writeFile(join(folder, 'pics', 'ok.png'), png);
    await writeFile(join(folder, 'notes.png'), 'this is a text file named like a picture');
    await writeFile(join(folder, 'real.dat'), png);
    const build = (src) => renderDeck(imageDeck({ src }), { baseDir: folder });
    assert.match(await build('pics/ok.png'), /<img src="data:image\/png;base64,/);
    assert.match(await build('real.dat'), /<img src="data:image\/png;base64,/, 'the first bytes decide, not the name');
    await assert.rejects(build('../secret.png'), /items\[0\]\.src "\.\.\/secret\.png" is outside the deck folder/);
    await assert.rejects(build('pics/../../secret.png'), /is outside the deck folder/);
    await assert.rejects(build(outside), /is not a path inside the deck folder/);
    await assert.rejects(build('\\\\server\\share\\a.png'), /is not a path inside the deck folder/);
    await assert.rejects(build('notes.png'), /is not a png, jpeg, gif or webp image/);
    await assert.rejects(build('missing.png'), /cannot be read in the deck folder/);
    await assert.rejects(build('..hidden.png'), /cannot be read in the deck folder/, 'a name that merely starts with two dots is looked for inside, not refused as outside');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the page check reads markup, so loaders fail and sentences that only mention them pass', async () => {
  const page = (body) => `<!doctype html><html><head><style>p{color:red}</style></head><body>${body}</body></html>`;
  for (const [body, what] of [
    ['<img src="https://example.com/a.png" alt="x">', 'remote image'], ['<img src="//example.com/a.png" alt="x">', 'protocol-relative image'],
    ['<a href="http://example.com">x</a>', 'link'], ['<script src="app.js"></script>', 'script src'], ['<link rel="stylesheet" href="a.css">', 'link tag'],
    ['<div onclick="go()">x</div>', 'handler'], ['<img src=data:image/png;base64,AA onerror=x>', 'unquoted handler'], ['<p style="background:url(http://x/y)">x</p>', 'style url'],
    ['<img srcset="a.png 2x" alt="x">', 'srcset'], ['<iframe src="#"></iframe>', 'iframe'], ['<meta http-equiv="refresh" content="0;url=x">', 'meta refresh'],
    ['<style>@import "x.css";</style>', 'import'], ['<style>a{background:url(https://x/y.png)}</style>', 'css url'], ['<img src="javascript:alert(1)" alt="x">', 'javascript address'],
  ]) assert.throws(() => assertSelfContained(page(body)), /would reach outside itself/, what);
  assert.doesNotThrow(() => assertSelfContained(page(`<a href="#s2">x</a><img src="${ONE_PIXEL}" alt="x"><p>write @import url(//x) or https://example.com or &lt;script src=x&gt; in a sentence</p>`)));
  const html = await renderDeck({ title: 't', slides: [{ type: 'text', title: 'about "@import url(//evil)"', paragraphs: ['url(//evil) and <img src=x onerror=1> and https://example.com'] }] });
  assert.ok(html.includes('&lt;img src=x onerror=1&gt;'));
});

test('marks need ids on every step, and a moved step or a changed arrow kind counts as changed', async () => {
  const a = { id: 'a', from: 'x', to: 'y', text: 'a' }, b = { id: 'b', from: 'y', to: 'x', text: 'b' }, c = { id: 'c', from: 'x', to: 'x', text: 'c' };
  assert.deepEqual(diffSequences([a, b, c], [a, b, c]).after.map((s) => s.kind), ['same', 'same', 'same']);
  const moved = diffSequences([a, b, c], [b, c, a]);
  assert.deepEqual(moved.after.map((s) => s.kind), ['same', 'same', 'changed']);
  assert.deepEqual(moved.before.map((s) => s.kind), ['changed', 'same', 'same']);
  assert.deepEqual(diffSequences([a, b], [a, { ...b, reply: true }]).after.map((s) => s.kind), ['same', 'changed'], 'a call that became a reply');
  assert.equal(diffSequences([a, c], [a, { ...c, self: false, to: 'y' }]).after[1].kind, 'changed');
  assert.equal(diffSequences([a, b, c], [c, b, a]).after.filter((s) => s.kind === 'same').length, 1, 'only the longest run in order stays');

  const half = { ...flow, after: { steps: [flow.after.steps[0], { from: 'page', to: 'unit', text: 'no id here' }] } };
  assert.throws(() => renderCompare(half), /after step 2 has no id/);
  assert.throws(() => renderCompare({ ...flow, diff: true, before: { steps: [{ from: 'you', to: 'page', text: 'x' }] } }), /before step 1 has no id/);
  assert.doesNotThrow(() => renderCompare({ ...half, diff: false }));
  const byHand = renderCompare({ ...flow, before: { steps: [{ from: 'you', to: 'page', text: 'x', kind: 'removed' }] }, after: { steps: [{ from: 'you', to: 'page', text: 'y', kind: 'added' }] } });
  assert.ok(byHand.includes('data-kind="removed"') && byHand.includes('data-kind="added"'), 'no ids anywhere: kinds are by hand');
  await assert.rejects(renderDeck({ title: 'd', slides: [{ type: 'title', title: 't' }, { ...half, type: 'compare', title: 'c' }] }), /deck: slides\[1\] \(compare\): after step 2 has no id/);
  await assert.rejects(renderDeck({ title: 'd', slides: [{ ...flow, type: 'compare', title: 'c', after: { steps: [{ id: 'x', from: 'you', to: 'nobody', text: 't' }] } }] }), /slides\[0\] \(compare\): after step 1\.to refers to the unknown actor "nobody"/);
  await assert.rejects(renderDeck({ title: 'd', slides: [{ ...flow, type: 'compare', title: 'c', plain: { ...flow.plain, 现在: '' } }] }), /slides\[0\] \(compare\): plain\.现在 is missing or empty/);
});

test('long labels and self-messages get room of their own and bold text is measured wider', () => {
  assert.ok(textWidth('M') >= 0.9 && textWidth('i') < 0.4 && textWidth('中') === 1);
  assert.ok(wrapText('一二三四五六七八九十', 14 * 5, 14, 1.1).lines.length > wrapText('一二三四五六七八九十', 14 * 5, 14).lines.length);
  const label = '每次打开这一页都会走一遍，包括重新打开和刷新之后，还有从别的页面跳过来的时候';
  const plan = layout({ actors: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], steps: [
    { from: 'a', to: 'b', text: '一' }, { from: 'a', to: 'a', text: '这是一条自己对自己的长消息，要有一整行的位置，不能挤成四个字一行', self: true }, { from: 'b', to: 'c', text: '二' }],
  groups: [{ label, from: 0, to: 2 }] }, { colWidth: 110 });
  const [frame] = plan.frames, first = plan.rows[0];
  assert.ok(frame.tab.lines.length > 1, 'the label wraps');
  assert.ok(frame.tab.width <= frame.box.width, 'the tab stays inside the frame');
  assert.ok(first.box.y >= frame.box.y + frame.tab.height, 'the first step starts below the tab');
  assert.ok(plan.rows[1].lines.length <= 3, `the self-message is not a sliver (${plan.rows[1].lines.length} lines)`);
  assert.ok(plan.rows[1].box.x + plan.rows[1].box.width <= plan.right);
});
