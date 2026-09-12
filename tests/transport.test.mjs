import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
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
  assert.equal((await call("binding.get")).root, "");
  await assert.rejects(() => call("snapshot"), /absolute study library/);
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
