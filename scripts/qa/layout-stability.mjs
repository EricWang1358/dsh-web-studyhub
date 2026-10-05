/* global window -- installLayoutObserver and the drain callback run in the browser */
/* Layout stability and jank for QA scripts (WP-LS, #208).

   The rule (ui/DESIGN.md "Late content"): content that arrives after the page is shown must not move what is already
   shown, and must not change a default the learner has already seen. This module is the measuring tool:

     context.addInitScript(installLayoutObserver)   // before the first navigation: observers start with the document
     ...                                            // a step runs
     const log = await drainLayoutStability(page)   // { shifts, longTasks } since the last drain
     const verdict = judgeLayoutStability(log, { maxCls: 0.05 })

   `layout-shift` entries that follow the learner's own input within 500 ms (`hadRecentInput`, Chromium's rule) are
   dropped at the source: a row added by a click is the learner's doing. `longtask` entries (> 50 ms on the main
   thread) are recorded for every step; they are only judged when a limit is given. */

export const DEFAULT_CLS_MAX = 0.05;

/** Runs inside the page (addInitScript serialises it): keep it self-contained, no closures over module scope. */
export function installLayoutObserver() {
  if (window.__layoutStability) return;
  const state = { shifts: [], longTasks: [], observers: [] };
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
  state.take = () => { for (const observer of state.observers) { const pending = observer.takeRecords(); if (pending.length) take({ getEntries: () => pending }); } };
}

/** Everything observed since the last drain (and clear it). A page that was just replaced answers an empty log. */
export async function drainLayoutStability(page) {
  try {
    return await page.evaluate(() => {
      const state = window.__layoutStability;
      if (!state) return { shifts: [], longTasks: [] };
      state.take();
      const log = { shifts: state.shifts.splice(0), longTasks: state.longTasks.splice(0) };
      return log;
    });
  } catch { return { shifts: [], longTasks: [] }; }
}

export const emptyLayoutLog = () => ({ shifts: [], longTasks: [] });
export function mergeLayoutLog(into, more) {
  into.shifts.push(...more.shifts);
  into.longTasks.push(...more.longTasks);
  return into;
}

const move = (source) => {
  const dy = source.to.y - source.from.y, dx = source.to.x - source.from.x;
  if (!dy && !dx) return source.to.height !== source.from.height ? `resized ${source.to.height - source.from.height}px` : "moved";
  return dy ? `${Math.abs(dy)}px ${dy > 0 ? "down" : "up"}` : `${Math.abs(dx)}px ${dx > 0 ? "right" : "left"}`;
};

/** The step's numbers and, when it broke the rule, a one-line message naming what moved. */
export function judgeLayoutStability(log, { maxCls = DEFAULT_CLS_MAX, maxLongTask = 0 } = {}) {
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
  if (maxLongTask > 0 && longestTask > maxLongTask) problems.push(`long task ${longestTask} ms > ${maxLongTask} ms`);
  return { ok: !problems.length, cls: Number(cls.toFixed(4)), shiftCount: shifts.length, longestTask, longTasks: (log.longTasks || []).length, message: problems.join(" | "), shifts };
}
