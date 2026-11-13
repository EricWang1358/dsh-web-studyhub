import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { wavDurationSeconds, hasTranscribeKey, transcribeUploadedClip } from "../lib/contexts/audio/clip.js";
import { pcmChunksToWavBytes } from "../ui/voice/mic.js";

test("wavDurationSeconds computes PCM duration and hasTranscribeKey checks configured providers", () => {
  const sample = pcmChunksToWavBytes([new Int16Array(16000)], 16000);
  const secs = wavDurationSeconds(Buffer.from(sample));
  assert.ok(Math.abs(secs - 1) <= 0.1);

  assert.equal(hasTranscribeKey({}), false);
  assert.equal(hasTranscribeKey({ freeKey: "AIza-free" }), true);
  assert.equal(hasTranscribeKey({ siliconflowKey: "sf-key" }), true);
  assert.equal(hasTranscribeKey({ groqKey: "gsk-test" }), true);
  assert.equal(hasTranscribeKey({ paidKey: "AIza-paid" }), true);
});

test("transcribeUploadedClip deletes uploaded raw audio after transcription even when provider throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audio-clip-"));
  const wav = pcmChunksToWavBytes([new Int16Array(8000)], 16000);
  let claimedDir = "";

  const prepareUpload = async (id) => {
    claimedDir = join(dir, id);
    await mkdir(claimedDir, { recursive: true });
    const filePath = join(claimedDir, "clip.wav");
    await writeFile(filePath, wav);
    return { id, dir: claimedDir, path: filePath, name: "clip.wav" };
  };

  const okRecord = await prepareUpload("clip-ok-001");
  const okUploads = {
    claimUpload(_root, uploadId) {
      assert.equal(uploadId, "clip-ok-001");
      return okRecord;
    },
    async discardUpload(upload) {
      if (upload?.dir) await rm(upload.dir, { recursive: true, force: true });
    },
  };

  const okFetch = async (url) => ({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => (String(url).includes("groq")
      ? { text: "幂等和指数退避" }
      : { candidates: [{ content: { parts: [{ text: "幂等和指数退避" }] } }] }),
    text: async () => JSON.stringify({ text: "幂等和指数退避" }),
  });

  // Success path deletes raw upload directory in finally.
  const ok = await transcribeUploadedClip({
    root: dir,
    uploadId: "clip-ok-001",
    uploads: okUploads,
    readSettings: async () => ({ groqKey: "gsk-test" }),
    fetch: okFetch,
  });
  assert.equal(ok.text, "幂等和指数退避");
  await assert.rejects(stat(claimedDir), { code: "ENOENT" });

  // Failure path ALSO deletes raw upload directory in finally.
  const errRecord = await prepareUpload("clip-err-001");
  const errUploads = {
    claimUpload(_root, uploadId) {
      assert.equal(uploadId, "clip-err-001");
      return errRecord;
    },
    async discardUpload(upload) {
      if (upload?.dir) await rm(upload.dir, { recursive: true, force: true });
    },
  };

  await assert.rejects(
    transcribeUploadedClip({
      root: dir,
      uploadId: "clip-err-001",
      uploads: errUploads,
      readSettings: async () => ({ groqKey: "gsk-test" }),
      fetch: async () => { throw new Error("upstream STT failure"); },
    }),
    /upstream STT failure/,
  );
  const leftover = await readdir(dir);
  assert.deepEqual(leftover, []);
});
