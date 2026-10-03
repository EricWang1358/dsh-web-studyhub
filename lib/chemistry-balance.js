/** Exact, bounded atom conservation for neutral ASCII formulas. No feasibility or ionic/redox proof. */
const ELEMENTS = new Set(('H He Li Be B C N O F Ne Na Mg Al Si P S Cl Ar K Ca Sc Ti V Cr Mn Fe Co Ni Cu Zn '
  + 'Ga Ge As Se Br Kr Rb Sr Y Zr Nb Mo Tc Ru Rh Pd Ag Cd In Sn Sb Te I Xe Cs Ba La Ce Pr Nd Pm Sm Eu '
  + 'Gd Tb Dy Ho Er Tm Yb Lu Hf Ta W Re Os Ir Pt Au Hg Tl Pb Bi Po At Rn Fr Ra Ac Th Pa U Np Pu Am Cm '
  + 'Bk Cf Es Fm Md No Lr Rf Db Sg Bh Hs Mt Ds Rg Cn Nh Fl Mc Lv Ts Og').split(' '));
const LIMIT = { characters: 512, species: 12, elements: 16, formulaCharacters: 128, tokens: 128,
  depth: 8, subscript: 1000, atoms: 1_000_000, coefficient: 10_000, bits: 128, operations: 20_000 };
const ZERO = { n: 0n, d: 1n }, ONE = { n: 1n, d: 1n };
class Unsupported extends Error {}
class Impossible extends Error {}
const unsupported = reason => { throw new Unsupported(reason); };
const impossible = reason => { throw new Impossible(reason); };
const abs = value => value < 0n ? -value : value;

function parseFormula(formula, budget) {
  if (!formula || formula.length > LIMIT.formulaCharacters) unsupported('Formula length limit or missing formula');
  let at = 0;
  const token = () => {
    if (++budget.tokens > LIMIT.tokens) unsupported('Formula token limit exceeded');
  };
  const multiplier = () => {
    const digits = /^\d+/.exec(formula.slice(at))?.[0];
    if (!digits) return 1;
    if (digits[0] === '0' || digits.length > 4 || Number(digits) > LIMIT.subscript)
      unsupported('Subscripts must be positive integers from 1 to 1000 without leading zeros');
    at += digits.length;
    return Number(digits);
  };
  const addAtoms = (into, element, count) => {
    const total = (into.get(element) || 0) + count;
    if (!Number.isSafeInteger(total) || total > LIMIT.atoms) unsupported('Per-element atom count limit exceeded');
    into.set(element, total);
  };
  const group = depth => {
    const counts = new Map();
    while (at < formula.length && formula[at] !== ')') {
      token();
      if (formula[at] === '(') {
        if (depth >= LIMIT.depth) unsupported('Parenthesis depth limit exceeded');
        at++;
        const inside = group(depth + 1);
        if (formula[at] !== ')' || !inside.size) unsupported('Unmatched or empty parentheses');
        at++;
        const factor = multiplier();
        for (const [element, count] of inside) addAtoms(counts, element, count * factor);
      } else {
        const symbol = /^[A-Z][a-z]?/.exec(formula.slice(at))?.[0];
        if (!symbol || !ELEMENTS.has(symbol)) unsupported('Unknown element or unsupported formula syntax');
        at += symbol.length;
        addAtoms(counts, symbol, multiplier());
      }
    }
    return counts;
  };
  const atoms = group(0);
  if (at !== formula.length || !atoms.size) unsupported('Unmatched parentheses or empty formula');
  return atoms;
}

function parseEquation(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > LIMIT.characters)
    unsupported('Provide an ASCII equation of at most 512 characters');
  if (/[^\x20-\x7e\t\r\n]/.test(input)) unsupported('Only ASCII formulas and the -> arrow are supported');
  let text = input.trim();
  if (text.startsWith('\\ce')) {
    const wrapper = /^\\ce\{([^{}]*)\}$/.exec(text);
    if (!wrapper) unsupported('Only a single outer \\ce{...} wrapper without nested braces is supported');
    text = wrapper[1].trim();
  }
  const sides = text.split('->');
  if (sides.length !== 2 || sides.some(side => !side.trim())) unsupported('Use one -> arrow with species on both sides');
  const left = sides[0].split('+'), right = sides[1].split('+');
  if (left.length + right.length > LIMIT.species) unsupported('At most 12 total species are supported');
  const budget = { tokens: 0 }, elements = new Set();
  const species = [...left, ...right].map((raw, index) => {
    let formula = raw.trim(), phase = '';
    if (/^\d/.test(formula)) {
      const prefix = /^([1-9]\d*)\s*/.exec(formula);
      if (!prefix || prefix[1].length > 5 || Number(prefix[1]) > LIMIT.coefficient)
        unsupported('Entered coefficients must be positive integers at most 10000 without leading zeros');
      formula = formula.slice(prefix[0].length);
    }
    const suffix = /\s*\((s|l|g|aq)\)$/.exec(formula);
    if (suffix) { phase = `(${suffix[1]})`; formula = formula.slice(0, suffix.index).trim(); }
    const atoms = parseFormula(formula, budget);
    for (const element of atoms.keys()) elements.add(element);
    if (elements.size > LIMIT.elements) unsupported('At most 16 distinct elements are supported');
    return { formula, phase, atoms, left: index < left.length };
  });
  return { species, elements: [...elements], leftCount: left.length };
}

