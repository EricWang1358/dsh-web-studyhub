import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { AUDIO_EXTENSIONS } from "./audio-file.js";

/* Finding audio in the session workspace, the way the composer's @ finds files:
   the learner searches and picks, and never types a path. Only the workspace is
   read, and only names, sizes and dates leave it. */

const SKIP = new Set(["node_modules", "dist", "build", "__pycache__", "venv", "site-packages", "audio-uploads", "audio-cache", "audio-batches", "shards", "backups"]);
const MAX_DEPTH = 6, MAX_VISITED = 20_000, MAX_RESULTS = 200;

export async function scanAudioFiles(root, { query = "", limit = 60 } = {}) {
  if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("工作区路径无效");
  const needle = String(query ?? "").trim().toLowerCase().slice(0, 100);
  const max = Math.min(Math.max(Number(limit) || 60, 1), MAX_RESULTS);
  const found = [], queue = [{ dir: root, depth: 0 }];
  let visited = 0, truncated = false;
  while (queue.length) {
    const { dir, depth } = queue.shift();
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++visited > MAX_VISITED) { truncated = true; queue.length = 0; break; }
      // Hidden folders (.git, .dsh-study, .claude) are never the learner's recordings.
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH && !SKIP.has(entry.name)) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      if (!entry.isFile() || !AUDIO_EXTENSIONS.includes(path.extname(entry.name).toLowerCase())) continue;
      const rel = path.relative(root, full);
      if (needle && !rel.toLowerCase().includes(needle)) continue;
      try {
        const info = await stat(full);
        found.push({ path: full, rel, name: entry.name, size: info.size, modified: Math.round(info.mtimeMs) });
      } catch { /* vanished while scanning */ }
    }
  }
  found.sort((a, b) => b.modified - a.modified);
  return { files: found.slice(0, max), total: found.length, truncated: truncated || found.length > max, root };
}

/**
 * A path as the conversation gives it: quoted, with the @ of a file mention in
 * front, or relative to the workspace. Only the host layer knows the workspace,
 * so it resolves before the service sees the path.
 */
export function resolveWorkspacePath(cwd, value) {
  if (typeof value !== "string") return value;
  const clean = value.trim().replace(/^"(.*)"$/, "$1").replace(/^@/, "").trim();
  if (!clean) return value;
  return path.isAbsolute(clean) ? clean : path.resolve(cwd, clean);
}
/** Preserve submitted order and upload IDs while resolving paths from any host entry point. */
export function resolveAudioImportPaths(cwd, args) {
  return { ...args,
    ...(args.path !== undefined ? { path: resolveWorkspacePath(cwd, args.path) } : {}),
    ...(Array.isArray(args.files) ? { files: args.files.map(file => file && typeof file === 'object' && !Array.isArray(file) && file.path !== undefined
      ? { ...file, path: resolveWorkspacePath(cwd, file.path) } : file) } : {}) };
}
