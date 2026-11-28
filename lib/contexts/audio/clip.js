import { readFile } from "node:fs/promises";
import { effectivePaidOnly } from "../../audio-settings.js";
import { providerStatus } from "../../audio-preflight.js";
import { tiersFromSettings } from "../../gemini.js";
import { startWorker } from "../../live-local.js";
import { audioMessage, endMessage, FRAME_BYTES, SAMPLE_RATE } from "../../live-protocol.js";

/* A voice answer (#1031) is an input method: one short clip, transcribed once, and the text goes into the box the learner would have typed in.
   audio.clip.transcribe reads a finished upload (audio.upload.*), asks ONE tier — a configured cloud provider of 设置 › 音频转写, else the local
   live engine of 课堂实录 when it is installed (no key, nothing leaves the computer) — and deletes the raw audio on every path. */

/** The longest clip the server takes (the recorder, ui/voice/wav.js, stops at 90 s; a little slack for the header and rounding). */
const MAX_SECONDS = 90;
const SLACK_SECONDS = 2;
/** The most bytes such a clip can be: 16 kHz mono PCM16 (32 000 bytes a second) and a header. A larger upload is refused before it is read. */
const MAX_BYTES = (MAX_SECONDS + SLACK_SECONDS) * 32_000 + 4096;
const tooLong = () => new Error(`语音回答最长 ${MAX_SECONDS} 秒，请分段说`);

/** No tier for this clip. `reason` is the setup guide's (no-provider, or paid-missing when 只用付费密钥 is on and only free keys are set). */
const setupError = (reason) => Object.assign(new Error("还没有可用的语音转写：在「设置 › 音频转写」填一个转写服务，或在课堂实录里装好本地识别引擎"), { code: "AUDIO_SETUP", reason: reason || "no-provider" });

