import { mkdir, readFile, writeFile, rename, rm } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { randomUUID } from "node:crypto";
import lockfile from "proper-lockfile";
import { defaults } from "./domain.js";

export const emptyState = () => ({
  version: 1,
  revision: 0,
  settings: { ...defaults },
  sources: [],
  decks: [],
  drafts: [],
  attempts: [],
  runs: [],
  teaching: [],
});
export class Store {
  constructor(root) {
    if (!root || !isAbsolute(root))
      throw new Error("Choose an absolute study library path first");
    this.root = root;
    this.path = join(root, "study-workspace.json");
  }
  async read() {
    try {
      const s = JSON.parse(await readFile(this.path, "utf8"));
      if (s.version !== 1) throw new Error("Unsupported library version");
      return s;
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
