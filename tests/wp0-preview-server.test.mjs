import test from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdir, mkdtemp, rm, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPreviewServer, previewOptions } from "../scripts/preview-server.mjs";
import { createFakeModel } from "../scripts/fake-model.mjs";
import { sampleMaterial } from "../scripts/qa/fixtures.mjs";

const repo = fileURLToPath(new URL("../", import.meta.url));
const savedHome = process.env.DSH_HOME;
test.after(() => { if (savedHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = savedHome; });

async function tempDir(t, prefix) {
  const base = join(repo, "output", "test-wp0");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, prefix));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 3 }));
  return dir;
}

async function start(t, options = {}) {
  const libraryRoot = await tempDir(t, "preview-lib-"), home = await tempDir(t, "preview-home-");
  const server = await createPreviewServer({ libraryRoot, home, port: 0, model: createFakeModel(), ...options });
  t.after(() => server.close());
  const raw = async (action, args = {}, token = server.token) => {
    const res = await fetch(server.url + "/api/call", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Study-Token": token },
      body: JSON.stringify({ action, args }),
    });
    return { status: res.status, body: res.status === 403 ? null : await res.json() };
  };
  const call = async (action, args) => {
    const { body } = await raw(action, args);
    if (!body.ok) throw new Error(body.error);
    return body.value;
  };
  return { server, call, raw, libraryRoot, home };
}

const until = async (check, ms = 15000) => {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for the preview");
    await new Promise((done) => setTimeout(done, 50));
  }
};

async function publishedDeck(call) {
  const source = await call("source.add", sampleMaterial("zh"));
  const { jobId } = await call("generate", { sourceIds: [source.id], count: 2, kind: "quiz", title: "WP0 preview" });
  const job = await call("job.wait", { jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "complete", job.stage);
  const published = await call("draft.publish", { id: job.draft.id, draftVersion: job.draft.draftVersion });
  const deck = (await call("snapshot", {})).decks.find((item) => item.id === published.deckId);
  return { source, deck };
}

test("one runtime per library: a generation started by one request is visible to the next", async (t) => {
  const { call } = await start(t);
  const source = await call("source.add", sampleMaterial("zh"));
  const started = await call("generate", { sourceIds: [source.id], count: 2, kind: "quiz", title: "WP0 jobs" });
  const snapshot = await call("snapshot", {});
  assert.ok(snapshot.jobs.some((job) => job.id === started.jobId), "the job card must be visible in the next snapshot");
  const finished = await call("job.wait", { jobId: started.jobId, timeoutSeconds: 30 });
  assert.equal(finished.status, "complete", finished.stage);
  assert.equal(finished.draft.cards, 2);
});

test("a running generation can be stopped from a later request", async (t) => {
  const { call } = await start(t, { model: createFakeModel({ latencyMs: 400 }) });
  const source = await call("source.add", sampleMaterial("zh"));
  const { jobId } = await call("generate", { sourceIds: [source.id], count: 2, kind: "quiz" });
  await call("job.cancel", { jobId });
  const job = await call("job.wait", { jobId, timeoutSeconds: 30 });
  assert.equal(job.status, "cancelled");
});

test("assist.start works in the preview like in the host and the answer is saved on the card", async (t) => {
  const { call } = await start(t);
  const { deck } = await publishedDeck(call);
  const cardId = (await call("deck.get", { id: deck.id })).cards[0].id;
  const task = await call("assist.start", { deckId: deck.id, cardId, mode: "ask", text: "能举个例子吗？", helpChoices: [] });
  assert.equal(task.status, "running");
  assert.equal(task.mode, "ask");
  const done = await until(async () => (await call("snapshot", {})).assist?.find((item) => item.id === task.id && item.status !== "running"));
  assert.equal(done.status, "done", done.message);
  const { card } = await call("card.locate", { deckId: deck.id, cardId });
  assert.ok(card.followups?.some((item) => item.source === "assistant" && item.answer.trim()), "the assistant answer is saved on the card");
});

test("the preview requires its session token and a local Host header", async (t) => {
  const { server, raw } = await start(t);
  assert.equal((await raw("snapshot", {}, "wrong-token")).status, 403);
  const status = await new Promise((done, fail) => {
    const req = request(server.url + "/api/call", { method: "POST", headers: {
      Host: "evil.example", "Content-Type": "application/json", "X-Study-Token": server.token } }, (res) => { res.resume(); done(res.statusCode); });
    req.on("error", fail);
    req.end(JSON.stringify({ action: "snapshot", args: {} }));
  });
  assert.equal(status, 403);
});

test("binding reports the preview model; without a model, generation asks for one", async (t) => {
  const withModel = await start(t);
  assert.ok((await withModel.call("binding.get")).route?.model, "a configured preview model is reported as the route");
  const without = await start(t, { model: null });
  assert.equal((await without.call("binding.get")).route, null);
  const source = await without.call("source.add", sampleMaterial("zh"));
  await assert.rejects(without.call("generate", { sourceIds: [source.id], count: 1, kind: "quiz" }), /model/i);
});

test("the library is the --library folder; choosing another one is preview state, never a file", async (t) => {
  const { call, libraryRoot } = await start(t);
  assert.equal((await call("snapshot", {})).root, libraryRoot);
  assert.equal((await call("binding.get")).rootSource, "workspace");
  const other = await tempDir(t, "preview-other-");
  const chosen = await call("binding.set", { root: other });
  assert.equal(chosen.rootSource, "custom");
  assert.equal(chosen.root, other);
  await call("source.add", sampleMaterial("zh"));
  assert.equal((await call("snapshot", {})).root, other);
  await assert.rejects(readFile(join(libraryRoot, ".dsh-study-binding.json")), { code: "ENOENT" });
  await assert.rejects(call("binding.set", { root: "relative/dir" }), /absolute/);
  const reset = await call("binding.set", { root: "" });
  assert.equal(reset.root, libraryRoot);
  assert.equal((await call("snapshot", {})).sources.length, 0);
});

test("global study files stay in the preview home, never the owner's ~/.dsh", async (t) => {
  const { call, home } = await start(t);
  const { revision } = await call("board.get", {});
  await call("board.card.add", { title: "WP0 board card", revision });
  const board = JSON.parse(await readFile(join(home, "study", "board.json"), "utf8"));
  assert.ok(Object.values(board.cards).some((card) => card.title === "WP0 board card"));
});

test("dev CLI options: same flags and env as before, isolated home by default", () => {
  const base = previewOptions(["node", "dev.mjs"], {});
  assert.equal(base.libraryRoot, resolve(repo, "output/preview-library"));
  assert.equal(base.home, resolve(repo, "output/preview-home"));
  assert.equal(base.port, 4178);
  assert.equal(base.model, null);
  const custom = previewOptions(["node", "dev.mjs", "--library=output/qa/x"], { PORT: "4191", DSH_HOME: "C:/tmp/h", STUDY_FAKE_MODEL: "1" });
  assert.equal(custom.libraryRoot, resolve("output/qa/x"));
  assert.equal(custom.home, resolve("C:/tmp/h"));
  assert.equal(custom.port, 4191);
  assert.equal(custom.model, "fake");
  const remote = previewOptions(["node", "dev.mjs"], { STUDY_API_KEY: "k", STUDY_BASE_URL: "http://127.0.0.1:9/v1", STUDY_MODEL: "m" });
  assert.deepEqual(remote.model, { apiKey: "k", baseUrl: "http://127.0.0.1:9/v1", model: "m" });
});
