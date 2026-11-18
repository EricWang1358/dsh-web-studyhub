/* Pure, safe mathematical expression parser and deterministic evaluator for cross-discipline
   parametric `sandbox` blocks (calculus, mechanics, control systems, physics, economics).
   Zero eval() or Function(): expressions compile to a small AST evaluated over bounded numbers. */

const CONSTANTS = Object.freeze({
  pi: Math.PI,
  PI: Math.PI,
  e: Math.E,
  E: Math.E,
  tau: Math.PI * 2,
});

function approxErf(x) {
  const s = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

const FUNCTIONS = Object.freeze({
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  sec: v => 1 / Math.cos(v),
  csc: v => 1 / Math.sin(v),
  cot: v => Math.cos(v) / Math.sin(v),
  asin: Math.asin,
  acos: Math.acos,
  atan: Math.atan,
  atan2: Math.atan2,
  sinh: Math.sinh,
  cosh: Math.cosh,
  tanh: Math.tanh,
  exp: Math.exp,
  ln: Math.log,
  log: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sqrt: v => (v < 0 ? NaN : Math.sqrt(v)),
  cbrt: Math.cbrt,
  hypot: Math.hypot,
  abs: Math.abs,
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  sign: Math.sign,
  sgn: Math.sign,
  min: Math.min,
  max: Math.max,
  pow: Math.pow,
  mod: (a, b) => (b === 0 ? NaN : ((a % b) + b) % b),
  deg: v => (v * 180) / Math.PI,
  rad: v => (v * Math.PI) / 180,
  clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
  lerp: (a, b, t) => a + (b - a) * t,
  step: (v, edge = 0) => (v >= edge ? 1 : 0),
  heaviside: (v, edge = 0) => (v >= edge ? 1 : 0),
  ramp: (v, edge = 0) => (v >= edge ? v - edge : 0),
  rect: (v, width = 1) => (Math.abs(v) <= width / 2 ? 1 : 0),
  sinc: v => (Math.abs(v) < 1e-9 ? 1 : Math.sin(v) / v),
  sigmoid: v => 1 / (1 + Math.exp(-v)),
  erf: approxErf,
  normpdf: v => Math.exp(-0.5 * v * v) / Math.sqrt(2 * Math.PI),
  normcdf: v => 0.5 * (1 + approxErf(v / Math.SQRT2)),
});

export const MAX_EXPR_LENGTH = 400;

export function tokenizeMath(source) {
  const text = String(source ?? '').trim();
  if (!text) throw new Error('Empty mathematical expression');
  if (text.length > MAX_EXPR_LENGTH) throw new Error(`Expression exceeds ${MAX_EXPR_LENGTH} characters`);
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const start = i;
      while (i < text.length && /[0-9.]/.test(text[i])) i++;
      if (i < text.length && /[eE]/.test(text[i]) && /[0-9+-]/.test(text[i + 1] || '')) {
        i++;
        if (/[+-]/.test(text[i])) i++;
        while (i < text.length && /[0-9]/.test(text[i])) i++;
      }
      const value = Number(text.slice(start, i));
      if (!Number.isFinite(value)) throw new Error(`Invalid number literal: ${text.slice(start, i)}`);
      tokens.push({ kind: 'num', value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_]/.test(text[i])) i++;
      const name = text.slice(start, i);
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        throw new Error(`Forbidden identifier: ${name}`);
      }
      tokens.push({ kind: 'id', name });
      continue;
    }
    if (text.slice(i, i + 2) === '**') {
      tokens.push({ kind: 'op', op: '^' });
      i += 2;
      continue;
    }
    if ('+-*/^(),'.includes(ch)) {
      tokens.push({ kind: '(),'.includes(ch) ? ch : 'op', op: ch });
      i++;
      continue;
    }
    throw new Error(`Unexpected character "${ch}" in expression "${text}"`);
  }
  return tokens;
}

