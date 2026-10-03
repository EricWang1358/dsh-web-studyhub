export const MAX_LOCAL_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil(MAX_LOCAL_IMAGE_BYTES / 3) * 4;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function detectRasterImageMime(bytes) {
  const starts = signature => signature.every((byte, index) => bytes[index] === byte);
  if (starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'image/png';
  if (starts([255, 216, 255])) return 'image/jpeg';
  const ascii = (at, text) => [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0));
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return 'image/gif';
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP') && bytes.length >= 12) return 'image/webp';
  return null;
}

/** Strict bounded raster data URI validation without allocating the full decoded image. */
export function safeRasterDataUri(value) {
  if (typeof value !== 'string' || value.length > MAX_BASE64_LENGTH + 30) return null;
  const header = /^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(value);
  if (!header) return null;
  const encoded = value.slice(header[0].length);
  if (!encoded.length || encoded.length > MAX_BASE64_LENGTH || encoded.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  const length = encoded.length / 4 * 3 - padding;
  if (!length || length > MAX_LOCAL_IMAGE_BYTES) return null;
  // Reject noncanonical padding bits, whitespace and alternative alphabets.
  const last = ALPHABET.indexOf(encoded[encoded.length - padding - 1]);
  if ((padding === 2 && (last & 15)) || (padding === 1 && (last & 3))) return null;
  const bytes = [];
  for (let at = 0; at < Math.min(encoded.length, 16); at += 4) {
    const word = (ALPHABET.indexOf(encoded[at]) << 18) | (ALPHABET.indexOf(encoded[at + 1]) << 12) |
      (Math.max(0, ALPHABET.indexOf(encoded[at + 2])) << 6) | Math.max(0, ALPHABET.indexOf(encoded[at + 3]));
    bytes.push((word >> 16) & 255, (word >> 8) & 255, word & 255);
  }
  return detectRasterImageMime(bytes.slice(0, Math.min(length, 12))) === header[1] ? value : null;
}

