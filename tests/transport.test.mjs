import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installTransport } from "../lib/host.js";
import { createStudyCall } from "../ui/transport.js";

test("browser carrier reaches exact registered native Fetch path and round-trips errors", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "study-rpc-"));
  let route;
  const connection = {
    fetch: {
      register: (r) => {
        route = r;
        return () => {};
      },
    },
  };
  const ctx = {
    sessions: { get: () => ({ header: { cwd } }) },
    get: () => connection,
    inject: (_deps, fn) => fn(ctx),
    effect: (fn) => fn(),
  };
  installTransport(ctx, {});
  // The real client carrier concatenates channel/endpoint and uses endpoint as method.
  const call = createStudyCall(
    {
      rpc: {
        call: async (channel, endpoint, payload) => {
          assert.equal(channel + "/" + endpoint, route.path);
          const response = await route.fetch(
            new Request("http://localhost" + channel + "/" + endpoint, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                type: "client-request",
                rpcId: "1",
                method: endpoint,
                payload,
              }),
            }),
          );
          assert.equal(response.status, 200);
          const data = await response.json();
          assert.equal(data.type, "server-response");
          if (!data.result.ok) {
            assert.equal(typeof data.result.error.code, "string");
            assert.equal(typeof data.result.error.details, "object");
          }
          return data.result;
        },
      },
    },
    "session",
  );
  assert.equal((await call("binding.get")).root, join(cwd, ".dsh-study"));
  await assert.rejects(
    () => call("binding.set", { root: "relative" }),
    /absolute library directory/,
  );
});
test("legacy fallback only follows 404/405, never auth failure or unknown server exception", async () => {
  const calls = [];
  const call = createStudyCall(
    {
      rpc: {
        call: async (channel, endpoint) => {
          calls.push([channel, endpoint]);
          if (channel === "/api") throw new Error("HTTP 404");
          return { ok: true, value: "legacy" };
        },
      },
    },
    "s",
  );
  assert.equal(await call("snapshot"), "legacy");
  assert.equal(await call("snapshot"), "legacy");
  assert.deepEqual(calls, [
    ["/api", "study-workspace/call"],
    ["/study-workspace", "call"],
    ["/study-workspace", "call"],
  ]);
  // While the host restarts neither route exists: never latch onto legacy.
  const seen = [];
  let up = false;
  const restarting = createStudyCall(
    {
      rpc: {
        call: async (channel) => {
          seen.push(channel);
          if (channel === "/api" && up) return { ok: true, value: "native" };
          throw new Error("transport failure for " + channel + ": HTTP 405");
        },
      },
    },
    "s",
  );
  await assert.rejects(() => restarting("snapshot"), (e) => e.code === "STUDY_UNAVAILABLE");
  up = true;
  assert.equal(await restarting("snapshot"), "native", "the next call tries the native route again");
  assert.deepEqual(seen, ["/api", "/study-workspace", "/api"]);
  let count = 0;
  const denied = createStudyCall(
    {
      rpc: {
        call: async () => {
          count++;
          throw new Error("HTTP 401");
        },
      },
    },
    "s",
  );
  await assert.rejects(() => denied("snapshot"), /401/);
  assert.equal(count, 1);
});

test("a remote-access browser that DSH 0.2.1 answers with 403 reads that StudyHub is owner-only, once", async () => {
  let count = 0;
  const call = createStudyCall({ rpc: { call: async () => { count++; throw new Error("transport failure for /api: HTTP 403"); } } }, "s");
  await assert.rejects(() => call("snapshot"), (e) => e.code === "STUDY_OWNER_ONLY" && /owner/.test(e.message) && /HTTP 403/.test(e.cause.message));
  assert.equal(count, 1, "no fallback to the legacy route for a refusal");
});

test("a failed answer without a message says so in Chinese, and the English catalogue carries it", async () => {
  const call = createStudyCall({ rpc: { call: async () => ({ ok: false, error: { code: "X" } }) } }, "s");
  const failure = await call("snapshot").then(() => null, (e) => e);
  assert.equal(failure.code, "X");
  assert.equal(failure.message, "StudyHub 的请求没有成功，也没有拿到具体原因。可以再试一次。");
  const english = JSON.parse(await readFile(new URL("../ui/locales/en.json", import.meta.url), "utf8"));
  assert.match(english[failure.message], /no reason came back/, "the English page shows English for it");
  assert.doesNotMatch(english[failure.message], /[㐀-鿿]/);
  const named = createStudyCall({ rpc: { call: async () => ({ ok: false, error: { message: "原因在这里" } }) } }, "s");
  await assert.rejects(() => named("snapshot"), /原因在这里/);
});
