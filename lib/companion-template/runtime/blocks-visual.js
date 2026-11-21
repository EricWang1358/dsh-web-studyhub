/* Visual cross-discipline blocks: Dialectical Scenario Matrix and Causal/Force Schematic. */

export function registerVisualBlocks({ L, h, svgEl, T }) {
  L.blocks.matrix = (b) => {
    const strictGate = Boolean(b.predictBeforeReveal);
    let activeId = b.scenarios[0].id, focusFw = null, predictMode = strictGate;
    const revealed = new Set();
    const promptEl = h("div.mtx__prompt"), gridEl = h("div.mtx__grid"), actionsEl = h("div.mtx__actions");
    const tabs = b.scenarios.length > 1
      ? L.segmented("", b.scenarios.map((s) => ({ id: s.id, label: s.title })), activeId, (id) => { activeId = id; focusFw = null; paint(); })
      : null;

    function keyOf(scId, fw, i) { return scId + ":" + (fw.id || i); }

    function measureCols() {
      const kids = [...gridEl.children];
      if (kids.length < 2) return 1;
      const top0 = kids[0].offsetTop;
      let cols = 0;
      for (const ch of kids) {
        if (Math.abs(ch.offsetTop - top0) <= 8) cols++;
        else break;
      }
      return Math.max(1, cols || Math.min(2, b.frameworks.length));
    }

    function revealScenario(sc) {
      b.frameworks.forEach((fw, i) => revealed.add(keyOf(sc.id, fw, i)));
    }

    function resetScenario(sc) {
      b.frameworks.forEach((fw, i) => revealed.delete(keyOf(sc.id, fw, i)));
      focusFw = null;
      predictMode = strictGate;
    }

    function paint() {
      const sc = b.scenarios.find((s) => s.id === activeId) || b.scenarios[0];
      promptEl.replaceChildren(L.md(sc.prompt));
      const hasFocus = focusFw !== null && focusFw !== undefined;
      gridEl.classList.toggle("has-focus", hasFocus);

      let scRevealed = 0;
      b.frameworks.forEach((fw, i) => {
        if (revealed.has(keyOf(sc.id, fw, i)) || focusFw === fw.id || focusFw === i) scRevealed++;
      });
      const total = b.frameworks.length;
      const allScRevealed = !predictMode || scRevealed >= total;

      const btns = [];
      if (!predictMode && !strictGate) {
        btns.push(h("button.btn.btn--quiet.mtx__mask-btn", {
          text: T.mtxPredictOff,
          attr: { type: "button", "aria-pressed": "false" },
          on: { click() { predictMode = true; b.frameworks.forEach((fw, i) => revealed.delete(keyOf(sc.id, fw, i))); focusFw = null; paint(); } },
        }));
      }
      if (predictMode && !allScRevealed) {
        const gated = strictGate && scRevealed === 0;
        btns.push(h("button.btn.btn--quiet.mtx__reveal-btn", {
          text: T.mtxRevealAll,
          attr: { type: "button", ...(gated ? { disabled: "" } : {}) },
          on: { click() { if (gated) return; revealScenario(sc); paint(); } },
        }));
      }
      if ((predictMode && scRevealed > 0) || hasFocus || (!strictGate && predictMode)) {
        btns.push(h("button.btn.btn--quiet.mtx__reset-btn", {
          text: T.reset,
          attr: { type: "button" },
          on: { click() { resetScenario(sc); paint(); } },
        }));
      }
      actionsEl.replaceChildren(...btns);

      const cardEls = b.frameworks.map((fw, i) => {
        const cell = sc.cells[i] || {};
        const cellTone = cell.tone || "neutral";
        const key = keyOf(sc.id, fw, i);
        const isFocused = focusFw === fw.id || focusFw === i;
        const isMasked = predictMode && !revealed.has(key) && !isFocused;
        const activate = () => {
          if (isMasked) {
            revealed.add(key);
            focusFw = fw.id ?? i;
          } else {
            focusFw = isFocused ? null : (fw.id ?? i);
          }
          paint();
        };
        return h("div.mtx__card" + (isFocused ? ".is-focus" : "") + (isMasked ? ".is-masked" : ""), {
          attr: { tabindex: "0", role: "button", "aria-pressed": String(isFocused) },
          on: {
            click: activate,
            keydown(e) {
              if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); activate(); return; }
              let nextIdx = -1;
              if (e.key === "ArrowRight") nextIdx = (i + 1) % total;
              else if (e.key === "ArrowLeft") nextIdx = (i - 1 + total) % total;
              else if (e.key === "ArrowDown") nextIdx = (i + measureCols()) % total;
              else if (e.key === "ArrowUp") nextIdx = (i - measureCols() + total) % total;
              else if (e.key === "Home") nextIdx = 0;
              else if (e.key === "End") nextIdx = total - 1;
              if (nextIdx >= 0) {
                e.preventDefault();
                e.stopPropagation();
                focusFw = b.frameworks[nextIdx].id ?? nextIdx;
                paint();
                gridEl.children[nextIdx]?.focus();
              }
            },
          },
        },
          h("div.mtx__head", null,
            h("span.mtx__fw", null, L.md(fw.name)),
            !isMasked && cell.badge ? h("span.mtx__badge.mtx__badge--" + cellTone, null, L.md(cell.badge)) : null),
          isMasked
            ? h("p.mtx__veil", { text: T.mtxClickReveal })
            : [h("p.mtx__verdict", null, L.md(cell.verdict || "")), h("p.mtx__why", null, L.md(cell.why || ""))]);
      });
      gridEl.replaceChildren(...cardEls);
    }
    paint();
    const walk = b.walk || [];
    const bar = h("div.mtx__bar", null, tabs?.el || h("span"), actionsEl);
    return {
      el: h("div.mtx", null, bar, promptEl, gridEl),
      steps: walk.map((w) => ({ say: w.say, key: w.key })),
      pass() {
        b.scenarios.forEach((sc) => revealScenario(sc));
        predictMode = false;
        paint();
      },
      set(k) {
        if (k >= 1 && walk[k - 1]) {
          if (walk[k - 1].scenario) { activeId = walk[k - 1].scenario; tabs?.pick(activeId); }
          focusFw = walk[k - 1].focus ?? null;
          if (focusFw !== null && focusFw !== undefined) revealed.add(activeId + ":" + focusFw);
          paint();
        } else if (k === 0) {
          focusFw = null;
          paint();
        }
      },
    };
  };

  L.blocks.schematic = (b) => {
    const baseW = 640, baseH = b.height || 290;
    let minX = 0, minY = 0, maxX = baseW, maxY = baseH;
    const expandBounds = (x, y) => {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    };

    const nodeMap = new Map();
    let selectedId = null, curStep = null, traceIdx = -1;
    const inspectEl = h("div.schem__inspect", { attr: { "aria-live": "polite" } });

    const nodeEls = b.nodes.map((n) => {
      const w = n.w || 126, nh = n.h || 52, x = n.x ?? 80, y = n.y ?? 80;
      expandBounds(x - 10, y - 10);
      expandBounds(x + w + 10, y + nh + 10);
      const labelEl = svgEl("text", { class: "schem__nlabel", x: x + w / 2, y: y + (n.sub ? 21 : 30) });
      L.svgText(labelEl, n.label);
      const subEl = svgEl("text", { class: "schem__nsub", x: x + w / 2, y: y + 37 });
      L.svgText(subEl, n.sub || "");
      const g = svgEl("g", { class: "schem__node", tabindex: "0", role: "button", "aria-pressed": "false" },
        svgEl("rect", { x, y, width: w, height: nh }),
        labelEl,
        subEl);
      const toggleInspect = () => {
        traceIdx = -1;
        selectedId = selectedId === n.id ? null : n.id;
        applyVisualState();
      };
      g.addEventListener("click", toggleInspect);
      g.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); toggleInspect(); }
      });
      const item = { n, x, y, w, h: nh, g, subEl };
      nodeMap.set(n.id, item);
      return item;
    });

    function rectBorderPoint(cx, cy, w, hRect, dx, dy, pad = 0) {
      const hw = w / 2 + pad, hh = hRect / 2 + pad;
      if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return { x: cx, y: cy };
      const sx = Math.abs(dx) > 1e-6 ? hw / Math.abs(dx) : Infinity;
      const sy = Math.abs(dy) > 1e-6 ? hh / Math.abs(dy) : Infinity;
      const s = Math.min(sx, sy);
      return { x: cx + dx * s, y: cy + dy * s };
    }

    function segmentHitsNode(x1, y1, x2, y2, nd) {
      const left = nd.x - 4, right = nd.x + nd.w + 4, top = nd.y - 4, bottom = nd.y + nd.h + 4;
      for (let s = 1; s <= 7; s++) {
        const t = s / 8;
        const px = x1 + (x2 - x1) * t, py = y1 + (y2 - y1) * t;
        if (px >= left && px <= right && py >= top && py <= bottom) return true;
      }
      return false;
    }

    let backHorizCount = 0, backVertCount = 0;
    const edgeEls = (b.edges || []).map((e, idx) => {
      const a = nodeMap.get(e.from), t = nodeMap.get(e.to);
      if (!a || !t) return null;
      const acx = a.x + a.w / 2, acy = a.y + a.h / 2, tcx = t.x + t.w / 2, tcy = t.y + t.h / 2;
      const dx = tcx - acx, dy = tcy - acy;
      const others = nodeEls.filter((nd) => nd !== a && nd !== t);
      const hitsMiddle = others.some((nd) => segmentHitsNode(acx, acy, tcx, tcy, nd));
      const dashAttr = (e.dashed || e.feedback) ? { "stroke-dasharray": "5 4" } : {};

      const isBackHoriz = acx > tcx + 12 || Boolean(e.feedback && Math.abs(dx) >= Math.abs(dy));
      const isBackVert = !isBackHoriz && (acy > tcy + 12 || Boolean(e.feedback));

      let pathD = "", polyPts = "", lx = 0, ly = 0, anchor = "middle";

      if (isBackHoriz || isBackVert || hitsMiddle) {
        let x1, y1, x2, y2, cx, cy;
        if (isBackHoriz) {
          const loX = Math.min(acx, tcx) - 8, hiX = Math.max(acx, tcx) + 8;
          const spanNodes = nodeEls.filter((nd) => nd.x + nd.w >= loX && nd.x <= hiX);
          const over = e.curve === "over";
          const laneOffset = (backHorizCount++) * 18;
          if (over) {
            const spanTop = Math.min(a.y, t.y, ...spanNodes.map((nd) => nd.y));
            x1 = acx; y1 = a.y;
            x2 = tcx; y2 = t.y - 2;
            cx = (x1 + x2) / 2;
            cy = spanTop - (Math.max(44, Math.min(88, Math.abs(dx) * 0.16 + 34)) + laneOffset);
          } else {
            const spanBottom = Math.max(a.y + a.h, t.y + t.h, ...spanNodes.map((nd) => nd.y + nd.h));
            x1 = acx; y1 = a.y + a.h;
            x2 = tcx; y2 = t.y + t.h + 2;
            cx = (x1 + x2) / 2;
            cy = spanBottom + Math.max(46, Math.min(92, Math.abs(dx) * 0.16 + 36)) + laneOffset;
          }
        } else if (isBackVert && Math.abs(dx) <= (a.w + t.w) * 0.85) {
          const loY = Math.min(acy, tcy) - 8, hiY = Math.max(acy, tcy) + 8;
          const spanNodes = nodeEls.filter((nd) => nd.y + nd.h >= loY && nd.y <= hiY);
          const spanRight = Math.max(a.x + a.w, t.x + t.w, ...spanNodes.map((nd) => nd.x + nd.w));
          const laneOffset = (backVertCount++) * 18;
          x1 = a.x + a.w; y1 = acy;
          x2 = t.x + t.w + 2; y2 = tcy;
          cx = spanRight + Math.max(48, Math.min(86, Math.abs(dy) * 0.22 + 36)) + laneOffset;
          cy = (y1 + y2) / 2;
        } else if (isBackVert) {
          const p1 = rectBorderPoint(acx, acy, a.w, a.h, dx, dy, 0);
          const p2 = rectBorderPoint(tcx, tcy, t.w, t.h, -dx, -dy, 3);
          x1 = p1.x; y1 = p1.y; x2 = p2.x; y2 = p2.y;
          const chord = Math.max(1, Math.hypot(x2 - x1, y2 - y1));
          const nx = -(y2 - y1) / chord, ny = (x2 - x1) / chord;
          const bow = hitsMiddle ? -56 : -36;
          cx = (x1 + x2) / 2 + nx * bow;
          cy = (y1 + y2) / 2 + ny * bow;
        } else {
          const loX = Math.min(acx, tcx) - 8, hiX = Math.max(acx, tcx) + 8;
          const spanNodes = nodeEls.filter((nd) => nd.x + nd.w >= loX && nd.x <= hiX);
          const spanTop = Math.min(a.y, t.y, ...spanNodes.map((nd) => nd.y));
          x1 = acx; y1 = a.y;
          x2 = tcx; y2 = t.y - 2;
          cx = (x1 + x2) / 2;
          cy = spanTop - Math.max(46, Math.min(88, Math.abs(dx) * 0.15 + 34));
        }

        const tdx = x2 - cx, tdy = y2 - cy, tlen = Math.max(1, Math.hypot(tdx, tdy));
        const tux = tdx / tlen, tuy = tdy / tlen;
        const bx = x2 - tux * 9, by = y2 - tuy * 9;
        pathD = "M " + x1.toFixed(1) + " " + y1.toFixed(1) + " Q " + cx.toFixed(1) + " " + cy.toFixed(1) + " " + bx.toFixed(1) + " " + by.toFixed(1);
        polyPts = x2.toFixed(1) + "," + y2.toFixed(1) + " " + (bx - tuy * 4.5).toFixed(1) + "," + (by + tux * 4.5).toFixed(1) + " " + (bx + tuy * 4.5).toFixed(1) + "," + (by - tux * 4.5).toFixed(1);
        const apexX = 0.25 * x1 + 0.5 * cx + 0.25 * x2;
        const apexY = 0.25 * y1 + 0.5 * cy + 0.25 * y2;
        if (isBackVert && Math.abs(dx) <= (a.w + t.w) * 0.85) {
          lx = apexX + 8; ly = apexY + 4; anchor = "start";
          expandBounds(lx + 56, ly + 12);
        } else if (cy > Math.max(y1, y2)) {
          lx = apexX; ly = apexY + 15;
          expandBounds(lx, ly + 10);
        } else {
          lx = apexX; ly = apexY - 7;
          expandBounds(lx, ly - 12);
        }
        expandBounds(apexX, apexY);
      } else {
        const p1 = rectBorderPoint(acx, acy, a.w, a.h, dx, dy, 0);
        const p2 = rectBorderPoint(tcx, tcy, t.w, t.h, -dx, -dy, 3);
        const len = Math.max(1, Math.hypot(p2.x - p1.x, p2.y - p1.y));
        const ux = (p2.x - p1.x) / len, uy = (p2.y - p1.y) / len;
        const bx = p2.x - ux * 8.5, by = p2.y - uy * 8.5;
        pathD = "M " + p1.x.toFixed(1) + " " + p1.y.toFixed(1) + " L " + bx.toFixed(1) + " " + by.toFixed(1);
        polyPts = p2.x.toFixed(1) + "," + p2.y.toFixed(1) + " " + (bx - uy * 4.2).toFixed(1) + "," + (by + ux * 4.2).toFixed(1) + " " + (bx + uy * 4.2).toFixed(1) + "," + (by - ux * 4.2).toFixed(1);
        lx = (p1.x + p2.x) / 2;
        ly = (p1.y + p2.y) / 2 - 7;
      }

      let lblEl = null;
      if (e.label) {
        lblEl = svgEl("text", { x: lx.toFixed(1), y: ly.toFixed(1), "text-anchor": anchor });
        L.svgText(lblEl, e.label);
      }
      const g = svgEl("g", { class: "schem__edge" },
        svgEl("path", Object.assign({ class: "schem__path", d: pathD }, dashAttr)),
        svgEl("polygon", { points: polyPts }),
        lblEl);
      return { id: e.id || e.from + "->" + e.to, idx, e, fromNode: a, toNode: t, g };
    }).filter(Boolean);

    const vbX = Math.floor(minX), vbY = Math.floor(minY), vbW = Math.ceil(maxX - minX), vbH = Math.ceil(maxY - minY);
    const svg = svgEl("svg", { viewBox: vbX + " " + vbY + " " + vbW + " " + vbH, class: "schem__svg" }, edgeEls.map((e) => e.g), nodeEls.map((n) => n.g));
    const walk = b.walk || [];

    const hasTraceBar = edgeEls.length >= 2;
    const tracePosEl = hasTraceBar ? h("span.schem__trace-pos.num") : null;
    const traceBtn = hasTraceBar ? h("button.btn.btn--quiet.schem__trace-btn", {
      text: T.schemTrace,
      attr: { type: "button" },
      on: {
        click() {
          traceIdx = (traceIdx + 1) % edgeEls.length;
          selectedId = null;
          applyVisualState();
        },
      },
    }) : null;
    const resetTraceBtn = hasTraceBar ? h("button.btn.btn--quiet.schem__reset-btn", {
      text: T.reset,
      attr: { type: "button", disabled: "" },
      on: {
        click() {
          traceIdx = -1;
          selectedId = null;
          applyVisualState();
        },
      },
    }) : null;
    const traceBar = hasTraceBar ? h("div.schem__bar", null, h("div.schem__actions", null, traceBtn, resetTraceBtn), tracePosEl) : null;

    function paintInspect() {
      const tracedEdge = traceIdx >= 0 ? edgeEls[traceIdx] : null;
      nodeEls.forEach((it) => {
        const sel = it.n.id === selectedId || (tracedEdge && it.n.id === tracedEdge.toNode.n.id);
        it.g.classList.toggle("is-selected", sel);
        it.g.setAttribute("aria-pressed", String(it.n.id === selectedId));
      });
      if (hasTraceBar) {
        traceBtn.textContent = traceIdx < 0 ? T.schemTrace : T.schemTraceNext;
        resetTraceBtn.disabled = traceIdx < 0 && selectedId === null;
        tracePosEl.textContent = traceIdx < 0 ? "" : (traceIdx + 1) + " / " + edgeEls.length;
      }
      if (tracedEdge) {
        inspectEl.classList.add("is-selected");
        const fn = tracedEdge.fromNode.n, tn = tracedEdge.toNode.n;
        const liveState = curStep?.states && Object.prototype.hasOwnProperty.call(curStep.states, tn.id) ? curStep.states[tn.id] : (tn.sub || "");
        const detailText = tn.detail || tn.note || fn.detail || fn.note || "";
        inspectEl.replaceChildren(
          h("b", null, L.md(fn.label + " → " + tn.label)),
          tracedEdge.e.label ? h("span.schem__inspect-sub", null, L.md(tracedEdge.e.label)) : null,
          liveState ? h("span.schem__inspect-sub", null, L.md(liveState)) : null,
          detailText ? h("span", null, L.md(detailText)) : null);
        return;
      }
      const target = selectedId ? nodeMap.get(selectedId) : null;
      if (!target) {
        inspectEl.classList.remove("is-selected");
        inspectEl.replaceChildren(h("span.schem__inspect-hint", { text: T.schemHint }));
        return;
      }
      inspectEl.classList.add("is-selected");
      const liveState = curStep?.states && Object.prototype.hasOwnProperty.call(curStep.states, target.n.id)
        ? curStep.states[target.n.id]
        : (target.n.sub || "");
      const detailText = target.n.detail || target.n.note || "";
      inspectEl.replaceChildren(
        h("b", null, L.md(target.n.label)),
        liveState ? h("span.schem__inspect-sub", null, L.md(liveState)) : null,
        detailText ? h("span", null, L.md(detailText)) : null);
    }

    function applyVisualState() {
      const tracedEdge = traceIdx >= 0 ? edgeEls[traceIdx] : null;
      const activeN = tracedEdge ? new Set([tracedEdge.fromNode.n.id, tracedEdge.toNode.n.id]) : new Set(curStep?.nodes || []);
      const activeE = tracedEdge ? new Set([tracedEdge.idx]) : new Set(curStep?.edges || []);
      nodeEls.forEach((it) => {
        it.g.classList.toggle("is-active", activeN.has(it.n.id));
        it.g.classList.toggle("is-ok", !tracedEdge && curStep?.tone === "ok" && activeN.has(it.n.id));
        it.g.classList.toggle("is-bad", !tracedEdge && curStep?.tone === "bad" && activeN.has(it.n.id));
        const nextSub = curStep?.states && Object.prototype.hasOwnProperty.call(curStep.states, it.n.id) ? curStep.states[it.n.id] : (it.n.sub || "");
        L.svgText(it.subEl, nextSub);
      });
      edgeEls.forEach((it) => it.g.classList.toggle("is-active", activeE.has(it.id) || activeE.has(it.idx)));
      paintInspect();
    }

    function set(k) {
      curStep = k >= 1 ? walk[k - 1] : null;
      traceIdx = -1;
      applyVisualState();
    }
    set(0);
    return { el: h("div.schem", null, traceBar, h("div.schem__canvas", null, svg), inspectEl), steps: walk.map((w) => ({ say: w.say, key: w.key })), set };
  };
}
