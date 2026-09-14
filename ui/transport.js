/** Match DSH's Fetch RPC carrier, with only 404/405 allowing legacy fallback. */
const ROUTES = {
  native: ["/api", "study-workspace/call"],
  legacy: ["/study-workspace", "call"],
};
const missingRoute = (e) => /HTTP (404|405)\b/.test(e?.message || "");

export function createStudyCall(connection, sessionId) {
  // Switch to the legacy route only after it actually answers. While the host
  // restarts, neither route exists yet; latching onto legacy then left every
  // later call failing with HTTP 405 until the page was reloaded.
  let route = "native";
  return async (action, args = {}) => {
    const signal = AbortSignal.timeout(200000),
      payload = { sessionId, action, args };
    const send = (which) => connection.rpc.call(...ROUTES[which], payload, signal);
    let result;
    try {
      result = await send(route);
    } catch (e) {
      if (!missingRoute(e)) throw e;
      const other = route === "native" ? "legacy" : "native";
      try {
        result = await send(other);
        route = other;
      } catch (fallback) {
        route = "native";
        if (!missingRoute(fallback)) throw fallback;
        throw Object.assign(new Error("学习插件还没有就绪（宿主可能刚重启），正在重试…"), {
          code: "STUDY_UNAVAILABLE",
          cause: e,
        });
      }
    }
    if (!result?.ok)
      throw new Error(result?.error?.message || "Study request failed");
    return result.value;
  };
}
/** Errors worth retrying on their own: the plugin route or host connection is not up yet. */
export const isTransientStudyError = (e) =>
  e?.code === "STUDY_UNAVAILABLE" || /Study connection is unavailable|Failed to fetch|NetworkError|ECONNREFUSED/i.test(e?.message || "");
