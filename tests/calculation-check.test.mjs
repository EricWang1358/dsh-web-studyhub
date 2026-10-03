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
