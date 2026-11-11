/* global document, getSelection, NodeFilter, MouseEvent, CSS */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { openPage, startLateServer } from '../scripts/qa/layout-late.mjs';
import { createStudyRuntime } from '../lib/runtime/builtins.js';
import { revealNavRow } from '../scripts/qa/nav-reveal.mjs';
import { until } from './helpers/wait.mjs';

const SERVLET_BOOK = [
  { type: 'text', text_level: 1, text: '第3章 Java Web基础', page_idx: 0 },
  { type: 'text', text: '本章介绍 Servlet 开发基础与请求响应生命周期。', page_idx: 0 },
  { type: 'text', text_level: 2, text: '3.3 Servlet方式开发', page_idx: 1 },
  { type: 'text', text_level: 3, text: '代码解析', page_idx: 1 },
  { type: 'text', text: '(1) @SuppressWarnings("serial"): 抑制编译警告，表明该类无需显式定义 serialVersionUID。', page_idx: 1 },
  { type: 'text', text: '(2) @WebServlet("/demo"): 通过注解映射访问路径，无需在 web.xml 中手动配置。', page_idx: 1 },
  { type: 'text', text: '(3) 继承 HttpServlet: 使当前类具备处理 HTTP 请求的能力。', page_idx: 1 },
  { type: 'text', text: '(4) 重写 doGet 方法: 专门接收并处理客户端发送的 GET 请求。', page_idx: 1 },
  { type: 'text', text: '(5) 获取请求参数: 通过 request.getParameter("t\\_name") 读取表单提交字段。', page_idx: 1 },
  { type: 'text', text: '(6) 输出响应内容: 设置文本编码并通过 PrintWriter 向浏览器返回结果。', page_idx: 1 },
  { type: 'text', text_level: 2, text: '3.4 Servlet生命周期', page_idx: 2 },
  { type: 'text', text: '容器加载 Servlet 后依次调用 init、service 与 destroy 方法。', page_idx: 2 },
  { type: 'text', text_level: 1, text: '第4章 JSP技术', page_idx: 3 },
  { type: 'text', text: '下一章介绍服务端动态页面模板与内置对象。', page_idx: 3 },
];

const LONG_LINES = Array.from({ length: 95 }, (_, i) => `长段第 ${i + 1} 节持续展开多行长选区在真实浏览器高亮层中的全量覆盖能力与超过四千字符裁剪恢复表现（标识 L-${String(i + 1).padStart(2, '0')}）。`);
const MD_NOTE = [
  '# 矩阵与请求流笔记',
  '',
  '前导说明段。',
  '',
  '![架构流程图](images/arch.png)',
  '',
  '图后第一行紧接说明，',
  '图后第二行给出乘积 $a*b + c*d$。',
  '',
  '$$A = x_1 + x_2$$',
  '',
  '$$\\begin{pmatrix} 1 \\\\ 2 \\end{pmatrix}$$',
  '',
  '矩阵后第一行结论，',
  '矩阵后第二行推论。',
  '',
  ...LONG_LINES,
  '',
  '超长段收束尾句终章。',
].join('\n\n');

let built = null;
const previewDist = () => built ??= (async () => {
  const dist = await mkdtemp(join(tmpdir(), 'study-multiline-dist-'));
  await buildPreview({ outdir: dist });
  return dist;
})();
test.after(async () => { if (built) await rm(await built.catch(() => null) ?? '', { recursive: true, force: true }); });

const selectSpan = (page, startWords, endWords) => page.evaluate(({ from, to }) => {
  const body = document.querySelector('.study-document-body'), walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let startNode = null, startOffset = 0, endNode = null, endOffset = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement.closest('[data-study-marker], [data-find-skip]')) continue;
    if (!startNode) {
      const at = node.data.indexOf(from);
      if (at >= 0) { startNode = node; startOffset = at; }
    }
    const endAt = node.data.indexOf(to);
    if (endAt >= 0) { endNode = node; endOffset = endAt + to.length; }
  }
  if (!startNode || !endNode) return null;
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  endNode.parentElement.scrollIntoView({ block: 'center' });
  const selection = getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  const rect = [...range.getClientRects()].reverse().find(r => r.width > 1 && r.height > 1) || range.getBoundingClientRect();
  return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 };
}, { from: startWords, to: endWords });

const painted = (page, name) => page.evaluate(key => CSS.highlights.get(key)?.size ?? 0, name);
const menu = page => page.getByRole('menu', { name: '选中文字的操作' });
const rightClickSelection = async page => {
  const pt = await page.evaluate(() => {
    const sel = getSelection();
    if (!sel?.rangeCount || sel.isCollapsed) return null;
    const range = sel.getRangeAt(0);
    const el = range.endContainer.nodeType === 1 ? range.endContainer : range.endContainer.parentElement;
    el?.scrollIntoView?.({ block: 'center' });
    const rect = [...range.getClientRects()].reverse().find(r => r.width > 1 && r.height > 1) || range.getBoundingClientRect();
    return { x: rect.left + Math.min(rect.width / 2, 20), y: rect.top + rect.height / 2 };
  });
  assert.ok(pt, 'live selection rect available for right-click');
  await page.mouse.click(pt.x, pt.y, { button: 'right' });
};

