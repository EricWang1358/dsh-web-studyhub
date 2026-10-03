// Exact, browser-safe polynomial identities. All resource limits apply to one proof.
const LIMITS = Object.freeze({ length: 4096, tokens: 256, depth: 32, variables: 16,
  identifier: 32, digits: 64, exponent: 8, degree: 16, terms: 128, bits: 1024, work: 20000 });

class Unchecked extends Error {}
const fail = reason => { throw new Unchecked(reason); };
const absolute = value => value < 0n ? -value : value;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function spend(context) {
  if (++context.work > LIMITS.work) fail('Expression exceeds the exact arithmetic work limit.');
}

function rational(n, d, context) {
  spend(context);
  if (d === 0n) fail('Division by zero is undefined.');
  if (d < 0n) { n = -n; d = -d; }
  if (absolute(n).toString(2).length > LIMITS.bits || d.toString(2).length > LIMITS.bits) {
    fail('Coefficient exceeds the exact integer size limit.');
  }
  let a = absolute(n), b = d;
  while (b) { spend(context); [a, b] = [b, a % b]; }
  return { n: n / a, d: d / a };
}

function addRational(a, b, context) {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d, context);
}

function multiplyRational(a, b, context) {
  return rational(a.n * b.n, a.d * b.d, context);
}

const keyFor = powers => powers.map(([name, exponent]) => `${name}^${exponent}`).join('*');
const constant = coefficient => coefficient.n === 0n ? new Map()
  : new Map([['', { powers: [], degree: 0, coefficient }]]);
const one = () => constant({ n: 1n, d: 1n });

function putTerm(polynomial, powers, coefficient, context) {
  spend(context);
  const key = keyFor(powers), old = polynomial.get(key);
  if (old) coefficient = addRational(old.coefficient, coefficient, context);
  if (coefficient.n === 0n) { polynomial.delete(key); return; }
  const degree = powers.reduce((sum, [, exponent]) => sum + exponent, 0);
  if (degree > LIMITS.degree) fail('Polynomial exceeds the total degree limit.');
  polynomial.set(key, { powers, degree, coefficient });
  if (polynomial.size > LIMITS.terms) fail('Polynomial expansion exceeds the term limit.');
}

function add(a, b, context, sign = 1n) {
  const result = new Map(a);
  for (const term of b.values()) {
    putTerm(result, term.powers, { n: sign * term.coefficient.n, d: term.coefficient.d }, context);
  }
  return result;
}

function multiply(a, b, context) {
  const result = new Map();
  for (const left of a.values()) for (const right of b.values()) {
    const powers = new Map(left.powers);
    for (const [name, exponent] of right.powers) powers.set(name, (powers.get(name) || 0) + exponent);
    putTerm(result, [...powers].sort(([x], [y]) => compare(x, y)),
      multiplyRational(left.coefficient, right.coefficient, context), context);
  }
  return result;
}

function asConstant(polynomial) {
  if (polynomial.size === 0) return { n: 0n, d: 1n };
  if (polynomial.size === 1 && polynomial.has('')) return polynomial.get('').coefficient;
  return null;
}

function divide(numerator, denominator, context) {
  const value = asConstant(denominator);
  if (!value) fail('Variable-dependent denominators are not checked; use polynomial expressions.');
  if (value.n === 0n) fail('Division by zero is undefined.');
  const reciprocal = rational(value.d, value.n, context);
  return multiply(numerator, constant(reciprocal), context);
}

function format(polynomial) {
  if (polynomial.size === 0) return '0';
  const terms = [...polynomial.entries()].sort(([a, x], [b, y]) => y.degree - x.degree || compare(a, b));
  return terms.map(([, { powers, coefficient }], index) => {
    const magnitude = absolute(coefficient.n);
    const number = coefficient.d === 1n ? String(magnitude) : `${magnitude}/${coefficient.d}`;
    const variables = powers.map(([name, exponent]) => exponent === 1 ? name : `${name}^${exponent}`).join('*');
    const body = variables ? `${magnitude === 1n && coefficient.d === 1n ? '' : number + '*'}${variables}` : number;
    return (index === 0 ? coefficient.n < 0n ? '-' : '' : coefficient.n < 0n ? ' - ' : ' + ') + body;
  }).join('');
}

function power(base, exponent, context) {
  const value = asConstant(exponent);
  if (!value || value.d !== 1n) fail('Powers require a constant integer exponent.');
  if (absolute(value.n) > BigInt(LIMITS.exponent)) fail('Power exceeds the integer exponent limit.');
  if (value.n === 0n) {
    const number = asConstant(base);
    if (number?.n === 0n) fail('Zero to the zero power is undefined.');
    if (!number) context.assumptions.add(`(${format(base)}) != 0 (required for the zero power).`);
    return one();
  }
  if (value.n < 0n) {
    if (!asConstant(base)) fail('Negative powers of variable expressions are not checked.');
    base = divide(one(), base, context);
  }
  let result = one();
  for (let i = 0; i < Number(absolute(value.n)); i++) result = multiply(result, base, context);
  return result;
}

