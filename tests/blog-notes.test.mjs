import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StudyService } from "../lib/service.js";
import { csdnMatches } from "../lib/adapters/csdn-public.js";

test("notes keep card links through draft, save, and published status", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-notes-"));
  const service = new StudyService(root);
  await service.store.update((state) => {
    state.decks.push({ id: "deck", title: "Deck", cards: [{ id: "card", prompt: "Sensitive prompt" }] });
  });
  const note = await service.call("note.create", { title: "Capacity planning", cards: [{ deckId: "deck", cardId: "card" }] });
  assert.ok(!note.markdown.includes("Sensitive prompt"));
  await service.call("note.save", { id: note.id, markdown: "# Capacity planning\n\n$x^2$" });
  await service.call("note.home", { home: "https://blog.csdn.net/example" });
  const url = "https://blog.csdn.net/example/article/details/12345";
  await service.call("note.link", { id: note.id, url });
  const restored = new StudyService(root);
  const snapshot = await restored.call("snapshot");
  assert.equal(snapshot.noteBadges.card[0].status, "published");
  assert.equal(snapshot.noteBadges.card[0].url, url);
  assert.equal((await restored.call("note.get", { id: note.id })).markdown, undefined,
    "published longform text stays on CSDN, while StudyHub keeps links and learning data");
  await assert.rejects(service.call("note.link", { id: note.id,
    url: "https://blog.csdn.net/other/article/details/12345" }), /已设置的 CSDN/);
});

test("homepage matching only accepts same author and exact normalized title", () => {
  const html = `<a href="https://blog.csdn.net/example/article/details/123"><div class="blog-list-box-top"><h4>Capacity&nbsp;planning</h4></div><div>Long excerpt</div></a>
    <a href="https://blog.csdn.net/other/article/details/456">Capacity planning</a>
    <a href="https://blog.csdn.net/example/article/details/789">Capacity planning tips</a>`;
  assert.deepEqual(csdnMatches(html, "Capacity planning", "https://blog.csdn.net/example"),
    ["https://blog.csdn.net/example/article/details/123"]);
});

test("unique matching article links automatically only when newer than prepublish homepage", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-note-lookup-"));
  const service = new StudyService(root);
  await service.store.update((state) => {
    state.decks.push({ id: "deck", title: "Deck", cards: [{ id: "card", prompt: "Prompt" }] });
  });
  const note = await service.call("note.create", { title: "Capacity planning", cards: [{ cardId: "card" }] });
  await service.call("note.save", { id: note.id, markdown: "# Latest saved version" });
  await service.call("note.home", { home: "https://blog.csdn.net/example" });
  const oldFetch = globalThis.fetch;
  let html = '<a href="https://blog.csdn.net/example/article/details/123"><h4>Old note</h4></a>';
  globalThis.fetch = async () => ({ ok: true, text: async () => html });
  try {
    assert.equal((await service.call("note.preparePublish", { id: note.id })).autoLookupReady, true);
    html = '<a href="https://blog.csdn.net/example/article/details/122"><h4>Capacity planning</h4></a>';
    const oldMatch = await service.call("note.lookup", { id: note.id });
    assert.equal(oldMatch.linked, undefined);
    assert.match(oldMatch.reason, /无法确认/);
    assert.equal((await service.call("note.get", { id: note.id })).markdown, "# Latest saved version");
    html = '<a href="https://blog.csdn.net/example/article/details/124"><div><h4>Capacity planning</h4></div><p>Excerpt</p></a>';
    const fresh = await service.call("note.lookup", { id: note.id });
    assert.equal(fresh.linked.publicUrl, "https://blog.csdn.net/example/article/details/124");
    assert.equal((await service.call("note.get", { id: note.id })).markdown, undefined);
  } finally { globalThis.fetch = oldFetch; }
});

test("AI note draft is generated in the background and keeps review links", async () => {
  const root = await mkdtemp(join(tmpdir(), "study-note-generate-"));
  const service = new StudyService(root, { complete: async () =>
    "# Capacity planning\n\n## 核心概念\n\n容量规划要先定义负载，再估算系统在不同流量下的资源需求。\n\n" +
    "## 常见误区\n\n不能只用一次峰值测量推断所有场景，需要考虑请求组合变化。\n\n" +
    "## 例子\n\n假设请求速率逐步提高，先测响应时间，再观察瓶颈。" });
  await service.store.update((state) => {
    state.decks.push({ id: "deck", title: "Private course", cards: [{ id: "card", topic: "Capacity planning",
      prompt: "Private course question", answer: "Answer", explanation: "Explanation", misconception: "Misconception" }] });
  });
  const note = await service.call("note.create", { title: "Capacity planning", cards: [{ cardId: "card" }] });
  assert.equal((await service.call("note.generate", { id: note.id })).status, "running");
  let ready;
  for (let attempt = 0; attempt < 30; attempt++) {
    ready = await service.call("note.get", { id: note.id });
    if (ready.generation.status !== "running") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(ready.generation.status, "done");
  assert.match(ready.markdown, /容量规划/);
  assert.ok(!ready.markdown.includes("Private course"));
  assert.equal(ready.cards[0].cardId, "card");
});
