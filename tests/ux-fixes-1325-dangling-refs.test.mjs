import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StudyService } from "../lib/service.js";
import { blogGenerationInput } from "../lib/blog-generation.js";
import { inferNoteCardsCourse } from "../lib/contexts/notes/question-note.js";

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "studyhub-1325-batch3-"));
}

const cardBase = { objective: "Understand core concept", hint: "Recall the definition.", explanation: "Core mechanism explanation.", misconception: "Confusing adjacent terms." };

test("#1325-7: notes with deleted cards remain saveable, allow clearing to empty cards, skip deleted cards in AI draft, and keep daily course attribution", async () => {
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    await service.call("source.add", { id: "s1", title: "OS Notes", text: "Paging separates logical and physical memory cleanly.", courses: ["OS"] });
    await service.call("draft.save", {
      deck: {
        id: "d-os",
        title: "OS Quiz",
        course: "OS",
        cards: [
          { ...cardBase, id: "c-keep", kind: "flashcard", topic: "Paging", prompt: "What is a page table?", answer: "Maps VPN to PFN.", citations: [{ sourceId: "s1", quote: "Paging separates logical and physical memory cleanly." }] },
          { ...cardBase, id: "c-del", kind: "flashcard", topic: "Paging", prompt: "What is TLB?", answer: "Page table cache.", citations: [{ sourceId: "s1", quote: "Paging separates logical and physical memory cleanly." }] },
        ],
      },
    });
    await service.call("draft.publish.quick", { id: "d-os" });

    // Create a note linked to both cards
    const note = await service.call("note.create", {
      title: "2026-11-23 · OS · 学习笔记",
      cards: [{ deckId: "d-os", cardId: "c-keep" }, { deckId: "d-os", cardId: "c-del" }],
      reuse: true,
    });

    // Delete c-del via deck edit + publish
    const editDraft = await service.call("deck.edit", { id: "d-os" });
    await service.call("draft.save", { deck: { ...editDraft, cards: editDraft.cards.filter((c) => c.id !== "c-del") } });
    await service.call("draft.publish.quick", { id: editDraft.id });

    // 1. Saving note with pre-existing deleted cardId still succeeds (no deadlock)
    const saved = await service.call("note.save", {
      id: note.id,
      markdown: "# Updated body with stale ref\n\nStill editable!",
      cards: [{ deckId: "d-os", cardId: "c-keep" }, { deckId: "d-os", cardId: "c-del" }],
      expectedRevision: note.revision,
    });
    assert.equal(saved.cards.length, 2);
    assert.equal(saved.cards.find((c) => c.cardId === "c-del")?.missing, true);

    // 2. Saving a brand-new nonexistent cardId is still rejected
    await assert.rejects(
      () => service.call("note.save", {
        id: note.id,
        cards: [{ deckId: "d-os", cardId: "brand-new-missing" }],
        expectedRevision: saved.revision,
      }),
      /Question not found/,
    );

    // 3. blogGenerationInput skips deleted cards and uses surviving live cards
    const state = await service.store.read();
    const rawNote = state.notes.find((n) => n.id === note.id);
    const genItems = blogGenerationInput(state, rawNote, "zh");
    assert.equal(genItems.length, 1);
    assert.equal(genItems[0].question, "What is a page table?");

    // 4. Removing all linked cards on an existing note is allowed (unlocks single-card deleted deadlock)
    const cleared = await service.call("note.save", {
      id: note.id,
      cards: [],
      markdown: "# Pure markdown note",
      expectedRevision: saved.revision,
    });
    assert.equal(cleared.cards.length, 0);

    // 5. blogGenerationInput throws localized Chinese message when 0 live cards remain
    const stateAfterClear = await service.store.read();
    assert.throws(
      () => blogGenerationInput(stateAfterClear, stateAfterClear.notes.find((n) => n.id === note.id), "zh"),
      /原题都已移除/,
    );

    // 6. inferNoteCardsCourse does NOT collapse all-deleted refs to '' (uncategorised)
    assert.equal(
      inferNoteCardsCourse(stateAfterClear, [{ deckId: "d-os", cardId: "c-del" }], "2026-11-23 · OS · 学习笔记"),
      "OS",
    );
    assert.equal(
      inferNoteCardsCourse(stateAfterClear, [{ deckId: "d-os", cardId: "c-del" }], "Custom title"),
      null,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1325-8: skeleton prunes deleted cards/decks, filters archived/slain cards on read, and patchSkeleton recovers from stale refs while staying anti-hallucination", async () => {
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    await service.call("source.add", { id: "s1", title: "Net", text: "TCP ensures reliable ordered delivery while UDP is connectionless." });
    await service.call("draft.save", {
      deck: {
        id: "d1",
        title: "Net A",
        cards: [
          { ...cardBase, id: "c1", kind: "flashcard", topic: "Transport", prompt: "TCP reliability?", answer: "ACK + retransmit", citations: [{ sourceId: "s1", quote: "TCP ensures reliable ordered delivery while UDP is connectionless." }] },
          { ...cardBase, id: "c2", kind: "flashcard", topic: "Transport", prompt: "UDP header?", answer: "8 bytes", citations: [{ sourceId: "s1", quote: "TCP ensures reliable ordered delivery while UDP is connectionless." }] },
        ],
      },
    });
    await service.call("draft.publish.quick", { id: "d1" });
    await service.call("draft.save", {
      deck: {
        id: "d2",
        title: "Net B",
        cards: [
          { ...cardBase, id: "c3", kind: "flashcard", topic: "Transport", prompt: "TCP handshake?", answer: "3-way SYN/SYN-ACK/ACK", citations: [{ sourceId: "s1", quote: "TCP ensures reliable ordered delivery while UDP is connectionless." }] },
        ],
      },
    });
    await service.call("draft.publish.quick", { id: "d2" });

    const saved = await service.call("skeleton.save", {
      skeleton: {
        title: "Transport Layer",
        scope: [{ deckId: "d1", cardId: "c1" }, { deckId: "d1", cardId: "c2" }, { deckId: "d2", cardId: "c3" }],
        nodes: [
          { id: "tcp", term: "TCP", meaning: "Reliable transport", cards: ["c1", "c3"] },
          { id: "udp", term: "UDP", meaning: "Connectionless transport", cards: ["c2"] },
        ],
        relations: [{ from: "tcp", to: "udp", type: "contrasts" }],
      },
    });

    // 1. Slay c3 -> skeleton.get filters c3 out so practice won't fail with archived/slain error
    await service.call("card.slay", { deckId: "d2", cardId: "c3" });
    const afterSlay = await service.call("skeleton.get", { id: saved.id });
    assert.deepEqual(afterSlay.nodes.find((n) => n.id === "tcp").cards.map((c) => c.cardId), ["c1"]);

    // 2. Delete c2 via editing draft publish -> pruned from stored skeleton
    const draft = await service.call("deck.edit", { id: "d1" });
    await service.call("draft.save", { deck: { ...draft, cards: draft.cards.filter((c) => c.id !== "c2") } });
    await service.call("draft.publish.quick", { id: draft.id });

    const rawAfterDelete = (await service.store.read()).skeletons.find((k) => k.id === saved.id);
    assert.equal(rawAfterDelete.nodes.find((n) => n.id === "udp").cards.length, 0);
    assert.ok(!rawAfterDelete.scope.some((ref) => ref.cardId === "c2"));

    // 3. Simulate a pre-existing stale dead card ref directly in storage, then patchSkeleton adds a new node cleanly
    await service.store.update((s) => {
      const sk = s.skeletons.find((k) => k.id === saved.id);
      sk.scope.push({ deckId: "deleted-deck", cardId: "dead-card" });
      sk.nodes[0].cards.push({ deckId: "deleted-deck", cardId: "dead-card" });
    });
    const patched = await service.call("skeleton.patch", {
      id: saved.id,
      ops: [{ op: "node.add", node: { id: "quic", term: "QUIC", meaning: "UDP-based multiplexed transport" } }],
    });
    assert.ok(patched.skeleton.nodes.some((n) => n.id === "quic"));
    assert.ok(!patched.skeleton.nodes[0].cards.some((c) => c.cardId === "dead-card"));

    // 4. Anti-hallucination still rejects bogus cardId in patchSkeleton ops
    await assert.rejects(
      () => service.call("skeleton.patch", { id: saved.id, ops: [{ op: "node.cards", id: "quic", add: ["hallucinated-id"] }] }),
      /unknown card hallucinated-id/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("#1325-9: source.remove succeeds after completed runs (including previousVersions) while still blocking active runs and decks", async () => {
  const root = tempRoot();
  try {
    const service = new StudyService(root);
    const src = await service.call("source.add", { id: "s-pdf", title: "Big Lecture PDF", text: "Memory hierarchy balances speed and capacity." });
    await service.call("draft.save", {
      deck: {
        id: "d-mem",
        title: "Memory Quiz",
        cards: [
          { ...cardBase, id: "c-mem", kind: "flashcard", topic: "Cache", prompt: "Why cache?", answer: "Locality of reference.", citations: [{ sourceId: src.id, quote: "Memory hierarchy balances speed and capacity." }] },
        ],
      },
    });
    await service.call("draft.publish.quick", { id: "d-mem" });

    // Start a run, answer & finish it, and inject a historical previousVersions citation too
    const run = await service.call("review.start", { deckId: "d-mem", mode: "path" });

    // Archive deck + source while run is open -> archive closes the open run!
    // First test an active run directly: keep deck deleted only after testing open-run block
    await service.call("source.archive", { id: src.id, archived: true });
    await assert.rejects(
      () => service.call("source.remove", { id: src.id, confirm: true }),
      /Source is referenced by a deck or draft/,
    );

    // Finish the run, archive and permanently delete the deck
    await service.call("review.end", { runId: run.id });
    await service.call("deck.archive", { id: "d-mem", archived: true });
    await service.call("deck.remove", { id: "d-mem", confirm: true });

    // Also attach a previousVersions snapshot on the closed run referencing src.id
    await service.store.update((s) => {
      s.runs[0].entries[0].previousVersions = [{ card: { id: "c-mem", citations: [{ sourceId: src.id, quote: "Memory hierarchy balances speed and capacity." }] } }];
    });

    // Now source.remove MUST succeed (completed runs & previousVersions no longer pin the source!)
    const removed = await service.call("source.remove", { id: src.id, confirm: true });
    assert.equal(removed.ok, true);
    const after = await service.store.read();
    assert.equal(after.sources.some((x) => x.id === src.id), false);

    // Verify an active (open) run with no remaining deck still blocks source.remove with the active-run message
    const src2 = await service.call("source.add", { id: "s-open", title: "Active Run PDF", text: "Virtual memory maps pages." });
    await service.call("source.archive", { id: src2.id, archived: true });
    await service.store.update((s) => {
      s.runs.push({
        id: "r-active",
        mode: "path",
        index: 0,
        entries: [{ deckId: "d-gone", card: { id: "c-open", citations: [{ sourceId: src2.id, quote: "Virtual memory maps pages." }] } }],
      });
    });
    await assert.rejects(
      () => service.call("source.remove", { id: src2.id, confirm: true }),
      /Source is referenced by an active practice run/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
