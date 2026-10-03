import { useCallback, useEffect, useState } from "react";

/* The search index coverage of the library (retrieval.index.coverage), read once when a page that shows material opens, and again every few seconds
   while a build is running so the rows follow it. `null` until known or when the host cannot say (no search component): the rows then say nothing. */
const POLL_MS = 3000;

export default function useIndexCoverage(call, { enabled = true } = {}) {
  const [coverage, setCoverage] = useState(null);
  const refresh = useCallback(async () => {
    if (typeof call !== "function") return null;
    try { const value = await call("retrieval.index.coverage", {}); if (value && Array.isArray(value.indexed)) { setCoverage(value); return value; } } catch { /* the host has no search component */ }
    return null;
  }, [call]);
  useEffect(() => { if (enabled) refresh(); }, [enabled, refresh]);
  const building = !!coverage?.building;
  useEffect(() => {
    if (!enabled || !building) return undefined;
    const timer = setInterval(refresh, POLL_MS);
    return () => clearInterval(timer);
  }, [enabled, building, refresh]);
  return [coverage, refresh];
}
