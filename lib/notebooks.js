import { parseStoredJson } from "./util.js";
import { atomicJson } from "./atomic-json.js";
import { courseActivityRules } from "./course-active.js";
import { constants } from "node:fs";
import {
  copyFile,
  readFile,
  access,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { studyHomePath } from "./runtime/dsh-home.js";
import { withStoreLock } from "./store-lock.js";
import { Store } from "./store.js";
import { norm } from "./domain.js";

/**
 * Cross-workspace notebook registry. Published notebooks stay in their own
 * workspace; the registry only records where each library lives so any
 * workspace's study panel can offer one-click jumps to the others.
 */
const registryPath = () => studyHomePath("notebooks.json");
const SUPPORTED_REGISTRY_VERSION = 1;

async function inspectRegistry() {
  const target = registryPath();
  let raw;
  try {
    raw = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { status: "missing", registry: { version: SUPPORTED_REGISTRY_VERSION, notebooks: [] } };
    }
    return { status: "unreadable", error };
  }
  try {
    const parsed = parseStoredJson(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { status: "corrupt", error: new Error("notebooks.json root must be a JSON object") };
    }
    if (Object.hasOwn(parsed, "version") && parsed.version !== undefined && parsed.version !== SUPPORTED_REGISTRY_VERSION) {
      return {
        status: "unsupported-version",
        version: parsed.version,
        error: new Error(`Unsupported notebooks.json version ${String(parsed.version)} (supported: ${SUPPORTED_REGISTRY_VERSION})`),
      };
    }
    if (!Array.isArray(parsed.notebooks)) {
      return { status: "corrupt", error: new Error("notebooks.json must contain a notebooks array") };
    }
    return { status: "ok", registry: parsed };
  } catch (error) {
    return { status: "corrupt", error };
  }
}

async function readRegistry() {
  const found = await inspectRegistry();
  if (found.status === "ok" || found.status === "missing") return found.registry;
  return { version: SUPPORTED_REGISTRY_VERSION, notebooks: [] };
}

async function backupCorruptRegistry(target) {
  const backupPath = `${target}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}.bak`;
  try {
    await copyFile(target, backupPath, constants.COPYFILE_EXCL);
  } catch (error) {
    throw Object.assign(
      new Error(`notebooks.json could not be backed up (${error?.message || error}); refusing to overwrite`),
      { code: "notebooks-registry-backup-failed", cause: error },
    );
  }
  return backupPath;
}

/** Serialize the entire read/modify/write transaction across processes. */
async function updateRegistry(update) {
  const target = registryPath();
  // The board lives in the same folder: one in-process queue for both, the file lock only between processes (lib/store-lock.js).
  return withStoreLock(join(target, ".."), async () => {
    const found = await inspectRegistry();
    if (found.status === "unreadable") {
      throw Object.assign(
        new Error(`notebooks.json could not be read (${found.error?.message || found.error}); refusing to overwrite`),
        { code: "notebooks-registry-unreadable", cause: found.error },
      );
    }
    if (found.status === "unsupported-version") {
      throw Object.assign(
        new Error(`${found.error?.message || "Unsupported notebooks.json version"}; refusing to overwrite`),
        { code: "notebooks-registry-unsupported-version", cause: found.error },
      );
    }
    let registry;
    if (found.status === "corrupt") {
      await backupCorruptRegistry(target);
      registry = { version: SUPPORTED_REGISTRY_VERSION, notebooks: [] };
    } else {
      registry = found.registry;
    }
    const result = update(registry);
    await atomicJson(target, registry, { space: 2, trailingNewline: true, ensureDir: true, sync: true });
    return result;
  });
}
const libraryExists = (root) =>
  access(join(root, "study-workspace.json")).then(
    () => true,
    () => false,
  );
