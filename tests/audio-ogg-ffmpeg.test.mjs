import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOgg, splitOgg } from "../lib/audio-ogg.js";
import { loadAudio } from "../lib/audio-file.js";

/* #408 with real encoders: recordings made by ffmpeg are split, and ffmpeg itself must decode every part without a
   complaint, the parts adding up to the original's length. Skipped when ffmpeg or ffprobe is not installed. */

const has = (command) => spawnSync(command, ["-version"], { stdio: "ignore", windowsHide: true }).status === 0;
const tools = has("ffmpeg") && has("ffprobe");
const skip = !tools && "ffmpeg / ffprobe are not installed";
const run = (command, args) => spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
const encoders = tools ? run("ffmpeg", ["-hide_banner", "-encoders"]).stdout : "";

/** A recording of `seconds`: a tone that comes and goes, so there is something to decode. */
function record(file, seconds, codec, rate = 48000) {
  const made = run("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=${rate}:duration=${seconds}`,
    "-af", "volume='if(lt(mod(t,7),5),1,0)':eval=frame", "-ac", "1", ...codec, file]);
  assert.equal(made.status, 0, made.stderr);
}
const probeSeconds = (file) => Number(JSON.parse(run("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", file]).stdout).format.duration);
/** Seconds of sound ffmpeg decodes from a file (counted in samples, not taken from the header), and its complaints. */
function decode(file) {
  const out = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-f", "s16le", "-ac", "1", "-ar", "8000", "pipe:1"], { windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return { status: out.status, errors: String(out.stderr).trim(), seconds: out.stdout.length / 2 / 8000 };
}

async function splitAndDecode(t, name, codec, seconds, parts) {
  const dir = await mkdtemp(join(tmpdir(), "audio-ogg-ffmpeg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const source = join(dir, name);
  record(source, seconds, codec);
  const bytes = await readFile(source), info = parseOgg(bytes);
  const probed = probeSeconds(source);
  assert.ok(Math.abs(info.seconds - probed) < 0.05, `our length ${info.seconds} vs ffprobe ${probed}`);
  const whole = decode(source), pieces = splitOgg(bytes, parts, info);
  assert.equal(pieces.length, parts);
  let decoded = 0, stated = 0;
  for (const [index, piece] of pieces.entries()) {
    const file = join(dir, `part${index}${name.slice(name.lastIndexOf("."))}`);
    await writeFile(file, piece.bytes);
    const result = decode(file);
    assert.equal(result.status, 0, result.errors);
    assert.equal(result.errors, "", `part ${index + 1} decodes without a complaint`);
    const probedPart = probeSeconds(file);
    assert.ok(Math.abs(probedPart - piece.seconds) < 0.05, `part ${index + 1}: ffprobe ${probedPart} vs ours ${piece.seconds}`);
    decoded += result.seconds; stated += piece.seconds;
  }
  assert.ok(Math.abs(decoded - whole.seconds) < 0.2, `the parts decode to ${decoded} s, the original to ${whole.seconds} s`);
  assert.ok(Math.abs(stated - seconds) < 0.2, `the parts say ${stated} s of ${seconds} s`);
}

test("a real 3-minute Opus recording splits into parts that ffmpeg decodes, adding up to the whole", { skip }, async (t) => {
  await splitAndDecode(t, "voice.opus", ["-c:a", "libopus", "-b:a", "64k"], 180, 3);
});

test("a real 3-minute Ogg Vorbis recording splits the same way", { skip: skip || (!/libvorbis/.test(encoders) && "this ffmpeg has no libvorbis") }, async (t) => {
  await splitAndDecode(t, "voice.ogg", ["-c:a", "libvorbis", "-q:a", "2"], 180, 3);
});

test("a FLAC recording over one request is cut by ffmpeg without re-encoding, and each piece decodes", { skip }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "audio-flac-ffmpeg-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "lecture.flac");
  record(file, 46 * 60, ["-ar", "8000", "-c:a", "flac"], 8000);
  const measured = await loadAudio({ path: file, measureOnly: true });
  assert.deepEqual([measured.parts, Math.round(measured.seconds)], [2, 2760]);
  await assert.rejects(loadAudio({ path: file, ffmpeg: null }), (error) => error.code === "AUDIO_UNSPLITTABLE" && /约 46 分钟/.test(error.message));
  const audio = await loadAudio({ path: file });
  assert.deepEqual([audio.ext, audio.mimeType, audio.chunks.length], [".flac", "audio/flac", 2]);
  let decoded = 0;
  for (const [index, chunk] of audio.chunks.entries()) {
    const piece = join(dir, `piece${index}.flac`);
    await writeFile(piece, chunk.bytes);
    const result = decode(piece);
    assert.equal(result.status, 0, result.errors);
    assert.equal(run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name", "-of", "csv=p=0", piece]).stdout.trim(), "flac");
    assert.ok(chunk.seconds > 20 * 60 && chunk.seconds < 45 * 60, `${chunk.seconds}`);
    decoded += result.seconds;
  }
  assert.ok(Math.abs(audio.chunks.reduce((sum, chunk) => sum + chunk.seconds, 0) - 2760) < 0.2);
  assert.ok(Math.abs(decoded - 2760) < 0.2, `${decoded}`);
});
