import test from 'node:test';
import assert from 'node:assert/strict';
import { bareChemistry, chemSpans, wrapChemistry } from '../lib/chem-text.js';

const found = (text) => bareChemistry(text);

test('unmistakable chemical formulas outside math are found', () => {
  assert.deepEqual(found('浓 H2SO4 与 H2SO3 的酸性'), ['H2SO4', 'H2SO3']);
  assert.deepEqual(found('CaCO3 受热分解为 CaO 和 CO2。'), ['CaCO3', 'CO2']);
  assert.deepEqual(found('NH3 与 Fe2O3 以及 Ca(OH)2'), ['NH3', 'Fe2O3', 'Ca(OH)2']);
  assert.deepEqual(found('(NH4)2SO4 和 Al2(SO4)3 都是盐'), ['(NH4)2SO4', 'Al2(SO4)3']);
  assert.deepEqual(found('2个H+ 与 OH- 反应'), ['H+', 'OH-']);
  assert.deepEqual(found('NH4+ 和 HSO4- 以及 Na+ 与 Cl-'), ['NH4+', 'HSO4-', 'Na+', 'Cl-']);
  assert.deepEqual(found('离子 SO4^2- 和 Fe^3+ 与 SO4^{2-}'), ['SO4^2-', 'Fe^3+', 'SO4^{2-}']);
  assert.deepEqual(found('氧气 O2 与 N2'), ['O2', 'N2']);
  assert.deepEqual(found('2H2 + O2 -> 2H2O'), ['2H2 + O2 -> 2H2O']);
});

test('ambiguous digit-then-sign endings are found but marked as not auto-fixable', () => {
  for (const text of ['SO42-', 'SO42−', 'CO32-', 'Fe3+', 'Mg2+', 'SO4 2-']) {
    const spans = chemSpans(`离子 ${text} 的检验`);
    assert.equal(spans.length, 1, text);
    assert.equal(spans[0].tex, null, text);
    assert.equal(bareChemistry(`离子 ${text} 的检验`).length, 1, text);
  }
});

test('plain words, product names, codes and units are not chemistry', () => {
  for (const text of ['A4 paper', 'MP3 player', 'B2B sales', 'B2C and C2C', 'COVID19 and COVID-19', 'Y2K bug', 'PS4 and PS5', 'WP4 and WP12 tasks', 'H1N1 flu', 'NO1 choice',
    'CS2030 is a course', 'IPv4 address', 'HTTP2 protocol', 'version 2.5.1 and v2.5.1', 'm2 and kg2 in prose', '2026-10-04', 'range 3-5',
    'C++ and C#', 'Wi-Fi6 router', 'H264 video', 'EC2 and S3 buckets', 'K2 mountain', 'F2 key', 'A+ grade', 'I- and B+ and C-', 'He said No2',
    'NaCl and HCl and NaOH have no digits', 'water', '3D printing', '4K screen', 'x2 speed', 'pH 7']) {
    assert.deepEqual(found(text), [], text);
  }
});

test('formulas already in math, in code, in links, in paths or in identifiers are left alone', () => {
  for (const text of ['已写好 $\\ce{H2SO4}$ 与 $H_2O$', '用 `H2SO4` 表示', '见 https://example.com/H2SO4 与 (https://x.org/CO2)',
    'C:\\Users\\H2O\\notes', 'var NH3_level = 1', 'file.CO2 and x_H2O', '\\(CO2\\) 和 $$H2SO4$$', '![H2O](img/CO2.png)']) {
    assert.deepEqual(found(text), [], text);
  }
  assert.deepEqual(found('A $\\ce{H2O}$ and CO2'), ['CO2']);
});

test('a formula followed by a hyphenated word or a full stop is still found', () => {
  assert.deepEqual(found('The CO2-based answer'), ['CO2']);
  assert.deepEqual(found('产物是 H2O。'), ['H2O']);
  assert.deepEqual(found('(H2SO4)'), ['H2SO4']);
});

test('wrapChemistry wraps unambiguous formulas as \\ce and normalises the minus sign', () => {
  assert.equal(wrapChemistry('浓 H2SO4 与 CaCO3'), '浓 $\\ce{H2SO4}$ 与 $\\ce{CaCO3}$');
  assert.equal(wrapChemistry('2个H+ 和 OH−'), '2个$\\ce{H+}$ 和 $\\ce{OH-}$');
  assert.equal(wrapChemistry('NH4+ 与 HSO4− 以及 Ca(OH)2'), '$\\ce{NH4+}$ 与 $\\ce{HSO4-}$ 以及 $\\ce{Ca(OH)2}$');
  assert.equal(wrapChemistry('离子 SO4^2- 与 Fe^3+ 和 SO4^{2-}'), '离子 $\\ce{SO4^2-}$ 与 $\\ce{Fe^3+}$ 和 $\\ce{SO4^2-}$');
  assert.equal(wrapChemistry('N2 + 3H2 <=> 2NH3'), '$\\ce{N2 + 3H2 <=> 2NH3}$');
  assert.equal(wrapChemistry('2H2 + O2 → 2H2O'), '$\\ce{2H2 + O2 -> 2H2O}$');
  assert.equal(wrapChemistry('Zn + H2SO4 -> ZnSO4 + H2'), '$\\ce{Zn + H2SO4 -> ZnSO4 + H2}$');
  assert.equal(wrapChemistry('The CO2-based answer'), 'The $\\ce{CO2}$-based answer');
});

test('wrapChemistry leaves ambiguous, delimited, code and plain text exactly as it was', () => {
  for (const text of ['离子 SO42− 的检验', '离子 SO42- 与 CO32-', 'Fe3+ 的颜色', '已有 $\\ce{H2O}$ 不变', '用 `H2SO4` 表示', 'A4 and MP3', '没有化学式', '见 https://x.org/H2O']) {
    assert.equal(wrapChemistry(text), text, text);
  }
  // A text with an ambiguous ion keeps it, while the unambiguous formulas around it are still wrapped.
  assert.equal(wrapChemistry('H2SO4 含 SO42−'), '$\\ce{H2SO4}$ 含 SO42−');
});

test('a wrapped formula next to an ASCII letter gets a space and a glued identifier is not chemistry', () => {
  assert.equal(wrapChemistry('pH与H2O'), 'pH与$\\ce{H2O}$');
  assert.equal(wrapChemistry('xH2O'), 'xH2O');
  assert.equal(wrapChemistry('H2O2 和 H2O3'), '$\\ce{H2O2}$ 和 $\\ce{H2O3}$');
  assert.equal(wrapChemistry('H2O5 个'), '$\\ce{H2O5}$ 个');
});