/** The PCM of a WAV clip: { rate, channels, bits, pcm, seconds }, or null when the bytes are not a plain PCM WAV. */
export function wavPcm(bytes) {
  if (!bytes || bytes.length < 44 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WAVE") return null;
  let offset = 12, format = null;
  while (offset + 8 <= bytes.length) {
    const id = bytes.toString("ascii", offset, offset + 4), size = bytes.readUInt32LE(offset + 4), body = offset + 8;
    if (id === "fmt " && size >= 16) format = { tag: bytes.readUInt16LE(body), channels: bytes.readUInt16LE(body + 2), rate: bytes.readUInt32LE(body + 4), bits: bytes.readUInt16LE(body + 14) };
    if (id === "data") {
      if (!format || format.tag !== 1) return null;
      const pcm = bytes.subarray(body, Math.min(bytes.length, body + size));
      return { rate: format.rate, channels: format.channels, bits: format.bits, pcm, seconds: pcm.length / (format.rate * format.channels * (format.bits / 8)) };
    }
    offset = body + size + (size % 2);
  }
  return null;
}

/** Finals of the local engine as one text: Chinese runs on, two Latin words keep a space between them. */
const joinFinals = (finals) => finals.reduce((text, part) => (text && /[A-Za-z0-9]$/.test(text) && /^[A-Za-z0-9]/.test(part) ? `${text} ${part}` : text + part), "").trim();

/** How long the local engine may take to answer a clip of `seconds`: 30 s, plus one and a half times the clip (it runs at about real time). */
const localReplyMs = (seconds) => 30_000 + Math.ceil(1.5 * seconds * 1000);

/** How long an idle warm local ASR worker stays resident before being reclaimed (default: 3 minutes). */
export const CLIP_WORKER_IDLE_TTL_MS = 3 * 60_000;

/**
 * Warm reusable worker pool for short voice-answer clips: avoids cold-loading 230 MB–1 GB ONNX models on every clip,
 * serializes overlapping clip decodes onto the warm worker, reclaims idle workers after `idleTtlMs`, and supports
 * draining & destroying the resident worker before model switching or engine uninstall.
 */
export function createLocalClipPool({ idleTtlMs = CLIP_WORKER_IDLE_TTL_MS, createWorker = startWorker } = {}) {
  let entry = null;
  let tail = Promise.resolve();
  let spawns = 0;

  const keyOf = ({ enginePath, modelDir, modelId, timing }) =>
    `${enginePath}\0${modelDir}\0${modelId || "sense-voice"}\0${timing?.minSilenceSec ?? ""}`;

  const destroyEntry = async (target) => {
    if (!target) return;
    clearTimeout(target.idleTimer);
    target.idleTimer = null;
    target.alive = false;
    if (entry === target) entry = null;
    try { await target.worker?.terminate?.(); } catch { /* worker already exited */ }
  };

  const scheduleIdle = (target) => {
    clearTimeout(target.idleTimer);
    target.idleTimer = null;
    if (!target.alive || entry !== target) return;
    target.worker?.unref?.();
    if (!(idleTtlMs > 0)) return;
    target.idleTimer = setTimeout(() => {
      if (entry === target && !target.busy) void destroyEntry(target);
    }, idleTtlMs);
    target.idleTimer.unref?.();
  };

  const spawnEntry = (localOptions, key) => {
    const factory = localOptions.createWorker || createWorker;
    const worker = factory({
      modelDir: localOptions.modelDir,
      enginePath: localOptions.enginePath,
      modelId: localOptions.modelId,
      timing: { ...(localOptions.timing || {}), disableInterim: true },
    });
    spawns += 1;
    const next = { key, worker, alive: true, busy: false, idleTimer: null, ready: null };
    next.ready = new Promise((resolve, reject) => {
      let settled = false;
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        worker.off?.("message", onMessage);
        worker.off?.("error", onError);
        worker.off?.("exit", onExit);
        fn(value);
      };
      const onMessage = (message) => {
        if (message?.type === "ready") done(resolve);
        else if (message?.type === "error") done(reject, new Error(message.message || "本地识别引擎中断"));
      };
      const onError = (error) => done(reject, new Error(`本地识别引擎出错：${error?.message || error}`));
      const onExit = (code) => done(reject, new Error(`本地识别引擎已退出（代码 ${code}）`));
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.on("exit", onExit);
    });
    // Prevent unhandled rejection if worker dies while idle between clips.
    next.ready.catch(() => {});
    worker.on("error", () => { if (entry === next && !next.busy) void destroyEntry(next); else next.alive = false; });
    worker.on("exit", () => {
      clearTimeout(next.idleTimer);
      next.idleTimer = null;
      next.alive = false;
      if (entry === next) entry = null;
    });
    entry = next;
    return next;
  };

  const runOnPool = (localOptions, pcm, { openTimeoutMs = 90_000, replyTimeoutMs = localReplyMs(pcm.length / (SAMPLE_RATE * 2)) } = {}) => {
    const turn = tail.then(async () => {
      const key = keyOf(localOptions);
      if (entry && (!entry.alive || entry.key !== key)) {
        await destroyEntry(entry);
      }
      const active = entry || spawnEntry(localOptions, key);
      clearTimeout(active.idleTimer);
      active.idleTimer = null;
      active.worker?.ref?.();
      active.busy = true;
      let failed = false;
      try {
        let openTimer;
        try {
          await Promise.race([
            active.ready,
            new Promise((_, reject) => {
              openTimer = setTimeout(() => reject(new Error("本地识别引擎没有按时启动，请稍后再试")), openTimeoutMs);
              openTimer.unref?.();
            }),
          ]);
        } finally { clearTimeout(openTimer); }
        if (!active.alive) throw new Error("本地识别引擎中断");

        const finals = [];
        let replyTimer;
        const result = await new Promise((resolve, reject) => {
          let settled = false;
          const cleanup = () => {
            clearTimeout(replyTimer);
            active.worker.off?.("message", onMessage);
            active.worker.off?.("error", onError);
            active.worker.off?.("exit", onExit);
          };
          const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
          };
          const onMessage = (message) => {
            if (message?.type === "final" && message.text) finals.push(String(message.text).trim());
            else if (message?.type === "done") finish(resolve, joinFinals(finals.filter(Boolean)));
            else if (message?.type === "error") finish(reject, new Error(message.message || "本地识别引擎中断"));
          };
          const onError = (error) => finish(reject, new Error(`本地识别引擎出错：${error?.message || error}`));
          const onExit = (code) => finish(reject, new Error(`本地识别引擎已退出（代码 ${code}）`));
          active.worker.on("message", onMessage);
          active.worker.on("error", onError);
          active.worker.on("exit", onExit);

          replyTimer = setTimeout(() => finish(reject, new Error("本地识别引擎没有按时给出文字，请稍后再试")), replyTimeoutMs);
          replyTimer.unref?.();

          for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) {
            const slice = pcm.subarray(offset, offset + FRAME_BYTES);
            const copy = new Uint8Array(slice.length);
            copy.set(slice);
            active.worker.postMessage({ type: "audio", buffer: copy.buffer }, [copy.buffer]);
          }
          active.worker.postMessage({ type: "end", keepAlive: true });
        });
        return result;
      } catch (error) {
        failed = true;
        throw error;
      } finally {
        active.busy = false;
        if (failed || !active.alive) await destroyEntry(active);
        else scheduleIdle(active);
      }
    });
    tail = turn.then(() => {}, () => {});
    return turn;
  };

  /** Drain any in-flight clip decode, then terminate and evict the warm worker (called before uninstall or model switch). */
  const drain = () => {
    const done = tail.then(() => destroyEntry(entry));
    tail = done.then(() => {}, () => {});
    return done;
  };

  const stats = () => ({ hasWorker: Boolean(entry?.alive), busy: Boolean(entry?.busy), key: entry?.key ?? null, spawns });

  return { transcribe: runOnPool, drain, stats };
}

const defaultClipPool = createLocalClipPool();
export const drainLocalClipPool = () => defaultClipPool.drain();
export const localClipPoolStats = () => defaultClipPool.stats();

