/** Bounded numerical agreement only. Never establishes the meaning or source support of a formula. */
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
const UNITS = new Map([
  ['m', [1, [1, 0, 0]]], ['cm', [.01, [1, 0, 0]]], ['mm', [.001, [1, 0, 0]]], ['km', [1000, [1, 0, 0]]],
  ['kg', [1, [0, 1, 0]]], ['g', [.001, [0, 1, 0]]],
  ['s', [1, [0, 0, 1]]], ['min', [60, [0, 0, 1]]], ['h', [3600, [0, 0, 1]]], ['%', [.01, [0, 0, 0]]],
]);
class Unsupported extends Error {}
class Mismatch extends Error {}
const unsupported = reason => { throw new Unsupported(reason); };
const mismatch = reason => { throw new Mismatch(reason); };
const sameDimensions = (a, b) => a.every((value, i) => value === b[i]);
const finite = value => {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e100 || value !== 0 && Math.abs(value) < 1e-100)
    unsupported('Nonfinite or out-of-range numerical value');
  return value;
};
const dimensions = values => {
  if (values.some(value => !Number.isInteger(value) || Math.abs(value) > 16)) unsupported('Dimension exponent limit exceeded');
  return values;
};
const scalar = value => ({ value: finite(value), dimensions: [0, 0, 0] });

function unitInfo(unit = '') {
  if (typeof unit !== 'string' || unit.length > 64) unsupported('Unsupported unit');
  const text = unit.trim();
  if (!text || text === '1') return { scale: 1, dimensions: [0, 0, 0] };
  let rest = text, scale = 1, dims = [0, 0, 0], sign = 1, factors = 0;
  while (rest) {
    const match = /^([A-Za-z]+|%)(?:\^([+-]?\d+))?/.exec(rest);
    if (!match || !UNITS.has(match[1]) || ++factors > 16) unsupported('Unknown or unsupported unit syntax');
    const power = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isInteger(power) || Math.abs(power) > 8) unsupported('Unit exponent limit exceeded');
    const [factor, basis] = UNITS.get(match[1]);
    scale = finite(scale * factor ** (sign * power));
    dims = dimensions(dims.map((value, i) => value + basis[i] * sign * power));
    rest = rest.slice(match[0].length);
    if (!rest) break;
    if (!['*', '/'].includes(rest[0]) || rest.length === 1) unsupported('Unsupported unit syntax');
    sign = rest[0] === '/' ? -1 : 1;
    rest = rest.slice(1);
  }
  return { scale, dimensions: dims };
}

function quantity(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) unsupported('A numerical value and optional unit are required');
  const info = unitInfo(claim.unit);
  return { value: finite(finite(claim.value) * info.scale), dimensions: info.dimensions };
}

function tokens(expression) {
  if (typeof expression !== 'string' || !expression.trim() || expression.length > 512) unsupported('Expression length limit or missing expression');
  const result = [];
  let rest = expression.trim();
  while (rest) {
    const number = NUMBER.exec(rest), name = /^[A-Za-z][A-Za-z0-9_]*/.exec(rest);
    if (number) { result.push({ number: finite(Number(number[0])) }); rest = rest.slice(number[0].length); }
    else if (name && NAME.test(name[0])) { result.push({ name: name[0] }); rest = rest.slice(name[0].length); }
    else if ('+-*/^()'.includes(rest[0])) { result.push(rest[0]); rest = rest.slice(1); }
    else unsupported('Unsupported expression syntax');
    if (result.length > 128) unsupported('Expression token limit exceeded');
    rest = rest.trimStart();
  }
  return result;
}

function evaluate(expression, variables) {
  const input = tokens(expression);
  let index = 0, depth = 0;
  const nested = action => {
    if (++depth > 32) unsupported('Expression depth limit exceeded');
    try { return action(); } finally { depth--; }
  };
  const multiply = (a, b, divide) => {
    if (divide && b.value === 0) unsupported('Division by zero');
    return { value: finite(divide ? a.value / b.value : a.value * b.value),
      dimensions: dimensions(a.dimensions.map((value, i) => value + (divide ? -1 : 1) * b.dimensions[i])) };
  };
  const atom = () => {
    const next = input[index++];
    if (next === '(') {
      const value = nested(sum);
      if (input[index++] !== ')') unsupported('Unmatched parentheses');
      return value;
    }
    if (next && typeof next === 'object') {
      if ('number' in next) return scalar(next.number);
      if (variables.has(next.name)) return variables.get(next.name);
      unsupported(`Unknown variable ${next.name}`);
    }
    unsupported('Expected a number, variable or parenthesized expression');
  };
  const power = () => {
    const base = atom();
    if (input[index] !== '^') return base;
    index++;
    const exponent = nested(unary);
    if (!sameDimensions(exponent.dimensions, [0, 0, 0]) || !Number.isInteger(exponent.value) || Math.abs(exponent.value) > 12)
      unsupported('Only dimensionless integer powers from -12 to 12 are supported');
    if (base.value === 0 && exponent.value <= 0) unsupported('Undefined zero power');
    return { value: finite(base.value ** exponent.value), dimensions: dimensions(base.dimensions.map(value => value * exponent.value)) };
  };
  const unary = () => {
    if (input[index] !== '+' && input[index] !== '-') return power();
    const negative = input[index++] === '-';
    const value = nested(unary);
    return { ...value, value: negative ? -value.value : value.value };
  };
  const product = () => {
    let value = unary();
    while (input[index] === '*' || input[index] === '/') {
      const divide = input[index++] === '/';
      value = multiply(value, unary(), divide);
    }
    return value;
  };
  const sum = () => {
    let value = product();
    while (input[index] === '+' || input[index] === '-') {
      const subtract = input[index++] === '-', right = product();
      if (!sameDimensions(value.dimensions, right.dimensions)) mismatch('Addition/subtraction uses incompatible dimensions');
      value = { ...value, value: finite(value.value + (subtract ? -right.value : right.value)) };
    }
    return value;
  };
  const value = sum();
  if (index !== input.length) unsupported('Unsupported expression syntax or trailing tokens');
  return value;
}

