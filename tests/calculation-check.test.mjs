import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCalculation } from '../lib/calculation-check.js';

const evidence = (expression, value, unit = '') => ({ expression, result: { value, unit } });
const check = (expression, value, unit = '', extra = {}) => checkCalculation({ ...evidence(expression, value, unit), ...extra }, { answer: `${value}${unit ? ` ${unit}` : ''}` });

test('bounded arithmetic handles precedence, signed powers, decimals and scientific notation', () => {
  for (const [expression, value] of [['2+3*4', 14], ['(2+3)*4', 20], ['-2^2', -4], ['2^-2', .25], ['2^3^2', 512], ['.1+.2', .3], ['1e3/4', 250]])
    assert.equal(check(expression, value).status, 'agreement', expression);
  assert.equal(check('2+3*4', 20).status, 'mismatch');
  assert.equal(check('1/3', .33, '', { decimalPlaces: 2 }).status, 'agreement');
  assert.equal(check('1/3', .3, '', { decimalPlaces: 2 }).status, 'mismatch');
  assert.equal(check('-1.25', -1.3, '', { decimalPlaces: 1 }).status, 'agreement');
  assert.equal(check('1.25', 1.3, '', { decimalPlaces: 1 }).status, 'agreement');
});

test('quantities convert a bounded SI subset and check dimension consistency', () => {
  const variables = { speed: { value: 36, unit: 'km/h' }, time: { value: 2, unit: 'min' } };
  assert.equal(check('speed*time', 1.2, 'km', { variables }).status, 'agreement');
  assert.equal(check('speed*time', 1200, 's', { variables }).status, 'mismatch');
  assert.equal(check('distance+time', 3, 'm', { variables: { distance: { value: 1, unit: 'm' }, time: { value: 2, unit: 's' } } }).status, 'mismatch');
  assert.equal(check('mass*distance/time^2', 2, 'kg*m/s^2', { variables: { mass: { value: 1, unit: 'kg' }, distance: { value: 8, unit: 'm' }, time: { value: 2, unit: 's' } } }).status, 'agreement');
  assert.equal(check('fraction*200', 50, '', { variables: { fraction: { value: 25, unit: '%' } } }).status, 'agreement');
  assert.equal(check('1', 0, 'm^8/mm^8').status, 'mismatch', 'composite unit scales cannot enlarge absolute tolerance');
});

test('intermediate claims are checked and later steps use computed values', () => {
  const steps = [{ name: 'subtotal', expression: '3*4', value: 12, unit: '' }, { name: 'total', expression: 'subtotal+2', value: 14, unit: '' }];
  assert.equal(check('total/2', 7, '', { steps }).status, 'agreement');
  assert.equal(check('total/2', 7, '', { steps: [{ ...steps[0], value: 11 }, steps[1]] }).status, 'mismatch');
  assert.equal(check('subtotal', 12, '', { variables: { subtotal: { value: 12 } }, steps }).status, 'not_checked');
});

test('a result is checked against the actual answer and correct numeric choice', () => {
  const data = evidence('2+3', 5);
  assert.equal(checkCalculation(data, { answer: '6' }).status, 'mismatch');
  assert.equal(checkCalculation(data, { answer: '5', options: [{ correct: true, text: '6' }] }).status, 'mismatch');
  assert.equal(checkCalculation(data, { answer: 'The result is five.' }).status, 'not_checked');
  assert.equal(checkCalculation(data, { answer: '5', options: [{ correct: true, text: 'Five units' }] }).status, 'not_checked');
});

test('unsupported and adversarial evidence never claims arithmetic agreement', () => {
  const expressions = ['process.exit()', 'globalThis.x=1', 'constructor.constructor("return 1")()', '2;3', 'Math.sqrt(4)', 'sqrt(4)', '2**3', '2x', 'x.y', '1/0', '0/0', '(-1)^.5', '2^1000', 'NaN', 'Infinity', '1e101', 'missing+1', '/*ok*/1', '[1][0]', '1<<2', '2=2', '"2"', '(', '2+', '1 '.repeat(300), '('.repeat(40) + '1' + ')'.repeat(40), '-'.repeat(40) + '1'];
  for (const expression of expressions) assert.equal(check(expression, 1).status, 'not_checked', expression);
  for (const unit of ['USD', 'C', 'm s', 'm^100', 'm//s', 'm;', 'µm']) assert.equal(check('1', 1, unit).status, 'not_checked', unit);
  for (const value of [Infinity, NaN, '5', null]) assert.equal(checkCalculation(evidence('5', value), { answer: '5' }).status, 'not_checked');
  assert.equal(check('1', 1, '', { decimalPlaces: 100 }).status, 'not_checked');
  assert.equal(check('1', 1, '', { variables: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`x${i}`, { value: 1 }])) }).status, 'not_checked');
  assert.equal(check('1', 1, '', { steps: Array.from({ length: 17 }, (_, i) => ({ name: `x${i}`, expression: '1', value: 1 })) }).status, 'not_checked');
  assert.equal(check('1', 1, '', { steps: [{ expression: '1', value: 1 }] }).status, 'not_checked');
  assert.equal(check('1', 1, '', { steps: [{ name: null, expression: '1', value: 1 }] }).status, 'not_checked');
  assert.equal(checkCalculation(undefined, { answer: '5' }).status, 'not_checked');
  assert.equal(check('1', 2, '', { status: 'agreement', verified: true, tolerance: 100 }).status, 'mismatch');
});

