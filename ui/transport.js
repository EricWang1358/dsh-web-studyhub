// @ts-check
/** Match DSH's Fetch RPC carrier, with only 404/405 allowing legacy fallback. */
const ROUTES = {
  native: ["/api", "study-workspace/call"],
  legacy: ["/study-workspace", "call"],
};
const missingRoute = (e) => /HTTP (404|405)\b/.test(e?.message || "");
// DSH 0.2.1 answers 403 on plugin routes to every browser that is not the owner's (remote access; @deepseek-ai/dsh-client-connection lib/index.js:829-831).
const ownerOnly = (e) => /HTTP 403\b/.test(e?.message || "");
const payloadTooLarge = (e) => /HTTP 413\b|\bToo large\b|Request body too large/i.test(e?.message || "");
const payloadTooLargeError = (cause) => Object.assign(new Error("请求体超过单次传输上限，请刷新页面后重试（备份文件会自动分片上传）。"), {
  code: "payload-too-large",
  cause,
});
const ownerOnlyError = (cause) => Object.assign(new Error("StudyHub 只对这台电脑上的 DSH 主人开放；通过远程访问打开的浏览器不能使用它。StudyHub is only available to the owner of this DSH, not to remote-access browsers."), {
  code: "STUDY_OWNER_ONLY",
  cause,
});

/** @typedef {import('../lib/types.js').StudyActionPayload} StudyActionPayload */

/**
 * One action of the panel, sent to the host (`study-workspace/call`), answering its `value`.
 * @param {Record<string, any>} connection the DSH client connection
 * @param {string} sessionId the session that asks
 * @returns {(action: string, args?: Record<string, any>) => Promise<any>}
 */
export function createStudyCall(connection, sessionId) {
  // Switch to the legacy route only after it actually answers. While the host
  // restarts, neither route exists yet; latching onto legacy then left every
  // later call failing with HTTP 405 until the page was reloaded.
  let route = "native";
  return async (action, args = {}) => {
    const signal = AbortSignal.timeout(200000),
      /** @type {StudyActionPayload} */
      payload = { sessionId, action, args };
    const send = (which) => connection.rpc.call(...ROUTES[which], payload, signal);
    let result;
    try {
      result = await send(route);
    } catch (e) {
      if (ownerOnly(e)) throw ownerOnlyError(e);
      if (payloadTooLarge(e)) throw payloadTooLargeError(e);
      if (!missingRoute(e)) throw e;
      const other = route === "native" ? "legacy" : "native";
      try {
        result = await send(other);
        route = other;
      } catch (fallback) {
        route = "native";
        if (ownerOnly(fallback)) throw ownerOnlyError(fallback);
        if (!missingRoute(fallback)) throw fallback;
        throw Object.assign(new Error("StudyHub 还没有启动好（DSH 可能刚重启）。等几秒再点一次。"), {
          code: "STUDY_UNAVAILABLE",
          cause: e,
        });
      }
    }
    if (!result?.ok)
      throw Object.assign(new Error(result?.error?.message || "StudyHub 的请求没有成功，也没有拿到具体原因。可以再试一次。"), { code: result?.error?.code, details: result?.error?.details });
    return result.value;
  };
}
/** Errors worth retrying on their own: the plugin route or host connection is not up yet. */
export const isTransientStudyError = (e) =>
  e?.code === "STUDY_UNAVAILABLE" || /Study connection is unavailable|Failed to fetch|NetworkError|ECONNREFUSED/i.test(e?.message || "");

const unsupportedWaitError = (e) =>
  /Unknown study action|Capability unavailable|Unknown endpoint/i.test(String(e?.message || ""));

/**
 * Subscribe to `study:library-changed` events over the host's authenticated `library.events.wait`
 * RPC (backed by `fs.watch` on the server, zero polling while idle). Pauses while hidden and
 * degrades silently on older hosts that lack `library.events.wait`.
 * @param {(action: string, args?: Record<string, any>) => Promise<any>} call
 * @param {{ timeoutMs?: number, retryMs?: number, doc?: Document | null }} [options]
 * @returns {(onEvent: (event: Record<string, any>) => void) => () => void}
 */
export function createLibraryEventWaitSubscription(
  call,
  { timeoutMs = 25000, retryMs = 2000, doc = typeof document !== "undefined" ? document : null } = {},
) {
  return (onEvent) => {
    if (typeof call !== "function" || typeof onEvent !== "function") return () => {};
    let stopped = false;
    let running = false;
    /** @type {string | null} */
    let sinceStamp = null;
    /** @type {number | null} */
    let sinceRevision = null;
    /** @type {any} */
    let retryTimer = null;

    const clearRetry = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const hidden = () => doc?.hidden === true;

    const loop = async () => {
      if (stopped || running || hidden()) return;
      running = true;
      try {
        while (!stopped && !hidden()) {
          /** @type {Record<string, any>} */
          const args = { timeoutMs };
          if (sinceStamp) args.sinceStamp = sinceStamp;
          if (typeof sinceRevision === "number") args.sinceRevision = sinceRevision;
          const result = await call("library.events.wait", args);
          if (stopped) return;
          if (result && typeof result === "object") {
            if (typeof result.stamp === "string" && result.stamp) sinceStamp = result.stamp;
            if (Number.isSafeInteger(result.revision)) sinceRevision = result.revision;
            if (result.changed === true) {
              onEvent({
                type: "study:library-changed",
                root: result.root || "",
                revision: result.revision ?? null,
                stamp: result.stamp ?? null,
                reason: result.reason || "disk",
                at: result.at || Date.now(),
              });
            }
          }
        }
      } catch (error) {
        if (stopped || unsupportedWaitError(error)) return;
        clearRetry();
        retryTimer = setTimeout(() => {
          retryTimer = null;
          void loop();
        }, retryMs);
        retryTimer?.unref?.();
      } finally {
        running = false;
      }
    };

    const onVisibility = () => {
      if (!stopped && !hidden()) {
        clearRetry();
        void loop();
      }
    };
    doc?.addEventListener?.("visibilitychange", onVisibility);
    void loop();

    return () => {
      stopped = true;
      clearRetry();
      doc?.removeEventListener?.("visibilitychange", onVisibility);
    };
  };
}