/** Rational operations reduce exactly and bound every integer intermediate, including products. */
function rationalMath() {
  let operations = 0;
  const tick = () => {
    if (++operations > LIMIT.operations) unsupported('Exact arithmetic operation limit exceeded');
  };
  const integer = value => {
    if (abs(value).toString(2).length > LIMIT.bits) unsupported('Exact arithmetic integer size limit exceeded');
    return value;
  };
  const gcd = (a, b) => {
    a = abs(a); b = abs(b);
    while (b !== 0n) { tick(); const remainder = a % b; a = b; b = remainder; }
    return a;
  };
  const fraction = (n, d = 1n) => {
    integer(n); integer(d);
    if (d === 0n) unsupported('Undefined exact arithmetic');
    if (n === 0n) return ZERO;
    if (d < 0n) { n = -n; d = -d; }
    const divisor = gcd(n, d);
    return { n: n / divisor, d: d / divisor };
  };
  const add = (a, b) => {
    tick();
    return fraction(integer(integer(a.n * b.d) + integer(b.n * a.d)), integer(a.d * b.d));
  };
  const multiply = (a, b) => {
    tick(); return fraction(integer(a.n * b.n), integer(a.d * b.d));
  };
  const divide = (a, b) => {
    tick(); return fraction(integer(a.n * b.d), integer(a.d * b.n));
  };
  const negate = a => ({ n: -a.n, d: a.d });
  const subtract = (a, b) => add(a, negate(b));
  const lcm = (a, b) => { tick(); return integer(a / gcd(a, b) * b); };
  return { tick, integer, gcd, fraction, subtract, multiply, divide, negate, lcm };
}

function uniqueBalance(species, elements, math) {
  const matrix = elements.map(element => species.map(item => math.fraction(BigInt(item.atoms.get(element) || 0) * (item.left ? 1n : -1n))));
  const pivots = [];
  let nextRow = 0;
  for (let col = 0; col < species.length && nextRow < matrix.length; col++) {
    const pivot = matrix.findIndex((row, index) => index >= nextRow && row[col].n !== 0n);
    if (pivot < 0) continue;
    [matrix[nextRow], matrix[pivot]] = [matrix[pivot], matrix[nextRow]];
    const divisor = matrix[nextRow][col];
    for (let j = col; j < species.length; j++) matrix[nextRow][j] = math.divide(matrix[nextRow][j], divisor);
    for (let row = 0; row < matrix.length; row++) {
      if (row === nextRow || matrix[row][col].n === 0n) continue;
      const factor = matrix[row][col];
      for (let j = col; j < species.length; j++)
        matrix[row][j] = math.subtract(matrix[row][j], math.multiply(factor, matrix[nextRow][j]));
    }
    pivots.push(col); nextRow++;
  }
  const freedom = species.length - pivots.length;
  if (freedom === 0) impossible('There is no nonzero atom-conserving balance for these species');
  if (freedom !== 1) unsupported('Ambiguous balance: atom conservation does not specify a unique coefficient ratio');
  const pivotSet = new Set(pivots), free = species.findIndex((_, index) => !pivotSet.has(index));
  const vector = species.map(() => ZERO);
  vector[free] = ONE;
  pivots.forEach((col, row) => { vector[col] = math.negate(matrix[row][free]); });
  if (vector.some(value => value.n <= 0n)) impossible('These species have no all-positive atom-conserving balance as written');
  const denominator = vector.reduce((value, fraction) => math.lcm(value, fraction.d), 1n);
  let coefficients = vector.map(fraction => { math.tick(); return math.integer(fraction.n * (denominator / fraction.d)); });
  const divisor = coefficients.reduce((value, coefficient) => math.gcd(value, coefficient), coefficients[0]);
  coefficients = coefficients.map(value => value / divisor);
  if (coefficients.some(value => value > BigInt(LIMIT.coefficient))) unsupported('Minimal coefficient limit exceeded (10000)');
  return coefficients;
}

/**
 * balanced means the returned equation conserves atoms; it does not mean the entered equation was balanced.
 * No model calls, JavaScript evaluation, interpreter, approximate search, DOM, or Node APIs are used.
 */
export function balanceEquation(input) {
  try {
    const { species, elements, leftCount } = parseEquation(input), math = rationalMath();
    const exact = uniqueBalance(species, elements, math);
    const conservation = elements.map(element => {
      let reactants = 0n, products = 0n;
      species.forEach((item, index) => {
        const count = BigInt(item.atoms.get(element) || 0) * exact[index];
        if (item.left) reactants += count;
        else products += count;
      });
      if (reactants !== products) throw new Error('Internal atom-conservation invariant failed');
      // Explicit atom/species/coefficient bounds make these totals safe integers.
      return { element, reactants: Number(reactants), products: Number(products) };
    });
    const coefficients = exact.map(Number);
    const terms = species.map((item, index) => `${coefficients[index] === 1 ? '' : coefficients[index] + ' '}${item.formula}${item.phase}`);
    return { status: 'balanced', equation: terms.slice(0, leftCount).join(' + ') + ' -> ' + terms.slice(leftCount).join(' + '),
      coefficients, conservation, reason: 'Atom counts conserved for the supplied neutral formulas; reaction feasibility and charge/redox chemistry were not checked' };
  } catch (error) {
    if (error instanceof Unsupported) return { status: 'not_checked', reason: error.message };
    if (error instanceof Impossible) return { status: 'not_balanced', reason: error.message };
    throw error;
  }
}
