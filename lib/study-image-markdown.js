import { safeRasterDataUri } from './study-image-policy.js';

/** Keep the existing prose budget while admitting one bounded embedded raster.
 * Embedding avoids machine-specific paths and includes images in JSON backups. */
export function validImageMarkdown(value, maxText = 200000) {
  if (typeof value !== 'string' || value.length > 3 * 1024 * 1024) return false;
  let textLength = value.length;
  for (const match of value.matchAll(/!\[[^\]\n]*\]\((data:[^\s)]+)\)/g)) {
    if (!safeRasterDataUri(match[1])) return false;
    textLength -= match[1].length;
  }
  return textLength <= maxText;
}

/** Text-only model calls must not pay for, or pretend to see, embedded bytes. */
export function omitLocalImagePayloads(value) {
  if (typeof value !== 'string') return value;
  return value.replace(/data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}/g, '[local image payload omitted]');
}
