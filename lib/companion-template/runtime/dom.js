/* Core DOM, SVG, MathML, markdown, syntax highlighting, tooltip, code view,
   segmented controls, persistence, and actor-diagram helpers for companion lessons. */

const SVG_NS = "http://www.w3.org/2000/svg";

const SVG_SYM = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ",
  phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  infty: "∞", partial: "∂", nabla: "∇", pm: "±", mp: "∓", times: "×", cdot: "·",
  le: "≤", leq: "≤", ge: "≥", geq: "≥", ne: "≠", neq: "≠", approx: "≈", equiv: "≡",
  to: "→", rightarrow: "→", leftarrow: "←", implies: "⟹", iff: "⇔",
  vdash: "⊢", models: "⊨", top: "⊤", bot: "⊥", Box: "□", Diamond: "◇", degree: "°",
};

const KW_JAVA = new Set("abstract boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public record return short static super switch synchronized this throw throws try var void volatile while true false".split(" "));
const KW_PY = new Set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None".split(" "));
const KW_JS = new Set("async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null return static super switch this throw true try typeof undefined var void while yield".split(" "));
const KW_SQL = new Set("SELECT FROM WHERE INSERT UPDATE DELETE JOIN LEFT RIGHT INNER ON GROUP BY ORDER HAVING LIMIT BEGIN COMMIT ROLLBACK FOR SHARE LOCK IN MODE SET VALUES INTO CREATE TABLE INDEX".split(" "));
const KW_PROOF_EN = "Theorem Lemma Proof Given Assume Suppose Let Therefore Hence Thus Contradiction Premise Conclusion Case Step QED";

function cleanSvgTex(tex) {
  return String(tex ?? "")
    .replace(/\^\s*(?:\{\s*\\circ\s*\}|\\circ)/g, "°")
    .replace(/\\(?:text|mathrm|mathbf|bm|operatorname|mathit)\{([^{}]*)\}/g, "$1")
    .replace(/\\([A-Za-z]+)/g, (_, c) => SVG_SYM[c] || c)
    .replace(/\\[,:;! ]/g, " ")
    .replace(/[{}]/g, "");
}

