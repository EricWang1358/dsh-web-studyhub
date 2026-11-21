import { DEFAULT_PALETTE } from './seed-prng.js';
import { PLATE_HEIGHT, PLATE_WIDTH } from './herbarium-svg.js';

/* Pure client-side SVG & 2x PNG poster serialization for Living Ink Gallery.
   100% offline and CSP-safe (uses data:image/svg+xml URIs for canvas rasterization
   so web-demo's `img-src 'self' data:; connect-src 'none'` policy always succeeds). */

function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

/** Build a safe kebab-case export filename (ASCII + digits + hyphens). */
export function buildPosterFilename(edition, ext = 'svg', today = '') {
  const safeEdition = String(edition || 'herbarium').replace(/[^a-z0-9-]+/gi, '-').toLowerCase();
  const safeDate = String(today || '').replace(/[^0-9-]+/g, '');
  const stamp = safeDate ? `-${safeDate}` : '';
  return `studyhub-ink-gallery-${safeEdition}${stamp}.${ext}`;
}

/**
 * Serialize a live `<svg>` element (or raw SVG markup string in tests) into a
 * standalone UTF-8 XML document with concrete theme background and dimensions.
 */
export function serializePlateSvg(svgOrMarkup, options = {}) {
  const {
    width = PLATE_WIDTH,
    height = PLATE_HEIGHT,
    palette = DEFAULT_PALETTE,
    fontFamily = 'Georgia, "Noto Serif SC", "Songti SC", serif',
  } = options;
  const bg = palette?.paper || DEFAULT_PALETTE.paper;
  const ink = palette?.ink || DEFAULT_PALETTE.ink;

  if (typeof svgOrMarkup === 'string') {
    const trimmed = svgOrMarkup.trim();
    if (!trimmed.startsWith('<svg')) return '';
    const hasXmlns = /\bxmlns=/.test(trimmed);
    let markup = trimmed;
    if (!hasXmlns) {
      markup = markup.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"');
    }
    const bgRect = `<rect width="${width}" height="${height}" fill="${escapeXml(bg)}" />`;
    markup = markup.replace(/(<svg[^>]*>)/, `$1${bgRect}`);
    return `<?xml version="1.0" encoding="UTF-8"?>\n${markup}`;
  }

  if (!svgOrMarkup || typeof svgOrMarkup.cloneNode !== 'function') return '';
  const clone = svgOrMarkup.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `0 0 ${width} ${height}`);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.setAttribute('style', `background:${bg};color:${ink};font-family:${fontFamily};`);

  // Strip transient interactive-only rings before exporting the collectible print
  clone.querySelectorAll?.('[data-export-omit="true"]')?.forEach((el) => el.remove());

  const doc = svgOrMarkup.ownerDocument || (typeof document !== 'undefined' ? document : null);
  if (doc?.createElementNS) {
    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('width', String(width));
    rect.setAttribute('height', String(height));
    rect.setAttribute('fill', bg);
    clone.insertBefore(rect, clone.firstChild);
  }

  const serializer = typeof XMLSerializer === 'function' ? new XMLSerializer() : null;
  const raw = serializer ? serializer.serializeToString(clone) : clone.outerHTML || '';
  if (!raw) return '';
  return `<?xml version="1.0" encoding="UTF-8"?>\n${raw}`;
}

function triggerDownload(href, filename, revoke = false) {
  if (typeof document === 'undefined') return false;
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  if (revoke && typeof URL?.revokeObjectURL === 'function') {
    setTimeout(() => URL.revokeObjectURL(href), 1500);
  }
  return true;
}

/** Export the current artwork plate as a standalone vector `.svg` file. */
export function exportPlateSvg(svgElement, filename, options = {}) {
  const xml = serializePlateSvg(svgElement, options);
  if (!xml) return false;
  if (typeof Blob === 'function' && typeof URL?.createObjectURL === 'function') {
    try {
      const blob = new Blob([xml], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      return triggerDownload(url, filename, true);
    } catch {
      // Fallback to data URI below when Blob URLs are unavailable
    }
  }
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  return triggerDownload(dataUrl, filename, false);
}

/** Export the current artwork plate as a crisp 2x retina `.png` poster (1920x880). */
export async function exportPlatePng(svgElement, filename, options = {}) {
  const scale = options.scale ?? 2;
  const width = options.width ?? PLATE_WIDTH;
  const height = options.height ?? PLATE_HEIGHT;
  const xml = serializePlateSvg(svgElement, { ...options, width, height });
  if (!xml || typeof document === 'undefined' || typeof Image === 'undefined') return false;

  // Use data: URI (not blob:) so strict CSP `img-src 'self' data:` allows rasterization
  const svgDataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`;
  const img = await new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to decode SVG plate for PNG export'));
    image.src = svgDataUrl;
  });

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;

  const bg = options.palette?.paper || DEFAULT_PALETTE.paper;
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);

  if (typeof canvas.toBlob === 'function' && typeof URL?.createObjectURL === 'function') {
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (blob) {
      const url = URL.createObjectURL(blob);
      return triggerDownload(url, filename, true);
    }
  }
  const pngUrl = canvas.toDataURL('image/png');
  return triggerDownload(pngUrl, filename, false);
}
