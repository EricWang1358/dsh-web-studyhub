import test from 'node:test';
import assert from 'node:assert/strict';
import { sectionsOf } from '../lib/sections.js';
import { parseConvertedDocument } from '../lib/converted-document.js';

/* A `#` line in code that is not fenced (converted material, pasted notes) is a comment, not a heading. The owner's 「Python 语法地基 · 源码结构·运算·流程 ·
   第二部分」 planned two 小节 「这是第一行说明」 and 「这是第二行说明」 out of `# 这是第一行说明` between code lines: nothing to test in them, and 补题 spent
   three rounds on them. Real headings stand apart from code: a blank line, prose, a list or a fence between them. */

const PYTHON = [
  '# Python 语法地基',
  '',
  '## 源码结构',
  '',
  'Python 用缩进表示代码块，用 # 写注释。',
  '',
  'x = 1',
  '# 这是第一行说明',
  '# 这是第二行说明',
  'y = x + 2',
  'print(y)',
  '',
  '# 定义函数',
  'def add(a, b):',
  '    return a + b',
  '',
  '## 运算',
  '',
  '>>> 3 // 2',
  '# 整除',
  '1',
  '',
  '## 流程',
  '',
  'for i in range(3):',
  '  # 循环体里的注释',
  '    print(i)',
  '',
  'total += 1',
  '# 累加之后',
].join('\n');

const titles = text => sectionsOf([{ id: 's', text }]).map(section => section.title);

test('a # line among unfenced code lines is a comment, not a 小节', () => {
  assert.deepEqual(titles(PYTHON), ['Python 语法地基', '源码结构', '运算', '流程']);
});

test('a converted book does not take its code comments for headings either', () => {
  const book = parseConvertedDocument(`<!-- page: 1 -->\n${PYTHON}\n<!-- page: 2 -->\n# 第二部分\n\n正文。`, { filename: 'python.md' });
  assert.deepEqual(book.outline.map(entry => entry.title), ['Python 语法地基', '源码结构', '运算', '流程', '第二部分']);
});

test('a heading next to prose, a list, a fence, another heading or code after a blank line stays a heading', () => {
  const kept = [
    '# 第一章 赋值',
    '## 1.1 赋值语句',
    '赋值用等号，例如 x = 1。',
    '',
    '## 1.2 示例',
    '',
    'x = 1',
    '',
    '## 1.3 带代码块',
    '```python',
    '# 代码块里的注释',
    'x = 1',
    '```',
    '## 1.4 要点',
    '- 变量不用声明',
    '  - 缩进的子项',
    '## 1.5 For example:',
    'For example: if you need it, return to 1.1.',
  ].join('\n');
  assert.deepEqual(titles(kept), ['第一章 赋值', '1.1 赋值语句', '1.2 示例', '1.3 带代码块', '1.4 要点', '1.5 For example:']);
});