/** One clip on the local live engine: reuses the warm idle-TTL worker pool when given a loopbackFactory, or speaks the
    Live wire format directly for injectable test sockets. `pcm`: 16 kHz mono PCM16. */
export async function transcribeLocally(WebSocketImpl, pcm, { openTimeoutMs = 90_000, replyTimeoutMs = localReplyMs(pcm.length / (SAMPLE_RATE * 2)), pool = defaultClipPool } = {}) {
  if (WebSocketImpl?.localOptions) {
    return pool.transcribe(WebSocketImpl.localOptions, pcm, { openTimeoutMs, replyTimeoutMs });
  }
  const socket = new WebSocketImpl("local://voice-answer");
  const finals = [];
  const closed = new Promise((resolve) => socket.addEventListener("close", resolve));
  const opened = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(new Error("本地识别引擎没有按时启动，请稍后再试")); }, openTimeoutMs);
    timer.unref?.();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.setupComplete) { clearTimeout(timer); resolve(); }
      const text = message.serverContent?.inputTranscription?.text;
      if (text) finals.push(text.trim());
    });
    closed.then((event) => { clearTimeout(timer); reject(new Error(event.reason || "本地识别引擎中断")); });
  });
  await opened;
  for (let offset = 0; offset < pcm.length; offset += FRAME_BYTES) socket.send(JSON.stringify(audioMessage(pcm.subarray(offset, offset + FRAME_BYTES))));
  socket.send(JSON.stringify(endMessage()));
  // An engine that takes the clip and never closes would hold the answer forever: it gets time in step with the clip (localReplyMs).
  let replyTimer;
  const gaveUp = new Promise((_, reject) => { replyTimer = setTimeout(() => { reject(new Error("本地识别引擎没有按时给出文字，请稍后再试")); socket.close(); }, replyTimeoutMs); });
  const { code, reason } = await Promise.race([closed, gaveUp]).finally(() => clearTimeout(replyTimer));
  if (code !== 1000) throw new Error(reason || "本地识别引擎中断");
  return joinFinals(finals.filter(Boolean));
}

/**
 * Transcribe one uploaded voice clip and delete it. `uploads` is the audio context's registry; `local()` gives the local engine's socket class when
 * it is installed (lib/contexts/audio/install/live-local-runs.js), else null. `paidOnly`: the request's 只用付费密钥, like the other audio operations;
 * absent, the audio settings' default (paidOnlyByDefault). With it on, a free key is never sent the learner's voice. Returns { text, seconds, tier }.
 */
export async function transcribeClip({ root, uploadId, uploads, settings, httpFetch, fetch: rawFetch, language, local, paidOnly }) {
  const transport = httpFetch ?? rawFetch;
  let upload;
  try { upload = uploads.claimUpload(root, String(uploadId ?? "")); }
  catch (error) {
    // An upload that never finished is not kept for later: it is cancelled now, not left to the 24 h backstop. One another import has claimed is
    // left alone (lib/audio-upload.js dropUnclaimedUpload).
    await uploads.dropUnclaimedUpload(root, String(uploadId ?? "")).catch(() => {});
    throw error;
  }
  let bytes;
  try {
    if (!(upload.size <= MAX_BYTES)) throw tooLong(); // refused on its declared size, before the bytes are read
    bytes = await readFile(upload.path);
  } finally { await uploads.discardUpload(upload).catch(() => {}); } // the raw voice is never kept once it was read
  const wav = wavPcm(bytes);
  if (!bytes.length || (wav && !wav.pcm.length)) throw new Error("录音是空的，请重新录一次");
  const seconds = wav ? wav.seconds : bytes.length / 32000;
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("录音格式不对，请用页面上的录音按钮重新录");
  if (seconds > MAX_SECONDS + SLACK_SECONDS) throw tooLong();
  const paid = effectivePaidOnly(paidOnly, settings);
  const status = providerStatus(settings, { paidOnly: paid });
  if (status.transcription) {
    const languageCodes = Array.isArray(settings.languageCodes) && settings.languageCodes.length ? settings.languageCodes : language === "en" ? ["en"] : ["zh", "en"];
    const tiers = tiersFromSettings(settings, { httpFetch: transport, skipFree: paid });
    const result = await tiers.transcribe({ bytes, mimeType: "audio/wav", kind: ".wav", seconds: Math.max(1, Math.round(seconds)), config: { languageCodes } });
    return { text: String(result?.text ?? "").trim(), seconds, tier: "cloud" };
  }
  const WebSocketImpl = await local();
  if (!WebSocketImpl) throw setupError(status.reason);
  if (!wav || wav.rate !== SAMPLE_RATE || wav.channels !== 1 || wav.bits !== 16) throw new Error("本地识别只接受 16 kHz 单声道录音，请用页面上的录音按钮重新录");
  return { text: await transcribeLocally(WebSocketImpl, wav.pcm), seconds, tier: "local" };
}
