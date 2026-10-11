import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { CUT_PREFIX, runFfmpeg, sweepStaleCuts } from "./groq.js";

/* Cutting the formats StudyHub cannot cut itself (FLAC, AIFF, AAC, WebM) when a recording is longer than one
   transcription request and ffmpeg is installed (#408). ffmpeg's segment muxer copies the coded audio into pieces of
   the same format (-c copy: nothing is decoded or re-encoded) and lists where each piece starts and ends, which gives
   every piece its real length. The pieces are read into memory, like the parts audio-file.js cuts itself, and the
   temporary folder is removed (one left by a crash is removed by a later cut once it is a day old). */

/**
 * Pieces of `pieceSeconds` (the last one shorter), each { bytes, seconds }, in the recording's own format `kind`
 * (".flac" …). A caller wanting N equal pieces asks for a second over the even share, so packet boundaries never
 * leave a sliver of a piece at the end.
 */
export async function cutWithFfmpeg({ command, bytes, kind, pieceSeconds }) {
  await sweepStaleCuts();
  const dir = await mkdtemp(join(tmpdir(), CUT_PREFIX));
  try {
    const input = join(dir, `in${kind}`), list = join(dir, "pieces.csv");
    await writeFile(input, bytes);
    await runFfmpeg(command, ["-y", "-v", "error", "-i", input, "-map", "0:a:0", "-c", "copy", "-f", "segment", "-segment_time", pieceSeconds.toFixed(3),
      "-reset_timestamps", "1", "-segment_list", list, "-segment_list_type", "csv", join(dir, `piece%03d${kind}`)]);
    const rows = (await readFile(list, "utf8")).split(/\r?\n/).filter(Boolean).map((line) => line.split(","));
    const pieces = [];
    for (const [name, start, end] of rows) pieces.push({ bytes: await readFile(join(dir, basename(name))), seconds: Math.max(0, Number(end) - Number(start)) });
    if (!pieces.length || pieces.some((piece) => !piece.bytes.length)) throw new Error("ffmpeg 没有切出可用的音频");
    return pieces;
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }).catch(() => {});
  }
}
