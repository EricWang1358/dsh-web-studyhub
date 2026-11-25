/* Stage sequencer, beats navigation, TOC & shortcut popovers, print-sheet mode, and theme switcher. */

export function createStageRenderer({ lesson, boot, L, h, T, memory, postHost }) {
  const predicts = {};
  for (const sl of lesson.slides) {
    for (const bl of sl.blocks) {
      if ((bl.t || bl.type) === "predict") predicts[bl.id] = bl;
    }
  }

  let at = { s: 0, m: 0 }, current = null, nudged = false, completedSent = false, stateReportTimer = 0;

  function isComplete() {
    if (!current || !lesson.slides?.length) return false;
    const isLast = at.s === lesson.slides.length - 1 && at.m === current.moments.length - 1;
    if (!isLast) return false;
    const curMoment = current.moments[at.m];
    const curItem = curMoment && curMoment.b >= 0 ? current.items[curMoment.b] : null;
    return !curItem?.made?.ready || Boolean(curItem.made.ready());
  }

  function reportState(immediate = false) {
    clearTimeout(stateReportTimer);
    const send = () => {
      if (!lesson.slides?.length) return;
      const done = isComplete();
      if (done && !completedSent) completedSent = true;
      postHost({
        kind: "progress",
        slide: at.s + 1,
        slideTotal: lesson.slides.length,
        moment: at.m,
        beat: lesson.slides[at.s]?.beat || "",
        completed: done,
        memory: memory.all(),
      });
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
  const beats = beatList.map((beat) => h("button.beat", {
    text: beat.label,
    attr: { type: "button" },
    on: { click: () => { const idx = lesson.slides.findIndex((s) => s.beat === beat.id); if (idx >= 0) go(idx, 0); } },
  }));
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
      const maker = Object.prototype.hasOwnProperty.call(L.blocks, bType)
        ? L.blocks[bType]
        : (() => ({ el: h("p.text", null, L.md(block.md || "")) }));
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
    if (now.key && !spoken) { keyLine.replaceChildren(L.md(T.keyAdded(now.key))); remember(now.key); }
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
    const done = isComplete();
    prev.disabled = at.s === 0 && at.m === 0;
    next.disabled = isLast;
    memory.set("at", at);
    if (done && !completedSent) completedSent = true;
    postHost({ kind: "progress", slide: at.s + 1, slideTotal: lesson.slides.length, moment: at.m, beat: lesson.slides[at.s].beat || "", completed: done, memory: memory.all() });
  }

  function go(s, m) {
    if (s < 0 || s >= lesson.slides.length) return;
    at = { s, m };
    nudged = false;
    show();
  }

  function forward() {
    const it = current.items[current.moments[at.m].b];
    if (it?.made.ready && !it.made.ready()) {
      if (!nudged) { nudged = true; return show(it.made.waitSay || T.waitPick); }
      it.made.pass?.();
    }
    if (at.m < current.moments.length - 1) return go(at.s, at.m + 1);
    if (at.s < lesson.slides.length - 1) go(at.s + 1, 0);
  }

  function back() {
    if (at.m > 0) return go(at.s, at.m - 1);
    if (at.s > 0) go(at.s - 1, Number.MAX_SAFE_INTEGER);
  }

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

  let printSheetEl = null;
  let printBuiltItems = [];
  window.addEventListener("beforeprint", () => {
    if (printSheetEl) return;
    printBuiltItems = [];
    const sections = lesson.slides.map((sl, idx) => {
      const built = build(idx);
      printBuiltItems.push(...built.items);
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
    printBuiltItems.forEach((it) => it.made?.destroy?.());
    printBuiltItems = [];
    if (printSheetEl) { printSheetEl.remove(); printSheetEl = null; }
  });

  const root = document.documentElement, themeBtn = $("theme");
  if (boot?.theme === "dark" || boot?.theme === "light") root.dataset.theme = boot.theme;
  const isDark = () => (root.dataset.theme ? root.dataset.theme === "dark" : window.matchMedia("(prefers-color-scheme: dark)").matches);
  const paintTheme = () => { themeBtn.textContent = isDark() ? T.light : T.dark; };
  themeBtn.addEventListener("click", () => {
    root.dataset.theme = isDark() ? "light" : "dark";
    try { localStorage.setItem("lesson-theme", root.dataset.theme); } catch { /* sandboxed */ }
    paintTheme();
  });
  paintTheme();

  function bootInitialSlide() {
    const hashTarget = boot?.initialAnchor || location.hash;
    const link = /^#(\d+)(\.end)?$/.exec(String(hashTarget || ""));
    const saved = memory.get("at", { s: 0, m: 0 });
    if (link) go(Math.min(Number(link[1]), lesson.slides.length) - 1, link[2] ? Number.MAX_SAFE_INTEGER : 0);
    else go(Math.min(saved.s || 0, lesson.slides.length - 1), saved.m || 0);
  }

  return { root, paintTheme, currentContext, go, bootInitialSlide };
}
