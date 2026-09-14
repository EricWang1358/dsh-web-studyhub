import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { defaults } from "./domain.js";

export const LATEST_VERSION = 1;
/** Fields every reader may rely on; older libraries are missing newer ones. */
const FIELDS = ["sources", "decks", "drafts", "attempts", "runs", "teaching"];

export const emptyState = () => ({
  version: LATEST_VERSION,
  revision: 0,
  settings: { ...defaults },
  ...Object.fromEntries(FIELDS.map((f) => [f, []])),
});
/* Stepwise upgrades: MIGRATIONS[from] upgrades state to from + 1. Fill this in
   when LATEST_VERSION moves so old libraries keep opening; migration runs in
   memory on read and persists on the next update. */
const MIGRATIONS = {};

/** Apply pending migrations and restore fields this build expects. */
export function normalizeState(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid library: expected an object");
  let s = raw;
  if (
    s.version !== undefined &&
    (!Number.isInteger(s.version) || s.version < 1)
  )
    throw new Error("Invalid library version");
  if (
    s.revision !== undefined &&
    (!Number.isSafeInteger(s.revision) || s.revision < 0)
  )
    throw new Error("Invalid library revision");
  if (
    s.settings !== undefined &&
    (!s.settings || typeof s.settings !== "object" || Array.isArray(s.settings))
  )
    throw new Error("Invalid library settings");
  let version = s.version ?? 1;
  if (version > LATEST_VERSION)
    throw new Error(
      `Library version ${version} is newer than this build supports (up to ${LATEST_VERSION}); update the plugin`,
    );
  while (version < LATEST_VERSION) {
    const migrate = MIGRATIONS[version];
    if (!migrate) throw new Error(`Unsupported library version ${version}`);
    s = migrate(s);
    version++;
  }
  const out = {
    ...s,
    version,
    settings: { ...defaults, ...(s.settings || {}) },
  };
  for (const f of FIELDS) {
    if (out[f] === undefined) out[f] = [];
    else if (!Array.isArray(out[f]))
      throw new Error(`Invalid library ${f}: expected an array`);
  }
  if (out.revision == null) out.revision = 0;
  return out;
}

export class Store {
  constructor(root) {
    if (!root || !isAbsolute(root))
      throw new Error("Choose an absolute study library path first");
    this.root = root;
    this.path = join(root, "study-workspace.json");
  }
  async read() {
    try {
      return normalizeState(JSON.parse(await readFile(this.path, "utf8")));
    } catch (e) {
      if (e.code === "ENOENT") return emptyState();
      throw e;
    }
  }
  async update(fn) {
    await mkdir(this.root, { recursive: true });
    const release = await lockfile.lock(this.root, {
      realpath: true,
      retries: { retries: 20, minTimeout: 25, maxTimeout: 250 },
      stale: 30000,
    });
    let temp;
    try {
      const s = await this.read();
      const value = await fn(s);
      s.revision++;
      temp = this.path + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(s, null, 2) + "\n", {
        encoding: "utf8",
        flag: "wx",
      });
      await rename(temp, this.path);
      return value;
    } finally {
      if (temp) await rm(temp, { force: true }).catch(() => {});
      await release();
    }
  }
}
