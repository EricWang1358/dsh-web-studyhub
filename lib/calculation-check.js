/** Bounded numerical agreement only. Never establishes the meaning or source support of a formula. */
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
// SI base dimensions: [L (m), M (kg), T (s), I (A), Θ (K), N (mol), A (rad)]
const ZERO_DIMS = Object.freeze([0, 0, 0, 0, 0, 0, 0]);
const EV_JOULES = 1.602176634e-19;
const DEG_RAD = Math.PI / 180;
const CELSIUS_OFFSET = 273.15;
const UNITS = new Map([
  // Dimensionless
  ['%', [0.01, [0, 0, 0, 0, 0, 0, 0]]],
  // Length
  ['m', [1, [1, 0, 0, 0, 0, 0, 0]]],
  ['km', [1e3, [1, 0, 0, 0, 0, 0, 0]]],
  ['dm', [1e-1, [1, 0, 0, 0, 0, 0, 0]]],
  ['cm', [1e-2, [1, 0, 0, 0, 0, 0, 0]]],
  ['mm', [1e-3, [1, 0, 0, 0, 0, 0, 0]]],
  ['nm', [1e-9, [1, 0, 0, 0, 0, 0, 0]]],
  // Mass
  ['kg', [1, [0, 1, 0, 0, 0, 0, 0]]],
  ['g', [1e-3, [0, 1, 0, 0, 0, 0, 0]]],
  ['mg', [1e-6, [0, 1, 0, 0, 0, 0, 0]]],
  ['t', [1e3, [0, 1, 0, 0, 0, 0, 0]]],
  // Time
  ['s', [1, [0, 0, 1, 0, 0, 0, 0]]],
  ['ms', [1e-3, [0, 0, 1, 0, 0, 0, 0]]],
  ['ns', [1e-9, [0, 0, 1, 0, 0, 0, 0]]],
  ['min', [60, [0, 0, 1, 0, 0, 0, 0]]],
  ['h', [3600, [0, 0, 1, 0, 0, 0, 0]]],
  // Area (m^2, cm^2, etc. derive from Length; hectare is SI-accepted)
  ['ha', [1e4, [2, 0, 0, 0, 0, 0, 0]]],
  // Volume (m^3, cm^3, dm^3 derive from Length)
  ['L', [1e-3, [3, 0, 0, 0, 0, 0, 0]]],
  ['mL', [1e-6, [3, 0, 0, 0, 0, 0, 0]]],
  ['dL', [1e-4, [3, 0, 0, 0, 0, 0, 0]]],
  // Thermodynamic temperature (°C is handled separately as a standalone affine unit)
  ['K', [1, [0, 0, 0, 0, 1, 0, 0]]],
  // Force: kg·m/s²
  ['N', [1, [1, 1, -2, 0, 0, 0, 0]]],
  ['kN', [1e3, [1, 1, -2, 0, 0, 0, 0]]],
  ['mN', [1e-3, [1, 1, -2, 0, 0, 0, 0]]],
  // Energy: kg·m²/s²
  ['J', [1, [2, 1, -2, 0, 0, 0, 0]]],
  ['kJ', [1e3, [2, 1, -2, 0, 0, 0, 0]]],
  ['MJ', [1e6, [2, 1, -2, 0, 0, 0, 0]]],
  ['mJ', [1e-3, [2, 1, -2, 0, 0, 0, 0]]],
  ['eV', [EV_JOULES, [2, 1, -2, 0, 0, 0, 0]]],
  ['keV', [EV_JOULES * 1e3, [2, 1, -2, 0, 0, 0, 0]]],
  ['MeV', [EV_JOULES * 1e6, [2, 1, -2, 0, 0, 0, 0]]],
  ['Wh', [3600, [2, 1, -2, 0, 0, 0, 0]]],
  ['kWh', [3.6e6, [2, 1, -2, 0, 0, 0, 0]]],
  ['cal', [4.184, [2, 1, -2, 0, 0, 0, 0]]],
  ['kcal', [4184, [2, 1, -2, 0, 0, 0, 0]]],
  // Power: kg·m²/s³
  ['W', [1, [2, 1, -3, 0, 0, 0, 0]]],
  ['kW', [1e3, [2, 1, -3, 0, 0, 0, 0]]],
  ['MW', [1e6, [2, 1, -3, 0, 0, 0, 0]]],
  ['mW', [1e-3, [2, 1, -3, 0, 0, 0, 0]]],
  // Pressure: kg/(m·s²)
  ['Pa', [1, [-1, 1, -2, 0, 0, 0, 0]]],
  ['kPa', [1e3, [-1, 1, -2, 0, 0, 0, 0]]],
  ['MPa', [1e6, [-1, 1, -2, 0, 0, 0, 0]]],
  ['GPa', [1e9, [-1, 1, -2, 0, 0, 0, 0]]],
  ['bar', [1e5, [-1, 1, -2, 0, 0, 0, 0]]],
  ['atm', [101325, [-1, 1, -2, 0, 0, 0, 0]]],
  // Electrical: current (A), voltage (W/A), resistance (V/A)
  ['A', [1, [0, 0, 0, 1, 0, 0, 0]]],
  ['mA', [1e-3, [0, 0, 0, 1, 0, 0, 0]]],
  ['kA', [1e3, [0, 0, 0, 1, 0, 0, 0]]],
  ['V', [1, [2, 1, -3, -1, 0, 0, 0]]],
  ['mV', [1e-3, [2, 1, -3, -1, 0, 0, 0]]],
  ['kV', [1e3, [2, 1, -3, -1, 0, 0, 0]]],
  ['Ω', [1, [2, 1, -3, -2, 0, 0, 0]]],
  ['kΩ', [1e3, [2, 1, -3, -2, 0, 0, 0]]],
  ['MΩ', [1e6, [2, 1, -3, -2, 0, 0, 0]]],
  ['mΩ', [1e-3, [2, 1, -3, -2, 0, 0, 0]]],
  ['ohm', [1, [2, 1, -3, -2, 0, 0, 0]]],
  ['kohm', [1e3, [2, 1, -3, -2, 0, 0, 0]]],
  // Frequency: s⁻¹
  ['Hz', [1, [0, 0, -1, 0, 0, 0, 0]]],
  ['kHz', [1e3, [0, 0, -1, 0, 0, 0, 0]]],
  ['MHz', [1e6, [0, 0, -1, 0, 0, 0, 0]]],
  ['GHz', [1e9, [0, 0, -1, 0, 0, 0, 0]]],
  // Amount of substance & molar concentration (1 M = 1 mol/L = 1000 mol/m³)
  ['mol', [1, [0, 0, 0, 0, 0, 1, 0]]],
  ['mmol', [1e-3, [0, 0, 0, 0, 0, 1, 0]]],
  ['M', [1e3, [-3, 0, 0, 0, 0, 1, 0]]],
  ['mM', [1, [-3, 0, 0, 0, 0, 1, 0]]],
  // Plane angle (explicit angle dimension prevents false agreement with scalars or Hz)
  ['rad', [1, [0, 0, 0, 0, 0, 0, 1]]],
  ['deg', [DEG_RAD, [0, 0, 0, 0, 0, 0, 1]]],
  ['°', [DEG_RAD, [0, 0, 0, 0, 0, 0, 1]]],
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
const scalar = value => ({ value: finite(value), dimensions: [...ZERO_DIMS] });

function unitInfo(unit = '') {
  if (typeof unit !== 'string' || unit.length > 64) unsupported('Unsupported unit');
  const text = unit.trim().replace(/\u2126/g, 'Ω');
  if (!text || text === '1') return { scale: 1, offset: 0, dimensions: [...ZERO_DIMS] };
  if (text === '°C') return { scale: 1, offset: CELSIUS_OFFSET, dimensions: [0, 0, 0, 0, 1, 0, 0] };
  if (text.includes('°C')) unsupported('Offset temperature unit °C cannot be combined in compound units; use K');
  let rest = text, scale = 1, dims = [...ZERO_DIMS], sign = 1, factors = 0;
  while (rest) {
    const match = /^(°|[A-Za-zΩ]+|%)(?:\^([+-]?\d+))?/.exec(rest);
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
  return { scale, offset: 0, dimensions: dims };
}

function quantity(claim) {
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) unsupported('A numerical value and optional unit are required');
  const info = unitInfo(claim.unit);
  return { value: finite(finite(claim.value) * info.scale + info.offset), dimensions: info.dimensions };
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
    if (!sameDimensions(exponent.dimensions, ZERO_DIMS) || !Number.isInteger(exponent.value) || Math.abs(exponent.value) > 12)
      unsupported('Only dimensionless integer powers from -12 to 12 are supported');
    if (base.value === 0 && exponent.value <= 0) unsupported('Undefined zero power');
    const value = base.value ** exponent.value;
    if (base.value !== 0 && value === 0) unsupported('Power underflow for a nonzero base');
    return { value: finite(value), dimensions: dimensions(base.dimensions.map(value => value * exponent.value)) };
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
  let value = finite((actual.value - info.offset) / info.scale);
  if (decimalPlaces !== undefined) {
    // Round in the stated result unit; restrict magnitude to preserve decimal rounding precision.
    if (Math.abs(value) * 10 ** decimalPlaces > Number.MAX_SAFE_INTEGER) unsupported('Decimal rounding magnitude limit exceeded');
    value = Math.sign(value) * Math.round((Math.abs(value) + Number.EPSILON * Math.abs(value)) * 10 ** decimalPlaces) / 10 ** decimalPlaces;
  }
  // Compare in normalized SI scales so large composite unit scales cannot enlarge absolute tolerance,
  // while tiny SI units (e.g., eV, nm) tighten absolute tolerance proportionally to their scale.
  const normalized = finite(value * info.scale + info.offset);
  const absTol = 1e-12 * Math.min(1, info.scale);
  if (Math.abs(normalized - expected.value) > absTol + 1e-9 * Math.max(Math.abs(normalized), Math.abs(expected.value)))
    mismatch(`${label}: arithmetic gives ${value}${claim.unit ? ` ${claim.unit}` : ''}, claimed ${claim.value}${claim.unit ? ` ${claim.unit}` : ''}`);
}

function stripOuterMath(text) {
  let out = text.trim();
  for (let pass = 0; pass < 3; pass++) {
    if (out.startsWith('$$') && out.endsWith('$$') && out.length > 4 && !out.slice(2, -2).includes('$')) {
      out = out.slice(2, -2).trim();
    } else if (out.startsWith('$') && out.endsWith('$') && out.length > 2 && !out.slice(1, -1).includes('$')) {
      out = out.slice(1, -1).trim();
    } else if (out.startsWith('\\(') && out.endsWith('\\)') && out.length > 4 && !/\\[()]/.test(out.slice(2, -2))) {
      out = out.slice(2, -2).trim();
    } else if (out.startsWith('\\[') && out.endsWith('\\]') && out.length > 4 && !/\\[[\]]/.test(out.slice(2, -2))) {
      out = out.slice(2, -2).trim();
    } else {
      const wrappedText = /^\\(?:text|mathrm|rm|operatorname|units)\{([^{}]+)\}$/.exec(out)
        || /^\\pu\{((?:[^{}]|\{[+-]?\d+\})+)\}$/.exec(out);
      if (!wrappedText) break;
      out = wrappedText[1].trim();
    }
  }
  return out;
}

function normalizeAnswerUnit(rawUnit, hadTex) {
  let unit = stripOuterMath(rawUnit);
  const unitHadTex = hadTex || unit !== rawUnit.trim() || /\\/.test(unit);
  if (!unit) return '';
  if (unitHadTex) {
    unit = unit
      .replace(/\u2126/g, 'Ω')
      .replace(/\\(?:cdot|times)\b/g, '*')
      .replace(/·/g, '*')
      .replace(/\\(?:Omega|ohm)\b/g, 'Ω')
      .replace(/\\celsius\b/g, '°C')
      .replace(/\\(?:text|mathrm|rm|operatorname|units|pu)\{([^{}]*)\}/g, '$1')
      .replace(/(?:\^\{\\circ\}|\^\\circ|\\textdegree\b|\\degree\b)\s*C(?![A-Za-z])/g, '°C')
      .replace(/(?:\^\{\\circ\}|\^\\circ|\\textdegree\b|\\degree\b)/g, 'deg')
      .replace(/\\%/g, '%')
      .replace(/\^\{([+-]?\d+)\}/g, '^$1')
      .replace(/\\(?:[,;:! ]|quad|qquad)|~/g, ' ')
      .replace(/\s*([*/])\s*/g, '$1')
      .trim();
  }
  return unit;
}

function answerQuantity(answer) {
  if (typeof answer !== 'string' || answer.length > 160) unsupported('Answer is outside the standalone numeric subset');
  const trimmed = answer.trim();
  let text = stripOuterMath(trimmed);
  const hadTex = text !== trimmed || /\\/.test(text);
  // Also handle a delimited standalone number followed by a unit, e.g. "$12$ m" or "\(12\) km/h".
  if (text === trimmed) {
    const split = /^(?:\$([^$\n]+)\$|\\\(([^)\n]+)\\\))\s*(.+)$/.exec(text);
    if (split) {
      const head = (split[1] ?? split[2]).replace(/\u2212/g, '-').trim();
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(head)) {
        return { value: finite(Number(head)), unit: normalizeAnswerUnit(split[3], true) };
      }
    }
  }
  text = text.replace(/\u2212/g, '-');
  if (hadTex) {
    const siunitx = /^\\(?:SI|qty)\{([^{}]+)\}\{((?:[^{}]|\{[^{}]*\})+)\}$/.exec(text);
    if (siunitx) {
      const head = siunitx[1].trim();
      if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(head)) {
        return { value: finite(Number(head)), unit: normalizeAnswerUnit(siunitx[2], true) };
      }
    }
    text = text.replace(/\\(?:[,;:! ]|quad|qquad)|~/g, ' ').trim();
  }
  if (text.length > 100) unsupported('Answer is outside the standalone numeric subset');
  const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*(.*?)$/.exec(text);
  if (!match) unsupported('Answer is outside the standalone numeric subset');
  return { value: finite(Number(match[1])), unit: normalizeAnswerUnit(match[2], hadTex) };
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
