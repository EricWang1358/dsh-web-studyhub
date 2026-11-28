import { ui } from '../i18n.js';

function bytesToBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Read a browser File (or test stub carrying `.dataUrl`) into a base64 data URL. */
export function readFileAsDataUrl(file) {
  if (typeof file?.dataUrl === 'string') return Promise.resolve(file.dataUrl);
  if (typeof FileReader !== 'function' && typeof file?.arrayBuffer === 'function') {
    return file.arrayBuffer().then((buffer) => {
      const mime = file.type || 'image/jpeg';
      return `data:${mime};base64,${bytesToBase64(new Uint8Array(buffer))}`;
    });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error(ui('读取图片失败')));
    reader.readAsDataURL(file);
  });
}

/**
 * Stage image File objects into `<workspace>/studyhub-work/focus-intake/` via `host.stageFocusImages`
 * when available, else via RPC `call('focus.images.stage', { files })`.
 * Resolves to `{ files: string[] }` on success or `{ files: [], error }` on failure.
 */
export async function stageImageFiles({ files = [], host = null, call = null, fallbackName = 'image.png' } = {}) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (!list.length) return { files: [] };
  try {
    let staged;
    if (typeof host?.stageFocusImages === 'function') {
      staged = await host.stageFocusImages(list);
    } else if (typeof call === 'function') {
      const payload = await Promise.all(list.map(async (file, index) => ({
        name: file.name || fallbackName || `image-${index + 1}.png`,
        dataUrl: await readFileAsDataUrl(file),
      })));
      staged = await call('focus.images.stage', { files: payload });
    } else {
      return { files: [] };
    }
    const stagedPaths = (staged?.files || []).map((item) => item?.relativePath).filter(Boolean);
    return { files: stagedPaths };
  } catch (error) {
    return { files: [], error };
  }
}
