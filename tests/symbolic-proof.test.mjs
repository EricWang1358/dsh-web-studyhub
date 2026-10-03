import test from 'node:test';
import assert from 'node:assert/strict';
import { proveIdentity } from '../lib/symbolic-proof.js';

test('proves polynomial identities by exact expansion', () => {
  const result = proveIdentity('(x+1)^2', 'x^2+2x+1');
  assert.equal(result.status, 'proved');
  assert.equal(result.left, 'x^2 + 2*x + 1');
  assert.equal(result.left, result.right);
  assert.ok(result.steps.length >= 3);
  assert.match(result.steps.join(' '), /exact|rational/i);
  assert.doesNotThrow(() => JSON.stringify(result));
  assert.equal(proveIdentity('(x+y)(x-y)', 'x^2-y^2').status, 'proved');
  assert.equal(proveIdentity('mass * acceleration + force', 'force + acceleration * mass').status, 'proved');
  assert.equal(proveIdentity('0.1x + 0.2x', '0.3x').status, 'proved');
  assert.equal(proveIdentity('x/3+x/6', 'x/2').status, 'proved');
  assert.equal(proveIdentity('x/(y-y+2)', '0.5x').status, 'proved');
});

test('different polynomials disprove an identity, not pointwise equality', () => {
  const result = proveIdentity('(x+1)^2', 'x^2+1');
  assert.equal(result.status, 'disproved');
  assert.match(result.reason, /particular values/);
  assert.equal(proveIdentity('xy', 'x*y').status, 'disproved');
  assert.equal(proveIdentity('0.30000000000000001', '0.3').status, 'disproved');
});

test('power precedence, unary signs, and constant reciprocals are exact', () => {
  assert.equal(proveIdentity('-x^2', '-(x*x)').status, 'proved');
  assert.equal(proveIdentity('(-x)^2', 'x^2').status, 'proved');
  assert.equal(proveIdentity('2^-3', '1/8').status, 'proved');
  assert.equal(proveIdentity('x^2^3', 'x^8').status, 'proved');
  assert.equal(proveIdentity('x^(2+1)', 'x*x*x').status, 'proved');
});

test('undefined and unsupported expressions never become proofs', () => {
  for (const expression of ['x/x', '1/(x+1)', 'x^-1', '0^0', '(x-x)^0', '0^-1',
    '0*(1/0)', '1/0', 'sin(x)', 'sqrt(x)', 'mass(x)', 'x^0.5', 'x^y', 'x=1',
    'NaN', 'Infinity', '1e309', 'Math.sin(x)', 'x;alert(1)', 'x[0]']) {
    const result = proveIdentity(expression, expression);
    assert.equal(result.status, 'not_checked', expression);
    assert.ok(result.reason, expression);
    assert.equal(result.steps, undefined, expression);
  }
});

test('zero powers record the necessary domain rather than erase it', () => {
  const result = proveIdentity('(x+1)^0', '1');
  assert.equal(result.status, 'proved');
  assert.ok(result.assumptions.some(value => value.includes('x + 1') && value.includes('!= 0')));
  const repeated = proveIdentity('x^0+x^0', '2');
  assert.equal(repeated.assumptions.filter(value => value.includes('!= 0')).length, 1);
});

test('rejects malformed syntax and non-string input', () => {
  for (const expression of ['', ' ', 'x+', '()', '(x', 'x)', 'x**2', '2 3', '2..3', 'x^^2', '/', '+']) {
    assert.equal(proveIdentity(expression, '0').status, 'not_checked', expression);
  }
  for (const value of [undefined, null, 1, {}, ['x']]) {
    assert.equal(proveIdentity(value, '0').status, 'not_checked');
  }
});

test('bounds input, recursion, expansion, degrees, and coefficient growth', () => {
  const expressions = [
    'x'.repeat(4097),
    '1'.repeat(65),
    'long_variable_name_that_exceeds_thirty_two_characters',
    Array(140).fill('x').join('+'),
    '('.repeat(40) + 'x' + ')'.repeat(40),
    '-'.repeat(40) + 'x',
    'x^9', '(x^8)^8',
    '(a+b+c+d+e+f+g+h)^8',
    Array.from({ length: 17 }, (_, i) => `v${i}`).join('+'),
    `((${ '9'.repeat(64) })^8)^8`,
  ];
  for (const expression of expressions) {
    assert.equal(proveIdentity(expression, expression).status, 'not_checked', expression.slice(0, 80));
  }
  assert.equal(proveIdentity('(x+y)^8', '(x+y)^8').status, 'proved');
});

test('canonical results are deterministic across variable and term order', () => {
  const result = proveIdentity('b*a + b^2 + a^2 - b*a + a*b', 'a^2+a*b+b^2');
  assert.equal(result.status, 'proved');
  assert.equal(result.left, 'a*b + a^2 + b^2');
  assert.equal(proveIdentity('x-x', '0').left, '0');
  assert.equal(proveIdentity('.25*(rate+rate)', 'rate/2').status, 'proved');
});

test('exact scientific decimals and cancellation do not use floating point', () => {
  assert.equal(proveIdentity('1e-24*x + 2e-24*x', '3e-24*x').status, 'proved');
  assert.equal(proveIdentity('1e24/10', '100000000000000000000000').status, 'proved');
  assert.equal(proveIdentity('1000000000000000000000000 + 1', '1000000000000000000000001').status, 'proved');
  assert.equal(proveIdentity('1e-24', '0').status, 'disproved');
  assert.equal(proveIdentity('x/(-2)', '-0.5x').status, 'proved');
  assert.equal(proveIdentity('(x+y)^3', 'x^3+3*x^2*y+3*x*y^2+y^3').status, 'proved');
});

test('undefined operands remain unchecked even if another factor is zero', () => {
  for (const expression of ['(x/x)*0', '0/(y-y)', '(1/0)^0', '0*(x^-1)', '0*sqrt(x)']) {
    assert.equal(proveIdentity(expression, '0').status, 'not_checked', expression);
  }
  const result = proveIdentity('0*(x^0)', '0');
  assert.equal(result.status, 'proved');
  assert.ok(result.assumptions.some(value => value.includes('(x) != 0')));
  assert.equal(proveIdentity('1', 'x/x').status, 'not_checked');
});

test('individual limits produce explicit unchecked reasons', () => {
  const cases = [
    ['x^9', /exponent limit/],
    ['(x^8)^3', /degree limit/],
    ['(a+b+c+d+e+f+g+h)^8', /term limit/],
    [`(${ '9'.repeat(64) })^8`, /integer size limit/],
    ['('.repeat(33) + 'x' + ')'.repeat(33), /nesting limit/],
    ['1e25', /scale limit/],
  ];
  for (const [expression, reason] of cases) {
    assert.match(proveIdentity(expression, expression).reason, reason);
  }
});