export function parseMathAst(source) {
  const tokens = tokenizeMath(source);
  let pos = 0;
  const peek = () => tokens[pos] || null;
  const take = () => tokens[pos++] || null;

  function parseAdd() {
    let left = parseMul();
    while (peek()?.kind === 'op' && (peek().op === '+' || peek().op === '-')) {
      const { op } = take();
      left = { t: 'bin', op, l: left, r: parseMul() };
    }
    return left;
  }

  function parseMul() {
    let left = parseUnary();
    while (peek()?.kind === 'op' && (peek().op === '*' || peek().op === '/')) {
      const { op } = take();
      left = { t: 'bin', op, l: left, r: parseUnary() };
    }
    return left;
  }

  function parseUnary() {
    if (peek()?.kind === 'op' && (peek().op === '+' || peek().op === '-')) {
      const { op } = take();
      const arg = parseUnary();
      return op === '-' ? { t: 'neg', a: arg } : arg;
    }
    return parsePow();
  }

  function parsePow() {
    const base = parsePrimary();
    if (peek()?.kind === 'op' && peek().op === '^') {
      take();
      return { t: 'bin', op: '^', l: base, r: parseUnary() };
    }
    return base;
  }

  function parsePrimary() {
    const tok = take();
    if (!tok) throw new Error('Unexpected end of mathematical expression');
    if (tok.kind === 'num') return { t: 'num', v: tok.value };
    if (tok.kind === '(') {
      const inner = parseAdd();
      if (take()?.kind !== ')') throw new Error('Unclosed parenthesis in expression');
      return inner;
    }
    if (tok.kind === 'id') {
      if (peek()?.kind === '(') {
        if (!Object.hasOwn(FUNCTIONS, tok.name)) throw new Error(`Unsupported math function: ${tok.name}`);
        take();
        const args = [];
        if (peek()?.kind !== ')') {
          args.push(parseAdd());
          while (peek()?.kind === ',') { take(); args.push(parseAdd()); }
        }
        if (take()?.kind !== ')') throw new Error(`Unclosed call to ${tok.name}(...)`);
        return { t: 'call', fn: tok.name, args };
      }
      if (Object.hasOwn(CONSTANTS, tok.name)) return { t: 'num', v: CONSTANTS[tok.name] };
      return { t: 'var', name: tok.name };
    }
    throw new Error(`Unexpected token "${tok.op || tok.kind}"`);
  }

  const ast = parseAdd();
  if (pos < tokens.length) throw new Error(`Unexpected trailing token "${tokens[pos].op || tokens[pos].name || tokens[pos].kind}"`);
  return ast;
}

export function evalMathAst(node, vars = {}) {
  switch (node.t) {
    case 'num': return node.v;
    case 'var': {
      if (!Object.hasOwn(vars, node.name)) return NaN;
      return Number(vars[node.name]);
    }
    case 'neg': return -evalMathAst(node.a, vars);
    case 'bin': {
      const l = evalMathAst(node.l, vars);
      const r = evalMathAst(node.r, vars);
      if (node.op === '+') return l + r;
      if (node.op === '-') return l - r;
      if (node.op === '*') return l * r;
      if (node.op === '/') return r === 0 ? NaN : l / r;
      if (node.op === '^') return Math.pow(l, r);
      return NaN;
    }
    case 'call': {
      const fn = FUNCTIONS[node.fn];
      if (!fn) return NaN;
      const evaluated = node.args.map(arg => evalMathAst(arg, vars));
      return fn(...evaluated);
    }
    default:
      return NaN;
  }
}

export function compileMathExpression(source) {
  const ast = parseMathAst(source);
  return {
    ast,
    evaluate: vars => evalMathAst(ast, vars),
  };
}