test('multi-paragraph selection on Page 2 of a converted book preserves line breaks, resolves in 学习, marks, queues, explains, handles triple-click and warns on cross-page', { timeout: 300000 }, async t => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium to look with: ${String(error.message).split('\n')[0]}`); return; }
  t.after(() => browser.close());

  let documentId = '';
  const running = await startLateServer({ distDir: await previewDist(), seed: async root => {
    const runtime = createStudyRuntime(root);
    documentId = (await runtime.call('materials.document.import', {
      filename: 'JavaWeb教材.json',
      dataBase64: Buffer.from(JSON.stringify(SERVLET_BOOK)).toString('base64'),
      courses: ['JavaWeb'],
    })).documentId;
    await runtime.call('materials.document.import', {
      filename: '矩阵与请求流笔记.md',
      dataBase64: Buffer.from(MD_NOTE).toString('base64'),
      courses: ['JavaWeb'],
    });
    runtime.dispose();
  } });
  t.after(() => running.close?.());

  const { context, page, errors } = await openPage(browser, running, { width: 1280, height: 900 });
  try {
    await page.goto(running.server.url);
    await (await revealNavRow(page, 'sources')).dispatchEvent('click');
    const row = page.locator('.source-doc', { hasText: 'JavaWeb教材' }).first();
    await row.waitFor({ timeout: 60000 });
    await row.locator('.source-main').click({ timeout: 30000 });
    const viewer = page.locator('.study-document-viewer');
    await viewer.locator('.study-document-body').getByText('3.3 Servlet方式开发').waitFor({ timeout: 60000 });

    // 1. Select across heading "代码解析" and paragraphs (1)-(6) on Page 2 (the exact screenshot scenario).
    const point = await selectSpan(page, '代码解析', '向浏览器返回结果。');
    assert.ok(point, 'multi-paragraph selection placed in DOM');

    const tools = viewer.locator('.study-document-learning');
    await tools.locator('#study-passage-quote').waitFor({ timeout: 15000 });
    const quoteText = await tools.locator('#study-passage-quote').evaluate(el => el.textContent);
    assert.match(quoteText, /^代码解析\n\(1\) @SuppressWarnings\("serial"\)/, 'PassageQuote keeps newline between heading and (1)');
    assert.doesNotMatch(quoteText, /代码解析\(1\)/, 'heading and (1) are never smashed onto one line');

    // Verify resolution succeeds: Ask form renders and no missing warning appears.
    await tools.getByRole('button', { name: '依据原文回答' }).waitFor({ timeout: 15000 });
    assert.equal(await tools.getByText('无法在已保存的资料中核实这段文字，请重新选择。').count(), 0);

    // 2. Right-click -> 下划线, 加入待出题, and AI 词解 on the multi-paragraph selection all succeed on Page 2.
    await page.mouse.click(point.x, point.y, { button: 'right' });
    await menu(page).waitFor();
    await menu(page).getByRole('menuitem', { name: '下划线', exact: true }).click();
    await menu(page).waitFor({ state: 'detached' });
    await until(async () => (await painted(page, 'study-mark-underline')) === 1, 'multi-paragraph underline painted');

    const point2 = await selectSpan(page, '代码解析', '向浏览器返回结果。');
    await page.mouse.click(point2.x, point2.y, { button: 'right' });
    await menu(page).waitFor();
    await menu(page).getByRole('menuitem', { name: 'AI 词解', exact: true }).click();
    await menu(page).waitFor({ state: 'detached' });
    await until(async () => {
      const listed = await running.api('materials.annotation.list', { documentId });
      return listed.items.some(item => item.kind === 'explain' && item.selection.page === 2 && item.selection.quote.includes('(6) 输出响应内容'));
    }, 'multi-paragraph AI 词解 saved on Page 2 without missing error', { timeoutMs: 60000 });
    assert.equal(await page.getByText('这段文字不在这份资料里。').count(), 0);

    // 3. Browser triple-click boundary on Page 2's last paragraph (Element startContainer on Page 2, Element endContainer on Page 3 offset 0).
    await page.evaluate(() => {
      const body = document.querySelector('.study-document-body');
      const pages = [...body.querySelectorAll('[data-study-page]')];
      const lastP = [...pages[1].querySelectorAll('.reader-p')].at(-1);
      const range = document.createRange();
      range.setStart(lastP, 0);
      range.setEnd(pages[2], 0);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await until(async () => {
      const text = await tools.locator('#study-passage-quote').textContent();
      return text.startsWith('(6) 输出响应内容');
    }, 'triple-click quote captured');
    await tools.getByRole('button', { name: '依据原文回答' }).waitFor({ timeout: 15000 });
    assert.equal(await tools.getByText('无法在已保存的资料中核实这段文字，请重新选择。').count(), 0);
    assert.equal(await tools.getByText('选区跨了多页，请在一页内选择。').count(), 0);

    // 4. Genuine cross-page selection from Page 2 into Page 3 shows honest cross-page message rather than false missing warning.
    const crossPoint = await selectSpan(page, '(6) 输出响应内容', '容器加载 Servlet');
    assert.ok(crossPoint);
    await tools.getByText('选区跨了多页，请在一页内选择。').waitFor({ timeout: 15000 });
    assert.equal(await tools.getByText('无法在已保存的资料中核实这段文字，请重新选择。').count(), 0);

    await page.mouse.click(crossPoint.x, crossPoint.y, { button: 'right' });
    await menu(page).waitFor();
    await menu(page).getByRole('menuitem', { name: 'AI 词解', exact: true }).click();
    await menu(page).waitFor({ state: 'detached' });
    await page.getByText('选区跨了多页，请在一页内选择。').first().waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('这段文字不在这份资料里。').count(), 0);

    // 5. Close the first reader dialog, then open the Markdown material: verify relative image ![alt](local.png), $a*b + c*d$, 1 \\ 2, adjacent plain lines, and >4000-char underline.
    await page.keyboard.press('Escape');
    await until(async () => !(await viewer.count()), 'first reader dialog closed', { timeoutMs: 15000 });
    const mdRow = page.locator('.source-doc', { hasText: '矩阵与请求流笔记' }).first();
    await mdRow.waitFor({ timeout: 30000 });
    await mdRow.locator('.source-main').click({ timeout: 30000 });
    await viewer.locator('.study-document-body .reader-html').getByText('矩阵与请求流笔记').waitFor({ timeout: 60000 });

    const mdPoint = await selectSpan(page, '前导说明段。', '矩阵后第二行推论。');
    assert.ok(mdPoint, 'Markdown multi-block formula/image selection placed');
    await until(async () => {
      const text = await tools.locator('#study-passage-quote').textContent();
      return text.includes('前导说明段。') && text.includes('矩阵后第二行推论。') && !text.includes('架构流程图');
    }, 'Markdown selection omits relative image alt text and keeps lines');
    await tools.getByRole('button', { name: '依据原文回答' }).waitFor({ timeout: 15000 });
    assert.equal(await tools.getByText('无法在已保存的资料中核实这段文字，请重新选择。').count(), 0);

    await rightClickSelection(page);
    await menu(page).waitFor();
    await menu(page).getByRole('menuitem', { name: '下划线', exact: true }).click();
    await menu(page).waitFor({ state: 'detached' });
    await until(async () => (await painted(page, 'study-mark-underline')) === 1, 'Markdown formula underline painted');

    // Re-selecting the underlined formula passage offers 去掉下划线.
    await selectSpan(page, '前导说明段。', '矩阵后第二行推论。');
    await rightClickSelection(page);
    await menu(page).waitFor();
    await menu(page).getByRole('menuitem', { name: '去掉下划线', exact: true }).click();
    await menu(page).waitFor({ state: 'detached' });
    await until(async () => (await painted(page, 'study-mark-underline')) === 0, 'Markdown formula underline removed');

    // Plain lines right below 1 \\ 2 resolve cleanly without prefix escape mismatch.
    await selectSpan(page, '矩阵后第一行结论', '矩阵后第二行推论。');
    await until(async () => (await tools.locator('#study-passage-quote').textContent()).startsWith('矩阵后第一行结论'), 'plain lines after matrix captured');
    await tools.getByRole('button', { name: '依据原文回答' }).waitFor({ timeout: 15000 });
    assert.equal(await tools.getByText('无法在已保存的资料中核实这段文字，请重新选择。').count(), 0);

    // >4000-char multi-paragraph underline paints all the way to the final paragraph past 4000 chars.
    const longPoint = await selectSpan(page, '长段第 1 节', '超长段收束尾句终章。');
    assert.ok(longPoint);
    await rightClickSelection(page);
    await menu(page).waitFor();
    await menu(page).getByRole('menuitem', { name: '下划线', exact: true }).click();
    await menu(page).waitFor({ state: 'detached' });
    await until(async () => page.evaluate(() => {
      const hl = CSS.highlights.get('study-mark-underline');
      if (!hl || hl.size !== 1) return false;
      const [range] = [...hl];
      return range.toString().endsWith('超长段收束尾句终章。') && range.toString().length > 4100;
    }), '>4000-char underline spans the full passage through the end');

    assert.deepEqual(errors, [], 'no console or page errors');
  } finally {
    await context.close();
  }
});
