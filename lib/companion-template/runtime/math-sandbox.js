/* Safe AST math evaluator, function-plot-inspired adaptive 1D singularity/asymptote
   protection, and parametric sandbox block renderer for interactive companion lessons. */

function approxErf(x) {
  const s = x < 0 ? -1 : 1, ax = Math.abs(x), t = 1 / (1 + 0.3275911 * ax);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
  return s * y;
}

export const MATH_FN = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, sec: (v) => 1 / Math.cos(v), csc: (v) => 1 / Math.sin(v), cot: (v) => Math.cos(v) / Math.sin(v),
  asin: Math.asin, acos: Math.acos, atan: Math.atan, atan2: Math.atan2,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10, log2: Math.log2,
  sqrt: (v) => (v < 0 ? NaN : Math.sqrt(v)), cbrt: Math.cbrt, hypot: Math.hypot, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round, sign: Math.sign, sgn: Math.sign,
  min: Math.min, max: Math.max, pow: Math.pow, mod: (a, b) => (b === 0 ? NaN : ((a % b) + b) % b),
  deg: (v) => (v * 180) / Math.PI, rad: (v) => (v * Math.PI) / 180,
  clamp: (v, a, b) => Math.min(b, Math.max(a, v)), lerp: (a, b, t) => a + (b - a) * t,
  step: (v, e = 0) => (v >= e ? 1 : 0), heaviside: (v, e = 0) => (v >= e ? 1 : 0), ramp: (v, e = 0) => (v >= e ? v - e : 0), rect: (v, w = 1) => (Math.abs(v) <= w / 2 ? 1 : 0),
  sinc: (v) => (Math.abs(v) < 1e-9 ? 1 : Math.sin(v) / v), sigmoid: (v) => (v >= 0 ? 1 / (1 + Math.exp(-v)) : Math.exp(v) / (1 + Math.exp(v))),
  erf: approxErf, normpdf: (v) => Math.exp(-0.5 * v * v) / Math.sqrt(2 * Math.PI), normcdf: (v) => 0.5 * (1 + approxErf(v / Math.SQRT2)),
};

export function evalAst(node, vars) {
  if (!node) return NaN;
  if (node.t === "num") return node.v;
  if (node.t === "var") return Object.prototype.hasOwnProperty.call(vars, node.name) ? Number(vars[node.name]) : NaN;
  if (node.t === "neg") return -evalAst(node.a, vars);
  if (node.t === "bin") {
    const l = evalAst(node.l, vars), r = evalAst(node.r, vars);
    return node.op === "+" ? l + r : node.op === "-" ? l - r : node.op === "*" ? l * r : node.op === "/" ? (r === 0 ? NaN : l / r) : node.op === "^" ? Math.pow(l, r) : NaN;
  }
  if (node.t === "call" && Object.prototype.hasOwnProperty.call(MATH_FN, node.fn)) {
    return MATH_FN[node.fn](...node.args.map((a) => evalAst(a, vars)));
  }
  return NaN;
}

function localSlopeCheck(evalFn, a, ya, b, yb) {
  const dx = b - a;
  if (dx <= 1e-12) return { nonFinite: false, oppositeChord: false, opposingEnds: false, sL: 0, sR: 0 };
  const eps = dx * 0.0625;
  const yap = evalFn(a + eps);
  const ybm = evalFn(b - eps);
  if (!Number.isFinite(yap) || !Number.isFinite(ybm)) {
    return { nonFinite: true, oppositeChord: false, opposingEnds: false, sL: 0, sR: 0 };
  }
  const sL = (yap - ya) / eps;
  const sR = (yb - ybm) / eps;
  const sChord = (yb - ya) / dx;
  const oppositeChord = sL * sR > 0 && sL * sChord < 0;
  const opposingEnds = sL * sR < 0;
  return { nonFinite: false, oppositeChord, opposingEnds, sL, sR };
}

function probeSingularity(evalFn, a, ya, b, yb, yLo, yHi, ySpan, depth) {
  if ((ya > yHi && yb < yLo) || (ya < yLo && yb > yHi)) return true;
  const m = (a + b) * 0.5;
  const ym = evalFn(m);
  if (!Number.isFinite(ym)) return true;
  if ((ya > yHi && ym < yLo) || (ya < yLo && ym > yHi) || (ym > yHi && yb < yLo) || (ym < yLo && yb > yHi)) return true;

  const blowLimit = ySpan * 2.5;
  const outHi = ym > yHi + blowLimit;
  const outLo = ym < yLo - blowLimit;
  if ((outHi || outLo) && depth >= 3) {
    const endMax = Math.max(Math.abs(ya), Math.abs(yb));
    if (Math.abs(ym) > Math.max(endMax * 1.4, Math.max(Math.abs(yLo), Math.abs(yHi)) + ySpan * 2.5)) return true;
  }

  const dy = Math.abs(yb - ya);
  if (depth >= 5) {
    const slope = localSlopeCheck(evalFn, a, ya, b, yb);
    if (slope.nonFinite || slope.oppositeChord) return true;
    if (dy > ySpan * 0.16) {
      const yq1 = evalFn(a * 0.75 + b * 0.25);
      const yq3 = evalFn(a * 0.25 + b * 0.75);
      if (!Number.isFinite(yq1) || !Number.isFinite(yq3)) return true;
      const segLo = Math.min(ya, yb) - dy * 0.08, segHi = Math.max(ya, yb) + dy * 0.08;
      if (yq1 < segLo || yq1 > segHi || ym < segLo || ym > segHi || yq3 < segLo || yq3 > segHi) return true;
      const d1 = Math.abs(yq1 - ya), d2 = Math.abs(ym - yq1), d3 = Math.abs(yq3 - ym), d4 = Math.abs(yb - yq3);
      if (Math.max(d1, d2, d3, d4) >= dy * 0.78 && Math.min(d1, d2, d3, d4) <= dy * 0.06) return true;
    }
    return false;
  }

  const leftSlope = localSlopeCheck(evalFn, a, ya, m, ym);
  const rightSlope = localSlopeCheck(evalFn, m, ym, b, yb);
  if (leftSlope.nonFinite || rightSlope.nonFinite) return true;

  const leftJump = Math.abs(ym - ya);
  const rightJump = Math.abs(yb - ym);
  const checkLeft = leftSlope.oppositeChord || outHi || outLo || leftJump >= rightJump || leftJump > ySpan * 0.14;
  const checkRight = rightSlope.oppositeChord || outHi || outLo || rightJump >= leftJump || rightJump > ySpan * 0.14;

  if (checkLeft && probeSingularity(evalFn, a, ya, m, ym, yLo, yHi, ySpan, depth + 1)) return true;
  if (checkRight && probeSingularity(evalFn, m, ym, b, yb, yLo, yHi, ySpan, depth + 1)) return true;
  return false;
}

