/* Browser stage runtime embedded into self-contained `studyhub-lesson/1` HTML files.
   Zero external dependencies, zero innerHTML on prose/code (MathML spans come only from
   server-verified `_math` entries via XML DOMParser), full bilingual (zh/en) stage chrome,
   25 interactive block types across STEM & humanities, and native StudyHub postMessage bridge. */

export const LESSON_TEMPLATE_RUNTIME_JS = String.raw`
(function () {
  "use strict";
  const lesson = JSON.parse(document.getElementById("lesson-data").textContent);
  const bootEl = document.getElementById("sh-companion-boot");
  const boot = bootEl ? (function () { try { return JSON.parse(bootEl.textContent); } catch { return null; } })() : null;
  const isEn = lesson.language === "en";

  const T = isEn ? {
    progressAria: "Lesson progress",
    voiceAria: "Teacher narration",
    notesBtn: (n) => "Takeaways " + n,
    notesEmpty: "Key conclusions appear here as you step through the lesson.",
    keyAdded: (k) => "Key takeaway: " + k,
    dark: "Dark",
    light: "Light",
    prev: "Previous step",
    next: "Next ",
    askBtn: "+ Ask / Note",
    askSel: "Ask about selection",
    needsTitle: "Prerequisites",
    afterTitle: (m) => "After this lesson (~" + m + " min)",
    waitPick: "Pick an answer first. Guessing wrong is fine; press Next again to skip.",
    waitSpot: "Click the line or step you suspect first. Press Next again to reveal.",
    waitHand: "Release the runs first to see what happens. Press Next again to skip.",
    recallAll: (n) => "All " + n + " foundations solid — ready to dive in.",
    recallSome: (r, n) => r + " of " + n + " recalled. Glance at the note under any missed item.",
    casesAll: (n) => "All " + n + " scenarios nailed.",
    casesSome: (r, n) => r + " of " + n + " matched. Review the rule for the ones missed.",
    sceneCols: ["Intuition scene", "Formal model"],
    spotHow: "Click the step or line on the left that contains the flaw.",
    insideWhat: "Step-by-step structural anatomy:",
    yourGuess: "Your prediction",
    actual: "Actual outcome",
    noGuess: "Skipped prediction",
    chooseCols: ["Solves", "Trade-off / Limit", "When to use"],
    egPrefix: "e.g. ",
    askedTitle: "How exams & interviews test this",
    right: "Correct",
    wrong: "Not quite",
    sayStart: "Start speaking",
    sayResume: "Resume",
    sayPause: "Pause",
    sayDone: "Done — check key points",
    sayShowModel: "Show model answer",
    sayHideModel: "Hide model answer",
    sayScore: (c, t) => "Covered " + c + " of " + t + " key points.",
    showAns: "Show answer",
    hideAns: "Hide",
    held: "in hand",
    now: "Current state",
    lanesRight: "Right — press Next to watch it happen.",
    lanesWrong: "Not quite — press Next to see what actually happens.",
    variantLabel: "Variant",
    allRight: (n) => "All " + n + " valid",
    allWrong: (n) => "All " + n + " failed",
    someWrong: (n) => n + " failed",
    median: "median ",
    expectPrefix: "Expected ",
    seeFirst: "Run trial 1",
    seeNext: "Run one more",
    seeRest: (n) => "Release remaining " + n + " runs",
    handEmpty: "Press below to inspect the first trial.",
    replay: "Replay",
    reset: "Reset",
    noLock: "Unlocked",
    sboxHint: "Move pointer across plot (or press ←/→ on plot) to inspect exact (x, y) values",
    sboxPinned: "(pinned — click plot to release)",
    sboxEq: "Equilibrium y = 0",
    sboxThresh: "Threshold",
    stepDown: "Decrease ",
    stepUp: "Increase ",
    mtxPredictOff: "Predict before reveal",
    mtxPredictOn: "Reveal all verdicts",
    mtxClickReveal: "Predict first — click card to reveal verdict",
    schemHint: "Click any block above to inspect its role & mechanism.",
    sboxField: "Direction field",
    kbdTitle: "Keyboard shortcuts",
    kbdNext: "Next moment / slide",
    kbdPrev: "Previous moment / slide",
    kbdSlider: "5x coarse step on sliders & plot",
    kbdEsc: "Close tips, notes, pin, or help",
    kbdToggle: "Toggle shortcut help",
    printSlide: (i, n) => "Slide " + i + " / " + n,
    tryTitle: "Hands-on Workshop",
    tryScratch: "Scratchpad / Draft",
    tryPlaceholder: "Sketch your proof, counterexample, or parameter derivation here...",
    tryShowHint: "Show hint",
    tryHideHint: "Hide hint",
    tryShowSol: "Reveal reference solution",
    tryHideSol: "Hide solution",
    mtxRevealAll: "Reveal all",
    schemTrace: "Step trace",
    schemTraceNext: "Next link →",
    tocTitle: "Slide map",
    kbdToc: "Open / close slide map",
  } : {
    progressAria: "这节课走到哪了",
    voiceAria: "老师的讲解",
    notesBtn: (n) => "要点 " + n,
    notesEmpty: "讲到关键结论时，会自动记在这里。",
    keyAdded: (k) => "已记入要点：" + k,
    dark: "深色",
    light: "浅色",
    prev: "上一步",
    next: "下一步 ",
    askBtn: "＋ 记疑问",
    askSel: "💬 就这句提问",
    needsTitle: "需要先会",
    afterTitle: (m) => "学完你能（约 " + m + " 分钟）",
    waitPick: "先选一个再往下。猜错没关系；实在想跳过，再按一次。",
    waitSpot: "先在左边点出你怀疑的那一行/那一步。点错会有提示；实在想跳过，再按一次。",
    waitHand: "先点「看第 1 次运行」，把结果放出来。实在想跳过，再按一次。",
    recallAll: (n) => n + " 样都记得，可以开始了。",
    recallSome: (r, n) => n + " 样里记得 " + r + " 样。没记住的看一眼下面那句话就够用了。",
    casesAll: (n) => n + " 个场景都选对了，这条判准是你的了。",
    casesSome: (r, n) => n + " 个里选对 " + r + " 个，对照理由再回想一下判准。",
    sceneCols: ["直觉场景", "核心模型"],
    spotHow: "在左边点出你怀疑有问题的一行或一步。",
    insideWhat: "底层机制逐行拆解：",
    yourGuess: "你猜的",
    actual: "实际结果",
    noGuess: "刚才没猜",
    chooseCols: ["解决什么", "代价与边界", "什么时候用"],
    egPrefix: "例：",
    askedTitle: "考题与面试常这样追问",
    right: "对",
    wrong: "不对",
    sayStart: "开始讲",
    sayResume: "接着讲",
    sayPause: "暂停",
    sayDone: "讲完了，对要点",
    sayShowModel: "看一份参考回答",
    sayHideModel: "收起参考回答",
    sayScore: (c, t) => t + " 个要点，你讲到了 " + c + " 个。",
    showAns: "看答案",
    hideAns: "收起",
    held: "手里",
    now: "此刻状态",
    lanesRight: "对。按下一步，看它是怎么发生的。",
    lanesWrong: "不是这个。按下一步，看实际发生了什么。",
    variantLabel: "方案",
    allRight: (n) => n + " 次全对",
    allWrong: (n) => n + " 次全错",
    someWrong: (n) => "错了 " + n + " 次",
    median: "中位 ",
    expectPrefix: "期望 ",
    seeFirst: "看第 1 次运行",
    seeNext: "再看一次",
    seeRest: (n) => "把剩下的 " + n + " 次一起放出来",
    handEmpty: "点下面的按钮，看第 1 次结果。",
    replay: "再放一遍",
    reset: "重来",
    noLock: "不加保护",
    sboxHint: "在图上移动指针（或聚焦图表按 ←/→）查看精确 (x, y) 读数",
    sboxPinned: "（已锁定——再次点击图表解除）",
    sboxEq: "平衡线 y = 0",
    sboxThresh: "参考阈值",
    stepDown: "减小 ",
    stepUp: "增大 ",
    mtxPredictOff: "先猜后看结论",
    mtxPredictOn: "展开全部结论",
    mtxClickReveal: "先想一想该理论会怎么判，点击卡片揭晓",
    schemHint: "点击上方任意模块，查看其内部机理与职责说明。",
    sboxField: "相平面方向场",
    kbdTitle: "键盘快捷键",
    kbdNext: "下一步 / 下一页",
    kbdPrev: "上一步 / 上一页",
    kbdSlider: "滑块与游标 5x 快速调节",
    kbdEsc: "关闭提示、要点、游标锁定或帮助",
    kbdToggle: "展开 / 收起快捷键说明",
    printSlide: (i, n) => "第 " + i + " / " + n + " 页",
    tryTitle: "动手推演工坊",
    tryScratch: "草稿与推演记录",
    tryPlaceholder: "在这里写下你的证明思路、反例构造或参数整定步骤……",
    tryShowHint: "查看提示",
    tryHideHint: "收起提示",
    tryShowSol: "查看参考解答",
    tryHideSol: "收起解答",
    mtxRevealAll: "揭晓全部",
    schemTrace: "逐步追踪",
    schemTraceNext: "下一环节 →",
    tocTitle: "全课目录",
    kbdToc: "展开 / 收起全课目录",
  };

  const L = (window.Lesson = { blocks: {}, glossary: lesson.terms || {} });
  const NS = "http://www.w3.org/2000/svg";

  L.h = function (spec, props, ...kids) {
    const [tag, ...classes] = spec.split(".");
    const el = document.createElement(tag || "div");
    if (classes.length) el.className = classes.join(" ");
    if (props) {
      if (props.text !== undefined) el.textContent = props.text;
      for (const [name, value] of Object.entries(props.attr || {})) if (value !== undefined && value !== null && value !== false) el.setAttribute(name, String(value));
      for (const [name, fn] of Object.entries(props.on || {})) el.addEventListener(name, fn);
    }
    for (const kid of kids.flat()) if (kid !== null && kid !== undefined && kid !== false) el.append(kid);
    return el;
  };
  const h = L.h;
  const svgEl = (tag, attrs, ...kids) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) if (v !== undefined && v !== null) el.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid) el.append(kid);
    return el;
  };

  L.num = (v) => Number(v).toLocaleString("en-US", { maximumFractionDigits: 4 });

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
  function cleanSvgTex(tex) {
    return String(tex ?? "")
      .replace(/\^\s*(?:\{\s*\\circ\s*\}|\\circ)/g, "°")
      .replace(/\\(?:text|mathrm|mathbf|bm|operatorname|mathit)\{([^{}]*)\}/g, "$1")
      .replace(/\\([A-Za-z]+)/g, (_, c) => SVG_SYM[c] || c)
      .replace(/\\[,:;! ]/g, " ")
      .replace(/[{}]/g, "");
  }
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

  function mountMathToken(index) {
    const entry = Array.isArray(lesson._math) ? lesson._math[Number(index)] : null;
    if (!entry || typeof entry.mathml !== "string") return document.createTextNode("");
    try {
      const doc = new DOMParser().parseFromString(entry.mathml, "application/xml");
      if (doc.documentElement && doc.documentElement.localName === "math") {
        const imported = document.importNode(doc.documentElement, true);
        if (entry.display) {
          const wrap = h("span.sh-math-block");
          wrap.append(imported);
          return wrap;
        }
        return imported;
      }
    } catch { /* fallback to plain tex */ }
    return h("code", { text: entry.tex || "" });
  }

  L.md = function (text) {
    const str = String(text ?? "");
    const out = document.createDocumentFragment();
    const pattern = /@@SHM_(\d+)@@|\*\*([^*]+)\*\*|\x60([^\x60]+)\x60|==([^=]+)==/g;
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

  const KW_JAVA = new Set("abstract boolean break byte case catch char class continue default do double else enum extends final finally float for if implements import instanceof int interface long new null package private protected public record return short static super switch synchronized this throw throws try var void volatile while true false".split(" "));
  const KW_PY = new Set("and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield True False None".split(" "));
  const KW_JS = new Set("async await break case catch class const continue default delete do else export extends false finally for from function if import in instanceof let new null return static super switch this throw true try typeof undefined var void while yield".split(" "));
  const KW_SQL = new Set("SELECT FROM WHERE INSERT UPDATE DELETE JOIN LEFT RIGHT INNER ON GROUP BY ORDER HAVING LIMIT BEGIN COMMIT ROLLBACK FOR SHARE LOCK IN MODE SET VALUES INTO CREATE TABLE INDEX".split(" "));
  const KW_PROOF = new Set("Theorem Lemma Proof Given Assume Suppose Let Therefore Hence Thus Contradiction Premise Conclusion Case Step QED 定理 引理 证明 设 假设 若 则 因此 矛盾 前提 结论 证毕".split(" "));
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
    if (!L.glossary[word]) return content;
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
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
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
            tags[lineNo] ? h("span.code__tag", { text: tags[lineNo] }) : null);
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
      get: (name, fallback) => (name in data ? data[name] : fallback),
      set(name, value) {
        data[name] = value;
        try { localStorage.setItem(key, JSON.stringify(data)); } catch { /* sandboxed */ }
      },
    };
  };

  function postHost(payload) {
    if (!boot || !boot.channelToken || window.parent === window) return;
    try {
      window.parent.postMessage(Object.assign({ protocol: "studyhub-companion/1", token: boot.channelToken }, payload), "*");
    } catch { /* ignore */ }
  }
  L.postHost = postHost;

  /* Safe AST evaluator for parametric sandbox blocks (no eval). */
  function approxErf(x) {
    const s = x < 0 ? -1 : 1, ax = Math.abs(x), t = 1 / (1 + 0.3275911 * ax);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-ax * ax);
    return s * y;
  }
  const FN = {
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
  function evalAst(node, vars) {
    if (!node) return NaN;
    if (node.t === "num") return node.v;
    if (node.t === "var") return Object.prototype.hasOwnProperty.call(vars, node.name) ? Number(vars[node.name]) : NaN;
    if (node.t === "neg") return -evalAst(node.a, vars);
    if (node.t === "bin") {
      const l = evalAst(node.l, vars), r = evalAst(node.r, vars);
      return node.op === "+" ? l + r : node.op === "-" ? l - r : node.op === "*" ? l * r : node.op === "/" ? (r === 0 ? NaN : l / r) : node.op === "^" ? Math.pow(l, r) : NaN;
    }
    if (node.t === "call" && FN[node.fn]) return FN[node.fn](...node.args.map((a) => evalAst(a, vars)));
    return NaN;
  }

  /* Shared actor picture */
  L.sharePicture = function ({ actors, shared, hands = true }) {
    const side = ["a", "b"];
    const value = h("b.pic__value"), boardTags = h("div.pic__tags"), board = h("div.pic__board", null, value);
    const boardName = h("div.pic__over", null, h("span.pic__name", { text: shared }), boardTags);
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
        el: h("div.pic__actor.pic__actor--" + side[i], null, fig(), h("span.pic__name", { text: name }), tags, note),
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

  /* ---------- Block Makers ---------- */
  const KEYS = "ABCDEF";
  L.blocks.text = (b) => ({ el: h("p.text", null, L.md(b.md)) });
  L.blocks.points = (b) => ({ el: h("ul.points", null, (b.items || []).map((it) => h("li", null, h("span", null, L.md(it))))) });
  L.blocks.callout = (b) => ({ el: h("div.callout.callout--" + (b.tone || "info"), null, h("h4", null, L.md(b.title)), h("p", null, L.md(b.md))) });
  let tryCounter = 0;
  L.blocks.try = L.blocks.workshop = (b, ctx) => {
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

    const pulseSiblings = (rootEl) => {
      const sl = rootEl.closest?.(".slide");
      if (!sl) return;
      for (const t of sl.querySelectorAll(".exp, .sbox")) { t.classList.remove("is-invited"); void t.offsetWidth; t.classList.add("is-invited"); }
    };

    if (!isWorkshop) {
      const el = h("span.try");
      return { el, refresh() { pulseSiblings(el); } };
    }

    const slotId = b.id || ("w" + (tryCounter++) + ":" + String(b.title || bodyMd || checkItems[0] || "").slice(0, 32));
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
      const r = make(item, (j) => { answers[i] = j; ctx.memory.set(key, answers); paint(); });
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
      if (b.answerLines.includes(n)) { found = true; wrong = []; ctx.memory.set(key, true); ctx.reportState?.(true); }
      else wrong = [n];
      paint();
    });
    paint();
    return {
      el: h("div.spot", null, h("p.spot__q", null, L.md(b.q)), view.el, h("div.spot__side", null, h("p.spot__how", { text: b.how || T.spotHow }), out)),
      ready: () => found, waitSay: T.waitSpot, pass() { found = true; wrong = []; paint(); },
    };
  };

  L.blocks.inside = (b) => {
    const view = L.codeView();
    const show = (k) => view.show(b.source, { path: b.command || b.path || "", lang: b.lang || "text", focus: k ? b.walk[k - 1].focusLines : [], tags: Object.fromEntries(b.walk.slice(0, k).map((s) => [s.focusLines.at(-1), s.label])) });
    show(0);
    return { el: h("div.inside", null, h("p.inside__what", { text: b.caption || T.insideWhat }), view.el), steps: b.walk.map((s) => ({ say: s.say, key: s.key })), set: show };
  };

  function optionBtn(i, text, onPick) {
    const tag = h("span.opt__tag");
    const el = h("button.opt", { attr: { type: "button" }, on: { click: () => onPick(i) } }, h("span.opt__key", { text: KEYS[i] || String(i + 1) }), h("span", null, L.md(text)), tag);
    return { el, tag };
  }

  L.blocks.predict = (b, ctx) => {
    const key = "predict:" + b.id;
    const opts = b.options.map((t, i) => optionBtn(i, t, (idx) => { ctx.memory.set(key, idx); paint(); }));
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
      h("span.choose__name", null, L.term(opt.name, h("span", { text: opt.name }))),
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
      el: h("li.decide__branch", null, h("span.decide__when", null, L.md(br.when)), h("span.decide__pick", null, L.term(br.pick, h("span", { text: br.pick }))), br.eg ? h("small.decide__eg", { text: T.egPrefix + br.eg }) : null),
    }));
    document.addEventListener("lesson:picked", (ev) => {
      const hit = branches.find((br) => br.pick === ev.detail.name);
      if (!hit || !hit.el.isConnected) return;
      branches.forEach((br) => br.el.classList.remove("is-hit"));
      void hit.el.offsetWidth;
      hit.el.classList.add("is-hit", "is-used");
    });
    return { el: h("div.decide", null, h("p.decide__q", null, L.md(b.q)), h("ul.decide__list", null, branches.map((br) => br.el))) };
  };

  L.blocks.name = (b) => ({
    el: h("div.name", null, h("h2.name__term", { text: b.term }), b.alias ? h("p.name__alias", { text: b.alias }) : null, h("p.name__line", null, L.md(b.oneLine)),
      h("div.name__asked", null, h("h4", { text: b.askedTitle || T.askedTitle }), h("ul", null, (b.asked || []).map((q) => h("li", null, L.md(q)))))),
  });

  let quizCounter = 0;
  L.blocks.quiz = (b, ctx) => {
    const slot = "check:" + (quizCounter++);
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

  L.blocks.say = (b) => {
    const total = b.seconds || 120;
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
    function toggle() { if (timer) return stop(); if (left === 0) left = total; start.textContent = T.sayPause; timer = setInterval(() => { if (!clock.isConnected) { stop(); return; } left -= 1; draw(); if (left === 0) stop(); }, 1000); draw(); }
    function tally() { score.textContent = T.sayScore(boxes.filter((x) => x.checked).length, b.points.length); }
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

  /* Lanes & Schedule */
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
        const btn = h("button.pick", { attr: { type: "button" }, on: { click() { answers[now - 1] = i; ctx.memory.set(key, answers); paintAsk(); } } }, L.md(txt));
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
          h("div.lanes__grid", null, h("div.lanes__head.lanes__head--a", { text: b.lanes[0] }), h("div.lanes__head.lanes__head--mid", { text: b.shared.name }), h("div.lanes__head.lanes__head--b", { text: b.lanes[1] }), rows),
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
    const goals = (b.goals || []).map((g) => h("li.goal", { text: g.label }));
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

  /* Recorded benchmark experiment & chart (compatible with Java Hood Lab) */
  const median = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] || 0; };
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
          time ? h("span.num", { text: T.median + median(runs.map((x) => x[time.key])) + " " + time.unit }) : null);
        r.el.classList.toggle("is-on", r.it.id === variant);
        if (r.it.id === variant) { ticks.style.setProperty("--expect", ((expVal / axisTop) * 100) + "%"); ticks.lastChild.textContent = T.expectPrefix + L.num(expVal); }
      });
      const curRuns = runsOf(item.id), curWrong = curRuns.filter((x) => x[metric.key] !== x[metric.expectKey]).length;
      finding.replaceChildren(L.md("**" + item.label + "**: " + (curWrong === 0 ? T.allRight(curRuns.length) : T.someWrong(curWrong))));
    }
    const more = h("button.btn.btn--primary", { text: T.seeFirst, attr: { type: "button" }, on: { click: () => { seen = Math.min(exp.repeat, seen + 1); more.textContent = T.seeNext; if (seen >= exp.repeat) hand.hidden = true; draw(); } } });
    const rest = h("button.btn", { text: T.seeRest(exp.repeat), attr: { type: "button" }, on: { click: () => { seen = exp.repeat; hand.hidden = true; draw(); } } });
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
      pts: xs.map((x) => { const runs = exp.results.variants[v.id].runs[x]; return { x, val: median(runs.map((r) => r[y.key])), wrong: runs.some((r) => r[exp.metric.key] !== r[exp.metric.expectKey]) }; }),
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

  /* NEW Cross-Discipline Block 1: Parametric Sandbox (Math, Physics, Mechanics, Economics) */
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

    function paintCrosshair() {
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
    const metricsBox = h("div.sbox__metrics");
    const caption = h("p.text", { text: "" });
    if (b.caption) caption.replaceChildren(L.md(b.caption));

    function hasBreak1D(ast, x1, y1, x2, y2, yLo, yHi) {
      if ((y1 > yHi && y2 < yLo) || (y1 < yLo && y2 > yHi)) return true;
      const ySpan = Math.max(1e-9, yHi - yLo);
      const dy = Math.abs(y2 - y1);
      if (dy <= ySpan * 0.16) return false;
      const ev = (xv) => evalAst(ast, Object.assign({}, state, { [dom.variable]: xv }));
      const xa = x1 * 0.75 + x2 * 0.25, xm = (x1 + x2) * 0.5, xb = x1 * 0.25 + x2 * 0.75;
      const ya = ev(xa), ym = ev(xm), yb = ev(xb);
      if (!Number.isFinite(ya) || !Number.isFinite(ym) || !Number.isFinite(yb)) return true;
      const segLo = Math.min(y1, y2) - dy * 0.08, segHi = Math.max(y1, y2) + dy * 0.08;
      if (ya < segLo || ya > segHi || ym < segLo || ym > segHi || yb < segLo || yb > segHi) return true;
      const d1 = Math.abs(ya - y1), d2 = Math.abs(ym - ya), d3 = Math.abs(yb - ym), d4 = Math.abs(y2 - yb);
      const maxQ = Math.max(d1, d2, d3, d4), minQ = Math.min(d1, d2, d3, d4);
      if (maxQ >= dy * 0.82 && minQ <= dy * 0.04) return true;
      return false;
    }

    function approachAsymptote(ast, xValid, yValid, xGap, yLo, yHi) {
      if (yValid < yLo || yValid > yHi) return null;
      for (let k = 1; k <= 6; k++) {
        const t = 1 - Math.pow(0.5, k);
        const tx = xValid + (xGap - xValid) * t;
        const ty = evalAst(ast, Object.assign({}, state, { [dom.variable]: tx }));
        if (!Number.isFinite(ty)) break;
        if (ty < yLo || ty > yHi) return [px(tx), pyCurve(ty)];
      }
      return null;
    }

    function draw() {
      const baseSteps = dom.steps || 80;
      const steps = allParametric ? baseSteps : Math.max(baseSteps, 160);
      const midU = (domMin + domMax) / 2;
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

      /* 2D Direction / Phase-Plane Quiver Field behind trajectories */
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
        const cmds = [];
        let open = false;
        let prevPt = null;
        let prevNullX = null;
        const validScreenPts = [];
        for (const p of item.pts) {
          if (p.x === null || p.y === null) {
            if (open && !item.s.parametric && prevPt && p.x !== null) {
              const ext = approachAsymptote(item.s.ast, prevPt.x, prevPt.y, p.x, yMin, yMax);
              if (ext) cmds.push("L" + ext[0].toFixed(1) + " " + ext[1].toFixed(1));
            }
            open = false;
            prevPt = null;
            prevNullX = p.x;
          } else {
            const sx = px(p.x), sy = item.s.parametric ? py(p.y) : pyCurve(p.y);
            if (open && !item.s.parametric && prevPt && hasBreak1D(item.s.ast, prevPt.x, prevPt.y, p.x, p.y, yMin, yMax)) {
              const extLeft = approachAsymptote(item.s.ast, prevPt.x, prevPt.y, p.x, yMin, yMax);
              if (extLeft) cmds.push("L" + extLeft[0].toFixed(1) + " " + extLeft[1].toFixed(1));
              open = false;
              const extRight = approachAsymptote(item.s.ast, p.x, p.y, prevPt.x, yMin, yMax);
              if (extRight) {
                cmds.push("M" + extRight[0].toFixed(1) + " " + extRight[1].toFixed(1));
                open = true;
              }
            } else if (!open && !item.s.parametric && prevNullX !== null) {
              const extRight = approachAsymptote(item.s.ast, p.x, p.y, prevNullX, yMin, yMax);
              if (extRight) {
                cmds.push("M" + extRight[0].toFixed(1) + " " + extRight[1].toFixed(1));
                open = true;
              }
            }
            cmds.push((open ? "L" : "M") + sx.toFixed(1) + " " + sy.toFixed(1));
            if (p.y >= yMin && p.y <= yMax) validScreenPts.push([sx, sy]);
            open = true;
            prevPt = p;
            prevNullX = null;
          }
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

      /* Live Equilibrium / Intersection / Operating-Point Markers */
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

      metricsBox.replaceChildren(...comp.readouts.map((r) => {
        const refX = !hasParametric && hoverX !== null ? hoverX : midU;
        const v = evalAst(r.ast, Object.assign({}, state, { [dom.variable]: refX }));
        return h("div.sbox__metric", null, h("span", null, L.md(r.label)), h("b", { text: (Number.isFinite(v) ? L.num(Number(v.toFixed(3))) : "—") + (r.unit ? " " + r.unit : "") }));
      }));
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

  /* NEW Cross-Discipline Block 2: Dialectical / Scenario Matrix (Philosophy, Law, Ethics, Humanities) */
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

  /* NEW Cross-Discipline Block 3: Step-by-Step Schematic / Force & Causal Diagram */
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
          // Forward edge jumping cleanly over an intermediate node
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

  /* ---------- Stage Sequencer ---------- */
  const memory = L.memory("lesson:" + lesson.id);
  const predicts = {};
  for (const sl of lesson.slides) for (const bl of sl.blocks) if ((bl.t || bl.type) === "predict") predicts[bl.id] = bl;
  let at = { s: 0, m: 0 }, current = null, nudged = false, completedSent = false, stateReportTimer = 0;

  function reportState(immediate = false) {
    clearTimeout(stateReportTimer);
    const send = () => {
      if (!lesson.slides?.length) return;
      const isLast = current ? (at.s === lesson.slides.length - 1 && at.m === current.moments.length - 1) : false;
      postHost({ kind: "progress", slide: at.s + 1, slideTotal: lesson.slides.length, moment: at.m, beat: lesson.slides[at.s]?.beat || "", completed: isLast, memory: memory.all() });
    };
    if (immediate) send();
    else stateReportTimer = setTimeout(send, 160);
  }
  L.reportState = reportState;

  const ctx = { lesson, memory, predicts, reportState };
  const $ = (id) => document.getElementById(id);
  const stage = $("stage"), line = $("line"), keyLine = $("key"), prev = $("prev"), next = $("next"), count = $("count") || $("counter"), notes = $("notes"), notesList = $("notes-list");

  $("beats").setAttribute("aria-label", T.progressAria);
  document.querySelector(".voice")?.setAttribute("aria-label", T.voiceAria);
  prev.setAttribute("aria-label", T.prev);
  next.replaceChildren(h("span.btn__label", { text: T.next }), "→");
  $("title").replaceChildren(L.md((lesson.course ? lesson.course + " · " : "") + lesson.title));

  const beatList = Array.isArray(lesson.beats) && lesson.beats.length ? lesson.beats : [{ id: "open", label: "Lesson" }];
  const beatLabelMap = new Map(beatList.map((b) => [b.id, b.label]));
  const beats = beatList.map((beat) => h("button.beat", { text: beat.label, attr: { type: "button" }, on: { click: () => { const idx = lesson.slides.findIndex((s) => s.beat === beat.id); if (idx >= 0) go(idx, 0); } } }));
  $("beats").append(...beats);

  const visitedSlides = new Set(Array.isArray(memory.get("visited")) ? memory.get("visited") : []);
  const tocPop = h("div.toc__pop", { attr: { id: "toc-pop", role: "dialog", "aria-label": T.tocTitle, hidden: "" } });
  const tocWrap = h("div.toc");
  if (count && count.parentNode) {
    count.parentNode.insertBefore(tocWrap, count);
    count.classList.add("tool", "toc__btn");
    count.setAttribute("role", "button");
    count.setAttribute("tabindex", "0");
    count.setAttribute("aria-haspopup", "dialog");
    count.setAttribute("aria-expanded", "false");
    count.setAttribute("aria-controls", "toc-pop");
    count.setAttribute("title", T.tocTitle);
    tocWrap.append(count, tocPop);
  }

  function paintToc() {
    const items = lesson.slides.map((sl, idx) => {
      const isNow = idx === at.s;
      const isVis = visitedSlides.has(idx);
      const beatTxt = beatLabelMap.get(sl.beat) || sl.beat || "";
      const btn = h("button.toc__item" + (isVis ? ".is-visited" : "") + (isNow ? ".is-now" : ""), {
        attr: { type: "button", "aria-current": isNow ? "step" : "false" },
        on: { click() { setTocOpen(false); go(idx, 0); } },
      },
        h("span.toc__num", { text: String(idx + 1) }),
        h("span.toc__name", null, L.md(sl.title || ("#" + (idx + 1)))),
        beatTxt ? h("span.toc__beat", { text: beatTxt }) : null);
      return h("li", null, btn);
    });
    tocPop.replaceChildren(h("p.toc__title", { text: T.tocTitle }), h("ol.toc__list", null, items));
  }

  function setTocOpen(open) {
    if (open) paintToc();
    tocPop.hidden = !open;
    count?.setAttribute("aria-expanded", String(open));
    if (open) {
      requestAnimationFrame(() => {
        tocPop.querySelector(".toc__item.is-now")?.scrollIntoView?.({ block: "nearest" });
      });
    }
  }

  function build(index) {
    const slide = lesson.slides[index];
    const items = slide.blocks.map((block) => {
      const bType = block.t || block.type;
      const maker = L.blocks[bType] || (() => ({ el: h("p.text", { text: block.md || "" }) }));
      const made = maker(block, ctx);
      return { block, made, wrap: h("div.block.is-waiting", null, made.el), seen: false };
    });
    const moments = slide.bridge ? [{ b: -1, k: 0, say: slide.bridge }] : [];
    items.forEach((it, b) => {
      moments.push({ b, k: 0, say: it.block.say || slide.title, key: it.block.key });
      (it.made.steps || []).forEach((st, i) => moments.push({ b, k: i + 1, say: st.say ?? st, key: st.key }));
    });
    const hook = index === 0;
    const meta = hook && ((lesson.needs && lesson.needs.length) || (lesson.after && lesson.after.length)) ? h("div.hook__meta", null,
      h("div", null, h("h3", { text: T.needsTitle }), h("ul", null, (lesson.needs || []).map((x) => h("li", null, L.md(x))))),
      h("div", null, h("h3", { text: T.afterTitle(lesson.minutes || 25) }), h("ul", null, (lesson.after || []).map((x) => h("li", null, L.md(x)))))) : null;
    const el = h("section.slide" + (hook ? ".slide--hook" : "") + (slide.layout === "split" ? ".slide--split" : ""), null,
      h("h1.slide__title", null, L.md(slide.title)), h("div.slide__blocks", null, items.map((x) => x.wrap)), meta);
    return { index, items, moments, el };
  }

  function remember(key) {
    const keys = memory.get("keys", []);
    if (!keys.includes(key)) memory.set("keys", keys.concat(key));
  }

  function paintNotes() {
    const keys = memory.get("keys", []);
    notes.textContent = T.notesBtn(keys.length);
    notesList.replaceChildren(...(keys.length ? keys.map((k) => h("li", null, L.md(k))) : [h("li.is-empty", { text: T.notesEmpty })]));
  }

  function currentContext(quoteText) {
    const slide = lesson.slides[at.s] || {};
    const codeBlock = (slide.blocks || []).find((b) => b.source || Array.isArray(b.lines));
    const rawCode = codeBlock ? (codeBlock.source ?? codeBlock.lines.join("\n")) : "";
    return {
      lessonId: lesson.id,
      lessonTitle: lesson.title,
      course: lesson.course || "",
      slide: at.s + 1,
      slideTotal: lesson.slides.length,
      slideTitle: slide.title || "",
      beat: slide.beat || "",
      moment: at.m,
      teacherLine: line.textContent || "",
      quote: String(quoteText || "").trim().slice(0, 600),
      codeSlice: rawCode ? String(rawCode).split("\n").slice(0, 35).join("\n") : "",
    };
  }

  function show(spoken) {
    L.hideTip();
    if (!current || current.index !== at.s) {
      current?.items?.forEach((it) => it.made?.destroy?.());
      current = build(at.s);
      stage.replaceChildren(current.el);
      stage.scrollTop = 0;
    }
    at.m = Math.min(at.m, current.moments.length - 1);
    const now = current.moments[at.m];
    current.items.forEach((it, b) => {
      const reached = current.moments.filter((m, i) => i <= at.m && m.b === b);
      it.wrap.classList.toggle("is-waiting", reached.length === 0);
      if (!reached.length) { it.seen = false; return; }
      it.made.set?.(reached.at(-1).k);
      if (!it.seen) { it.seen = true; it.made.refresh?.(); }
    });
    line.replaceChildren(h("span", null, L.md(spoken || now.say || "")));
    line.classList.remove("is-fresh"); void line.offsetWidth; line.classList.add("is-fresh");
    keyLine.hidden = !now.key || Boolean(spoken);
    if (now.key && !spoken) { keyLine.textContent = T.keyAdded(now.key); remember(now.key); }
    paintNotes();
    const changed = current.items[now.b];
    const reducedMotion = Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches);
    if (at.m > 0 && changed) changed.wrap.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    const beatIdx = beatList.findIndex((x) => x.id === lesson.slides[at.s].beat);
    beats.forEach((el, i) => { el.classList.toggle("is-now", i === beatIdx); el.classList.toggle("is-done", i < beatIdx); el.setAttribute("aria-current", i === beatIdx ? "step" : "false"); });
    if (count) count.textContent = (at.s + 1) + " / " + lesson.slides.length;
    if (!visitedSlides.has(at.s)) {
      visitedSlides.add(at.s);
      memory.set("visited", [...visitedSlides]);
    }
    if (!tocPop.hidden) paintToc();
    const isLast = at.s === lesson.slides.length - 1 && at.m === current.moments.length - 1;
    prev.disabled = at.s === 0 && at.m === 0;
    next.disabled = isLast;
    memory.set("at", at);
    if (isLast && !completedSent) completedSent = true;
    postHost({ kind: "progress", slide: at.s + 1, slideTotal: lesson.slides.length, moment: at.m, beat: lesson.slides[at.s].beat || "", completed: isLast, memory: memory.all() });
  }

  function go(s, m) { if (s < 0 || s >= lesson.slides.length) return; at = { s, m }; nudged = false; show(); }
  function forward() {
    const it = current.items[current.moments[at.m].b];
    if (it?.made.ready && !it.made.ready()) {
      if (!nudged) { nudged = true; return show(it.made.waitSay || T.waitPick); }
      it.made.pass?.();
    }
    if (at.m < current.moments.length - 1) return go(at.s, at.m + 1);
    if (at.s < lesson.slides.length - 1) go(at.s + 1, 0);
  }
  function back() { if (at.m > 0) return go(at.s, at.m - 1); if (at.s > 0) go(at.s - 1, Number.MAX_SAFE_INTEGER); }

  /* Keyboard shortcut help (?) toggle & popover */
  const kbdRows = [
    ["Space / →", T.kbdNext],
    ["←", T.kbdPrev],
    ["g", T.kbdToc],
    ["Shift + ←/→", T.kbdSlider],
    ["Esc", T.kbdEsc],
    ["?", T.kbdToggle],
  ].map(([keys, desc]) => h("div.kbd__row", null, h("kbd.kbd__keys", { text: keys }), h("p.kbd__desc", { text: desc })));
  const kbdPop = h("div.kbd__pop", { attr: { id: "kbd-pop", role: "dialog", "aria-label": T.kbdTitle, hidden: "" } },
    h("p.kbd__title", { text: T.kbdTitle }),
    h("div.kbd__list", null, kbdRows));
  const kbdBtn = h("button.tool.kbd__btn", {
    text: "?",
    attr: { id: "kbd-btn", type: "button", "aria-label": T.kbdTitle, "aria-expanded": "false", "aria-controls": "kbd-pop" },
    on: { click(e) { e.stopPropagation(); toggleKbd(); } },
  });
  const kbdWrap = h("div.kbd", null, kbdBtn, kbdPop);
  document.querySelector(".top__tools")?.append(kbdWrap);

  function setKbdOpen(open) {
    kbdPop.hidden = !open;
    kbdBtn.setAttribute("aria-expanded", String(open));
  }
  function toggleKbd() {
    const nextOpen = kbdPop.hidden;
    notesList.hidden = true;
    setTocOpen(false);
    setKbdOpen(nextOpen);
  }
  function toggleToc() {
    const nextOpen = tocPop.hidden;
    notesList.hidden = true;
    setKbdOpen(false);
    setTocOpen(nextOpen);
  }

  count?.addEventListener("click", (e) => { e.stopPropagation(); toggleToc(); });
  count?.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      e.stopPropagation();
      toggleToc();
    }
  });
  next.addEventListener("click", forward);
  prev.addEventListener("click", back);
  document.addEventListener("keydown", (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Escape") {
      notesList.hidden = true;
      setKbdOpen(false);
      setTocOpen(false);
      return;
    }
    const textInput = e.target.closest?.("input:not([type=range]):not([type=checkbox]):not([type=radio]), textarea, select, [contenteditable]");
    if (e.key === "?" && !textInput) {
      e.preventDefault();
      toggleKbd();
      return;
    }
    if ((e.key === "g" || e.key === "G") && !textInput) {
      e.preventDefault();
      toggleToc();
      return;
    }
    const interactive = e.target.closest?.("button, input, textarea, select, [role=button], [role=application], .code__scroll");
    const arrowCaptured = e.target.closest?.("input, textarea, select, .seg__set, .sbox__hit, .mtx__card");
    if ((e.key === "ArrowRight" && !arrowCaptured) || e.key === "PageDown" || (e.key === " " && !interactive)) { e.preventDefault(); forward(); }
    else if ((e.key === "ArrowLeft" && !arrowCaptured) || e.key === "PageUp") { e.preventDefault(); back(); }
  });
  notes.addEventListener("click", (e) => { e.stopPropagation(); notesList.hidden = !notesList.hidden; setKbdOpen(false); setTocOpen(false); });
  document.addEventListener("click", (e) => {
    if (!notesList.contains(e.target)) notesList.hidden = true;
    if (!kbdWrap.contains(e.target)) setKbdOpen(false);
    if (!tocWrap.contains(e.target)) setTocOpen(false);
  });

  /* Full-lesson Study-Sheet Mode when printing / saving as PDF */
  let printSheetEl = null;
  window.addEventListener("beforeprint", () => {
    if (printSheetEl) return;
    const sections = lesson.slides.map((sl, idx) => {
      const built = build(idx);
      built.items.forEach((it) => {
        it.wrap.classList.remove("is-waiting");
        const stepLen = Array.isArray(it.made.steps) ? it.made.steps.length : 0;
        it.made.set?.(stepLen);
        it.made.pass?.();
        it.made.refresh?.();
      });
      for (const node of built.el.querySelectorAll(".card__a, .say__model, .try__hint, .try__solution")) node.hidden = false;
      for (const det of built.el.querySelectorAll("details.try__pad")) det.open = true;
      const lastSay = built.moments.at(-1)?.say || sl.title || "";
      return h("div.print-sheet__slide", null,
        h("div.print-sheet__num", { text: T.printSlide(idx + 1, lesson.slides.length) }),
        built.el,
        lastSay ? h("p.print-sheet__say", null, L.md(lastSay)) : null);
    });
    printSheetEl = h("div.print-sheet", null, sections);
    document.body.append(printSheetEl);
    document.body.classList.add("has-print-sheet");
  });
  window.addEventListener("afterprint", () => {
    document.body.classList.remove("has-print-sheet");
    if (printSheetEl) { printSheetEl.remove(); printSheetEl = null; }
  });

  const root = document.documentElement, themeBtn = $("theme");
  if (boot?.theme === "dark" || boot?.theme === "light") root.dataset.theme = boot.theme;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  const paintTheme = () => { themeBtn.textContent = isDark() ? T.light : T.dark; };
  themeBtn.addEventListener("click", () => { root.dataset.theme = isDark() ? "light" : "dark"; try { localStorage.setItem("lesson-theme", root.dataset.theme); } catch {} paintTheme(); });
  paintTheme();

  /* StudyHub Bridge UI when hosted in DiagramFrame */
  if (boot && boot.channelToken) {
    window.__shCompanionMounted = true;
    const askBtn = h("button.tool.tool--ask", { text: boot.askLabel || T.askBtn, attr: { type: "button" }, on: { click: () => postHost({ kind: "inquiry", context: currentContext(window.getSelection?.()?.toString() || "") }) } });
    document.querySelector(".top__tools")?.prepend(askBtn);
    const pill = h("button.sh-sel-pill", { text: boot.selectionLabel || T.askSel, attr: { type: "button", hidden: "" }, on: {
      mousedown: (e) => e.preventDefault(),
      click: () => { const q = window.getSelection?.()?.toString() || ""; pill.hidden = true; postHost({ kind: "inquiry", context: currentContext(q) }); },
    } });
    document.body.append(pill);
    document.addEventListener("selectionchange", () => {
      const sel = window.getSelection?.();
      const txt = sel ? sel.toString().trim() : "";
      if (!txt || txt.length < 2 || !sel.rangeCount) { pill.hidden = true; return; }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) { pill.hidden = true; return; }
      pill.hidden = false;
      pill.style.left = Math.max(8, Math.min(window.innerWidth - 160, rect.left + rect.width / 2 - 60)) + "px";
      pill.style.top = Math.max(8, rect.top - 38) + "px";
    });
    window.addEventListener("message", (ev) => {
      if (ev.data?.protocol !== "studyhub-companion/1" || ev.data?.token !== boot.channelToken) return;
      if (ev.data.kind === "goto" && Number.isInteger(ev.data.slide)) go(Math.max(0, Math.min(lesson.slides.length - 1, ev.data.slide - 1)), 0);
      if (ev.data.kind === "theme" && (ev.data.theme === "dark" || ev.data.theme === "light")) { root.dataset.theme = ev.data.theme; paintTheme(); }
      if (ev.data.kind === "labels") {
        if (ev.data.askLabel) askBtn.textContent = String(ev.data.askLabel);
        if (ev.data.selectionLabel) pill.textContent = String(ev.data.selectionLabel);
      }
    });
  }

  const hashTarget = boot?.initialAnchor || location.hash;
  const link = /^#(\d+)(\.end)?$/.exec(String(hashTarget || ""));
  const saved = memory.get("at", { s: 0, m: 0 });
  if (link) go(Math.min(Number(link[1]), lesson.slides.length) - 1, link[2] ? Number.MAX_SAFE_INTEGER : 0);
  else go(Math.min(saved.s || 0, lesson.slides.length - 1), saved.m || 0);
})();
`.trim();

const EN_ONLY_RUNTIME_JS = LESSON_TEMPLATE_RUNTIME_JS
  .replace(/const T = isEn \? (\{[\s\S]*?\n  \}) : \{[\s\S]*?\n  \};/, 'const T = $1;')
  .replace('定理 引理 证明 设 假设 若 则 因此 矛盾 前提 结论 证毕', '')
  .replace(/[\u3400-\u9fff]+/g, '');

export function buildLessonTemplateRuntimeJs(language = 'zh') {
  return language === 'en' ? EN_ONLY_RUNTIME_JS : LESSON_TEMPLATE_RUNTIME_JS;
}
