/* Core interactive lesson blocks: prose, workshop, recall/cases, code/spot/inside,
   predict/reveal, choose/decide/name, quiz/say/cards, lanes/schedule, experiment/chart. */

const OPTION_KEYS = "ABCDEF";

function extractWorkshopInfo(b) {
  const rawList = Array.isArray(b.steps) && b.steps.length
    ? b.steps
    : Array.isArray(b.criteria) && b.criteria.length
      ? b.criteria
      : Array.isArray(b.points) && b.points.length
        ? b.points
        : [];
  const checkItems = rawList.map((it) => (typeof it === "string" ? it : (it?.label || it?.text || ""))).filter(Boolean);
  const bodyMd = b.prompt || b.goal || b.mission || b.text || b.md || "";
  const solMd = b.solution || b.sampleAnswer || b.model || "";
  const isWorkshop = b.t === "workshop" || b.type === "workshop" || Boolean(b.title || bodyMd || checkItems.length || b.hint || solMd);
  return { checkItems, bodyMd, solMd, isWorkshop };
}

const medianOf = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] || 0;
};

export function registerCoreBlocks({ L, h, svgEl, T, lesson, postHost }) {
  const quizSlotMap = new WeakMap();
  const trySlotMap = new WeakMap();
  const spotSlotMap = new WeakMap();
  const saySlotMap = new WeakMap();
  let quizSlotSeq = 0, trySlotSeq = 0, spotSlotSeq = 0, saySlotSeq = 0;

  for (const sl of lesson.slides || []) {
    for (const bl of sl?.blocks || []) {
      if (!bl || typeof bl !== "object") continue;
      const bType = bl.t || bl.type;
      if (bType === "quiz") {
        quizSlotMap.set(bl, "check:" + (quizSlotSeq++));
      } else if (bType === "spot") {
        spotSlotMap.set(bl, "spot:" + (bl.of || bl.id || String(spotSlotSeq++)));
      } else if (bType === "say") {
        saySlotMap.set(bl, "say:" + (saySlotSeq++));
      } else if (bType === "try" || bType === "workshop") {
        const info = extractWorkshopInfo(bl);
        if (info.isWorkshop) {
          trySlotMap.set(bl, bl.id || ("w" + (trySlotSeq++) + ":" + String(bl.title || info.bodyMd || info.checkItems[0] || "").slice(0, 32)));
        }
      }
    }
  }

  L.blocks.text = (b) => ({ el: h("p.text", null, L.md(b.md)) });
  L.blocks.points = (b) => ({ el: h("ul.points", null, (b.items || []).map((it) => h("li", null, h("span", null, L.md(it))))) });
  L.blocks.callout = (b) => ({ el: h("div.callout.callout--" + (b.tone || "info"), null, h("h4", null, L.md(b.title)), h("p", null, L.md(b.md))) });

  L.blocks.try = L.blocks.workshop = (b, ctx) => {
    const { checkItems, bodyMd, solMd, isWorkshop } = extractWorkshopInfo(b);

    const pulseSiblings = (rootEl) => {
      const sl = rootEl.closest?.(".slide");
      if (!sl) return;
      for (const t of sl.querySelectorAll(".exp, .sbox")) { t.classList.remove("is-invited"); void t.offsetWidth; t.classList.add("is-invited"); }
    };

    if (!isWorkshop) {
      const el = h("span.try");
      return { el, refresh() { pulseSiblings(el); } };
    }

    if (!trySlotMap.has(b)) {
      trySlotMap.set(b, b.id || ("w" + (trySlotSeq++) + ":" + String(b.title || bodyMd || checkItems[0] || "").slice(0, 32)));
    }
    const slotId = trySlotMap.get(b);
    const checksKey = "try:" + slotId + ":checks";
    const draftKey = "try:" + slotId + ":draft";
    const savedChecks = Object.assign({}, ctx?.memory?.get(checksKey, {}) || {});
    const savedDraft = String(ctx?.memory?.get(draftKey, "") ?? "");

    const badge = checkItems.length ? h("span.try-work__badge.num") : null;
    const itemRows = checkItems.map((txt, idx) => {
      const cb = h("input", {
        attr: { type: "checkbox", ...(savedChecks[idx] ? { checked: "" } : {}) },
        on: {
          change() {
            savedChecks[idx] = cb.checked;
            ctx?.memory?.set(checksKey, Object.assign({}, savedChecks));
            paintChecks();
            ctx?.reportState?.(true);
          },
        },
      });
      cb.checked = Boolean(savedChecks[idx]);
      const li = h("li.try-work__item" + (cb.checked ? ".is-checked" : ""), null, h("label", null, cb, h("span", null, L.md(txt))));
      return { cb, li };
    });

    function paintChecks() {
      if (!badge) return;
      let doneCount = 0;
      itemRows.forEach(({ cb, li }, idx) => {
        const on = Boolean(savedChecks[idx]);
        cb.checked = on;
        li.classList.toggle("is-checked", on);
        if (on) doneCount++;
      });
      badge.textContent = doneCount + "/" + checkItems.length;
      badge.classList.toggle("is-done", doneCount === checkItems.length);
    }
    paintChecks();

    const draftEl = h("textarea.try__draft", {
      attr: { rows: "3", placeholder: b.placeholder || T.tryPlaceholder, "aria-label": T.tryScratch },
      on: {
        input() {
          ctx?.memory?.set(draftKey, draftEl.value);
          ctx?.reportState?.(false);
        },
        change() {
          ctx?.memory?.set(draftKey, draftEl.value);
          ctx?.reportState?.(true);
        },
      },
    });
    draftEl.value = savedDraft;
    const padEl = h("details.try__pad", { attr: { open: "" } }, h("summary.try__pad-sum", { text: T.tryScratch }), draftEl);

    const hintBox = b.hint ? h("div.try__hint", { attr: { hidden: "" } }, L.md(b.hint)) : null;
    const hintBtn = b.hint ? h("button.btn.btn--quiet.try__hint-btn", {
      text: T.tryShowHint,
      attr: { type: "button", "aria-expanded": "false" },
      on: {
        click() {
          hintBox.hidden = !hintBox.hidden;
          hintBtn.textContent = hintBox.hidden ? T.tryShowHint : T.tryHideHint;
          hintBtn.setAttribute("aria-expanded", String(!hintBox.hidden));
        },
      },
    }) : null;

    const solBox = solMd ? h("div.try__solution", { attr: { hidden: "" } }, L.md(solMd)) : null;
    const solBtn = solMd ? h("button.btn.btn--quiet.try__sol-btn", {
      text: T.tryShowSol,
      attr: { type: "button", "aria-expanded": "false" },
      on: {
        click() {
          solBox.hidden = !solBox.hidden;
          solBtn.textContent = solBox.hidden ? T.tryShowSol : T.tryHideSol;
          solBtn.setAttribute("aria-expanded", String(!solBox.hidden));
        },
      },
    }) : null;

    const el = h("div.try-work", null,
      h("div.try-work__head", null, h("h4.try-work__title", null, L.md(b.title || T.tryTitle)), badge),
      bodyMd ? h("p.try-work__prompt", null, L.md(bodyMd)) : null,
      itemRows.length ? h("ul.try-work__checks", null, itemRows.map((r) => r.li)) : null,
      padEl,
      (hintBtn || solBtn) ? h("div.try-work__actions", null, hintBtn, solBtn) : null,
      hintBox,
      solBox);

    return { el, refresh() { pulseSiblings(el); } };
  };

  function picks(labels, onPick, extra = "") {
    const btns = labels.map((t, i) => h("button.pick" + extra, { attr: { type: "button" }, on: { click: () => onPick(i) } }, L.md(t)));
    return {
      el: h("div.picks", null, btns),
      paint(picked, right) {
        btns.forEach((b, i) => { b.disabled = picked !== undefined; b.classList.toggle("is-right", picked !== undefined && i === right); b.classList.toggle("is-wrong", picked === i && i !== right); });
      },
    };
  }

  function answered(block, ctx, name, make, sum) {
    const key = name + ":" + block.items.length + ":" + (block.items[0]?.q || block.items[0]?.text || "");
    const answers = ctx.memory.get(key, {});
    const score = h("p." + name + "__score", { attr: { "aria-live": "polite" } });
    const rows = block.items.map((item, i) => {
      const why = h("p." + name + "__why", { attr: { hidden: "" } }, L.md(item.why));
      const r = make(item, (j) => { answers[i] = j; ctx.memory.set(key, answers); paint(); ctx?.reportState?.(true); });
      return { item, why, pick: r.pick, el: h("div." + name + "__item", null, r.head, r.pick.el, why) };
    });
    const done = () => rows.every((_, i) => answers[i] !== undefined);
    function paint() {
      rows.forEach((r, i) => { r.pick.paint(answers[i], r.item.answer); r.why.hidden = answers[i] === undefined; });
      score.textContent = done() ? sum(rows.filter((r, i) => answers[i] === r.item.answer).length, rows.length) : "";
    }
    paint();
    return { el: h("div." + name, null, rows.map((r) => r.el), score), ready: done, waitSay: T.waitPick };
  }

  L.blocks.recall = (b, ctx) => answered(b, ctx, "recall",
    (it, onPick) => ({ head: [h("span.recall__have", null, L.md(it.have || "")), h("p.recall__q", null, L.md(it.q))], pick: picks(it.options, onPick) }),
    (r, n) => (r === n ? T.recallAll(n) : T.recallSome(r, n)));

  L.blocks.cases = (b, ctx) => answered(b, ctx, "cases",
    (it, onPick) => ({ head: [h("p.cases__text", null, L.md(it.text))], pick: picks(b.tools, (j) => { onPick(j); document.dispatchEvent(new CustomEvent("lesson:picked", { detail: { name: b.tools[it.answer] } })); }, ".pick--tool") }),
    (r, n) => (r === n ? T.casesAll(n) : T.casesSome(r, n)));

  L.blocks.scene = (b) => {
    const cols = Array.isArray(b.columns) && b.columns.length === 2 ? b.columns : T.sceneCols;
    const rows = b.map.map((pair) => h("div.scene__row", null, h("span", null, L.md(pair.scene)), h("span.scene__arrow", { text: "→" }), h("span.scene__to", null, L.md(pair.code || pair.model || ""))));
    const table = h("div.scene__map", null, h("div.scene__head", null, h("span", { text: cols[0] }), h("span"), h("span", { text: cols[1] })), rows);
    const picture = b.picture && Array.isArray(b.picture.actors) && b.picture.shared ? L.sharePicture({ actors: b.picture.actors, shared: b.picture.shared.name, hands: false }) : null;
    const set = (k) => {
      table.classList.toggle("is-waiting", k === 0);
      rows.forEach((r, i) => { r.classList.toggle("is-waiting", i >= k); r.classList.toggle("is-now", i === k - 1); });
      if (picture) {
        const tags = { actors: [], shared: [], action: "" };
        b.map.slice(0, k).forEach((p) => { if (p.on === "action") tags.action = p.tag; else if (p.on && tags[p.on]) tags[p.on].push(p.tag); });
        picture.set({ value: b.picture.shared.value, tags, hot: k ? b.map[k - 1].on || null : null });
      }
    };
    set(0);
    return { el: h("div.scene", null, h("p.scene__story", null, L.md(b.story)), h("div.scene__body" + (picture ? ".has-picture" : ""), null, table, picture?.el)), steps: b.map.map((p) => ({ say: p.say, key: p.key })), set };
  };

  L.blocks.code = (b) => {
    const view = L.codeView(), walk = b.walk || [];
    const show = (focus) => view.show(b.source, { path: b.path || "", lang: b.lang || "text", focus: focus || [] });
    show(b.focusLines || []);
    return { el: view.el, steps: walk.map((s) => ({ say: s.say, key: s.key })), set(k) { show(k ? walk[k - 1].focusLines : b.focusLines || []); } };
  };

  L.blocks.spot = (b, ctx) => {
    const srcText = b.source ?? (Array.isArray(b.lines) ? b.lines.join("\n") : "");
    const key = "spot:" + (b.of || b.path || "") + ":" + b.answerLines.join("-");
    if (!spotSlotMap.has(b)) spotSlotMap.set(b, "spot:" + (b.of || b.id || String(spotSlotSeq++)));
    const slot = spotSlotMap.get(b);
    const view = L.codeView(), out = h("p.spot__out", { attr: { "aria-live": "polite" } });
    let found = ctx.memory.get(key, false), wrong = [];
    function paint() {
      view.show(srcText, {
        path: b.path || "",
        lang: b.lang || "text",
        focus: found ? b.answerLines : [],
        wrong,
        interactive: true,
        pickable: !found,
        pickedLines: found ? b.answerLines : wrong,
      });
      view.el.classList.toggle("is-pickable", !found);
      out.className = "spot__out" + (found ? " is-ok" : wrong.length ? " is-miss" : "");
      out.replaceChildren(found ? L.md(b.found) : wrong.length ? L.md(b.hint) : "");
    }
    view.onLine((n) => {
      if (found) return;
      if (b.answerLines.includes(n)) {
        found = true; wrong = []; ctx.memory.set(key, true);
        postHost({ kind: "self-check", slot, correct: true });
        ctx.reportState?.(true);
      } else wrong = [n];
      paint();
    });
    paint();
    return {
      el: h("div.spot", null, h("p.spot__q", null, L.md(b.q)), view.el, h("div.spot__side", null, h("p.spot__how", null, L.md(b.how || T.spotHow)), out)),
      ready: () => found, waitSay: T.waitSpot, pass() { found = true; wrong = []; paint(); },
    };
  };

  L.blocks.inside = (b) => {
    const view = L.codeView();
    const show = (k) => view.show(b.source, { path: b.command || b.path || "", lang: b.lang || "text", focus: k ? b.walk[k - 1].focusLines : [], tags: Object.fromEntries(b.walk.slice(0, k).map((s) => [s.focusLines.at(-1), s.label])) });
    show(0);
    return { el: h("div.inside", null, h("p.inside__what", null, L.md(b.caption || T.insideWhat)), view.el), steps: b.walk.map((s) => ({ say: s.say, key: s.key })), set: show };
  };

  function optionBtn(i, text, onPick) {
    const tag = h("span.opt__tag");
    const el = h("button.opt", { attr: { type: "button" }, on: { click: () => onPick(i) } }, h("span.opt__key", { text: OPTION_KEYS[i] || String(i + 1) }), h("span", null, L.md(text)), tag);
    return { el, tag };
  }

  L.blocks.predict = (b, ctx) => {
    const key = "predict:" + b.id;
    let firstPicked = ctx.memory.get(key) !== undefined;
    const opts = b.options.map((t, i) => optionBtn(i, t, (idx) => {
      ctx.memory.set(key, idx);
      if (!firstPicked) {
        firstPicked = true;
        postHost({ kind: "self-check", slot: key, correct: idx === b.answer });
      }
      paint();
      ctx.reportState?.(true);
    }));
    function paint() { const p = ctx.memory.get(key); opts.forEach((it, i) => { it.el.classList.toggle("is-picked", i === p); it.tag.textContent = i === p ? T.yourGuess : ""; }); }
    paint();
    return { el: h("div.predict", null, h("p.predict__q", null, L.md(b.q)), h("div.opts", null, opts.map((o) => o.el))), ready: () => ctx.memory.get(key) !== undefined, waitSay: T.waitPick };
  };

  L.blocks.reveal = (b, ctx) => {
    const pred = ctx.predicts[b.of], guess = h("dd");
    return {
      el: h("div.reveal", null, h("dl", null, h("dt", { text: T.yourGuess }), guess), h("dl", null, h("dt", { text: T.actual }), h("dd.is-ok", null, L.md(pred ? pred.options[pred.answer] : "")))),
      refresh() {
        const p = ctx.memory.get("predict:" + b.of);
        guess.className = p === undefined ? "" : p === pred?.answer ? "is-ok" : "is-miss";
        guess.replaceChildren(p === undefined ? T.noGuess : L.md(pred?.options[p] || ""));
      },
    };
  };

  L.blocks.choose = (b) => {
    const cols = Array.isArray(b.columns) && b.columns.length === 3 ? b.columns : T.chooseCols;
    const rows = b.options.map((opt) => h("div.choose__row", null,
      h("span.choose__name", null, L.term(opt.name, h("span", null, L.md(opt.name)))),
      h("span", null, L.md(opt.solves)), h("span", null, L.md(opt.cost)), h("span", null, L.md(opt.when))));
    const rule = h("p.choose__rule", null, L.md(b.rule));
    const el = h("div.choose", null, h("div.choose__head", null, h("span"), h("span", { text: cols[0] }), h("span", { text: cols[1] }), h("span", { text: cols[2] })), rows, rule);
    const set = (k) => { const w = k >= 1 && k <= rows.length; el.classList.toggle("is-walking", w); rows.forEach((r, i) => r.classList.toggle("is-now", w && i === k - 1)); rule.classList.toggle("is-waiting", k <= rows.length); };
    set(0);
    return { el, steps: b.options.map((o) => ({ say: o.say })).concat(b.ruleSay ? [{ say: b.ruleSay, key: b.ruleKey }] : []), set };
  };

  L.blocks.decide = (b) => {
    const branches = b.branches.map((br) => ({
      pick: br.pick,
      el: h("li.decide__branch", null, h("span.decide__when", null, L.md(br.when)), h("span.decide__pick", null, L.term(br.pick, h("span", null, L.md(br.pick)))), br.eg ? h("small.decide__eg", null, L.md(T.egPrefix + br.eg)) : null),
    }));
    const onPicked = (ev) => {
      const hit = branches.find((br) => br.pick === ev.detail.name);
      if (!hit || !hit.el.isConnected) return;
      branches.forEach((br) => br.el.classList.remove("is-hit"));
      void hit.el.offsetWidth;
      hit.el.classList.add("is-hit", "is-used");
    };
    document.addEventListener("lesson:picked", onPicked);
    return {
      el: h("div.decide", null, h("p.decide__q", null, L.md(b.q)), h("ul.decide__list", null, branches.map((br) => br.el))),
      destroy() { document.removeEventListener("lesson:picked", onPicked); },
    };
  };

  L.blocks.name = (b) => ({
    el: h("div.name", null, h("h2.name__term", null, L.md(b.term)), b.alias ? h("p.name__alias", null, L.md(b.alias)) : null, h("p.name__line", null, L.md(b.oneLine)),
      h("div.name__asked", null, h("h4", { text: b.askedTitle || T.askedTitle }), h("ul", null, (b.asked || []).map((q) => h("li", null, L.md(q)))))),
  });

  L.blocks.quiz = (b, ctx) => {
    if (!quizSlotMap.has(b)) {
      quizSlotMap.set(b, "check:" + (quizSlotSeq++));
    }
    const slot = quizSlotMap.get(b);
    const rawOpts = Array.isArray(b.options) ? b.options : (Array.isArray(b.choices) ? b.choices : []);
    const ansIdx = Number.isInteger(b.answer) ? b.answer : (Number.isInteger(b.answerIndex) ? b.answerIndex : -1);
    const fallbackWhy = b.why || b.explanation || "";
    const normOpts = rawOpts.map((it, i) => {
      if (typeof it === "string") return { text: it, ok: i === ansIdx, why: fallbackWhy };
      const ok = it?.ok !== undefined ? Boolean(it.ok) : it?.correct !== undefined ? Boolean(it.correct) : it?.isCorrect !== undefined ? Boolean(it.isCorrect) : i === ansIdx;
      return { text: it?.text ?? it?.label ?? it?.choice ?? "", ok, why: it?.why ?? it?.feedback ?? it?.explanation ?? fallbackWhy };
    });
    const saved = ctx.memory.get("quiz:" + slot);
    let firstReported = saved !== undefined;
    let solved = Boolean(ctx.memory.get("quiz-ok:" + slot, firstReported && Boolean(normOpts[saved]?.ok)));
    const tried = new Set(ctx.memory.get("quiz-tried:" + slot, firstReported && Number.isInteger(saved) ? [saved] : []));
    const opts = normOpts.map((it, i) => optionBtn(i, it.text, pick));
    function paint() {
      normOpts.forEach((it, i) => {
        const showThis = tried.has(i) || (solved && it.ok);
        opts[i].el.setAttribute("aria-pressed", String(tried.has(i)));
        if (!showThis) return;
        opts[i].el.classList.add(it.ok ? "is-right" : "is-wrong");
        opts[i].tag.textContent = it.ok ? T.right : T.wrong;
        if (it.why && !opts[i].el.querySelector(".opt__why")) {
          opts[i].el.append(h("span.opt__why", null, L.md(it.why)));
        }
      });
    }
    function pick(index) {
      if (!firstReported) {
        firstReported = true;
        ctx.memory.set("quiz:" + slot, index);
        postHost({ kind: "self-check", slot, correct: Boolean(normOpts[index]?.ok) });
      }
      tried.add(index);
      ctx.memory.set("quiz-tried:" + slot, [...tried]);
      if (normOpts[index]?.ok) {
        solved = true;
        ctx.memory.set("quiz-ok:" + slot, true);
      }
      paint();
      ctx.reportState?.(true);
    }
    paint();
    return {
      el: h("div.quiz", null, h("p.quiz__q", null, L.md(b.q || b.question || b.prompt || "")), h("div.opts", null, opts.map((o) => o.el))),
      ready: () => firstReported,
      waitSay: T.waitPick,
      pass() { solved = true; paint(); },
    };
  };

  L.blocks.say = (b, ctx) => {
    const total = b.seconds || 120;
    if (!saySlotMap.has(b)) saySlotMap.set(b, "say:" + (saySlotSeq++));
    const slot = saySlotMap.get(b);
    let left = total, timer = 0;
    const clock = h("span.say__clock"), score = h("p.say__score");
    const boxes = b.points.map(() => h("input", { attr: { type: "checkbox" }, on: { change: tally } }));
    const points = h("ul.say__points", { attr: { hidden: "" } }, b.points.map((pt, i) => h("li", null, h("label", null, boxes[i], h("span", null, L.md(pt))))), score);
    const modelText = b.model || b.sample || "";
    const model = h("p.say__model", { attr: { hidden: "" } }, L.md(modelText));
    const showModel = h("button.btn", { text: T.sayShowModel, attr: { type: "button", hidden: "" }, on: { click() { model.hidden = !model.hidden; showModel.textContent = model.hidden ? T.sayShowModel : T.sayHideModel; } } });
    const start = h("button.btn", { text: T.sayStart, attr: { type: "button" }, on: { click: toggle } });
    const check = h("button.btn.btn--primary", { text: T.sayDone, attr: { type: "button" }, on: { click() { stop(); points.hidden = false; check.hidden = true; showModel.hidden = false; tally(); } } });
    function draw() { clock.textContent = Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0"); }
    function stop() { clearInterval(timer); timer = 0; start.textContent = left === total ? T.sayStart : T.sayResume; }
    function toggle() { if (timer) return stop(); if (left === 0) left = total; start.textContent = T.sayPause; timer = window.setInterval(() => { if (!clock.isConnected) { stop(); return; } left -= 1; draw(); if (left === 0) stop(); }, 1000); draw(); }
    function tally() {
      const hit = boxes.filter((x) => x.checked).length;
      score.textContent = T.sayScore(hit, b.points.length);
      if (hit > 0) {
        postHost({ kind: "self-check", slot, correct: hit >= Math.ceil(b.points.length / 2) });
        ctx?.reportState?.(true);
      }
    }
    draw();
    return { el: h("div.say", null, h("p.say__prompt", null, L.md(b.prompt)), h("div.say__row", null, clock, start, check, showModel), points, model), destroy: stop };
  };

  L.blocks.cards = (b) => ({
    el: h("div.cards", null, b.items.map((c) => {
      const ans = h("p.card__a", { attr: { hidden: "" } }, L.md(c.a));
      const btn = h("button.btn.btn--quiet", { text: T.showAns, attr: { type: "button" }, on: { click() { ans.hidden = !ans.hidden; btn.textContent = ans.hidden ? T.showAns : T.hideAns; } } });
      return h("div.card", null, h("p.card__q", null, L.md(c.q)), btn, ans);
    })),
  });

  function laneRow(step, shared) {
    const touches = step.op === "read" || step.op === "write", inward = step.op === "write";
    const arrow = h("span.arrow.arrow--" + (!touches ? "none" : (step.lane === 0) === inward ? "right" : "left"));
    const chip = h("span.chip" + (step.op === "note" && step.tone ? ".chip--" + step.tone : ""), null, L.md(step.text));
    const cells = [h("div.lcell.lcell--a"), h("div.lcell.lcell--mid"), h("div.lcell.lcell--b")];
    cells[step.lane === 0 ? 0 : 2].append(...(step.lane === 0 ? [chip, arrow] : [arrow, chip]));
    if (touches) cells[1].append(h("span.val" + (inward ? ".val--write" : ""), { text: String(shared) }));
    return h("div.lrow", null, cells);
  }

  L.blocks.lanes = (b, ctx) => {
    let shared = b.shared.start, now = 0;
    const OPS = ["read", "calc", "write"];
    const key = "lanes:" + (b.expr || "") + ":" + b.steps.length;
    const answers = ctx.memory.get(key, {});
    const parts = b.parts ? OPS.map((op) => h("span.part", { text: b.parts[op] || op })) : null;
    const rows = b.steps.map((st) => { if (st.op === "write") shared = st.value; return laneRow(st, shared); });
    const verdict = h("p.lanes__verdict.is-waiting", null, L.md(b.verdict));
    const askBox = h("div.lanes__ask", { attr: { hidden: "" } });
    const askNow = () => (now >= 1 && now <= rows.length ? b.steps[now - 1].ask : null);
    const picture = L.sharePicture({ actors: b.lanes, shared: b.shared.name });
    const frames = L.shareFrames(b.steps, b.shared.start);
    function paintAsk() {
      const ask = askNow(); askBox.hidden = !ask; if (!ask) return;
      const picked = answers[now - 1];
      const btns = ask.options.map((txt, i) => {
        const btn = h("button.pick", { attr: { type: "button" }, on: { click() { answers[now - 1] = i; ctx.memory.set(key, answers); paintAsk(); ctx?.reportState?.(true); } } }, L.md(txt));
        btn.disabled = picked !== undefined;
        if (picked !== undefined && i === ask.answer) btn.classList.add("is-right");
        if (picked === i && i !== ask.answer) btn.classList.add("is-wrong");
        return btn;
      });
      askBox.replaceChildren(h("p", null, L.md(ask.q)), h("div.picks", null, btns), h("p.ask__out", { text: picked === undefined ? "" : picked === ask.answer ? T.lanesRight : T.lanesWrong }));
    }
    return {
      el: h("div.lanes", null,
        h("div.lanes__main", null,
          b.expr ? h("div.lanes__expr", null, h("code.lanes__code", { text: b.expr }), parts ? h("div.lanes__parts", null, parts[0], "→", parts[1], "→", parts[2]) : null) : null,
          h("div.lanes__grid", null, h("div.lanes__head.lanes__head--a", null, L.md(b.lanes[0])), h("div.lanes__head.lanes__head--mid", null, L.md(b.shared.name)), h("div.lanes__head.lanes__head--b", null, L.md(b.lanes[1])), rows),
          askBox, verdict),
        h("div.lanes__side", null, h("p.lanes__now", { text: T.now }), picture.el)),
      steps: b.steps.map((s) => ({ say: s.say, key: s.key })).concat(b.verdictSay ? [{ say: b.verdictSay, key: b.verdictKey }] : []),
      waitSay: T.waitPick,
      ready: () => !askNow() || answers[now - 1] !== undefined,
      set(k) {
        now = k;
        rows.forEach((el, i) => { el.classList.toggle("is-waiting", i >= k); el.classList.toggle("is-now", i === k - 1); });
        if (parts) { const op = k >= 1 && k <= rows.length ? b.steps[k - 1].op : null; parts.forEach((p, i) => p.classList.toggle("is-now", OPS[i] === op)); }
        verdict.classList.toggle("is-waiting", k <= rows.length);
        picture.set(frames[Math.min(k, frames.length - 1)]);
        paintAsk();
      },
    };
  };

  L.blocks.schedule = (b) => {
    const OPS = ["read", "calc", "write"], name = b.shared.name, reached = new Set();
    let shared, actors, owner, locked = false;
    const rows = h("div.lrow-list"), value = h("span.val"), result = h("p.sched__result");
    const buttons = [0, 1].map((lane) => h("button.btn", { attr: { type: "button" }, on: { click: () => move(lane) } }));
    const goals = (b.goals || []).map((g) => h("li.goal", null, L.md(g.label)));
    const lock = b.lock ? L.segmented("", [{ id: "off", label: T.noLock }, { id: "on", label: b.lock.label }], "off", (id) => { locked = id === "on"; reset(); }) : null;
    function paint() {
      value.textContent = String(shared);
      buttons.forEach((btn, lane) => { const ac = actors[lane], waits = locked && owner !== null && owner !== lane; btn.disabled = ac.pc === 3 || waits; btn.textContent = b.lanes[lane] + " (" + ac.pc + "/3)"; });
      if (actors.every((ac) => ac.pc === 3)) { reached.add(shared); result.replaceChildren(L.md(name + " = **" + shared + "**" + (b.done ? " · " + b.done : ""))); }
      goals.forEach((el, i) => el.classList.toggle("is-done", reached.has(b.goals[i].value)));
    }
    function move(lane) {
      const ac = actors[lane], op = OPS[ac.pc];
      let txt;
      if (op === "read") { ac.local = shared; owner = lane; txt = "→ " + shared; }
      else if (op === "calc") { ac.local += b.delta || 1; txt = "= " + ac.local; }
      else { shared = ac.local; owner = null; txt = "← " + shared; }
      ac.pc += 1; rows.append(laneRow({ lane, op, text: txt }, shared)); paint();
    }
    function reset() { shared = b.shared.start; actors = [{ pc: 0, local: null }, { pc: 0, local: null }]; owner = null; rows.replaceChildren(); result.textContent = ""; paint(); }
    reset();
    return {
      el: h("div.sched", null, h("div.sched__bar", null, h("ul.goals", null, goals), lock?.el, h("button.btn.btn--quiet", { text: T.reset, attr: { type: "button" }, on: { click: reset } })),
        h("div.lanes__grid", null, h("div.lanes__head.lanes__head--a", { text: b.lanes[0] }), h("div.lanes__head.lanes__head--mid", { text: name }), h("div.lanes__head.lanes__head--b", { text: b.lanes[1] }), [rows, h("div.lrow.lrow--controls", null, h("div.lcell.lcell--a", null, buttons[0]), h("div.lcell.lcell--mid", null, value), h("div.lcell.lcell--b", null, buttons[1]))]), result),
    };
  };

  L.blocks.experiment = (b, ctx) => {
    const exp = ctx.lesson.experiments[b.lab], shown = exp.variants.filter((v) => b.show.includes(v.id)), base = exp.variants[0], metric = exp.metric, time = exp.time;
    let variant = b.select || shown[0].id, knob = b.at || (exp.knob ? exp.knob.default : "-"), seen = b.hand ? 0 : exp.repeat;
    const runsOf = (id) => exp.results.variants[id].runs[knob];
    const view = L.codeView(), note = h("p.exp__note"), finding = h("p.exp__finding"), ticks = h("div.plot__ticks", null, h("span", { text: "0" }), h("span.is-expect"));
    const reachable = exp.knob && b.knob !== false ? exp.knob.values : [knob];
    const axisTop = 1.04 * Math.max(1, ...shown.flatMap((it) => reachable.flatMap((v) => exp.results.variants[it.id].runs[v].flatMap((r) => [r[metric.key], r[metric.expectKey]]))));
    const rows = shown.map((it) => {
      const dots = Array.from({ length: exp.repeat }, () => h("i.dot"));
      const sum = h("span.plot__sum"), label = h("button.plot__label", { text: it.label, attr: { type: "button" }, on: { click: () => { variant = it.id; tabs?.pick(it.id); draw(); } } });
      return { it, dots, sum, el: h("div.plot__row", null, label, h("div.plot__track", null, dots), sum), track: null };
    });
    rows.forEach((r) => { r.track = r.el.children[1]; });
    function draw() {
      const item = exp.variants.find((c) => c.id === variant) || shown[0];
      const src = exp.sources?.[variant] || "";
      if (src) view.show(src, { path: exp.paths?.[variant] || "", lang: exp.lang || "java", changed: variant === base.id ? [] : L.changedLines(exp.sources?.[base.id] || "", src), focus: variant === base.id ? b.focusLines || [] : [] });
      note.textContent = item.note || "";
      rows.forEach((r) => {
        const runs = runsOf(r.it.id), misses = runs.map((x) => x[metric.key] - x[metric.expectKey]), wrong = misses.filter(Boolean).length, expVal = runs[0][metric.expectKey];
        r.track.style.setProperty("--expect", ((expVal / axisTop) * 100) + "%");
        runs.forEach((run, i) => {
          r.dots[i].style.left = ((run[metric.key] / axisTop) * 100) + "%";
          r.dots[i].classList.toggle("is-ok", run[metric.key] === run[metric.expectKey]);
          r.dots[i].classList.toggle("is-waiting", b.hand && r === rows[0] && i >= seen);
        });
        r.sum.replaceChildren(h("b" + (wrong ? "" : ".is-ok"), { text: wrong === 0 ? T.allRight(runs.length) : wrong === runs.length ? T.allWrong(runs.length) : T.someWrong(wrong) }),
          time ? h("span.num", { text: T.median + medianOf(runs.map((x) => x[time.key])) + " " + time.unit }) : null);
        r.el.classList.toggle("is-on", r.it.id === variant);
        if (r.it.id === variant) { ticks.style.setProperty("--expect", ((expVal / axisTop) * 100) + "%"); ticks.lastChild.textContent = T.expectPrefix + L.num(expVal); }
      });
      const curRuns = runsOf(item.id), curWrong = curRuns.filter((x) => x[metric.key] !== x[metric.expectKey]).length;
      finding.replaceChildren(L.md("**" + item.label + "**: " + (curWrong === 0 ? T.allRight(curRuns.length) : T.someWrong(curWrong))));
    }
    const more = h("button.btn.btn--primary", { text: T.seeFirst, attr: { type: "button" }, on: { click: () => { seen = Math.min(exp.repeat, seen + 1); more.textContent = T.seeNext; if (seen >= exp.repeat) hand.hidden = true; draw(); ctx?.reportState?.(true); } } });
    const rest = h("button.btn", { text: T.seeRest(exp.repeat), attr: { type: "button" }, on: { click: () => { seen = exp.repeat; hand.hidden = true; draw(); ctx?.reportState?.(true); } } });
    const hand = b.hand ? h("div.exp__hand", null, more, rest) : null;
    const tabs = shown.length > 1 ? L.segmented(T.variantLabel, shown.map((x) => ({ id: x.id, label: x.label })), variant, (id) => { variant = id; draw(); }) : null;
    const dial = exp.knob && b.knob !== false ? L.segmented(exp.knob.label, exp.knob.values.map((v) => ({ id: v, label: v })), knob, (v) => { knob = v; draw(); }) : null;
    draw();
    return {
      el: h("div.exp", null, tabs || dial ? h("div.exp__bar", null, tabs?.el, dial?.el) : null, h("div.exp__body", null, h("div", null, view.el, note), h("div.exp__data", null, h("div.plot", null, rows.map((r) => r.el), h("div.plot__axis", null, h("span"), ticks, h("span"))), finding, hand))),
      ready: () => seen >= exp.repeat, waitSay: T.waitHand, pass() { seen = exp.repeat; if (hand) hand.hidden = true; draw(); },
    };
  };

  L.blocks.chart = (b, ctx) => {
    const exp = ctx.lesson.experiments[b.of], y = Object.assign({ label: "Value", unit: "" }, exp.time || {}, b.y || {}), xs = exp.knob.values;
    const series = exp.variants.filter((v) => !b.show || b.show.includes(v.id)).slice(0, 4).map((v, idx) => ({
      v, slot: idx + 1,
      pts: xs.map((x) => { const runs = exp.results.variants[v.id].runs[x]; return { x, val: medianOf(runs.map((r) => r[y.key])), wrong: runs.some((r) => r[exp.metric.key] !== r[exp.metric.expectKey]) }; }),
    }));
    const top = Math.max(1, ...series.flatMap((s) => s.pts.map((p) => p.val))) * 1.1;
    const W = 560, H = 260, Lpad = 46, Rpad = 24, Tpad = 16, Bpad = 32, pw = W - Lpad - Rpad, ph = H - Tpad - Bpad;
    const px = (i) => Lpad + (xs.length <= 1 ? pw / 2 : (i * pw) / (xs.length - 1));
    const py = (val) => Tpad + ph - (val / top) * ph;
    const svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, class: "chart__svg" },
      svgEl("line", { class: "chart__base", x1: Lpad, x2: Lpad + pw, y1: Tpad + ph, y2: Tpad + ph }),
      xs.map((x, i) => svgEl("text", { class: "chart__tick", x: px(i), y: H - 10, "text-anchor": "middle" }, String(x))),
      series.map((s) => svgEl("g", { class: "chart__series--" + s.slot },
        svgEl("polyline", { class: "chart__line", points: s.pts.map((p, i) => px(i) + "," + py(p.val)).join(" ") }),
        s.pts.map((p, i) => svgEl("circle", { class: "chart__dot" + (p.wrong ? " is-wrong" : ""), cx: px(i), cy: py(p.val), r: 4.5 })))));
    const read = h("p.chart__read");
    const btns = series.map((s) => h("button.chart__pick", { text: s.v.label, attr: { type: "button" }, on: { click: () => { read.replaceChildren(L.md("**" + s.v.label + "**: " + s.pts[0].val + " → " + s.pts.at(-1).val + " " + y.unit)); } } }));
    return {
      el: h("figure.chart", null, h("figcaption.chart__cap", null, h("b", { text: y.label + (y.unit ? " (" + y.unit + ")" : "") })), svg, h("div.chart__side", null, h("div.chart__picks", null, btns), read)),
      steps: (b.walk || []).map((w) => ({ say: w.say, key: w.key })),
    };
  };
}