function tokenize(input) {
  if (typeof input !== 'string' || !input.trim()) fail('Enter a nonempty expression as text.');
  if (input.length > LIMITS.length) fail('Expression exceeds the input length limit.');
  const tokens = [];
  let position = 0;
  while (position < input.length) {
    const remaining = input.slice(position);
    const whitespace = /^\s+/.exec(remaining);
    if (whitespace) { position += whitespace[0].length; continue; }
    const number = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(remaining);
    const identifier = /^[A-Za-z][A-Za-z0-9_]*/.exec(remaining);
    let token;
    if (number) token = { type: 'number', value: number[0] };
    else if (identifier) {
      if (identifier[0].length > LIMITS.identifier) fail('Variable name exceeds the identifier length limit.');
      if (['NaN', 'Infinity'].includes(identifier[0])) fail('Nonfinite numeric values are not checked.');
      token = { type: 'variable', value: identifier[0] };
    } else if ('+-*/^()'.includes(remaining[0])) token = { type: remaining[0], value: remaining[0] };
    else fail(`Unsupported symbol at position ${position + 1}.`);
    tokens.push(token);
    if (tokens.length > LIMITS.tokens) fail('Expression exceeds the token limit.');
    position += token.value.length;
  }
  tokens.push({ type: 'end' });
  return tokens;
}

function decimal(text, context) {
  const [mantissa, scientific = '0'] = text.toLowerCase().split('e');
  const digits = mantissa.replace('.', '');
  if (digits.length > LIMITS.digits) fail('Number exceeds the decimal digit limit.');
  if (scientific.length > 3 || !Number.isInteger(Number(scientific)) || Math.abs(Number(scientific)) > 24) {
    fail('Scientific exponent exceeds the decimal scale limit.');
  }
  const fractionDigits = mantissa.includes('.') ? mantissa.length - mantissa.indexOf('.') - 1 : 0;
  const scale = fractionDigits - Number(scientific);
  return rational(BigInt(digits) * (scale < 0 ? 10n ** BigInt(-scale) : 1n),
    scale > 0 ? 10n ** BigInt(scale) : 1n, context);
}

class Parser {
  constructor(input, context) { this.tokens = tokenize(input); this.index = 0; this.depth = 0; this.context = context; }
  current() { return this.tokens[this.index]; }
  take(type) {
    if (this.current().type !== type) return false;
    this.index++;
    return true;
  }
  nested(callback) {
    if (++this.depth > LIMITS.depth) fail('Expression exceeds the nesting limit.');
    try { return callback(); } finally { this.depth--; }
  }
  parse() {
    const result = this.sum();
    if (this.current().type !== 'end') fail('Malformed expression: unexpected token.');
    return result;
  }
  sum() {
    let result = this.product();
    while (['+', '-'].includes(this.current().type)) {
      const sign = this.current().type === '+' ? 1n : -1n;
      this.index++;
      result = add(result, this.product(), this.context, sign);
    }
    return result;
  }
  product() {
    let result = this.unary();
    while (true) {
      if (this.take('*')) result = multiply(result, this.unary(), this.context);
      else if (this.take('/')) result = divide(result, this.unary(), this.context);
      else if (['number', 'variable', '('].includes(this.current().type)) {
        if (this.current().type === 'number' && this.tokens[this.index - 1].type === 'number') {
          fail('Adjacent numbers require an explicit multiplication sign.');
        }
        result = multiply(result, this.unary(), this.context);
      } else break;
    }
    return result;
  }
  unary() {
    if (this.take('+')) return this.nested(() => this.unary());
    if (this.take('-')) return multiply(constant({ n: -1n, d: 1n }), this.nested(() => this.unary()), this.context);
    return this.exponent();
  }
  exponent() {
    const base = this.primary();
    return this.take('^') ? power(base, this.nested(() => this.unary()), this.context) : base;
  }
  primary() {
    const token = this.current();
    if (this.take('number')) return constant(decimal(token.value, this.context));
    if (this.take('variable')) {
      if (token.value.length > 1 && this.current().type === '(') {
        fail('Function calls are not checked; write explicit * for a multi-letter variable product.');
      }
      this.context.variables.add(token.value);
      if (this.context.variables.size > LIMITS.variables) fail('Expression exceeds the variable count limit.');
      const powers = [[token.value, 1]];
      return new Map([[keyFor(powers), { powers, degree: 1, coefficient: { n: 1n, d: 1n } }]]);
    }
    if (this.take('(')) {
      const result = this.nested(() => this.sum());
      if (!this.take(')')) fail('Malformed expression: missing closing parenthesis.');
      return result;
    }
    fail('Malformed expression: expected a number, variable, or parenthesis.');
  }
}

/** Compare exact polynomials; "disproved" means not an identity, not never equal. */
export function proveIdentity(left, right) {
  const context = { work: 0, variables: new Set(), assumptions: new Set() };
  try {
    const leftPolynomial = new Parser(left, context).parse();
    const rightPolynomial = new Parser(right, context).parse();
    const normalizedLeft = format(leftPolynomial), normalizedRight = format(rightPolynomial);
    const proved = normalizedLeft === normalizedRight;
    return {
      status: proved ? 'proved' : 'disproved', left: normalizedLeft, right: normalizedRight,
      steps: [
        'Convert each finite decimal to an exact rational coefficient; no floating-point sampling is used.',
        'Expand bounded integer powers and products, then collect like monomials using exact rational arithmetic.',
        `Left canonical polynomial: ${normalizedLeft}.`,
        `Right canonical polynomial: ${normalizedRight}.`,
        proved ? 'All corresponding monomial coefficients match exactly, proving the identity under the stated assumptions.'
          : 'At least one monomial coefficient differs, so these expressions are not a polynomial identity.',
      ],
      assumptions: [
        'Identifiers are independent commuting real variables; names such as xy denote one variable, not x*y.',
        'Finite decimal coefficients are treated as exact values, not measurements or rounded approximations.',
        ...context.assumptions,
      ],
      ...(proved ? {} : { reason: 'Distinct canonical polynomials are not an identity; they may agree at particular values.' }),
    };
  } catch (error) {
    if (!(error instanceof Unchecked)) throw error;
    return { status: 'not_checked', reason: error.message };
  }
}
