/* Audio stand-ins for the QA journey (WP6): recordings built in code, and a SiliconFlow that answers locally.
   Nothing here reaches the network: the preview runs in this process, so replacing globalThis.fetch for
   api.siliconflow.cn is enough for the audio pipeline (lib/gemini.js uses a replaced global fetch). */

/** `seconds` of 16 kHz mono 16-bit tone with a short pause every ten seconds. */
export function toneWav(seconds) {
  const rate = 16000, frames = Math.round(seconds * rate), data = Buffer.alloc(frames * 2), header = Buffer.alloc(44);
  for (let i = 0; i < frames; i++) {
    const quiet = (i / rate) % 10 > 9.6;
    data.writeInt16LE(quiet ? 0 : Math.round(Math.sin(i / rate * 2 * Math.PI * 220) * 6000), i * 2);
  }
  header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** An M4A container of `minutes` (placeholder AAC frames: the container is what pre-flight and splitting read). */
export function longM4a(minutes) {
  const box = (type, ...parts) => { const body = Buffer.concat(parts), head = Buffer.alloc(8); head.writeUInt32BE(8 + body.length); head.write(type, 4, "latin1"); return Buffer.concat([head, body]); };
  const full = (type, flags, ...parts) => { const head = Buffer.alloc(4); head.writeUInt32BE(flags); return box(type, head, ...parts); };
  const words = (values) => { const out = Buffer.alloc(values.length * 4); values.forEach((value, i) => out.writeUInt32BE(value, i * 4)); return out; };
  const count = Math.ceil(minutes * 60 * 16000 / 1024), frame = Buffer.from([0x21, 0x10, 0x04, 0x60]);
  const ftyp = box("ftyp", Buffer.from("M4A "), words([0]), Buffer.from("M4A isom"));
  const mdat = box("mdat", Buffer.concat(Array.from({ length: count }, () => frame)));
  const moov = box("moov", full("mvhd", 0, words([0, 0, 1000, minutes * 60000, 0x10000]), Buffer.alloc(80)),
    box("trak", box("mdia", full("mdhd", 0, words([0, 0, 16000, count * 1024]), Buffer.from([0x55, 0xc4, 0, 0])),
      full("hdlr", 0, words([0]), Buffer.from("soun"), Buffer.alloc(13)),
      box("minf", box("stbl", full("stsd", 0, words([1]), box("mp4a", Buffer.alloc(28))), full("stts", 0, words([1, count, 1024])),
        full("stsc", 0, words([1, 1, count, 1])), full("stsz", 0, words([4, count])), full("stco", 0, words([1, ftyp.length + 8])))))));
  return Buffer.concat([ftyp, mdat, moov]);
}

export const FAKE_SILICONFLOW_KEY = "sk-qa-journey-siliconflow-not-a-real-key";
const TRANSCRIPTS = {
  zh: "今天我们讲数据库索引。B+ 树把相邻的键放在一起，所以范围查询很快。哈希索引只适合等值查询，不适合排序。",
  en: "Today we talk about database indexes. A B+ tree keeps neighbouring keys together, so range queries are fast. A hash index only suits equality lookups.",
};

/** Replace fetch for api.siliconflow.cn only; returns a function that restores the real fetch. */
export function fakeSiliconflow(lang = "zh") {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    if (!String(url).startsWith("https://api.siliconflow.cn/")) return real(url, init);
    calls.push(String(url));
    const body = String(url).endsWith("/v1/user/info") ? { code: 20000, status: true, data: { name: "qa" } } : { text: TRANSCRIPTS[lang] || TRANSCRIPTS.zh };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const restore = () => { globalThis.fetch = real; };
  restore.calls = calls;
  return restore;
}
