/* global window, document, ResizeObserver, MutationObserver -- installLayoutObserver and the drain callback run in the browser */
/* Layout stability and jank for QA scripts (WP-LS, #208).

   The rule (ui/DESIGN.md "Late content"): content that arrives after the page is shown must not move what is already
   shown, and must not change a default the learner has already seen. This module is the measuring tool:

     context.addInitScript(installLayoutObserver)   // before the first navigation: observers start with the document
     ...                                            // a step runs
     const log = await drainLayoutStability(page)   // { shifts, longTasks, resizes } since the last drain
     const verdict = judgeLayoutStability(log, { maxCls: 0.05 })

   `layout-shift` entries that follow the learner's own input within 500 ms (`hadRecentInput`, Chromium's rule) are
   dropped at the source: a row added by a click is the learner's doing. `longtask` entries (> 50 ms on the main
   thread) are recorded for every step; they are only judged when a limit is given. A row of a list window (`data-scroll-key`, or
   `data-stable-row`) that changes height after it was first measured is a `resizes` entry and breaks the step: the layout-shift
   score alone misses a list that grows inside its own scroller (measured on the picker of 创建题组: 20 px more per row, score 0). */

export const DEFAULT_CLS_MAX = 0.05;

/** Runs inside the page (addInitScript serialises it): keep it self-contained, no closures over module scope. */
export function installLayoutObserver() {
  if (window.__layoutStability) return;
  const state = { shifts: [], longTasks: [], resizes: [], observers: [], sentinels: 0 };
  window.__layoutStability = state;
  const rectOf = (rect) => ({ x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
  const describe = (node) => {
    const element = node && node.nodeType === 1 ? node : node && node.parentElement;
    if (!element) return "(removed element)";
    let text = "";
    try { text = (element.getAttribute("aria-label") || element.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40); } catch { /* detached */ }
    const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).filter(Boolean).slice(0, 3) : [];
    const tour = element.getAttribute && element.getAttribute("data-tour");
    return `${element.tagName.toLowerCase()}${element.id ? `#${element.id}` : ""}${classes.map((name) => `.${name}`).join("")}${tour ? `[data-tour=${tour}]` : ""}${text ? ` "${text}"` : ""}`;
  };
  const take = (list) => {
    for (const entry of list.getEntries()) {
      if (entry.entryType === "layout-shift") {
        // drainLayoutStability's own marker: it only proves that every earlier entry has been delivered.
        if ((entry.sources || []).some((source) => source.node && source.node.nodeType === 1 && source.node.hasAttribute("data-layout-sentinel"))) { state.sentinels++; continue; }
        if (entry.hadRecentInput || !entry.value) continue;
        state.shifts.push({ value: entry.value, startTime: Math.round(entry.startTime),
          sources: (entry.sources || []).map((source) => ({ element: describe(source.node), from: rectOf(source.previousRect), to: rectOf(source.currentRect) })) });
      } else state.longTasks.push({ duration: Math.round(entry.duration), startTime: Math.round(entry.startTime) });
    }
  };
  for (const type of ["layout-shift", "longtask"]) {
    try {
      const observer = new PerformanceObserver(take);
      observer.observe({ type, buffered: true });
      state.observers.push(observer);
    } catch { /* this browser does not report it */ }
  }
  // Rows of a scrolling list window (ScrollWindow, `data-scroll-key`, or any `data-stable-row`) are watched for a change of height after they
  // were first measured: Chromium's layout-shift score does not reliably report a list that grows inside its own scroller, and a row that
  // gets taller when late data arrives is exactly the shift the rule forbids. A change within 500 ms of the learner's own input or of a
  // window resize (a different width wraps text differently) is not counted.
  const ROWS = "[data-scroll-key], [data-stable-row]";
  let lastInput = -1e9;
  const touched = (event) => { if (event.type === "resize" || event.isTrusted) lastInput = performance.now(); };
  for (const type of ["pointerdown", "keydown", "wheel", "touchstart", "resize"]) window.addEventListener(type, touched, { capture: true, passive: true });
  if (typeof ResizeObserver === "function" && typeof MutationObserver === "function") {
    const heights = new WeakMap();
    const sizes = new ResizeObserver((entries) => {
      for (const entry of entries) {
        // A row that left the document (the learner went to another page) reports a height of 0: that is no shrinking.
        if (!entry.target.isConnected) { heights.delete(entry.target); continue; }
        const height = Math.round((entry.borderBoxSize && entry.borderBoxSize[0] ? entry.borderBoxSize[0].blockSize : entry.contentRect.height) * 10) / 10;
        const before = heights.get(entry.target);
        heights.set(entry.target, height);
        if (before !== undefined && Math.abs(height - before) >= 3 && performance.now() - lastInput > 500)
          state.resizes.push({ element: describe(entry.target), from: before, to: height, startTime: Math.round(performance.now()) });
      }
    });
    const watch = (node) => {
      if (node.nodeType !== 1) return;
      if (node.matches(ROWS)) sizes.observe(node);
      for (const row of node.querySelectorAll(ROWS)) sizes.observe(row);
    };
    new MutationObserver((records) => { for (const record of records) for (const node of record.addedNodes) watch(node); }).observe(document, { childList: true, subtree: true });
    if (document.documentElement) watch(document.documentElement); // at document start there may be none yet: the observer above sees it arrive
  }
  state.take = () => { for (const observer of state.observers) { const pending = observer.takeRecords(); if (pending.length) take({ getEntries: () => pending }); } };
}

/** Everything observed since the last drain (and clear it). A page that was just replaced answers an empty log.
 *  Chromium delivers a layout-shift entry some frames after the shift, so by default the drain first moves a faint marker and waits
 *  until the entry for that move arrives: entries come in order, so everything before it is in the log (`flush: false` skips this). */
export async function drainLayoutStability(page, { flush = true, timeoutMs = 2000 } = {}) {
  try {
    if (flush) {
      const wanted = await page.evaluate(() => {
        const state = window.__layoutStability;
        if (!state || !document.body) return 0;
        let marker = document.querySelector("[data-layout-sentinel]");
        if (!marker) {
          marker = document.createElement("div");
          marker.setAttribute("data-layout-sentinel", "");
          marker.setAttribute("aria-hidden", "true");
          marker.style.cssText = "position:fixed;left:0;top:0;width:240px;height:240px;background:rgba(0,0,0,0.05);pointer-events:none";
          document.body.append(marker);
        }
        marker.style.top = marker.style.top === "9px" ? "0px" : "9px";
        return state.sentinels + 1;
      });
      if (wanted) await page.waitForFunction((count) => { window.__layoutStability.take(); return window.__layoutStability.sentinels >= count; }, wanted, { timeout: timeoutMs, polling: 25 }).catch(() => {});
    }
    return await page.evaluate(() => {
      const state = window.__layoutStability;
      if (!state) return { shifts: [], longTasks: [], resizes: [] };
      state.take();
      document.querySelector("[data-layout-sentinel]")?.remove();
      const log = { shifts: state.shifts.splice(0), longTasks: state.longTasks.splice(0), resizes: state.resizes.splice(0) };
      return log;
    });
  } catch { return { shifts: [], longTasks: [], resizes: [] }; }
}

export const emptyLayoutLog = () => ({ shifts: [], longTasks: [], resizes: [] });
export function mergeLayoutLog(into, more) {
  into.shifts.push(...more.shifts);
  into.longTasks.push(...more.longTasks);
  into.resizes.push(...(more.resizes || []));
  return into;
}

const move = (source) => {
  const dy = source.to.y - source.from.y, dx = source.to.x - source.from.x;
  if (!dy && !dx) return source.to.height !== source.from.height ? `resized ${source.to.height - source.from.height}px` : "moved";
  return dy ? `${Math.abs(dy)}px ${dy > 0 ? "down" : "up"}` : `${Math.abs(dx)}px ${dx > 0 ? "right" : "left"}`;
};

/** The step's numbers and, when it broke the rule, a one-line message naming what moved. */
export function judgeLayoutStability(log, { maxCls = DEFAULT_CLS_MAX, maxLongTask = 0, maxRowResizes = 0 } = {}) {
  const shifts = (log.shifts || []).filter((item) => !item.hadRecentInput);
  const cls = shifts.reduce((sum, item) => sum + item.value, 0);
  const longestTask = (log.longTasks || []).reduce((most, task) => Math.max(most, task.duration), 0);
  const problems = [];
  if (cls > maxCls) {
    const named = [...shifts].sort((a, b) => b.value - a.value).slice(0, 3).map((item) => {
      const first = item.sources[0];
      const others = item.sources.length > 1 ? ` +${item.sources.length - 1} more` : "";
      return first ? `${first.element} ${move(first)} (${item.value.toFixed(3)}${others})` : `unnamed element (${item.value.toFixed(3)})`;
    });
    problems.push(`layout shift: CLS ${cls.toFixed(3)} > ${maxCls} — ${named.join("; ")}`);
  }
  const resizes = log.resizes || [];
  if (resizes.length > maxRowResizes) {
    const named = resizes.slice(0, 3).map((item) => `${item.element} ${item.from}→${item.to}px`);
    problems.push(`list row height changed after it was shown: ${resizes.length} row${resizes.length === 1 ? "" : "s"} — ${named.join("; ")}`);
  }
  if (maxLongTask > 0 && longestTask > maxLongTask) problems.push(`long task ${longestTask} ms > ${maxLongTask} ms`);
  return { ok: !problems.length, cls: Number(cls.toFixed(4)), shiftCount: shifts.length, longestTask, longTasks: (log.longTasks || []).length, rowResizes: resizes.length, message: problems.join(" | "), shifts, resizes };
}