function compare(actual, claim, decimalPlaces, label) {
  const expected = quantity(claim), info = unitInfo(claim.unit);
  if (!sameDimensions(actual.dimensions, expected.dimensions)) mismatch(`${label}: incompatible result dimensions`);
  let value = finite(actual.value / info.scale);
  if (decimalPlaces !== undefined) {
    // Round in the stated result unit; restrict magnitude to preserve decimal rounding precision.
    if (Math.abs(value) * 10 ** decimalPlaces > Number.MAX_SAFE_INTEGER) unsupported('Decimal rounding magnitude limit exceeded');
    value = Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON * Math.abs(value)) * 10 ** decimalPlaces) / 10 ** decimalPlaces;
  }
  // Compare in normalized SI scales so a generated composite unit cannot enlarge absolute tolerance.
  const normalized = finite(value * info.scale);
  if (Math.abs(normalized - expected.value) > 1e-12 + 1e-9 * Math.max(Math.abs(normalized), Math.abs(expected.value)))
    mismatch(`${label}: arithmetic gives ${value}${claim.unit ? ` ${claim.unit}` : ''}, claimed ${claim.value}${claim.unit ? ` ${claim.unit}` : ''}`);
}

function answerQuantity(answer) {
  if (typeof answer !== 'string' || answer.length > 100) unsupported('Answer is outside the standalone numeric subset');
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*?)$/.exec(answer.trim());
  if (!match) unsupported('Answer is outside the standalone numeric subset');
  return { value: finite(Number(match[1])), unit: match[2] };
}

/** Status is agreement, mismatch, or not_checked; model-provided success/tolerance flags have no authority. */
export function checkCalculation(evidence, item = {}) {
  if (evidence === undefined || evidence === null) return { status: 'not_checked', reason: 'No structured calculation evidence' };
  try {
    if (typeof evidence !== 'object' || Array.isArray(evidence)) unsupported('Invalid calculation evidence');
    const { decimalPlaces } = evidence;
    if (decimalPlaces !== undefined && (!Number.isInteger(decimalPlaces) || decimalPlaces < 0 || decimalPlaces > 10))
      unsupported('decimalPlaces must be an integer from 0 to 10');
    const values = evidence.variables ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values) || Object.keys(values).length > 32) unsupported('Variable limit or invalid variables');
    const variables = new Map();
    for (const [name, value] of Object.entries(values)) {
      if (!NAME.test(name)) unsupported('Unsupported variable name');
      variables.set(name, quantity(value));
    }
    const steps = evidence.steps ?? [];
    if (!Array.isArray(steps) || steps.length > 16) unsupported('Step limit or invalid steps');
    for (const step of steps) {
      if (!step || typeof step.name !== 'string' || !NAME.test(step.name) || variables.has(step.name)) unsupported('Invalid, duplicate or overwritten step name');
      const actual = evaluate(step.expression, variables);
      // Steps are unrounded; subsequent steps use computed quantities, never claimed values.
      compare(actual, step, undefined, `Step ${step.name}`);
      variables.set(step.name, actual);
    }
    const actual = evaluate(evidence.expression, variables);
    compare(actual, evidence.result, decimalPlaces, 'Result');
    compare(actual, answerQuantity(item.answer), decimalPlaces, 'Blueprint answer');
    for (const option of Array.isArray(item.options) ? item.options : [])
      if (option?.correct === true) compare(actual, answerQuantity(option.text), decimalPlaces, 'Correct option');
    return { status: 'agreement', reason: 'Supported arithmetic, supplied steps and numeric answer agree; semantic/source review is still required' };
  } catch (error) {
    if (error instanceof Unsupported) return { status: 'not_checked', reason: error.message };
    if (error instanceof Mismatch) return { status: 'mismatch', reason: error.message };
    throw error;
  }
}

/** Recomputed for the independent reviewer. Diagnostic results are never taken from generated JSON. */
export function calculationDiagnostics(blueprint) {
  return (Array.isArray(blueprint?.items) ? blueprint.items : []).map(item => ({ targetId: item?.targetId,
    ...checkCalculation(item?.calculation, item) }));
}
