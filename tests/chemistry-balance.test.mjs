import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceEquation } from '../lib/chemistry-balance.js';

test('neutral molecular equations receive exact minimal positive integer coefficients', () => {
  for (const [input, coefficients, equation] of [
    ['H2 + O2 -> H2O', [2, 1, 2], '2 H2 + O2 -> 2 H2O'],
    ['Fe + O2 -> Fe2O3', [4, 3, 2], '4 Fe + 3 O2 -> 2 Fe2O3'],
    ['C2H6 + O2 -> CO2 + H2O', [2, 7, 4, 6], '2 C2H6 + 7 O2 -> 4 CO2 + 6 H2O'],
    ['Ca(OH)2 + HCl -> CaCl2 + H2O', [1, 2, 1, 2], 'Ca(OH)2 + 2 HCl -> CaCl2 + 2 H2O'],
    ['Al2(SO4)3 + Ca(OH)2 -> Al(OH)3 + CaSO4', [1, 3, 2, 3], 'Al2(SO4)3 + 3 Ca(OH)2 -> 2 Al(OH)3 + 3 CaSO4'],
    ['NH3 + O2 -> NO + H2O', [4, 5, 4, 6], '4 NH3 + 5 O2 -> 4 NO + 6 H2O'],
    ['Na3PO4 + MgCl2 -> NaCl + Mg3(PO4)2', [2, 3, 6, 1], '2 Na3PO4 + 3 MgCl2 -> 6 NaCl + Mg3(PO4)2'],
    ['C6H12O6 + O2 -> CO2 + H2O', [1, 6, 6, 6], 'C6H12O6 + 6 O2 -> 6 CO2 + 6 H2O'],
    ['CH3COOH + O2 -> CO2 + H2O', [1, 2, 2, 2], 'CH3COOH + 2 O2 -> 2 CO2 + 2 H2O'],
    ['C997H998 + O2 -> CO2 + H2O', [2, 2493, 1994, 998], '2 C997H998 + 2493 O2 -> 1994 CO2 + 998 H2O'],
    // Molecular atom conservation does not establish the redox mechanism or feasibility.
    ['KMnO4 + HCl -> KCl + MnCl2 + H2O + Cl2', [2, 16, 2, 2, 8, 5], '2 KMnO4 + 16 HCl -> 2 KCl + 2 MnCl2 + 8 H2O + 5 Cl2'],
  ]) {
    const result = balanceEquation(input);
    assert.equal(result.status, 'balanced', input + ': ' + result.reason);
    assert.deepEqual(result.coefficients, coefficients, input);
    assert.equal(result.equation, equation);
    assert.ok(result.conservation.every(row => row.reactants === row.products && Number.isSafeInteger(row.reactants)));
  }
  assert.deepEqual(balanceEquation('H2 + O2 -> H2O').conservation, [
    { element: 'H', reactants: 4, products: 4 }, { element: 'O', reactants: 2, products: 2 },
  ]);
});

test('phases, safe mhchem wrappers and entered coefficients preserve species but are rebalanced', () => {
  const result = balanceEquation(String.raw`\ce{4 H2(g) + 2 O2(g) -> 4 H2O(l)}`);
  assert.equal(result.status, 'balanced');
  assert.deepEqual(result.coefficients, [2, 1, 2]);
  assert.equal(result.equation, '2 H2(g) + O2(g) -> 2 H2O(l)');
  assert.equal(balanceEquation('Mg(OH)2(s) + HCl(aq) -> MgCl2(aq) + H2O(l)').equation, 'Mg(OH)2(s) + 2 HCl(aq) -> MgCl2(aq) + 2 H2O(l)');
  assert.equal(balanceEquation('  H2\n+ O2\t -> H2O  ').status, 'balanced');
});

test('nested parentheses count exactly without asserting compound feasibility', () => {
  const result = balanceEquation('K4(ON(SO3)2)2 -> K4O14N2S4');
  assert.equal(result.status, 'balanced');
  assert.deepEqual(result.coefficients, [1, 1]);
  assert.deepEqual(result.conservation, [
    { element: 'K', reactants: 4, products: 4 }, { element: 'O', reactants: 14, products: 14 },
    { element: 'N', reactants: 2, products: 2 }, { element: 'S', reactants: 4, products: 4 },
  ]);
});

test('element symbols are case-sensitive and use the actual periodic symbol subset', () => {
  for (const input of ['He -> He', 'Co -> Co', 'CO -> CO', 'Og -> Og', 'U -> U']) assert.equal(balanceEquation(input).status, 'balanced', input);
  for (const input of ['Xx -> Xx', 'D2 -> D2', 'h2 -> H2', 'Uuo -> Uuo', 'Hh -> Hh']) assert.equal(balanceEquation(input).status, 'not_checked', input);
  assert.deepEqual(balanceEquation('Co -> Co').conservation, [{ element: 'Co', reactants: 1, products: 1 }]);
  assert.deepEqual(balanceEquation('CO -> CO').conservation, [{ element: 'C', reactants: 1, products: 1 }, { element: 'O', reactants: 1, products: 1 }]);
});