test('power underflow cannot claim agreement with zero for a nonzero base', () => {
  for (const expression of ['1e-100^12', '(-1e-100)^11', '(-1e-100)^12'])
    assert.equal(check(expression, 0).status, 'not_checked', expression);
  for (const expression of ['0^2', '0^12', '(-0)^11'])
    assert.equal(check(expression, 0).status, 'agreement', expression);
});

test('TeX-wrapped numeric answers and options are unwrapped before checking and cannot bypass mismatch', () => {
  const plain = evidence('3*4', 12);
  for (const answer of ['$12$', '$$12$$', '\\(12\\)', '\\[12\\]', '\\text{12}', '$+12$']) {
    assert.equal(checkCalculation(plain, { answer, options: [{ correct: true, text: answer }] }).status, 'agreement', answer);
  }
  // Wrong TeX-wrapped numeric answers/options MUST trigger mismatch instead of falling back to not_checked.
  assert.equal(checkCalculation(plain, { answer: '$24$' }).status, 'mismatch');
  assert.equal(checkCalculation(plain, { answer: '\\(24\\)' }).status, 'mismatch');
  assert.equal(checkCalculation(plain, { answer: '$12$', options: [{ correct: true, text: '$24$' }] }).status, 'mismatch');

  // Negative numbers including Unicode minus U+2212.
  assert.equal(checkCalculation(evidence('-3*4', -12), { answer: '$-12$' }).status, 'agreement');
  assert.equal(checkCalculation(evidence('-3*4', -12), { answer: '$−12$' }).status, 'agreement');

  // LaTeX-wrapped SI units, spacing macros, percent and braced exponents.
  const dist = {
    expression: 'speed*time',
    result: { value: 1.2, unit: 'km' },
    variables: { speed: { value: 36, unit: 'km/h' }, time: { value: 2, unit: 'min' } },
  };
  for (const answer of ['$1.2\\text{ km}$', '$1.2\\,\\mathrm{km}$', '$1200\\,\\text{m}$', '$1.2$ km', '1.2 $\\mathrm{km}$']) {
    assert.equal(checkCalculation(dist, { answer }).status, 'agreement', answer);
  }
  assert.equal(checkCalculation(dist, { answer: '$1200\\text{ s}$' }).status, 'mismatch');
  assert.equal(checkCalculation(evidence('0.25', 25, '%'), { answer: '$25\\%$' }).status, 'agreement');
  assert.equal(
    checkCalculation(
      { expression: 'm*d/t^2', result: { value: 2, unit: 'kg*m/s^2' }, variables: { m: { value: 1, unit: 'kg' }, d: { value: 8, unit: 'm' }, t: { value: 2, unit: 's' } } },
      { answer: '$2\\,\\mathrm{kg}\\cdot\\mathrm{m}/\\mathrm{s}^{2}$' },
    ).status,
    'agreement',
  );

  // Non-numeric symbolic expressions remain not_checked (never false agreement or false mismatch).
  for (const answer of ['$5\\sqrt{2}$', '$x + 1$', '$3 + 9$']) {
    assert.equal(checkCalculation(plain, { answer }).status, 'not_checked', answer);
  }
});