/** Live read-only stats for one entry; a missing library reads as absent. */
async function describe(entry, currentRoot) {
  const exists = await libraryExists(entry.root);
  const base = {
    root: entry.root,
    workspace: entry.workspace || "",
    title: entry.title || basename(entry.workspace || entry.root),
    publishedAt: entry.publishedAt || null,
    current: entry.root === currentRoot,
    exists,
    decks: [],
    deckCount: 0,
    dueToday: 0,
  };
  if (!exists) return base;
  try {
    const s = await new Store(entry.root).read();
    const rules = courseActivityRules(s);
    const decks = s.decks.map((d) => {
      const cards = d.cards.filter((q) => !q.suspended);
      return {
        id: d.id,
        title: d.title,
        folder: d.folder || "",
        archived: !!d.archived,
        ...(rules.deckActive(d) ? {} : { inactive: true }),
        count: cards.length,
        due: cards.filter(
          (q) => !q.review?.due_at || Date.parse(q.review.due_at) <= Date.now(),
        ).length,
      };
    });
    return {
      ...base,
      decks: decks.slice(0, 50),
      deckCount: decks.filter((d) => !d.archived).length,
      // Parked courses (lib/course-active.js) are not part of what is due today.
      dueToday: decks.filter((d) => !d.archived && !d.inactive).reduce((n, d) => n + d.due, 0),
    };
  } catch {
    return { ...base, exists: false };
  }
}
const byRecency = (a, b) =>
  a.current === b.current
    ? String(b.publishedAt || "").localeCompare(String(a.publishedAt || ""))
    : a.current
      ? -1
      : 1;
export async function listNotebooks(currentRoot) {
  const registry = await readRegistry();
  const described = await Promise.all(
    registry.notebooks
      .filter((e) => e && typeof e.root === "string")
      .map((e) => describe(e, currentRoot)),
  );
  return {
    registryPath: registryPath(),
    currentRoot,
    notebooks: described.filter(Boolean).sort(byRecency),
  };
}
export async function publishNotebook(cwd, currentRoot) {
  return updateRegistry((registry) => {
    const now = new Date().toISOString();
    const entry = {
      root: currentRoot,
      workspace: cwd,
      title: basename(cwd),
      publishedAt:
        registry.notebooks.find((e) => e?.root === currentRoot)?.publishedAt ||
        now,
    };
    registry.notebooks = [
      ...registry.notebooks.filter((e) => e?.root !== currentRoot),
      entry,
    ];
    return entry;
  });
}
export async function unpublishNotebook(currentRoot) {
  return updateRegistry((registry) => {
    registry.notebooks = registry.notebooks.filter(
      (e) => e?.root !== currentRoot,
    );
  });
}
const normSearch = norm;
/** Read-only search across published libraries: deck titles, topics, prompts. */
export async function searchNotebooks(query) {
  const q = normSearch(query);
  if (!q || q.length > 100)
    throw new Error("A 1–100 character query is required");
  const registry = await readRegistry(),
    items = [];
  for (const entry of registry.notebooks) {
    if (!entry || typeof entry.root !== "string") continue;
    let s;
    try {
      s = await new Store(entry.root).read();
    } catch {
      continue;
    }
    for (const deck of s.decks) {
      if (deck.archived) continue;
      if (normSearch(deck.title).includes(q))
        items.push({
          root: entry.root,
          workspace: entry.workspace || "",
          title: entry.title || basename(entry.workspace || entry.root),
          deckId: deck.id,
          deckTitle: deck.title,
          topic: "",
          cardId: "",
          prompt: "",
          due: 0,
        });
      for (const card of deck.cards) {
        if (card.suspended) continue;
        const hit =
          normSearch(card.topic).includes(q) ||
          normSearch(card.prompt).includes(q) ||
          normSearch(card.objective).includes(q);
        if (!hit) continue;
        items.push({
          root: entry.root,
          workspace: entry.workspace || "",
          title: entry.title || basename(entry.workspace || entry.root),
          deckId: deck.id,
          deckTitle: deck.title,
          topic: card.topic || "",
          cardId: card.id,
          prompt: card.prompt,
          due:
            !card.review?.due_at || Date.parse(card.review.due_at) <= Date.now()
              ? 1
              : 0,
        });
      }
      if (items.length >= 50) break;
    }
    if (items.length >= 50) break;
  }
  return { items: items.slice(0, 50) };
}