/** Sample a parametric sandbox specification to verify finite outputs and precompute initial bounds. */
export function evaluateSandboxPreview(block) {
  const knobs = Array.isArray(block?.knobs) ? block.knobs : [];
  const defaults = {};
  for (const knob of knobs) {
    const val = Number(knob?.default ?? knob?.min ?? 0);
    defaults[knob.id] = Number.isFinite(val) ? val : 0;
  }
  const domain = block?.domain || {};
  const xVar = typeof domain.variable === 'string' && domain.variable.trim() ? domain.variable.trim() : 'x';
  const min = Number.isFinite(Number(domain.min)) ? Number(domain.min) : 0;
  const max = Number.isFinite(Number(domain.max)) && Number(domain.max) > min ? Number(domain.max) : min + 10;
  const steps = Math.max(16, Math.min(240, Math.floor(Number(domain.steps) || 80)));

  const series = (Array.isArray(block?.series) ? block.series : []).map(item => {
    const isParametric = typeof item?.xExpr === 'string' && item.xExpr.trim().length > 0
      || typeof item?.yExpr === 'string' && item.yExpr.trim().length > 0;
    if (isParametric) {
      const xCompiled = compileMathExpression(item.xExpr);
      const yCompiled = compileMathExpression(item.yExpr);
      const points = [];
      let finiteCount = 0;
      for (let i = 0; i <= steps; i++) {
        const u = min + ((max - min) * i) / steps;
        const env = { ...defaults, [xVar]: u };
        const px = xCompiled.evaluate(env);
        const py = yCompiled.evaluate(env);
        if (Number.isFinite(px) && Number.isFinite(py)) {
          finiteCount++;
          points.push([Number(px.toFixed(6)), Number(py.toFixed(6))]);
        } else {
          points.push([null, null]);
        }
      }
      if (finiteCount < Math.ceil(steps * 0.25)) {
        throw new Error(`Sandbox parametric series "${item.label || item.id}" produced fewer than 25% finite (x, y) points on [${min}, ${max}]`);
      }
      return { id: item.id, label: item.label, parametric: true, xAst: xCompiled.ast, yAst: yCompiled.ast, samplePoints: points };
    }

    const compiled = compileMathExpression(item?.expr);
    const points = [];
    let finiteCount = 0;
    for (let i = 0; i <= steps; i++) {
      const x = min + ((max - min) * i) / steps;
      const y = compiled.evaluate({ ...defaults, [xVar]: x });
      if (Number.isFinite(y)) {
        finiteCount++;
        points.push([Number(x.toFixed(6)), Number(y.toFixed(6))]);
      } else {
        points.push([Number(x.toFixed(6)), null]);
      }
    }
    if (finiteCount < Math.ceil(steps * 0.25)) {
      throw new Error(`Sandbox series "${item.label || item.id}" produced fewer than 25% finite points on [${min}, ${max}]`);
    }
    return { id: item.id, label: item.label, parametric: false, ast: compiled.ast, samplePoints: points };
  });

  let field = null;
  if (block?.field && typeof block.field === 'object' && !Array.isArray(block.field)) {
    const rawF = block.field;
    const fxMin = Number(rawF.xMin);
    const fxMax = Number(rawF.xMax);
    const fyMin = Number(rawF.yMin);
    const fyMax = Number(rawF.yMax);
    if (!Number.isFinite(fxMin) || !Number.isFinite(fxMax) || fxMax <= fxMin) {
      throw new Error('Sandbox field requires finite xMin < xMax');
    }
    if (!Number.isFinite(fyMin) || !Number.isFinite(fyMax) || fyMax <= fyMin) {
      throw new Error('Sandbox field requires finite yMin < yMax');
    }
    const grid = Math.max(4, Math.min(24, Math.round(Number(rawF.grid) || 12)));
    const fxVar = typeof rawF.xVar === 'string' && rawF.xVar.trim() ? rawF.xVar.trim() : 'x';
    const fyVar = typeof rawF.yVar === 'string' && rawF.yVar.trim() ? rawF.yVar.trim() : 'y';
    const dxCompiled = compileMathExpression(rawF.dxExpr);
    const dyCompiled = compileMathExpression(rawF.dyExpr);
    let finiteVecs = 0;
    const midU = (min + max) / 2;
    for (let ix = 0; ix < grid; ix++) {
      const gx = fxMin + ((ix + 0.5) / grid) * (fxMax - fxMin);
      for (let iy = 0; iy < grid; iy++) {
        const gy = fyMin + ((iy + 0.5) / grid) * (fyMax - fyMin);
        const env = { ...defaults, [xVar]: midU, x: gx, y: gy, [fxVar]: gx, [fyVar]: gy };
        const dx = dxCompiled.evaluate(env);
        const dy = dyCompiled.evaluate(env);
        if (Number.isFinite(dx) && Number.isFinite(dy)) finiteVecs++;
      }
    }
    if (finiteVecs < Math.ceil((grid * grid) * 0.25)) {
      throw new Error('Sandbox field produced fewer than 25% finite vectors across [xMin..xMax, yMin..yMax]');
    }
    field = { xMin: fxMin, xMax: fxMax, yMin: fyMin, yMax: fyMax, grid, xVar: fxVar, yVar: fyVar, dxAst: dxCompiled.ast, dyAst: dyCompiled.ast };
  }

  const markers = (Array.isArray(block?.markers) ? block.markers : []).map((m, idx) => {
    const xCompiled = compileMathExpression(m?.xExpr);
    const yCompiled = compileMathExpression(m?.yExpr);
    const env = { ...defaults, [xVar]: (min + max) / 2 };
    const mx = xCompiled.evaluate(env);
    const my = yCompiled.evaluate(env);
    if (!Number.isFinite(mx) || !Number.isFinite(my)) {
      throw new Error(`Sandbox marker "${m?.label || idx}" evaluated to non-finite coordinates at default knob settings`);
    }
    return {
      id: m.id || `marker-${idx}`,
      label: m.label || '',
      xAst: xCompiled.ast,
      yAst: yCompiled.ast,
      initial: [Number(mx.toFixed(4)), Number(my.toFixed(4))],
    };
  });

  const readouts = (Array.isArray(block?.readouts) ? block.readouts : []).map(item => {
    const compiled = compileMathExpression(item.expr);
    let value = compiled.evaluate({ ...defaults, [xVar]: (min + max) / 2 });
    if (!Number.isFinite(value)) {
      value = compiled.evaluate({ ...defaults, [xVar]: min + (max - min) * 0.6180339887 });
    }
    if (!Number.isFinite(value)) {
      throw new Error(`Sandbox readout "${item.label || item.id}" evaluated to non-finite value at default knob settings`);
    }
    return { id: item.id, label: item.label, unit: item.unit || '', ast: compiled.ast, initial: Number(value.toFixed(4)) };
  });

  return { defaults, domain: { variable: xVar, min, max, steps, label: domain.label || xVar, unit: domain.unit || '' }, series, field, markers, readouts };
}
