import { appendFile, mkdir, readdir, rm, stat, lstat, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES } from "./audio-file.js";

/* A file the learner chose or dropped in the panel. The browser cannot tell the
   plugin where a file lives, so it sends the bytes in small chunks (the panel
   transport caps a request at 12 MB) and the plugin assembles them in the
   library's audio-uploads/ folder. The path is only ever made here, from an
   upload id the plugin issued, never taken from the browser. The copy is
   removed once the import that used it has finished. */

export const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const STALE_MS = 24 * 60 * 60 * 1000;
const ID = /^[\w-]{8,64}$/;

export const uploadsDir = (root) => path.join(root, "audio-uploads");
/** The name the learner will see in the source: no folders, no characters a file system refuses. */
export const safeName = (name) => path.basename(String(name ?? "").replace(/\\/g, "/")).replace(/[\u0000-\u001f<>:"|?*]/g, "_").slice(-120);

/** Upload work belongs to one runtime, even when another runtime uses the same disk root. */
export function createUploadRegistry(uploads = new Map()) {
  const owned = new WeakSet(uploads.values());
  const requireOwned = upload => {
    if (!owned.has(upload)) throw new Error('Upload belongs to another runtime');
  };
  const record = (root, id) => {
    const found = ID.test(String(id)) ? uploads.get(id) : null;
    if (!found || found.root !== root) throw new Error("这次上传已经失效，请重新选择文件");
    return found;
  };

  /** Remove upload folders that nothing will claim any more (a restart forgets the map). */
  async function pruneStale(root) {
    let names = [];
    try { names = await readdir(uploadsDir(root)); } catch { return; }
    for (const name of names) {
      const dir = path.join(uploadsDir(root), name);
      try {
        if (!uploads.has(name) && Date.now() - (await stat(dir)).mtimeMs > STALE_MS) await rm(dir, { recursive: true, force: true });
      } catch { /* another process got there first */ }
    }
  }

  async function startUpload(root, { name, size }) {
    const clean = safeName(name), ext = path.extname(clean).toLowerCase();
    if (!clean || !AUDIO_EXTENSIONS.includes(ext)) throw new Error(`不支持的音频格式 ${ext || "（无扩展名）"}；支持 ${AUDIO_EXTENSIONS.join("、")}`);
    if (!Number.isSafeInteger(size) || size < 1) throw new Error("音频文件是空的");
    if (size > MAX_AUDIO_BYTES) throw new Error("音频超过 512 MB，请先压缩成 MP3 或按章节拆分");
    await pruneStale(root);
    const id = randomUUID(), dir = path.join(uploadsDir(root), id), file = path.join(dir, clean);
    await mkdir(dir, { recursive: true });
    await writeFile(file, "");
    const upload = { id, root, dir, path: file, name: clean, size, received: 0, complete: false, claimed: false };
    uploads.set(id, upload);
    owned.add(upload);
    return { uploadId: id, chunkBytes: UPLOAD_CHUNK_BYTES };
  }

  async function appendUpload(root, { uploadId, offset, data }) {
    const upload = record(root, uploadId);
    if (upload.complete) throw new Error("这个文件已经上传完成");
    if (offset !== upload.received) throw new Error("上传顺序不对，请重新选择文件");
    if (typeof data !== "string" || data.length > Math.ceil(UPLOAD_CHUNK_BYTES / 3) * 4 + 8 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw new Error("上传的数据无效");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length || upload.received + bytes.length > upload.size) throw new Error("上传的数据超过了声明的文件大小");
    await appendFile(upload.path, bytes);
    upload.received += bytes.length;
    return { received: upload.received };
  }

  function finishUpload(root, uploadId) {
    const upload = record(root, uploadId);
    if (upload.received !== upload.size) throw new Error(`文件没有传完（${upload.received} / ${upload.size} 字节），请重新选择`);
    upload.complete = true;
    return { uploadId: upload.id, name: upload.name, size: upload.size };
  }

  async function cancelUpload(root, uploadId) {
    const upload = uploads.get(uploadId);
    if (!upload || upload.root !== root) return { cancelled: false };
    uploads.delete(upload.id);
    await rm(upload.dir, { recursive: true, force: true });
    return { cancelled: true };
  }

  /** Hand a finished upload to an import; it is not offered to a second import. */
  function claimUpload(root, uploadId) {
    const upload = record(root, uploadId);
    if (!upload.complete) throw new Error("文件还没有传完，请等上传结束");
    if (upload.claimed) throw new Error("这个文件已经在导入");
    upload.claimed = true;
    return upload;
  }
  /** Where a finished upload is, for a read-only pre-flight check: it stays unclaimed and owned by the panel. */
  function inspectUpload(root, uploadId) {
    const upload = record(root, uploadId);
    if (!upload.complete) throw new Error("文件还没有传完，请等上传结束");
    return { path: upload.path, name: upload.name, size: upload.size };
  }
  /** Release a claim so the same upload can be tried again (the import never started). */
  function releaseUpload(upload) { requireOwned(upload); upload.claimed = false; }

  /** Reclaim a completed file named by a persisted import checkpoint after restart.
   * Persisted paths are never trusted, and this does not authorize foreign handles. */
  async function adoptStoredUpload(root, { id, name }) {
    if (!path.isAbsolute(root) || !ID.test(String(id)) || typeof name !== 'string' || name !== safeName(name) ||
        !AUDIO_EXTENSIONS.includes(path.extname(name).toLowerCase())) throw new Error('Invalid stored upload');
    const dir = path.join(uploadsDir(root), id), file = path.join(dir, name);
    const [rootPath, directory, info] = await Promise.all([realpath(root), lstat(dir), lstat(file)]);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !info.isFile() || info.isSymbolicLink() ||
        info.size < 1 || info.size > MAX_AUDIO_BYTES ||
        await realpath(dir) !== path.join(rootPath, 'audio-uploads', id) || await realpath(file) !== path.join(rootPath, 'audio-uploads', id, name))
      throw new Error('Stored upload is outside its library or incomplete');
    const existing = uploads.get(id);
    if (existing) {
      requireOwned(existing);
      if (existing.root !== root || existing.name !== name || existing.path !== file || !existing.complete)
        throw new Error('Stored upload identity conflict');
      return existing;
    }
    const upload = { id, root, dir, path: file, name, size: info.size, received: info.size, complete: true, claimed: true };
    uploads.set(id, upload); owned.add(upload);
    return upload;
  }

  /** The import is over (in any state): the transcripts are cached, the original copy is not needed. */
  async function discardUpload(upload) {
    requireOwned(upload);
    uploads.delete(upload.id);
    await rm(upload.dir, { recursive: true, force: true });
  }
  return Object.freeze({ startUpload, appendUpload, finishUpload, cancelUpload, claimUpload, inspectUpload, releaseUpload, discardUpload, adoptStoredUpload });
}

// Standalone callers keep their API. Audio contexts inject an independently owned registry.
export const { startUpload, appendUpload, finishUpload, cancelUpload,
  claimUpload, inspectUpload, releaseUpload, discardUpload } = createUploadRegistry();
