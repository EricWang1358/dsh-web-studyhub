import http from "node:http";
import https from "node:https";

/* A small fetch-shaped client on node:https for the Gemini calls.

   Node's own fetch gives up on a response after five minutes and offers no way
   to change that without an extra package. Transcribing an hour of audio can
   take longer than that, and a request that is dropped is paid for again, so
   the caller sets the deadline instead (`timeoutMs`), sized to the work. Bodies
   are sent whole, which is what these calls need; only https is allowed (an API
   key never travels in the clear), except to the local machine for tests. */

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** Same shape as a failed fetch: a TypeError whose `cause` says what really went wrong. */
const failure = (cause) => new TypeError("fetch failed", { cause });

export function longFetch(input, init = {}) {
  const { method = "GET", headers = {}, body, signal, timeoutMs, awaitPhysicalClose = false } = init;
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(String(input)); } catch (error) { return reject(new TypeError("Invalid URL", { cause: error })); }
    const secure = url.protocol === "https:";
    if (!secure && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) return reject(new TypeError("Only https requests are sent"));
    if (signal?.aborted) return reject(signal.reason);
    let timer, finished = false, request, pending, closed = false;
    const onAbort = () => { request?.destroy(); finish(reject, signal.reason); };
    function finish(settle, value) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (awaitPhysicalClose && request && !closed) pending = () => settle(value);
      else settle(value);
    }
    const payload = body === undefined || body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    request = (secure ? https : http).request(url, {
      method, headers: { ...headers, ...(payload ? { "content-length": String(payload.length) } : {}) },
    }, (res) => {
      const parts = [];
      res.on("data", (part) => parts.push(part));
      res.on("error", (error) => finish(reject, failure(error)));
      res.on("close", () => {
        if (!res.complete) finish(reject, failure(Object.assign(new Error("connection closed before the response finished"), { code: "ECONNRESET" })));
      });
      res.on("end", () => {
        const text = Buffer.concat(parts).toString("utf8");
        finish(resolve, {
          status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: { get: (name) => { const value = res.headers[String(name).toLowerCase()]; return Array.isArray(value) ? value.join(", ") : value ?? null; } },
          text: async () => text, json: async () => JSON.parse(text),
        });
      });
    });
    request.on('close', () => {
      closed = true;
      if (pending) pending();
      else if (!finished) finish(reject, failure(Object.assign(new Error('request closed without a complete response'), { code: 'ECONNRESET' })));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs > 0) timer = setTimeout(() => {
      request.destroy();
      finish(reject, failure(Object.assign(new Error(`no response within ${Math.round(timeoutMs / 1000)} seconds`), { code: "LONGFETCH_TIMEOUT", timeoutMs })));
    }, timeoutMs);
    request.on("error", (error) => finish(reject, failure(error)));
    request.end(payload);
  });
}