/**
 * Function-plot-inspired adaptive 1D singularity, asymptote, and jump-discontinuity detector.
 * Catches odd poles (`1/x`, `tan(x)` even with tiny residue), even poles (`1/x^2`),
 * and step/floor jumps while keeping smooth steep curves (`exp(-20x^2)`, `x^3`) unbroken.
 */
export function detectDiscontinuity1D(evalFn, x1, y1, x2, y2, yLo, yHi) {
  if (!Number.isFinite(y1) || !Number.isFinite(y2)) return true;
  if ((y1 > yHi && y2 < yLo) || (y1 < yLo && y2 > yHi)) return true;

  const ySpan = Math.max(1e-9, yHi - yLo);
  const dx = x2 - x1;
  if (dx <= 1e-12) return false;

  // Both endpoints above or below viewport: check whether an even-order pole separates them.
  if ((y1 > yHi && y2 > yHi) || (y1 < yLo && y2 < yLo)) {
    const ym = evalFn((x1 + x2) * 0.5);
    if (!Number.isFinite(ym)) return true;
    if ((y1 > yHi && ym < yLo) || (y1 < yLo && ym > yHi)) return true;
    if (Math.abs(ym) > Math.max(Math.abs(y1), Math.abs(y2)) * 1.4) return true;
    return false;
  }

  const dy = Math.abs(y2 - y1);
  const slope = localSlopeCheck(evalFn, x1, y1, x2, y2);
  if (slope.nonFinite) return true;

  // Trigger adaptive bisection when:
  // 1) Large vertical jump relative to viewport,
  // 2) Endpoint local slopes agree in sign while the chord runs opposite (odd vertical asymptote),
  // 3) Steep opposing slopes pointing toward an interior blow-up (even vertical asymptote).
  const steepOpposing = slope.opposingEnds && (Math.abs(slope.sL) * dx > ySpan * 0.25 && Math.abs(slope.sR) * dx > ySpan * 0.25);
  const needsProbe = dy > ySpan * 0.14 || slope.oppositeChord || steepOpposing;
  if (!needsProbe) return false;

  return probeSingularity(evalFn, x1, y1, x2, y2, yLo, yHi, ySpan, 0);
}

export function approachAsymptote1D(evalFn, xValid, yValid, xGap, yLo, yHi, px, pyCurve) {
  if (!Number.isFinite(yValid) || yValid < yLo || yValid > yHi) return null;
  let lo = xValid;
  let hi = xGap;
  let lastInside = null;
  let firstOutside = null;
  for (let k = 0; k < 8; k++) {
    const mid = (lo + hi) * 0.5;
    const my = evalFn(mid);
    if (!Number.isFinite(my)) {
      hi = mid;
      continue;
    }
    if (my < yLo || my > yHi) {
      firstOutside = [px(mid), pyCurve(my)];
      hi = mid;
    } else {
      lastInside = [px(mid), pyCurve(my)];
      lo = mid;
    }
  }
  return firstOutside || lastInside;
}

/**
 * Build SVG path commands for a 1D curve `y = evalFn(x)` with singularity break protection.
 * Returns `{ commands, segments, breaks, validScreenPts }` so callers and unit tests can inspect
 * exact disjoint segments and break counts without needing a live browser SVG engine.
 */