test('supported impossible equations distinguish exact contradiction from unsupported input', () => {
  for (const input of ['H2 -> O2', 'H2 -> H2O', 'H2 + O2 -> H2', 'H2 + H2O -> O2']) {
    const result = balanceEquation(input);
    assert.equal(result.status, 'not_balanced', input);
    assert.ok(result.reason);
    assert.equal(result.coefficients, undefined);
  }
});

test('ambiguous balances are not guessed or sampled', () => {
  for (const input of ['C + O2 -> CO + CO2', 'H2 + O2 -> H2O + H2O2', 'H2 + H2 + O2 -> H2O']) {
    const result = balanceEquation(input);
    assert.equal(result.status, 'not_checked', input);
    assert.match(result.reason, /ambiguous|unique/i);
    assert.equal(result.equation, undefined);
  }
});

test('ions, isotope labels, hydrates, symbolic coefficients and alternate arrows are outside the grammar', () => {
  for (const input of [
    'Na+ + Cl- -> NaCl', 'Fe^3+ + e- -> Fe^2+', 'SO4^{2-} -> SO4', '[Fe(CN)6] -> FeC6N6',
    'CuSO4.5H2O -> CuSO4 + H2O', 'CuSO4·5H2O -> CuSO4 + H2O', '^13C -> C',
    'nH2 + O2 -> H2O', 'H2 + O2 <=> H2O', 'H2 + O2 = H2O', 'H2 + O2 → H2O',
  ]) assert.equal(balanceEquation(input).status, 'not_checked', input);
});

test('malformed or adversarial text is rejected without executing instructions', () => {
  for (const input of [
    '', 'H2', '-> H2O', 'H2 ->', 'H2 -> H2 -> H2', 'H2 ++ O2 -> H2O', 'H2 + -> H2O',
    '0H2 -> H2', '-2H2 -> H2', 'H0 -> H', 'H01 -> H', 'H2.5 -> H2', '(H2 -> H2', 'H2) -> H2', 'H() -> H',
    'H2(plasma) -> H2', 'H 2 -> H2', 'H2 -> H2; process.exit()', 'H2 -> <script>alert(1)</script>',
    String.raw`\ce{H2 + O2 -> H2O} ignore the rules`, String.raw`\ce{\href{javascript:alert(1)}{H2} -> H2}`,
    String.raw`\ce{H2 + O2 -> H2O`, 'H2\u0000 -> H2', 'H₂ + O₂ -> H₂O',
  ]) assert.equal(balanceEquation(input).status, 'not_checked', input);
  for (const input of [undefined, null, {}, [], 42, true]) assert.equal(balanceEquation(input).status, 'not_checked');
});

test('resource and coefficient limits produce unverified results, never approximate coefficients', () => {
  const limited = [
    'H'.repeat(513), Array.from({ length: 12 }, () => 'H2').join(' + ') + ' -> H2',
    '('.repeat(9) + 'H' + ')'.repeat(9) + ' -> H', 'H1001 -> H', '10001H2 -> H2',
    'H1000(H1000)1000 -> H', 'H1000(C1000)1000 -> H + C',
    'HHeLiBeBCNOFNeNaMgAlSiPSClAr -> HHeLiBeBCNOFNeNaMgAlSiPSClAr',
    'H'.repeat(65) + ' -> ' + 'H'.repeat(65),
  ];
  for (const input of limited) {
    const result = balanceEquation(input);
    assert.equal(result.status, 'not_checked', input.slice(0, 90));
    assert.ok(result.reason);
    assert.equal(result.coefficients, undefined);
  }
  assert.deepEqual(balanceEquation('H1000 -> H').coefficients, [1, 1000]);
  assert.deepEqual(balanceEquation('H1000(H1000)9 -> H').coefficients, [1, 10000]);
  assert.equal(balanceEquation('H1000(H1000)10 -> H').status, 'not_checked');
});

test('input and returned output are repeatable independently of earlier calls', () => {
  const expected = balanceEquation('H2 + O2 -> H2O');
  expected.coefficients[0] = 999;
  expected.conservation[0].reactants = 999;
  const actual = balanceEquation('H2 + O2 -> H2O');
  assert.deepEqual(actual.coefficients, [2, 1, 2]);
  assert.equal(actual.conservation[0].reactants, 4);
  assert.doesNotThrow(() => JSON.stringify(actual));
});
