/* The formulas #996 names, drawn the way the app draws them (tests/math-font.test.mjs, tests/math-font-browser.test.mjs). */
export const MATH_SAMPLES = [
  String.raw`x_i^2 + y^{n+1}`, String.raw`\sum_{i\ge1} \frac{1}{i^2} = \frac{\pi^2}{6}`, String.raw`\mathbb{E}[X] = \int_{\mathbb{R}} x\,p(x)\,\mathrm{d}x`,
  String.raw`\mathcal{F} \subseteq 2^{\Omega}`, String.raw`\frac{\partial f}{\partial x} + \frac{a+b}{c}`,
  String.raw`\begin{pmatrix}1 & 2\\ 3 & 4\end{pmatrix} \begin{bmatrix}a\\ b\end{bmatrix}`, String.raw`\left( \frac{a}{b} \right)^{k} \left[ \sum_{k=0}^{n} x_k \right]`,
  String.raw`\ce{2H2 + O2 -> 2H2O}`, String.raw`\ce{Fe^{3+} + SCN- <=> FeSCN^{2+}}`, String.raw`\mathbf{v} \cdot \vec{w} = \hat{\theta}\,\|\mathbf{v}\|`,
  String.raw`\mathbb{R}^k,\ \mathfrak{g},\ \mathscr{L}`,
];
/** Inline in a sentence: what must not change the height of its line. */
export const INLINE_SAMPLES = [String.raw`x_i^2`, String.raw`R^k`, String.raw`\mathbb{E}[X]`, String.raw`\sum_{i\ge1} a_i`, String.raw`\frac{a}{b}`];