export function buildCurve1DPath(evalFn, { pts, yMin, yMax, px, pyCurve }) {
  const commands = [];
  const validScreenPts = [];
  let open = false;
  let prevPt = null;
  let prevNullX = null;
  let breaks = 0;
  let segments = 0;

  for (const p of pts) {
    if (p.x === null || p.y === null || !Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      if (open && prevPt && p.x !== null && Number.isFinite(p.x)) {
        const ext = approachAsymptote1D(evalFn, prevPt.x, prevPt.y, p.x, yMin, yMax, px, pyCurve);
        if (ext) commands.push("L" + ext[0].toFixed(1) + " " + ext[1].toFixed(1));
      }
      if (open) breaks++;
      open = false;
      prevPt = null;
      prevNullX = Number.isFinite(p.x) ? p.x : null;
      continue;
    }

    const sx = px(p.x);
    const sy = pyCurve(p.y);

    if (open && prevPt && detectDiscontinuity1D(evalFn, prevPt.x, prevPt.y, p.x, p.y, yMin, yMax)) {
      const extLeft = approachAsymptote1D(evalFn, prevPt.x, prevPt.y, p.x, yMin, yMax, px, pyCurve);
      if (extLeft) commands.push("L" + extLeft[0].toFixed(1) + " " + extLeft[1].toFixed(1));
      open = false;
      breaks++;
      const extRight = approachAsymptote1D(evalFn, p.x, p.y, prevPt.x, yMin, yMax, px, pyCurve);
      if (extRight) {
        commands.push("M" + extRight[0].toFixed(1) + " " + extRight[1].toFixed(1));
        segments++;
        open = true;
      }
    } else if (!open && prevNullX !== null) {
      const extRight = approachAsymptote1D(evalFn, p.x, p.y, prevNullX, yMin, yMax, px, pyCurve);
      if (extRight) {
        commands.push("M" + extRight[0].toFixed(1) + " " + extRight[1].toFixed(1));
        segments++;
        open = true;
      }
    }

    if (!open) segments++;
    commands.push((open ? "L" : "M") + sx.toFixed(1) + " " + sy.toFixed(1));
    if (p.y >= yMin && p.y <= yMax) validScreenPts.push([sx, sy]);
    open = true;
    prevPt = p;
    prevNullX = null;
  }

  return { commands, segments, breaks, validScreenPts };
}