test('expanded SI & physics/chemistry units convert accurately and catch dimensional mismatches', () => {
  // Volume & area conversions: L, mL, dm^3, cm^3, m^3, ha
  assert.equal(check('v', 1500, 'mL', { variables: { v: { value: 1.5, unit: 'L' } } }).status, 'agreement');
  assert.equal(check('v', 1500, 'cm^3', { variables: { v: { value: 1.5, unit: 'L' } } }).status, 'agreement');
  assert.equal(check('v', 0.0015, 'm^3', { variables: { v: { value: 1.5, unit: 'L' } } }).status, 'agreement');
  assert.equal(check('a*b', 2, 'ha', { variables: { a: { value: 200, unit: 'm' }, b: { value: 100, unit: 'm' } } }).status, 'agreement');
  assert.equal(check('v', 1500, 'm^2', { variables: { v: { value: 1.5, unit: 'L' } } }).status, 'mismatch');

  // Force, Energy, Power, Pressure: N, kN, J, kJ, eV, W, kW, Pa, kPa, MPa, bar, atm
  assert.equal(
    check('m*a', 2.5, 'kN', { variables: { m: { value: 500, unit: 'kg' }, a: { value: 5, unit: 'm/s^2' } } }).status,
    'agreement',
  );
  assert.equal(
    check('f*d', 1.2, 'kJ', { variables: { f: { value: 400, unit: 'N' }, d: { value: 3, unit: 'm' } } }).status,
    'agreement',
  );
  assert.equal(
    check('e/t', 2.5, 'kW', { variables: { e: { value: 5000, unit: 'J' }, t: { value: 2, unit: 's' } } }).status,
    'agreement',
  );
  assert.equal(
    check('p*t', 3.6, 'MJ', { variables: { p: { value: 1, unit: 'kW' }, t: { value: 1, unit: 'h' } } }).status,
    'agreement',
  );
  assert.equal(
    check('f/area', 50, 'kPa', { variables: { f: { value: 100, unit: 'kN' }, area: { value: 2, unit: 'm^2' } } }).status,
    'agreement',
  );
  assert.equal(
    check('p', 100, 'kPa', { variables: { p: { value: 1, unit: 'bar' } } }).status,
    'agreement',
  );
  assert.equal(
    check('p', 101.325, 'kPa', { variables: { p: { value: 1, unit: 'atm' } } }).status,
    'agreement',
  );
  assert.equal(
    check('p', 1, 'MPa', { variables: { p: { value: 10, unit: 'bar' } } }).status,
    'agreement',
  );
  // Tiny energy unit eV must convert accurately AND reject mismatched eV values (no SI absolute-tolerance washout).
  assert.equal(
    check('e', 1.602176634e-19, 'J', { variables: { e: { value: 1, unit: 'eV' } } }).status,
    'agreement',
  );
  assert.equal(
    check('e', 2, 'eV', { variables: { e: { value: 1, unit: 'eV' } } }).status,
    'mismatch',
    '1 eV must never falsely agree with 2 eV',
  );
  assert.equal(
    check('e', 0, 'eV', { variables: { e: { value: 1, unit: 'eV' } } }).status,
    'mismatch',
    '1 eV must never falsely agree with 0 eV',
  );

  // Electrical: V, mV, A, mA, Ω, kΩ + Ohm's law & electrical power
  assert.equal(
    check('v/r', 3, 'mA', { variables: { v: { value: 12, unit: 'V' }, r: { value: 4, unit: 'kΩ' } } }).status,
    'agreement',
  );
  assert.equal(
    check('i*r', 600, 'mV', { variables: { i: { value: 20, unit: 'mA' }, r: { value: 30, unit: 'Ω' } } }).status,
    'agreement',
  );
  assert.equal(
    check('v*i', 2.4, 'W', { variables: { v: { value: 12, unit: 'V' }, i: { value: 200, unit: 'mA' } } }).status,
    'agreement',
  );
  assert.equal(
    check('v^2/r', 0.036, 'W', { variables: { v: { value: 12, unit: 'V' }, r: { value: 4, unit: 'kΩ' } } }).status,
    'agreement',
  );
  assert.equal(
    check('v/r', 3, 'V', { variables: { v: { value: 12, unit: 'V' }, r: { value: 4, unit: 'kΩ' } } }).status,
    'mismatch',
  );

  // Frequency: Hz, kHz, MHz
  assert.equal(
    check('1/t', 0.5, 'kHz', { variables: { t: { value: 2, unit: 'ms' } } }).status,
    'agreement',
  );
  assert.equal(
    check('c/lambda', 600, 'MHz', { variables: { c: { value: 3e8, unit: 'm/s' }, lambda: { value: 0.5, unit: 'm' } } }).status,
    'agreement',
  );

  // Amount of substance & molarity: mol, mmol, M (= mol/L)
  assert.equal(
    check('c*v', 100, 'mmol', { variables: { c: { value: 0.5, unit: 'M' }, v: { value: 200, unit: 'mL' } } }).status,
    'agreement',
  );
  assert.equal(
    check('n/v', 0.5, 'M', { variables: { n: { value: 0.25, unit: 'mol' }, v: { value: 500, unit: 'mL' } } }).status,
    'agreement',
  );
  assert.equal(
    check('n/v', 0.5, 'mol/L', { variables: { n: { value: 0.25, unit: 'mol' }, v: { value: 500, unit: 'mL' } } }).status,
    'agreement',
  );

  // Angle: rad, deg (with explicit angle dimension preventing false agreement with Hz or dimensionless)
  assert.equal(
    check('theta', 3.141593, 'rad', { variables: { theta: { value: 180, unit: 'deg' } }, decimalPlaces: 6 }).status,
    'agreement',
  );
  assert.equal(
    check('theta', 3.1415926536, 'rad', { variables: { theta: { value: 180, unit: 'deg' } }, decimalPlaces: 10 }).status,
    'agreement',
  );
  assert.equal(
    check('omega*t', 90, 'deg', { variables: { omega: { value: 0.5 * Math.PI, unit: 'rad/s' }, t: { value: 1, unit: 's' } } }).status,
    'agreement',
  );
  assert.equal(
    check('theta', 180, '', { variables: { theta: { value: 180, unit: 'deg' } } }).status,
    'mismatch',
  );
  assert.equal(
    check('f', 10, 'rad/s', { variables: { f: { value: 10, unit: 'Hz' } } }).status,
    'mismatch',
  );
});

