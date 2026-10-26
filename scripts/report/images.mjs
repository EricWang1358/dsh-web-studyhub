/* Images for a deck. A file is read only from inside the deck's own folder (so a deck json cannot pull a private file from elsewhere on the
   machine into a page that gets shared) and only when its first bytes say it is a png, jpeg, gif or webp. A data: URI is accepted only in
   the plain base64 form below, which cannot carry a quote or a tag. */
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;

/** The mime type named by the file's first bytes, or null. */
export function sniffImage(bytes) {
  const at = (offset, text) => text.every((byte, i) => bytes[offset + i] === (typeof byte === "string" ? byte.charCodeAt(0) : byte));
  if (at(0, [0x89, "P", "N", "G", 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at(0, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at(0, ["G", "I", "F", "8"]) && (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) return "image/gif";
  if (at(0, ["R", "I", "F", "F"]) && at(8, ["W", "E", "B", "P"])) return "image/webp";
  return null;
}

const outside = (base, target) => { const rel = relative(base, target); return /^\.\.(?:[\\/]|$)/.test(rel) || isAbsolute(rel); };

/** A data: URI for the image at `src` (relative to baseDir), or a thrown Error whose message says what is wrong with it. */
export async function readDeckImage(src, baseDir) {
  if (DATA_IMAGE.test(src)) return src;
  if (/^data:/i.test(src)) throw new Error(`is a data: address that is not plain base64 image data (data:image/png;base64,...)`);
  if (isAbsolute(src) || /^[A-Za-z]:/.test(src) || /^[\\/]/.test(src)) throw new Error(`"${src}" is not a path inside the deck folder (use a path relative to the deck json)`);
  const base = resolve(baseDir), file = resolve(base, src);
  if (outside(base, file)) throw new Error(`"${src}" is outside the deck folder; put the image next to the deck json or in a folder under it`);
  let bytes;
  try {
    // a link inside the folder that points out of it is outside too
    if (outside(await realpath(base), await realpath(file))) throw new Error("outside");
    bytes = await readFile(file);
  } catch (error) {
    if (error.message === "outside") throw new Error(`"${src}" leads outside the deck folder`);
    throw new Error(`"${src}" cannot be read in the deck folder`);
  }
  const mime = sniffImage(bytes);
  if (!mime) throw new Error(`"${src}" is not a png, jpeg, gif or webp image (the first bytes of the file say otherwise)`);
  return `data:${mime};base64,${bytes.toString("base64")}`;
}