export function createDomRuntime({ lesson, boot, T, extraProofKeywords = "" }) {
  const L = (window.Lesson = { blocks: {}, glossary: lesson.terms || {} });

  L.h = function (spec, props, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag || "div");
    if (classes.length) el.className = classes.join(" ");
    if (props) {
      if (props.text !== undefined) el.textContent = props.text;
      for (const [name, value] of Object.entries(props.attr || {})) {
        if (value !== undefined && value !== null && value !== false) el.setAttribute(name, String(value));
      }
      for (const [name, fn] of Object.entries(props.on || {})) el.addEventListener(name, fn);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  };
  const h = L.h;

  const svgEl = (tag, attrs, ...kids) => {
    const el = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  };

  L.num = (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });

  L.svgText = function (target, raw) {
    const str = String(raw ?? "");
    const expanded = str.replace(/@@SHM_(\d+)@@/g, (_, idx) => {
      const entry = Array.isArray(lesson._math) ? lesson._math[Number(idx)] : null;
      return entry ? String(entry.tex || "") : "";
    });
    target.replaceChildren();
    const scriptRe = /([_^])(?:\{([^{}]*)\}|([A-Za-z0-9+-]))/g;
    let last = 0;
    for (let m = scriptRe.exec(expanded); m; m = scriptRe.exec(expanded)) {
      const chunk = cleanSvgTex(expanded.slice(last, m.index));
      if (chunk) target.append(chunk);
      const body = cleanSvgTex(m[2] !== undefined ? m[2] : m[3]);
      if (m[1] === "^" && body === "°") target.append("°");
      else if (body) target.append(svgEl("tspan", { "baseline-shift": m[1] === "_" ? "sub" : "super", "font-size": "78%" }, body));
      last = scriptRe.lastIndex;
    }
    const tail = cleanSvgTex(expanded.slice(last));
    if (tail) target.append(tail);
    return target;
  };

  const mathParser = typeof DOMParser === "function" ? new DOMParser() : null;
  const mathCache = new Map();
  function mountMathToken(index) {
    const key = Number(index);
    const entry = Array.isArray(lesson._math) ? lesson._math[key] : null;
    if (!entry || typeof entry.mathml !== "string") return document.createTextNode("");
    let template = mathCache.get(key);
    if (template === undefined) {
      template = null;
      if (mathParser) {
        try {
          const doc = mathParser.parseFromString(entry.mathml, "application/xml");
          const hasErr = typeof doc.getElementsByTagName === "function" && doc.getElementsByTagName("parsererror").length > 0;
          if (!hasErr && doc.documentElement && doc.documentElement.localName === "math") {
            template = document.importNode(doc.documentElement, true);
          }
        } catch { /* fallback to plain tex */ }
      }
      mathCache.set(key, template);
    }
    if (template) {
      const imported = template.cloneNode(true);
      if (entry.display) {
        const wrap = h("span.sh-math-block");
        wrap.append(imported);
        return wrap;
      }
      return imported;
    }
    return h("code", { text: entry.tex || "" });
  }

  L.md = function (text) {
    const str = String(text ?? "");
    const out = document.createDocumentFragment();
    const pattern = /@@SHM_(\d+)@@|\*\*([^*]+)\*\*|`([^`]+)`|==([^=]+)==/g;
    let last = 0;
    for (let hit = pattern.exec(str); hit; hit = pattern.exec(str)) {
      if (hit.index > last) out.append(str.slice(last, hit.index));
      if (hit[1] !== undefined) out.append(mountMathToken(hit[1]));
      else if (hit[2] !== undefined) out.append(h("b", { text: hit[2] }));
      else if (hit[3] !== undefined) out.append(L.term(hit[3], h("code", { text: hit[3] })));
      else out.append(h("mark", { text: hit[4] }));
      last = pattern.lastIndex;
    }
    if (last < str.length) out.append(str.slice(last));
    return out;
  };

  const kwProofList = (KW_PROOF_EN + (extraProofKeywords ? " " + extraProofKeywords : "")).trim().split(/\s+/).filter(Boolean);
  const KW_PROOF = new Set(kwProofList);
  const LANGS = {
    java: { words: KW_JAVA, comment: "//" },
    python: { words: KW_PY, comment: "#" },
    js: { words: KW_JS, comment: "//" },
    javascript: { words: KW_JS, comment: "//" },
    sql: { words: KW_SQL, comment: "--" },
    proof: { words: KW_PROOF, comment: "//" },
    argument: { words: KW_PROOF, comment: "//" },
    derivation: { words: KW_PROOF, comment: "//" },
    text: { words: new Set(), comment: "\n" },
  };
  const TOKEN = /(\/\/.*$|#.*$|--.*$)|("(?:[^"\\]|\\.)*")|('(?:[^'\\]|\\.)*')|\b(\d[\d_]*(?:\.\d+)?[LlFfDd]?)\b|\b([A-Za-z_]\w*)\b/g;

  L.colour = function (line, lang) {
    if (/@@SHM_\d+@@/.test(line)) return L.md(line);
    const cfg = LANGS[lang] || LANGS.text;
    const out = document.createDocumentFragment();
    let last = 0;
    TOKEN.lastIndex = 0;
    for (let hit = TOKEN.exec(line); hit; hit = TOKEN.exec(line)) {
      const kind = hit[1] ? (hit[1].startsWith(cfg.comment) ? "c" : "") : hit[2] || hit[3] ? "s" : hit[4] ? "n" : cfg.words.has(hit[5]) ? "k" : "";
      out.append(line.slice(last, hit.index));
      out.append(kind ? h("span.tk-" + kind, { text: hit[0] }) : hit[0]);
      last = TOKEN.lastIndex;
    }
    out.append(line.slice(last));
    return out;
  };

  const tip = h("div.tip", { attr: { role: "tooltip", id: "lesson-tip", hidden: "" } });
  let tipFor = null, tipTimer = 0;
  function showTip(anchor, word) {
    clearTimeout(tipTimer);
    tipFor = anchor;
    tip.replaceChildren(h("b.mono", { text: word }), h("span", null, L.md(L.glossary[word])));
    tip.hidden = false;
    if (!tip.isConnected) document.body.append(tip);
    const box = anchor.getBoundingClientRect(), width = tip.offsetWidth, height = tip.offsetHeight;
    tip.style.left = Math.max(8, Math.min(window.innerWidth - width - 8, box.left + box.width / 2 - width / 2)) + "px";
    tip.style.top = (box.bottom + height + 14 > window.innerHeight ? box.top - height - 8 : box.bottom + 8) + "px";
  }
  L.hideTip = function () { clearTimeout(tipTimer); tip.hidden = true; tipFor = null; };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") L.hideTip(); });
  document.addEventListener("click", (e) => { if (tipFor && !tipFor.contains(e.target)) L.hideTip(); });

  L.term = function (word, content) {
    if (!Object.prototype.hasOwnProperty.call(L.glossary, word) || !L.glossary[word]) return content;
    return h("span.term", {
      attr: { tabindex: "0", role: "button", "aria-describedby": "lesson-tip" },
      on: {
        mouseenter(e) { const a = e.currentTarget; tipTimer = setTimeout(() => showTip(a, word), 140); },
        mouseleave: L.hideTip,
        focus(e) { showTip(e.currentTarget, word); },
        blur: L.hideTip,
        click(e) { e.stopPropagation(); if (tipFor === e.currentTarget) L.hideTip(); else showTip(e.currentTarget, word); },
      },
    }, content);
  };

  L.codeLine = function (line, lang) {
    if (/@@SHM_\d+@@/.test(line)) return L.md(line);
    const words = Object.keys(L.glossary).sort((a, b) => b.length - a.length);
    const cfg = LANGS[lang] || LANGS.text;
    const comment = line.indexOf(cfg.comment);
    const limit = comment < 0 ? line.length : comment;
    const out = document.createDocumentFragment();
    let from = 0;
    for (let at = 0; at < limit;) {
      const word = words.find((c) => line.startsWith(c, at)
        && !(/\w/.test(c[0]) && /\w/.test(line[at - 1] || ""))
        && !(/\w/.test(c.at(-1)) && /\w/.test(line[at + c.length] || "")));
      if (!word) { at++; continue; }
      out.append(L.colour(line.slice(from, at), lang), L.term(word, h("span", null, L.colour(word, lang))));
      at += word.length; from = at;
    }
    out.append(L.colour(line.slice(from), lang));
    return out;
  };

  L.changedLines = function (base, other) {
    const a = String(base || "").split("\n"), b = String(other || "").split("\n");
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
      }
    }
    const changed = [];
    for (let i = 0, j = 0; j < b.length;) {
      if (i < a.length && a[i] === b[j]) { i++; j++; } else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) i++; else changed.push(++j);
    }
    return changed;
  };

  L.codeView = function () {
    const scroll = h("div.code__scroll", { attr: { tabindex: "0" } });
    const label = h("div.code__path");
    const el = h("div.code", null, label, scroll);
    return {
      el,
      onLine(fn) {
        scroll.addEventListener("click", (e) => {
          const row = e.target.closest(".code__line");
          if (row) fn([...scroll.children].indexOf(row) + 1);
        });
        scroll.addEventListener("keydown", (e) => {
          const row = e.target.closest(".code__line");
          if (!row) return;
          const rows = [...scroll.children];
          const idx = rows.indexOf(row);
          if (idx < 0) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            fn(idx + 1);
            scroll.children[idx]?.focus?.();
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            e.stopPropagation();
            const nextIdx = e.key === "ArrowDown" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx - 1);
            rows[nextIdx]?.focus?.();
          }
        });
      },
      show(source, { path = "", lang = "text", focus = [], changed = [], wrong = [], tags = {}, interactive = false, pickable = false, pickedLines = [] } = {}) {
        label.textContent = path;
        label.hidden = !path;
        el.classList.toggle("has-focus", focus.length > 0);
        scroll.setAttribute("tabindex", interactive ? "-1" : "0");
        scroll.replaceChildren(...String(source || "").split("\n").map((ln, i) => {
          const lineNo = i + 1;
          const st = changed.includes(lineNo) ? ".is-changed" : focus.includes(lineNo) ? ".is-focus" : wrong.includes(lineNo) ? ".is-wrong" : "";
          const rowAttr = interactive
            ? { role: "button", tabindex: "0", "aria-pressed": String(pickedLines.includes(lineNo)), "aria-disabled": pickable ? null : "true" }
            : null;
          return h("div.code__line" + st, rowAttr ? { attr: rowAttr } : null,
            h("span.code__no", { attr: { "data-no": String(lineNo), "aria-hidden": "true" } }),
            h("span", null, L.codeLine(ln, lang)),
            tags[lineNo] ? h("span.code__tag", null, L.md(tags[lineNo])) : null);
        }));
        requestAnimationFrame(() => {
          const first = scroll.querySelector(".is-changed, .is-focus");
          if (first) scroll.scrollTop = Math.max(0, first.offsetTop - scroll.offsetTop - scroll.clientHeight / 3);
        });
      },
    };
  };

  L.segmented = function (label, options, selected, onPick) {
    let curIdx = Math.max(0, options.findIndex((o) => o.id === selected));
    const buttons = options.map((opt, idx) => h("button", {
      attr: { type: "button", "aria-pressed": String(opt.id === selected), tabindex: opt.id === selected || (curIdx === 0 && idx === 0) ? "0" : "-1" },
      on: {
        click() { pick(opt.id); onPick(opt.id); },
        keydown(e) {
          if (options.length < 2) return;
          let nextIdx = -1;
          if (e.key === "ArrowRight" || e.key === "ArrowDown") nextIdx = (idx + 1) % options.length;
          else if (e.key === "ArrowLeft" || e.key === "ArrowUp") nextIdx = (idx - 1 + options.length) % options.length;
          else if (e.key === "Home") nextIdx = 0;
          else if (e.key === "End") nextIdx = options.length - 1;
          if (nextIdx >= 0) {
            e.preventDefault();
            e.stopPropagation();
            const targetOpt = options[nextIdx];
            pick(targetOpt.id);
            buttons[nextIdx].focus();
            onPick(targetOpt.id);
          }
        },
      },
    }, L.md(String(opt.label))));
    function pick(id) {
      curIdx = Math.max(0, options.findIndex((o) => o.id === id));
      buttons.forEach((b, i) => {
        const active = options[i].id === id;
        b.setAttribute("aria-pressed", String(active));
        b.setAttribute("tabindex", i === curIdx ? "0" : "-1");
      });
    }
    return { el: h("div.seg", null, label ? h("span", null, L.md(label)) : null, h("div.seg__set", { attr: { role: "group", "aria-label": label || "select" } }, buttons)), pick };
  };

  L.memory = function (key) {
    let data = Object.assign(
      {},
      boot && boot.memory && typeof boot.memory === "object" ? boot.memory : {},
      boot && boot.savedState && boot.savedState.memory && typeof boot.savedState.memory === "object" ? boot.savedState.memory : {},
    );
    try { const raw = localStorage.getItem(key); if (raw) data = Object.assign(JSON.parse(raw), data); } catch { /* sandboxed */ }
    return {
      all: () => data,
      get: (name, fallback) => (Object.prototype.hasOwnProperty.call(data, name) ? data[name] : fallback),
      set(name, value) {
        data[name] = value;
        try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* sandboxed */ }
      },
    };
  };

  L.sharePicture = function ({ actors, shared, hands = true }) {
    const side = ["a", "b"];
    const value = h("b.pic__value"), boardTags = h("div.pic__tags"), board = h("div.pic__board", null, value);
    const boardName = h("div.pic__over", null, h("span.pic__name", null, L.md(shared)), boardTags);
    const action = h("span.pic__action");
    const fig = () => svgEl("svg", { viewBox: "0 0 44 40", class: "pic__figure", "aria-hidden": "true" }, svgEl("circle", { cx: 22, cy: 10, r: 8.5 }), svgEl("path", { d: "M4 40v-4a18 14 0 0 1 36 0v4" }));
    const arrowG = (x1, y1, x2, y2) => {
      const len = Math.hypot(x2 - x1, y2 - y1), ux = (x2 - x1) / len, uy = (y2 - y1) / len;
      const tx = x2 - ux * 3, ty = y2 - uy * 3, bx = tx - ux * 9, by = ty - uy * 9;
      return svgEl("g", { class: "pic__arrow" }, svgEl("line", { x1: x1 + ux * 3, y1: y1 + uy * 3, x2: bx, y2: by }),
        svgEl("polygon", { points: tx + "," + ty + " " + (bx - uy * 4.5) + "," + (by + ux * 4.5) + " " + (bx + uy * 4.5) + "," + (by - ux * 4.5) }));
    };
    const people = actors.slice(0, 2).map((name, i) => {
      const tags = h("div.pic__tags"), note = h("span.pic__note"), held = h("b");
      return {
        tags, note, held,
        el: h("div.pic__actor.pic__actor--" + side[i], null, fig(), h("span.pic__name", null, L.md(name)), tags, note),
        hand: hands ? h("div.pic__hand.pic__hand--" + side[i], null, h("small", { text: T.held }), held) : null,
      };
    });
    const ends = hands ? [[124, 110, 104, 144], [176, 110, 196, 144]] : [[122, 110, 62, 192], [178, 110, 238, 192]];
    const arrows = ends.map(([bx, by, px, py]) => ({ in: arrowG(bx, by, px, py), out: arrowG(px, py, bx, by) }));
    const lines = svgEl("svg", { viewBox: "0 0 300 300", class: "pic__lines", "aria-hidden": "true" }, arrows.flatMap((p) => [p.in, p.out]));
    const el = h("div.pic" + (hands ? "" : ".pic--plain"), { attr: { role: "img" } }, lines, boardName, board, action, people.flatMap((p) => [p.hand, p.el]));
    const fill = (box, texts) => box.replaceChildren(...(texts || []).map((t) => h("span", { text: t })));
    return {
      el,
      set(st) {
        const mv = st.move, tags = st.tags || {};
        value.textContent = String(st.value ?? "");
        board.classList.toggle("is-now", mv?.op === "write" || st.hot === "shared");
        fill(boardTags, tags.shared);
        action.textContent = tags.action || "";
        people.forEach((p, i) => {
          const mine = mv?.lane === i;
          if (p.hand) {
            const txt = st.hands?.[i];
            p.held.textContent = txt ?? "";
            p.hand.classList.toggle("is-empty", txt === null || txt === undefined);
            p.hand.classList.toggle("is-now", mine && (mv.op === "read" || mv.op === "calc"));
          }
          const n = st.notes?.[i];
          p.note.textContent = n?.text || "";
          p.note.className = "pic__note" + (n?.tone ? " pic__note--" + n.tone : "");
          p.el.classList.toggle("is-now", st.hot === "actors" || (mine && mv.op === "note"));
          fill(p.tags, tags.actors);
          arrows[i].in.classList.toggle("is-on", mine && mv.op === "read");
          arrows[i].out.classList.toggle("is-on", (mine && mv.op === "write") || Boolean(tags.action));
        });
      },
    };
  };

  L.shareFrames = function (steps, start) {
    const frames = [{ value: start, hands: [null, null], notes: [null, null], move: null }];
    for (const st of steps) {
      const last = frames.at(-1);
      const frame = { value: last.value, hands: [...last.hands], notes: last.notes.map((n) => (n?.tone === "fail" ? null : n)), move: { lane: st.lane, op: st.op } };
      if (st.op === "read") frame.hands[st.lane] = String(frame.value);
      else if (st.op === "calc") frame.hands[st.lane] = st.text.includes("=") ? st.text.split("=").pop().trim() : st.text;
      else if (st.op === "write") { frame.value = st.value; frame.hands[st.lane] = null; }
      else frame.notes[st.lane] = { text: st.text, tone: st.tone };
      frames.push(frame);
    }
    return frames.concat(Object.assign({}, frames.at(-1), { move: null }));
  };

  return { L, h, svgEl, SVG_NS };
}
