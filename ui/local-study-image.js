import { MAX_LOCAL_IMAGE_BYTES, detectRasterImageMime } from '../lib/study-image-policy.js';
export { MAX_LOCAL_IMAGE_BYTES, safeRasterDataUri } from '../lib/study-image-policy.js';
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

/** Filename text stays readable within the renderer's bounded Markdown image grammar. */
export function localImageAlt(name) {
  return String(name || '').split(/[\\/]/).pop().replace(/\.[A-Za-z0-9]{1,8}$/, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\[/g, '(').replace(/\]/g, ')')
    .replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim().slice(0, 120) || '图片';
}

/** Read only a browser-selected file; embed portable content, never a filesystem path. */
export async function localImageMarkdown(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size <= 0 || typeof file.arrayBuffer !== 'function')
    throw new Error('选择 PNG、JPEG、WebP 或 GIF 图片。');
  if (file.size > MAX_LOCAL_IMAGE_BYTES) throw new Error('图片不能超过 2 MiB。');
  if (file.type && !MIME_TYPES.has(file.type)) throw new Error('选择 PNG、JPEG、WebP 或 GIF 图片。');
  let bytes;
  try { bytes = new Uint8Array(await file.arrayBuffer()); }
  catch { throw new Error('无法读取图片，请重新选择。'); }
  const mime = detectRasterImageMime(bytes);
  if (bytes.length !== file.size || !mime || (file.type && file.type !== mime))
    throw new Error('图片内容与格式不匹配，或文件已损坏。');
  let binary = '';
  // Bound each argument list rather than spreading a potentially 2 MiB file.
  for (let at = 0; at < bytes.length; at += 8192) binary += String.fromCharCode(...bytes.subarray(at, at + 8192));
  const uri = `data:${mime};base64,${btoa(binary)}`;
  return `![${localImageAlt(file.name)}](${uri})`;
}
