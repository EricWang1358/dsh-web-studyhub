/* WP-M1 · formula notation: the learner's 公式写法 choice (auto / text / latex), how "auto" resolves from the
   sources, the one-line prompt rule per resolved mode, and the plain-Unicode converter used in text mode. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NOTATIONS, normalizeNotation, resolveNotation, notationInstruction, toUnicodeMath } from '../lib/notation.js';

const text = value => toUnicodeMath(value).text;

test('NOTATIONS lists the three choices and unknown values fall back to auto', () => {
  assert.deepEqual([...NOTATIONS], ['auto', 'text', 'latex']);
  for (const value of ['auto', 'text', 'latex']) assert.equal(normalizeNotation(value), value);
  for (const value of [undefined, null, '', 'LaTeX', 'markdown', 3, {}, [], 'tex']) assert.equal(normalizeNotation(value), 'auto');
});

test('an explicit text or latex choice is never second-guessed by the sources', () => {
  assert.equal(resolveNotation('text', [{ text: 'Solve $\\frac{a}{b}$ and \\ce{H2SO4}' }]), 'text');
  assert.equal(resolveNotation('latex', [{ text: 'The Tang dynasty fell in 907.' }]), 'latex');
  assert.equal(resolveNotation('latex', []), 'latex');
});

const handouts = {
  maths: `二次函数与不等式讲义。设 f(x)=x²−4x+3，则 f(x)=0 的解为 x=1 或 x=3；当 x≠1 时，(x²−1)/(x−1)=x+1。
    求 √(x+1)≥2 的解集；计算 ∫₀¹ x² dx = 1/3；级数 ∑ aₙ 收敛当且仅当部分和有界。若 a≠b，则 a²≠b²（注意 ±）。`,
  chemistry: `酸碱反应。H2SO4 与 NaOH 反应生成 Na2SO4 和 H2O；写成方程：H2SO4 + 2NaOH → Na2SO4 + 2H2O。
    氢氧化钙 Ca(OH)2 与 CO2 反应生成 CaCO3 沉淀；硫酸根离子为 SO4^2-，铁离子为 Fe^3+。实验室中 KMnO4 受热分解产生 O2。`,
  history: `The Tang dynasty (618-907) reached its height under Emperor Xuanzong. The An Lushan rebellion of 755 weakened the
    court; by 907 the dynasty had collapsed. Historians still debate whether fiscal reform or military power mattered more.
    The Song dynasty (960-1279) followed after the period of the Five Dynasties and Ten Kingdoms. CAN NO ONE SAY IT IS SO? HIS IS.`,
  programming: `Bit tricks. In C, \`x ^ y\` is XOR and the loop \`for (i = 0; i < n; i++) total = total + x + 1;\` runs n times.
    The complexity is O(n^2) in the worst case, versus O(2^n) for brute force. XOR of a and b is written a^b in most languages.

\`\`\`c
int mix(int x, int y) { return (x ^ y) + x+1 + (y ^ 2) ^ x ^ 3 ^ 4 ^ 5 ^ 6; }
\`\`\``,
  essay: '春天来了，校园里的樱花开得正好。我和同学们在树下读书，微风吹过，花瓣落在书页上。那一刻我明白，成长不仅是学会知识，更是学会感受生活。',
};

test('auto resolves to latex for a maths handout and a chemistry handout', () => {
  assert.equal(resolveNotation('auto', [{ text: handouts.maths }]), 'latex');
  assert.equal(resolveNotation('auto', [{ text: handouts.chemistry }]), 'latex');
});

test('auto resolves to text for history, programming and a Chinese essay', () => {
  assert.equal(resolveNotation('auto', [{ text: handouts.history }]), 'text');
  assert.equal(resolveNotation('auto', [{ text: handouts.programming }]), 'text', 'code with ^ or x+1 does not flip it');
  assert.equal(resolveNotation('auto', [{ text: handouts.essay }]), 'text');
  assert.equal(resolveNotation('auto', []), 'text');
  assert.equal(resolveNotation(undefined, undefined), 'text');
});

test('auto resolves to latex as soon as the sources contain LaTeX', () => {
  for (const sample of ['Compute $\\frac{1}{2}$ first.', 'The root is \\sqrt{2}.', 'Write \\ce{H2O} in the answer.', '\\begin{pmatrix} 1 & 2 \\end{pmatrix}',
    'Let $x^2 + y^2 = r^2$ hold.'])
    assert.equal(resolveNotation('auto', [{ text: sample }]), 'latex', sample);
  assert.equal(resolveNotation('auto', [{ text: 'Plain.' }, { text: 'Then \\frac{a}{b}.' }]), 'latex', 'any one source is enough');
  assert.equal(resolveNotation('auto', ['Then \\frac{a}{b}.']), 'latex', 'plain strings are accepted as sources');
});

test('prices and shell variables are not mistaken for LaTeX', () => {
  assert.equal(resolveNotation('auto', [{ text: 'The ticket costs $5 and the book costs $10 in total.' }]), 'text');
  assert.equal(resolveNotation('auto', [{ text: 'Run echo $HOME and then echo $PATH to compare.' }]), 'text');
  assert.equal(resolveNotation('auto', [{ text: 'Course codes CS2030, CS1010 and EE2026 are all offered.' }]), 'text');
});

test('notationInstruction is one short English rule per resolved mode', () => {
  const plain = notationInstruction('text', '中文'), tex = notationInstruction('latex', 'English');
  assert.match(plain, /plain Unicode/i);
  assert.match(plain, /H₂SO₄/);
  assert.match(plain, /never.*\$/i);
  assert.match(tex, /\$/);
  assert.match(tex, /\\ce\{/);
  assert.match(tex, /double/i);
  assert.ok(plain.length < 600 && tex.length < 600);
  assert.notEqual(plain, tex);
  assert.equal(notationInstruction('auto', 'English'), '', 'an unresolved choice adds no rule');
  assert.equal(notationInstruction('nonsense'), '');
});

test('toUnicodeMath converts the simple cases from the brief', () => {
  assert.equal(text('$x^{2}+1$'), 'x²+1');
  assert.equal(text('x^2'), 'x²');
  assert.equal(text('$5\\sqrt{2}$'), '5√2');
  assert.equal(text('$\\ce{H2SO4}$'), 'H₂SO₄');
  assert.equal(text('H2SO4'), 'H₂SO₄');
  assert.equal(text('SO4^2-'), 'SO₄²⁻');
  assert.equal(text('$\\ce{SO4^2-}$'), 'SO₄²⁻');
  assert.equal(text('$\\frac{x^2-1}{x-1}$'), '(x²-1)/(x-1)');
  assert.equal(text('$\\sqrt{x+1}$'), '√(x+1)');
  assert.equal(text('$\\frac{a}{b}$'), 'a/b');
  assert.equal(text('$\\frac{1}{2}$'), '1/2');
});

test('superscripts convert only when every character has a superscript form', () => {
  assert.equal(text('$x^{n-1}$'), 'xⁿ⁻¹');
  assert.equal(text('$2^{n+1}$'), '2ⁿ⁺¹');
  assert.equal(text('$e^{-x}$'), 'e⁻ˣ');
  assert.equal(text('x^10'), 'x¹⁰');
  assert.equal(text('$x^{a*b}$'), 'x^(a*b)', 'a character without a superscript keeps a readable ASCII exponent');
  assert.equal(text('$x^{\\alpha}$'), 'x^(α)');
});

test('subscripts, symbols and the supported operators', () => {
  assert.equal(text('$x_1 + x_{2}$'), 'x₁ + x₂');
  assert.equal(text('$a_{n+1}$'), 'aₙ₊₁');
  assert.equal(text('$x\\neq 1$'), 'x≠1');
  assert.equal(text('$a \\le b \\ge c \\ne d$'), 'a ≤ b ≥ c ≠ d');
  assert.equal(text('$3 \\times 4 \\div 2 \\cdot 5$'), '3 × 4 ÷ 2 · 5');
  assert.equal(text('$\\pi r^2$'), 'πr²', 'TeX swallows the space after a letter-like command');
  assert.equal(text('$x \\to \\infty$'), 'x → ∞');
  assert.equal(text('$\\pm 3$'), '± 3');
  assert.equal(text('$\\sqrt[3]{x}$'), '³√x');
  assert.equal(text('$\\int_0^1 x\\,dx$'), '∫₀¹ x dx');
  assert.equal(text('$30^\\circ$'), '30°');
  assert.equal(text('$\\text{rate} = \\frac{\\Delta c}{\\Delta t}$'), 'rate = Δc/Δt');
  assert.equal(text('$\\left( a+b \\right)^2$'), '( a+b )²');
});

test('chemistry formulas, ions and equations', () => {
  assert.equal(text('Ca(OH)2 and Al2(SO4)3'), 'Ca(OH)₂ and Al₂(SO₄)₃');
  assert.equal(text('Fe^3+ reacts with OH^-'), 'Fe³⁺ reacts with OH⁻');
  assert.equal(text('$\\ce{2H2 + O2 -> 2H2O}$'), '2H₂ + O₂ → 2H₂O');
  assert.equal(text('$\\ce{H+ + OH- -> H2O}$'), 'H⁺ + OH⁻ → H₂O');
  assert.equal(text('$\\ce{Fe^{3+}}$'), 'Fe³⁺');
  assert.equal(text('$\\ce{CuSO4.5H2O}$'), 'CuSO₄·5H₂O');
  assert.equal(text('$\\ce{N2 + 3H2 <=> 2NH3}$'), 'N₂ + 3H₂ ⇌ 2NH₃');
  assert.equal(text('$H_2SO_4$ and $SO_4^{2-}$'), 'H₂SO₄ and SO₄²⁻');
  assert.equal(text('$\\mathrm{H_2O}$'), 'H₂O');
});

test('text that is not a formula stays exactly as it was', () => {
  for (const sample of ['CS2030 and CS1010 are modules.', 'The H1B visa and B2B sales.', 'snake_case_name and a_b_c', 'Costs $5 and $10 in total.',
    'Run x ^ y or a ^ b in C.', 'Plain prose with no formulas at all.', '路径 C:\\\\Users\\\\x 与 50%'])
    assert.equal(text(sample), sample, sample);
  assert.deepEqual(toUnicodeMath('CS2030 and $5 and $10').unconverted, []);
});

test('code spans and fences are never touched', () => {
  const sample = 'Use `x^2` and `H2SO4` here.\n```\nH2SO4 + x^2 = $\\frac{a}{b}$\n```\nBut convert H2SO4 and x^2 outside.';
  assert.equal(text(sample), 'Use `x^2` and `H2SO4` here.\n```\nH2SO4 + x^2 = $\\frac{a}{b}$\n```\nBut convert H₂SO₄ and x² outside.');
});

test('what cannot be converted completely is left as it was and reported', () => {
  const matrix = '$\\begin{pmatrix} 1 & 2 \\\\ 3 & 4 \\end{pmatrix}$';
  const result = toUnicodeMath(`Matrix ${matrix} and $x^2$.`);
  assert.equal(result.text, `Matrix ${matrix} and x².`);
  assert.equal(result.unconverted.length, 1);
  assert.equal(result.unconverted[0].span, matrix);
  assert.equal(result.unconverted[0].index, 'Matrix '.length);
  const bare = toUnicodeMath('See \\frac{a}{b} outside delimiters.');
  assert.equal(bare.text, 'See \\frac{a}{b} outside delimiters.');
  assert.deepEqual(bare.unconverted.map(item => item.span), ['\\frac']);
  assert.deepEqual(toUnicodeMath('$\\unknowncmd{x}$').unconverted.map(item => item.span), ['$\\unknowncmd{x}$']);
  assert.equal(toUnicodeMath('$x_{abc}$').text, '$x_{abc}$', 'a subscript without a Unicode form is reported, not mangled');
  assert.equal(toUnicodeMath('$x_{abc}$').unconverted.length, 1);
});

test('conversion is idempotent and tolerates non-strings', () => {
  const once = text('$\\frac{x^2-1}{x-1}$ and H2SO4, SO4^2-, $5\\sqrt{2}$, $\\ce{2H2 + O2 -> 2H2O}$');
  assert.equal(text(once), once);
  assert.equal(text(''), '');
  assert.equal(text(undefined), '');
  assert.equal(text(null), '');
  assert.deepEqual(toUnicodeMath(undefined), { text: '', unconverted: [] });
});