export function registerSandboxBlock({ L, h, svgEl, T }) {
  let sboxSeq = 0;

  L.blocks.sandbox = (b) => {
    const comp = b._compiled || { domain: b.domain || { variable: "x", min: 0, max: 10, steps: 80, label: "x" }, series: [], markers: [], readouts: [] };
    const dom = comp.domain, domMin = dom.min, domMax = dom.max, domSpan = Math.max(1e-9, domMax - domMin);
    const fieldSpec = comp.field || null;
    const markersSpec = Array.isArray(comp.markers) ? comp.markers : [];
    const hasParametric = comp.series.some((s) => s.parametric);
    const allParametric = comp.series.length > 0 && comp.series.every((s) => s.parametric);
    const rawTh = b.threshold ?? b.target;
    const thresh = rawTh && typeof rawTh === "object" && Number.isFinite(Number(rawTh.value))
      ? { value: Number(rawTh.value), label: rawTh.label || "", band: Number.isFinite(Number(rawTh.band)) ? Math.max(0, Number(rawTh.band)) : 0 }
      : typeof rawTh === "number" && Number.isFinite(rawTh)
        ? { value: rawTh, label: "", band: 0 }
        : null;

    const state = {}, defaults = {}, knobEls = {};
    function setKnobValue(id, rawVal) {
      const entry = knobEls[id];
      if (!entry) return;
      const clamped = Math.min(entry.max, Math.max(entry.min, Number(rawVal)));
      const decimals = (String(entry.step).split(".")[1] || "").length;
      const cleanVal = Number(clamped.toFixed(Math.max(decimals, 4)));
      state[id] = cleanVal;
      entry.input.value = String(cleanVal);
      entry.valText.textContent = L.num(cleanVal) + (entry.unit ? " " + entry.unit : "");
    }

    const controls = (b.knobs || []).map((k) => {
      const min = Number(k.min ?? 0), max = Number(k.max ?? 10), step = Number(k.step ?? 0.1);
      const val = Number(k.default ?? min);
      state[k.id] = val;
      defaults[k.id] = val;
      const valText = h("b", { text: L.num(val) + (k.unit ? " " + k.unit : "") });
      const plainLabel = String(k.label || k.id).replace(/@@SHM_\d+@@/g, "").trim() || k.id;
      const input = h("input", {
        attr: { type: "range", min, max, step, value: val, "aria-label": plainLabel },
        on: {
          input() { setKnobValue(k.id, input.value); draw(); },
          change() { setKnobValue(k.id, input.value); draw(); },
          keydown(e) {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.stopPropagation();
              if (e.shiftKey) {
                e.preventDefault();
                const dir = e.key === "ArrowRight" || e.key === "ArrowUp" ? 1 : -1;
                setKnobValue(k.id, state[k.id] + dir * step * 5);
                draw();
              }
            }
          },
        },
      });
      const decBtn = h("button.sbox__step", { text: "−", attr: { type: "button", "aria-label": T.stepDown + plainLabel }, on: { click() { setKnobValue(k.id, state[k.id] - step); draw(); } } });
      const incBtn = h("button.sbox__step", { text: "+", attr: { type: "button", "aria-label": T.stepUp + plainLabel }, on: { click() { setKnobValue(k.id, state[k.id] + step); draw(); } } });
      knobEls[k.id] = { input, valText, min, max, step, unit: k.unit || "" };
      return h("div.sbox__knob", null, h("div.sbox__khead", null, h("span", null, L.md(k.label)), valText), h("div.sbox__krow", null, decBtn, input, incBtn));
    });

    const presets = Array.isArray(b.presets)
      ? b.presets.filter((p) => p && String(p.label || "").trim().length > 0 && p.values && typeof p.values === "object" && !Array.isArray(p.values) && Object.keys(p.values).length > 0)
      : [];
    const presetBtns = presets.map((p) => h("button.sbox__preset", {
      attr: { type: "button", "aria-pressed": "false" },
      on: { click() { for (const [id, val] of Object.entries(p.values)) setKnobValue(id, val); draw(); } },
    }, L.md(p.label)));
    const resetBtn = controls.length
      ? h("button.btn.btn--quiet.sbox__reset", {
          text: T.reset,
          attr: { type: "button", disabled: "" },
          on: { click() { for (const [id, val] of Object.entries(defaults)) setKnobValue(id, val); draw(); } },
        })
      : null;
    const toolbar = (presetBtns.length || resetBtn)
      ? h("div.sbox__toolbar" + (presetBtns.length ? "" : ".sbox__toolbar--solo"), null,
          presetBtns.length ? h("div.sbox__presets", null, presetBtns) : null,
          resetBtn)
      : null;

    const W = 540, H = 264, Lp = 50, Rp = 18, Tp = 16, Bp = 32, pw = W - Lp - Rp, ph = H - Tp - Bp;
    const clipId = "sbox-clip-" + (sboxSeq++);
    const defs = svgEl("defs", null, svgEl("clipPath", { id: clipId }, svgEl("rect", { x: Lp, y: Tp, width: pw, height: ph })));
    const plotLayer = svgEl("g");
    const crossLine = svgEl("line", { class: "sbox__cross-line", y1: Tp, y2: Tp + ph, x1: Lp, x2: Lp });
    const crossDots = comp.series.map((_, idx) => svgEl("circle", { class: "sbox__dot sbox__s--" + ((idx % 4) + 1), r: 4.5, cx: Lp, cy: Tp }));
    const crossG = svgEl("g", { class: "sbox__cross", hidden: "" }, crossLine, crossDots);

    let hoverX = null, hoverY = null, pinned = false;
    let curXMin = domMin, curXMax = domMax, curYMin = 0, curYMax = 1, lastSampled = [];
    const px = (x) => Lp + ((Math.min(curXMax, Math.max(curXMin, x)) - curXMin) / Math.max(1e-9, curXMax - curXMin)) * pw;
    const py = (y) => Tp + ph - ((Math.min(curYMax, Math.max(curYMin, y)) - curYMin) / Math.max(1e-9, curYMax - curYMin)) * ph;
    const pyCurve = (y) => {
      const raw = Tp + ph - ((y - curYMin) / Math.max(1e-9, curYMax - curYMin)) * ph;
      return Math.min(Tp + ph * 3.5, Math.max(Tp - ph * 2.5, raw));
    };

    const cursorBar = h("div.sbox__cursor", { text: T.sboxHint, attr: { "aria-live": "polite" } });
    const legValueEls = comp.series.map(() => h("b", { text: "" }));
    const markerLegEls = markersSpec.map((m) => {
      const valEl = h("b", { text: "" });
      return { valEl, el: h("span.sbox__leg.sbox__leg--marker", null, h("i.sbox__swatch.sbox__swatch--marker"), h("span", null, L.md(m.label)), valEl) };
    });
    const eqLegItem = h("span.sbox__leg", { attr: { hidden: "" } }, h("i.sbox__swatch.sbox__swatch--zero"), h("span", { text: T.sboxEq }));
    const fieldLegItem = fieldSpec ? h("span.sbox__leg", null, h("span", { text: "↗ " + T.sboxField })) : null;
    const threshLegItem = thresh ? h("span.sbox__leg", null, h("i.sbox__swatch.sbox__swatch--dash"), h("span", null, thresh.label ? L.md(thresh.label) : T.sboxThresh), h("b", { text: L.num(thresh.value) })) : null;
    const legend = h("div.sbox__legend", null,
      comp.series.map((s, idx) => h("span.sbox__leg.sbox__s--" + ((idx % 4) + 1), null, h("i.sbox__swatch"), h("span", null, L.md(s.label)), legValueEls[idx])),
      markerLegEls.map((m) => m.el),
      fieldLegItem,
      eqLegItem,
      threshLegItem);

    const midU = (domMin + domMax) / 2;
    const readoutValEls = comp.readouts.map(() => h("b", { text: "—" }));
    const metricsBox = h("div.sbox__metrics", null, comp.readouts.map((r, idx) =>
      h("div.sbox__metric", null, h("span", null, L.md(r.label)), readoutValEls[idx])));
    function paintReadouts() {
      const refX = !hasParametric && hoverX !== null ? hoverX : midU;
      const env = Object.assign({}, state, { [dom.variable]: refX });
      comp.readouts.forEach((r, idx) => {
        const v = evalAst(r.ast, env);
        readoutValEls[idx].textContent = (Number.isFinite(v) ? L.num(Number(v.toFixed(3))) : "—") + (r.unit ? " " + r.unit : "");
      });
    }

    function paintCrosshair() {
      paintReadouts();
      if (hoverX === null) {
        crossG.setAttribute("hidden", "");
        cursorBar.classList.remove("is-pinned");
        cursorBar.replaceChildren(T.sboxHint);
        legValueEls.forEach((bEl) => { bEl.textContent = ""; });
        return;
      }
      crossG.removeAttribute("hidden");
      const cx = px(hoverX);
      crossLine.setAttribute("x1", cx.toFixed(1));
      crossLine.setAttribute("x2", cx.toFixed(1));
      const xAxisName = (allParametric || fieldSpec) ? (fieldSpec?.xVar || "x") : (dom.variable || "x");
      const readParts = [h("span", { text: xAxisName + " = " + L.num(Number(hoverX.toFixed(3))) + (!allParametric && dom.unit ? " " + dom.unit : "") })];
      if (fieldSpec && hoverY !== null) {
        const fxVar = fieldSpec.xVar || "x", fyVar = fieldSpec.yVar || "y";
        const fEnv = Object.assign({}, state, { [dom.variable]: (domMin + domMax) / 2, x: hoverX, y: hoverY, [fxVar]: hoverX, [fyVar]: hoverY });
        const fdx = evalAst(fieldSpec.dxAst, fEnv), fdy = evalAst(fieldSpec.dyAst, fEnv);
        if (Number.isFinite(fdx) && Number.isFinite(fdy)) {
          readParts.push(h("span", { text: fyVar + " = " + L.num(Number(hoverY.toFixed(3))) + " · Δ(" + L.num(Number(fdx.toFixed(2))) + ", " + L.num(Number(fdy.toFixed(2))) + ")" }));
        }
      }
      comp.series.forEach((s, idx) => {
        const dot = crossDots[idx];
        if (s.parametric) {
          const item = lastSampled[idx];
          let best = null, bestDist = Infinity;
          for (const p of item ? item.pts : []) {
            if (p.x === null || p.y === null) continue;
            const d = hoverY !== null ? Math.hypot(px(p.x) - cx, py(p.y) - py(hoverY)) : Math.abs(px(p.x) - cx);
            if (d < bestDist) { bestDist = d; best = p; }
          }
          if (best) {
            dot.removeAttribute("hidden");
            dot.setAttribute("cx", px(best.x).toFixed(1));
            dot.setAttribute("cy", py(best.y).toFixed(1));
            const fmt = "(" + L.num(Number(best.x.toFixed(3))) + ", " + L.num(Number(best.y.toFixed(3))) + ")";
            legValueEls[idx].textContent = fmt;
            readParts.push(h("span.sbox__s--" + ((idx % 4) + 1), null, h("span", null, L.md(s.label)), ": ", h("b", { text: fmt })));
          } else {
            dot.setAttribute("hidden", "");
            legValueEls[idx].textContent = "—";
          }
          return;
        }
        const y = evalAst(s.ast, Object.assign({}, state, { [dom.variable]: hoverX }));
        if (Number.isFinite(y)) {
          if (y >= curYMin && y <= curYMax) {
            dot.removeAttribute("hidden");
            dot.setAttribute("cx", cx.toFixed(1));
            dot.setAttribute("cy", py(y).toFixed(1));
          } else {
            dot.setAttribute("hidden", "");
          }
          const fmt = L.num(Number(y.toFixed(4)));
          legValueEls[idx].textContent = fmt;
          readParts.push(h("span.sbox__s--" + ((idx % 4) + 1), null, h("span", null, L.md(s.label)), ": ", h("b", { text: fmt })));
        } else {
          dot.setAttribute("hidden", "");
          legValueEls[idx].textContent = "—";
        }
      });
      cursorBar.classList.toggle("is-pinned", pinned);
      cursorBar.replaceChildren(h("span.sbox__cursor-vals", null, readParts), pinned ? h("span", { text: T.sboxPinned }) : null);
    }

    function clientToPlot(clientX, clientY) {
      const rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return { x: (curXMin + curXMax) / 2, y: (curYMin + curYMax) / 2 };
      const svgX = ((clientX - rect.left) / rect.width) * W;
      const svgY = ((clientY - rect.top) / rect.height) * H;
      const rx = Math.min(1, Math.max(0, (svgX - Lp) / pw));
      const ry = Math.min(1, Math.max(0, (svgY - Tp) / ph));
      return {
        x: curXMin + rx * (curXMax - curXMin),
        y: curYMax - ry * (curYMax - curYMin),
      };
    }

    const hitRect = svgEl("rect", { class: "sbox__hit", x: Lp, y: Tp, width: pw, height: ph, tabindex: "0", role: "application", "aria-label": T.sboxHint });
    hitRect.addEventListener("pointermove", (e) => {
      if (!pinned) {
        const pt = clientToPlot(e.clientX, e.clientY);
        hoverX = pt.x; hoverY = pt.y;
        paintCrosshair();
      }
    });
    hitRect.addEventListener("pointerleave", () => { if (!pinned) { hoverX = null; hoverY = null; paintCrosshair(); } });
    hitRect.addEventListener("click", (e) => {
      const pt = clientToPlot(e.clientX, e.clientY);
      if (pinned) { pinned = false; hoverX = pt.x; hoverY = pt.y; }
      else { hoverX = pt.x; hoverY = pt.y; pinned = true; }
      paintCrosshair();
    });
    hitRect.addEventListener("keydown", (e) => {
      if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        e.preventDefault();
        e.stopPropagation();
        const plotSpanX = Math.max(1e-9, curXMax - curXMin);
        const stepX = plotSpanX / (e.shiftKey ? 10 : 40);
        const base = hoverX === null ? (curXMin + curXMax) / 2 : hoverX;
        hoverX = Math.min(curXMax, Math.max(curXMin, base + (e.key === "ArrowRight" ? stepX : -stepX)));
        if (hoverY === null) hoverY = (curYMin + curYMax) / 2;
        paintCrosshair();
      } else if (e.key === "Escape") {
        pinned = false;
        hoverX = null;
        hoverY = null;
        paintCrosshair();
      }
    });

    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "sbox__svg" }, defs, plotLayer, crossG, hitRect);
    const caption = h("p.text", { text: "" });
    if (b.caption) caption.replaceChildren(L.md(b.caption));

    function draw() {
      const baseSteps = dom.steps || 80;
      const steps = allParametric ? baseSteps : Math.max(baseSteps, 160);
      const sampled = comp.series.map((s, idx) => {
        const pts = [];
        for (let i = 0; i <= steps; i++) {
          const u = domMin + (domSpan * i) / steps;
          const env = Object.assign({}, state, { [dom.variable]: u });
          if (s.parametric) {
            const xv = evalAst(s.xAst, env), yv = evalAst(s.yAst, env);
            pts.push(Number.isFinite(xv) && Number.isFinite(yv) ? { x: xv, y: yv, u } : { x: null, y: null, u });
          } else {
            const yv = evalAst(s.ast, env);
            pts.push({ x: u, y: Number.isFinite(yv) ? yv : null, u });
          }
        }
        return { s, slot: (idx % 4) + 1, pts };
      });
      lastSampled = sampled;

      const evalMarkers = markersSpec.map((m, idx) => {
        const env = Object.assign({}, state, { [dom.variable]: midU });
        const mx = evalAst(m.xAst, env), my = evalAst(m.yAst, env);
        const ok = Number.isFinite(mx) && Number.isFinite(my);
        markerLegEls[idx].valEl.textContent = ok ? "(" + L.num(Number(mx.toFixed(3))) + ", " + L.num(Number(my.toFixed(3))) + ")" : "—";
        return { m, mx, my, ok };
      });

      const finiteXs = sampled.flatMap((s) => s.pts.map((p) => p.x).filter((x) => x !== null));
      const seriesYs = sampled.flatMap((s) => s.pts.map((p) => p.y).filter((y) => y !== null));
      let effectiveSeriesYs = seriesYs;
      if (!Array.isArray(b.yRange) && !fieldSpec && !allParametric && seriesYs.length >= 12) {
        const sortedYs = [...seriesYs].sort((a, b2) => a - b2);
        const q10 = sortedYs[Math.floor(sortedYs.length * 0.1)];
        const q90 = sortedYs[Math.floor(sortedYs.length * 0.9)];
        const iqSpan = Math.max(1, q90 - q10);
        const rawSpan = sortedYs[sortedYs.length - 1] - sortedYs[0];
        if (rawSpan > iqSpan * 5.5) {
          const filtered = seriesYs.filter((yv) => yv >= q10 - iqSpan * 1.8 && yv <= q90 + iqSpan * 1.8);
          if (filtered.length >= 4) effectiveSeriesYs = filtered;
        }
      }
      const finiteYs = [...effectiveSeriesYs];
      for (const em of evalMarkers) {
        if (em.ok) { finiteXs.push(em.mx); finiteYs.push(em.my); }
      }
      if (thresh) {
        finiteYs.push(thresh.value - thresh.band, thresh.value + thresh.band);
      }

      let plotXMin, plotXMax;
      if (Array.isArray(b.xRange) && b.xRange.length === 2) {
        plotXMin = Number(b.xRange[0]);
        plotXMax = Number(b.xRange[1]);
      } else if (fieldSpec && (allParametric || !comp.series.length)) {
        plotXMin = fieldSpec.xMin;
        plotXMax = fieldSpec.xMax;
      } else if (allParametric && finiteXs.length) {
        plotXMin = Math.min(...finiteXs);
        plotXMax = Math.max(...finiteXs);
        if (Math.abs(plotXMax - plotXMin) < 1e-6) { plotXMax += 1; plotXMin -= 1; }
        const xPad = (plotXMax - plotXMin) * 0.08;
        plotXMin -= xPad; plotXMax += xPad;
      } else {
        plotXMin = fieldSpec ? Math.min(domMin, fieldSpec.xMin) : domMin;
        plotXMax = fieldSpec ? Math.max(domMax, fieldSpec.xMax) : domMax;
      }
      if (Math.abs(plotXMax - plotXMin) < 1e-6) { plotXMax += 1; plotXMin -= 1; }

      let yMin, yMax;
      if (Array.isArray(b.yRange) && b.yRange.length === 2) {
        yMin = Number(b.yRange[0]);
        yMax = Number(b.yRange[1]);
      } else if (fieldSpec && (allParametric || !comp.series.length)) {
        yMin = fieldSpec.yMin;
        yMax = fieldSpec.yMax;
      } else {
        yMin = Math.min(0, ...(finiteYs.length ? finiteYs : [0]));
        yMax = Math.max(1, ...(finiteYs.length ? finiteYs : [1]));
        if (fieldSpec) { yMin = Math.min(yMin, fieldSpec.yMin); yMax = Math.max(yMax, fieldSpec.yMax); }
        if (Math.abs(yMax - yMin) < 1e-6) { yMax += 1; yMin -= 1; }
        const pad = (yMax - yMin) * 0.08;
        yMin -= pad; yMax += pad;
      }
      if (Math.abs(yMax - yMin) < 1e-6) { yMax += 1; yMin -= 1; }
      curXMin = plotXMin; curXMax = plotXMax;
      curYMin = yMin; curYMax = yMax;

      const children = [];
      for (let t = 0; t <= 4; t++) {
        const yv = yMin + ((yMax - yMin) * t) / 4;
        children.push(svgEl("line", { class: "chart__grid", x1: Lp, x2: Lp + pw, y1: py(yv), y2: py(yv) }));
        children.push(svgEl("text", { class: "chart__tick", x: Lp - 6, y: py(yv) + 4, "text-anchor": "end" }, L.num(Number(yv.toFixed(2)))));
      }
      if (plotXMin < 0 && plotXMax > 0) {
        children.push(svgEl("line", { class: "sbox__zero-x", x1: px(0), x2: px(0), y1: Tp, y2: Tp + ph }));
      }
      const hasZeroLine = yMin <= 0 && yMax >= 0;
      eqLegItem.hidden = !hasZeroLine;
      if (hasZeroLine) {
        const y0 = py(0);
        children.push(svgEl("line", { class: "chart__base sbox__zero", x1: Lp, x2: Lp + pw, y1: y0, y2: y0 }));
        children.push(svgEl("text", { class: "sbox__zero-tag", x: Lp + 4, y: Math.max(Tp + 10, y0 - 4) }, "y=0"));
      }

      if (fieldSpec) {
        const grid = fieldSpec.grid || 12;
        const fxMin = fieldSpec.xMin, fxMax = fieldSpec.xMax, fyMin = fieldSpec.yMin, fyMax = fieldSpec.yMax;
        const fxVar = fieldSpec.xVar || "x", fyVar = fieldSpec.yVar || "y";
        const vecs = [];
        let maxMag = 0;
        for (let ix = 0; ix < grid; ix++) {
          const gx = fxMin + ((ix + 0.5) / grid) * (fxMax - fxMin);
          if (gx < plotXMin || gx > plotXMax) continue;
          for (let iy = 0; iy < grid; iy++) {
            const gy = fyMin + ((iy + 0.5) / grid) * (fyMax - fyMin);
            if (gy < yMin || gy > yMax) continue;
            const fEnv = Object.assign({}, state, { [dom.variable]: midU, x: gx, y: gy, [fxVar]: gx, [fyVar]: gy });
            const dx = evalAst(fieldSpec.dxAst, fEnv), dy = evalAst(fieldSpec.dyAst, fEnv);
            if (!Number.isFinite(dx) || !Number.isFinite(dy)) continue;
            const mag = Math.hypot(dx, dy);
            if (mag < 1e-9) continue;
            if (mag > maxMag) maxMag = mag;
            vecs.push({ gx, gy, dx, dy, mag });
          }
        }
        if (vecs.length && maxMag > 0) {
          const cellSize = Math.min(pw / grid, ph / grid);
          const maxLen = cellSize * 0.68;
          const qCmds = [];
          for (const v of vecs) {
            const sx = (v.dx / Math.max(1e-9, plotXMax - plotXMin)) * pw;
            const sy = -(v.dy / Math.max(1e-9, yMax - yMin)) * ph;
            const sMag = Math.hypot(sx, sy);
            if (sMag < 1e-9) continue;
            const ux = sx / sMag, uy = sy / sMag;
            const len = maxLen * (0.48 + 0.52 * Math.min(1, Math.sqrt(v.mag / maxMag)));
            const cx0 = px(v.gx), cy0 = py(v.gy);
            const x1 = cx0 - ux * len * 0.45, y1 = cy0 - uy * len * 0.45;
            const x2 = cx0 + ux * len * 0.55, y2 = cy0 + uy * len * 0.55;
            const head = Math.max(2.6, len * 0.28);
            const wx1 = x2 - ux * head - uy * head * 0.62, wy1 = y2 - uy * head + ux * head * 0.62;
            const wx2 = x2 - ux * head + uy * head * 0.62, wy2 = y2 - uy * head - ux * head * 0.62;
            qCmds.push(
              "M" + x1.toFixed(1) + " " + y1.toFixed(1) + "L" + x2.toFixed(1) + " " + y2.toFixed(1)
              + "M" + wx1.toFixed(1) + " " + wy1.toFixed(1) + "L" + x2.toFixed(1) + " " + y2.toFixed(1) + "L" + wx2.toFixed(1) + " " + wy2.toFixed(1));
          }
          if (qCmds.length) {
            children.push(svgEl("g", { class: "sbox__quiver" }, svgEl("path", { class: "sbox__quiver-path", d: qCmds.join("") })));
          }
        }
      }

      if (thresh && thresh.value >= yMin && thresh.value <= yMax) {
        const ty = py(thresh.value);
        const bandTop = thresh.band > 0 ? py(thresh.value + thresh.band) : ty - 4;
        const bandBot = thresh.band > 0 ? py(thresh.value - thresh.band) : ty + 4;
        const thLabel = svgEl("text", { class: "sbox__thresh-label", x: Lp + pw - 4, y: Math.max(Tp + 11, ty - 5), "text-anchor": "end" });
        L.svgText(thLabel, thresh.label ? thresh.label + " (" + L.num(thresh.value) + ")" : L.num(thresh.value));
        children.push(svgEl("g", { class: "sbox__threshold" },
          svgEl("rect", { class: "sbox__band", x: Lp, y: Math.min(bandTop, bandBot), width: pw, height: Math.max(4, Math.abs(bandBot - bandTop)) }),
          svgEl("line", { class: "sbox__thresh-line", x1: Lp, x2: Lp + pw, y1: ty, y2: ty }),
          thLabel));
      }
      for (let t = 0; t <= 4; t++) {
        const xv = plotXMin + ((plotXMax - plotXMin) * t) / 4;
        children.push(svgEl("text", { class: "chart__tick", x: px(xv), y: H - 8, "text-anchor": "middle" }, L.num(Number(xv.toFixed(2)))));
      }

      const curveGroups = [];
      for (const item of sampled) {
        let cmds = [];
        let validScreenPts = [];
        if (item.s.parametric) {
          let open = false;
          for (const p of item.pts) {
            if (p.x === null || p.y === null) {
              open = false;
            } else {
              const sx = px(p.x), sy = py(p.y);
              cmds.push((open ? "L" : "M") + sx.toFixed(1) + " " + sy.toFixed(1));
              if (p.y >= yMin && p.y <= yMax) validScreenPts.push([sx, sy]);
              open = true;
            }
          }
        } else {
          const evalFn = (xv) => evalAst(item.s.ast, Object.assign({}, state, { [dom.variable]: xv }));
          const built = buildCurve1DPath(evalFn, { pts: item.pts, yMin, yMax, px, pyCurve });
          cmds = built.commands;
          validScreenPts = built.validScreenPts;
        }
        if (cmds.length) {
          let dirArrow = null;
          if (item.s.parametric && validScreenPts.length >= 4) {
            const midIdx = Math.floor(validScreenPts.length * 0.45);
            const [ax1, ay1] = validScreenPts[midIdx], [ax2, ay2] = validScreenPts[Math.min(validScreenPts.length - 1, midIdx + 2)];
            const dLen = Math.hypot(ax2 - ax1, ay2 - ay1);
            if (dLen > 2) {
              const ux = (ax2 - ax1) / dLen, uy = (ay2 - ay1) / dLen;
              const tx = ax2, ty = ay2, bx = tx - ux * 8, by = ty - uy * 8;
              dirArrow = svgEl("polygon", { class: "sbox__dir-arrow", points: tx.toFixed(1) + "," + ty.toFixed(1) + " " + (bx - uy * 4).toFixed(1) + "," + (by + ux * 4).toFixed(1) + " " + (bx + uy * 4).toFixed(1) + "," + (by - ux * 4).toFixed(1) });
            }
          }
          curveGroups.push(svgEl("g", { class: "sbox__s--" + item.slot },
            svgEl("path", { class: "chart__line sbox__curve", d: cmds.join(" ") }),
            dirArrow));
        }
      }
      if (curveGroups.length) {
        children.push(svgEl("g", { class: "sbox__curves", "clip-path": "url(#" + clipId + ")" }, curveGroups));
      }

      for (const em of evalMarkers) {
        if (!em.ok || em.mx < plotXMin || em.mx > plotXMax || em.my < yMin || em.my > yMax) continue;
        const mcx = px(em.mx), mcy = py(em.my);
        const nearRight = mcx > Lp + pw - 90;
        const nearTop = mcy < Tp + 20;
        const mLabel = svgEl("text", {
          class: "sbox__marker-label",
          x: (mcx + (nearRight ? -9 : 9)).toFixed(1),
          y: (mcy + (nearTop ? 14 : -8)).toFixed(1),
          "text-anchor": nearRight ? "end" : "start",
        });
        L.svgText(mLabel, em.m.label);
        children.push(svgEl("g", { class: "sbox__marker" },
          svgEl("circle", { class: "sbox__marker-halo", cx: mcx.toFixed(1), cy: mcy.toFixed(1), r: 7.5 }),
          svgEl("circle", { class: "sbox__marker-dot", cx: mcx.toFixed(1), cy: mcy.toFixed(1), r: 4.2 }),
          mLabel));
      }

      plotLayer.replaceChildren(...children);

      if (resetBtn) {
        resetBtn.disabled = !Object.keys(defaults).some((id) => Math.abs(state[id] - defaults[id]) > 1e-6);
      }
      presetBtns.forEach((btn, idx) => {
        const entries = Object.entries(presets[idx].values).filter(([id]) => id in state);
        const active = entries.length > 0 && entries.every(([id, val]) => Math.abs(state[id] - Number(val)) <= 1e-6);
        btn.setAttribute("aria-pressed", String(active));
      });
      paintCrosshair();
    }

    draw();
    const walk = b.walk || [];
    return {
      el: h("div.sbox", null, toolbar, controls.length ? h("div.sbox__controls", null, controls) : null, h("div.sbox__body", null, h("div.sbox__plot", null, svg, cursorBar, legend), h("div.sbox__side", null, metricsBox, b.caption ? caption : null))),
      steps: walk.map((w) => ({ say: w.say, key: w.key })),
      set(k) {
        if (k >= 1 && walk[k - 1]?.set) {
          for (const [id, val] of Object.entries(walk[k - 1].set)) {
            setKnobValue(id, val);
          }
          draw();
        } else if (k === 0) {
          for (const [id, val] of Object.entries(defaults)) {
            setKnobValue(id, val);
          }
          draw();
        }
      },
    };
  };
}