test('temperature K and °C handle affine offset conversions and reject compound °C cleanly', () => {
  assert.equal(check('t', 298.15, 'K', { variables: { t: { value: 25, unit: '°C' } } }).status, 'agreement');
  assert.equal(check('t', 26.85, '°C', { variables: { t: { value: 300, unit: 'K' } } }).status, 'agreement');
  assert.equal(check('t', 0, 'K', { variables: { t: { value: -273.15, unit: '°C' } } }).status, 'agreement');
  assert.equal(check('t', 25, 'K', { variables: { t: { value: 25, unit: '°C' } } }).status, 'mismatch');
  assert.equal(check('t2-t1', 80, 'K', { variables: { t2: { value: 100, unit: '°C' }, t1: { value: 20, unit: '°C' } } }).status, 'agreement');
  // Ideal gas law PV = nRT with T in °C, P in kPa, V in L
  assert.equal(
    check('n*R*T/P', 24.95, 'L', {
      variables: {
        n: { value: 1, unit: 'mol' },
        R: { value: 8.314, unit: 'J/mol/K' },
        T: { value: 27, unit: '°C' },
        P: { value: 100, unit: 'kPa' },
      },
      decimalPlaces: 2,
    }).status,
    'agreement',
  );
  // Compound units with °C stay conservatively not_checked (must use K)
  assert.equal(check('1', 1, 'J/kg/°C').status, 'not_checked');
  assert.equal(check('1', 1, '°C^2').status, 'not_checked');
});

test('TeX unwrapping supports \\pu, \\Omega, ^\\circ\\mathrm{C}, and ^\\circ without false positives', () => {
  const tempEv = { expression: 't', result: { value: 25, unit: '°C' }, variables: { t: { value: 298.15, unit: 'K' } } };
  for (const answer of ['$25^{\\circ}\\mathrm{C}$', '$25^\\circ\\text{C}$', '$25\\,\\text{°C}$', '$\\pu{25 °C}$', '$25\\,\\celsius$']) {
    assert.equal(checkCalculation(tempEv, { answer }).status, 'agreement', answer);
  }
  assert.equal(checkCalculation(tempEv, { answer: '$30^{\\circ}\\mathrm{C}$' }).status, 'mismatch');

  const ohmEv = { expression: 'v/i', result: { value: 4, unit: 'kΩ' }, variables: { v: { value: 12, unit: 'V' }, i: { value: 3, unit: 'mA' } } };
  for (const answer of ['$4\\,\\mathrm{k\\Omega}$', '$4\\,\\text{k}\\Omega$', '$4000\\,\\Omega$', '$\\pu{4 kΩ}$', '$\\SI{4}{k\\Omega}$']) {
    assert.equal(checkCalculation(ohmEv, { answer }).status, 'agreement', answer);
  }
  assert.equal(checkCalculation(ohmEv, { answer: '$4\\,\\mathrm{kV}$' }).status, 'mismatch');

  const angleEv = { expression: 'theta', result: { value: 90, unit: 'deg' }, variables: { theta: { value: Math.PI / 2, unit: 'rad' } } };
  for (const answer of ['$90^\\circ$', '$90^{\\circ}$', '90°', '$\\pu{90 deg}$']) {
    assert.equal(checkCalculation(angleEv, { answer }).status, 'agreement', answer);
  }
  assert.equal(checkCalculation(angleEv, { answer: '$45^\\circ$' }).status, 'mismatch');

  const energyEv = { expression: 'f*d', result: { value: 12, unit: 'kJ' }, variables: { f: { value: 4, unit: 'kN' }, d: { value: 3, unit: 'm' } } };
  assert.equal(checkCalculation(energyEv, { answer: '$\\pu{12 kJ}$' }).status, 'agreement');
  assert.equal(checkCalculation(energyEv, { answer: '$\\pu{12000 J}$' }).status, 'agreement');
  assert.equal(checkCalculation(energyEv, { answer: '$\\pu{12 kW}$' }).status, 'mismatch');
});
