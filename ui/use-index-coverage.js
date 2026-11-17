import { useCallback, useContext, useEffect, useState, useSyncExternalStore } from "react";
import { AppContext } from "./app/app-context.js";
import { hasContext } from "./capabilities.js";
import { usePolling } from "./use-polling.js";

/* The search index coverage of the library (retrieval.index.coverage), read once when a page that shows material opens, and again every few seconds
   while a build is running so the rows follow it. `null` until known or when the host cannot say (no search component): the rows then say nothing. */
const POLL_MS = 3000;

/** How long a list of materials waits for the first answer before it draws its rows without it: about the page's own fade-in (--dur) and a little more. */
export const INDEX_WAIT_MS = 400;

/**
 * Does a list with a badge per row still wait before it draws its rows (#1084)? Until the first answer (`status`, useIndexCoverage's third value) or the end
 * of the wait (`over`), whichever comes first; then never again while it is shown. The rows are then drawn once with the answer known, each with the badge's
 * place only if it has a badge; past the wait they are drawn without it (a badge that comes later is shown only where it moves nothing: ui/SourcePicker.jsx).
 * While it waits the page draws nothing in the list's place nor after it, so the rows and what follows them appear at once and nothing on the page moves.
 */
export const indexWaiting = (status, over) => !over && status === "loading";

const noSubscribe = () => () => {};

/** indexWaiting over time. A render with no browser (a server or static render) has no answer to wait for and nothing that could move: it never waits. */
export function useIndexWait(status, waitMs = INDEX_WAIT_MS) {
  const live = useSyncExternalStore(noSubscribe, () => true, () => false);
  const [over, setOver] = useState(false);
  const waiting = live && indexWaiting(status, over);
  useEffect(() => {
    if (!waiting) { setOver(true); return undefined; }
    const timer = setTimeout(() => setOver(true), waitMs);
    return () => clearTimeout(timer);
  }, [waiting, waitMs]);
  return waiting;
}

/* Third value, `status`: "loading" until the first answer, "ready" once there is one, "unavailable" when the first read failed or `call` is missing.
   A list that shows a badge per row waits for it a moment before it draws (useIndexWait). */
export default function useIndexCoverage(call, { enabled = true } = {}) {
  const app = useContext(AppContext);
  const active = enabled && hasContext(app?.data, "generation");
  const [coverage, setCoverage] = useState(null);
  const [failed, setFailed] = useState(typeof call !== "function");
  const refresh = useCallback(async () => {
    if (typeof call !== "function") { setFailed(true); return null; }
    try { const value = await call("retrieval.index.coverage", {}); if (value && Array.isArray(value.indexed)) { setCoverage(value); setFailed(false); return value; } } catch { /* the host has no search component */ }
    setFailed(true);
    return null;
  }, [call]);
  useEffect(() => { if (active) refresh(); }, [active, refresh]);
  const building = !!coverage?.building;
  usePolling(refresh, { intervalMs: POLL_MS, enabled: active && building });
  return [coverage, refresh, coverage ? "ready" : (!active || failed) ? "unavailable" : "loading"];
}
