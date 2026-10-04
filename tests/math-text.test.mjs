import test from 'node:test';
import assert from 'node:assert/strict';
import { bareMathText, toTex, wrapMathText } from '../lib/math-text.js';

test('Unicode and ASCII math a card would show raw is found', () => {
  assert.deepEqual(bareMathText('5√4'), ['5√4']);
  assert.deepEqual(bareMathText('化简 √8+√18 的结果'), ['√8+√18']);
  assert.deepEqual(bareMathText('√(x+1) 有意义'), ['√(x+1)']);
  assert.deepEqual(bareMathText('x^2+1 与 3^n'), ['x^2+1', '3^n']);
  assert.deepEqual(bareMathText('约去非零因子(x−1)后得到x+1'), ['(x−1)', 'x+1']);
  assert.deepEqual(bareMathText('当 x≠1 时'), ['x≠1']);
  assert.deepEqual(bareMathText('(x−1)(x+1)'), ['(x−1)(x+1)']);
  assert.deepEqual(bareMathText('求 2x−3 的值，或 a/b'), ['2x−3', 'a/b']);
  assert.deepEqual(bareMathText('x ≤ 5 且 y ≥ 2'), ['x ≤ 5', 'y ≥ 2']);
  assert.deepEqual(bareMathText('结果是 5±0.1'), ['5±0.1']);
  assert.deepEqual(bareMathText('x + 1 = 3'), ['x + 1 = 3']);
  assert.deepEqual(bareMathText('速度 m/s^2'), ['m/s^2']);
});

test('prose, units, dates, versions, identifiers and numbers alone are not math', () => {
  for (const text of ['C++ and C#', 'A/B 测试', '1+1 的口算', '2026-10-04', '范围 3-5', 'version 2.5.1 and v2.5.1', '1. 第一步', 'and/or', 'w/o sugar and n/a and y/n',
    'speed 5 m/s', 'e-mail and x-ray', 'a-b', 'i++ in code', 'Wi-Fi 6', 'COVID-19', '3:4 和 10:30', '1/2 cup', '1920×1080', 'pH 7', 'Q&A', 'R&D', '100%',
    'foo_bar+1', 'a_n and x1', 'path C:\\Users\\x+1', 'mail a+b@example.com', '(a) 选项 (1)', 'f(x)', '-> and => and ==', '价格 $5 and $10']) {
    assert.deepEqual(bareMathText(text), [], text);
  }
});

test('math already in delimiters, code, links and addresses is left alone', () => {
  for (const text of ['已有 $x+1$ 与 $$\\sqrt{2}$$', '代码 `x^2+1` 不变', '见 https://example.com/x+1 与 ![x^2](a.png)', '\\(a≠b\\)']) {
    assert.deepEqual(bareMathText(text), [], text);
  }
  assert.deepEqual(bareMathText('已有 $x$ 并且 x≠1'), ['x≠1']);
});

test('chemistry is never read as algebra', () => {
  assert.deepEqual(bareMathText('H+ 与 OH- 以及 SO4^2- 和 Fe^3+ 还有 NH4+'), []);
});

test('toTex converts Unicode math and bare powers', () => {
  assert.equal(toTex('5√4'), '5\\sqrt{4}');
  assert.equal(toTex('√26'), '\\sqrt{26}');
  assert.equal(toTex('√x'), '\\sqrt{x}');
  assert.equal(toTex('√(x+1)'), '\\sqrt{x+1}');
  assert.equal(toTex('x^2+1'), 'x^{2}+1');
  assert.equal(toTex('x^(n-1)'), 'x^{n-1}');
  assert.equal(toTex('x^-1'), 'x^{-1}');
  assert.equal(toTex('3^n'), '3^{n}');
  assert.equal(toTex('x^{2}'), 'x^{2}');
  assert.equal(toTex('x−1'), 'x-1');
  assert.equal(toTex('x≠1 且 y≤2 或 z≥3'), 'x\\neq 1 且 y\\le 2 或 z\\ge 3');
  assert.equal(toTex('a×b÷c·d'), 'a\\times b\\div c\\cdot d');
  assert.equal(toTex('2πr'), '2\\pi r');
  assert.equal(toTex('∞'), '\\infty');
  assert.equal(toTex('∑_{i=1}^{n} i'), '\\sum_{i=1}^{n} i');
  assert.equal(toTex('5±0.1'), '5\\pm 0.1');
});

test('wrapMathText wraps only the math spans and leaves the prose alone', () => {
  assert.equal(wrapMathText('约去非零因子(x−1)后得到x+1'), '约去非零因子$(x-1)$后得到$x+1$');
  assert.equal(wrapMathText('化简 √8+√18 的结果'), '化简 $\\sqrt{8}+\\sqrt{18}$ 的结果');
  assert.equal(wrapMathText('当 x≠1 时'), '当 $x\\neq 1$ 时');
  assert.equal(wrapMathText('所以 (x−1)(x+1) 成立'), '所以 $(x-1)(x+1)$ 成立');
  assert.equal(wrapMathText('没有公式'), '没有公式');
  assert.equal(wrapMathText('已有 $x+1$'), '已有 $x+1$');
  assert.equal(wrapMathText('Fill {{b1}} where x+1 appears.'), 'Fill {{b1}} where x+1 appears.');
});
