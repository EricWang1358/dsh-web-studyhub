import { ui } from './i18n.js';

function concatChunks(chunks) {
  const total = chunks.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

async function streamTransform(bytes, StreamCtor) {
  const stream = new StreamCtor('deflate');
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const reader = stream.readable.getReader();
  const parts = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) parts.push(value);
  }
  return concatChunks(parts);
}

function readUint32BE(bytes, at) {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

function parseJpegSize(bytes) {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) { i += 1; continue; }
    const marker = bytes[i + 1];
    if (marker === 0xff) { i += 1; continue; }
    if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) break;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
      || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      const components = bytes[i + 9];
      return { width: Math.max(1, width), height: Math.max(1, height), components };
    }
    i += 2 + len;
  }
  throw new Error(ui('无法解码这张图片，请导出为 PNG 或 JPG'));
}

function paethPredictor(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

async function decodePngToRgbFlate(bytes) {
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts = [];
  while (offset + 8 <= bytes.length) {
    const length = readUint32BE(bytes, offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) break;
    if (type === 'IHDR') {
      width = readUint32BE(bytes, dataStart);
      height = readUint32BE(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'IDAT') {
      idatParts.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4;
  }
  if (!width || !height || !idatParts.length) {
    throw new Error(ui('无法解码这张图片，请导出为 PNG 或 JPG'));
  }
  const idat = concatChunks(idatParts);
  if (bitDepth === 8 && interlace === 0 && (colorType === 2 || colorType === 0)) {
    return {
      width,
      height,
      colorSpace: colorType === 0 ? '/DeviceGray' : '/DeviceRGB',
      decodeParms: `/DecodeParms << /Predictor 15 /Colors ${colorType === 0 ? 1 : 3} /BitsPerComponent 8 /Columns ${width} >>`,
      stream: idat,
    };
  }
  if (bitDepth === 8 && interlace === 0 && (colorType === 6 || colorType === 4)
    && typeof DecompressionStream === 'function' && typeof CompressionStream === 'function') {
    const raw = await streamTransform(idat, DecompressionStream);
    const bpp = colorType === 6 ? 4 : 2;
    const stride = width * bpp;
    const prevRow = new Uint8Array(stride);
    const curRow = new Uint8Array(stride);
    const rgb = new Uint8Array(width * height * 3);
    let src = 0;
    let dst = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[src++];
      for (let x = 0; x < stride; x++) {
        const val = raw[src++];
        const left = x >= bpp ? curRow[x - bpp] : 0;
        const up = prevRow[x];
        const upLeft = x >= bpp ? prevRow[x - bpp] : 0;
        if (filter === 0) curRow[x] = val;
        else if (filter === 1) curRow[x] = (val + left) & 0xff;
        else if (filter === 2) curRow[x] = (val + up) & 0xff;
        else if (filter === 3) curRow[x] = (val + ((left + up) >> 1)) & 0xff;
        else curRow[x] = (val + paethPredictor(left, up, upLeft)) & 0xff;
      }
      prevRow.set(curRow);
      for (let px = 0; px < width; px++) {
        if (colorType === 6) {
          const r = curRow[px * 4];
          const g = curRow[px * 4 + 1];
          const b = curRow[px * 4 + 2];
          const a = curRow[px * 4 + 3] / 255;
          rgb[dst++] = Math.round(r * a + 255 * (1 - a));
          rgb[dst++] = Math.round(g * a + 255 * (1 - a));
          rgb[dst++] = Math.round(b * a + 255 * (1 - a));
        } else {
          const gray = curRow[px * 2];
          const a = curRow[px * 2 + 1] / 255;
          const v = Math.round(gray * a + 255 * (1 - a));
          rgb[dst++] = v;
          rgb[dst++] = v;
          rgb[dst++] = v;
        }
      }
    }
    const deflated = await streamTransform(rgb, CompressionStream);
    return { width, height, colorSpace: '/DeviceRGB', decodeParms: '', stream: deflated };
  }
  return null;
}

async function fileToJpegViaCanvas(file) {
  if (typeof Image !== 'function' || typeof document === 'undefined') {
    throw new Error(ui('无法解码这张图片，请导出为 PNG 或 JPG'));
  }
  const url = typeof file?.dataUrl === 'string'
    ? file.dataUrl
    : await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error(ui('读取图片失败')));
      reader.readAsDataURL(file);
    });
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error(ui('无法解码这张图片，请导出为 PNG 或 JPG')));
    el.src = url;
  });
  const width = Math.max(1, img.naturalWidth || img.width || 800);
  const height = Math.max(1, img.naturalHeight || img.height || 600);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  const jpgUrl = canvas.toDataURL('image/jpeg', 0.92);
  const base64 = jpgUrl.slice(jpgUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const jpgBytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) jpgBytes[i] = binary.charCodeAt(i);
  return {
    width,
    height,
    colorSpace: '/DeviceRGB',
    filter: '/DCTDecode',
    decodeParms: '',
    stream: jpgBytes,
  };
}

async function preparePdfImage(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const { width, height, components } = parseJpegSize(bytes);
    return {
      width,
      height,
      colorSpace: components === 1 ? '/DeviceGray' : '/DeviceRGB',
      filter: '/DCTDecode',
      decodeParms: '',
      stream: bytes,
    };
  }
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const png = await decodePngToRgbFlate(bytes);
    if (png) return { ...png, filter: '/FlateDecode' };
  }
  return fileToJpegViaCanvas(file);
}

/** Bundle raster focus screenshots into a standalone multi-page PDF without pulling server PDF libraries into the browser bundle. */
export async function buildPdfFileFromImages(files, courseName) {
  const pages = [];
  for (const file of files) pages.push(await preparePdfImage(file));

  const encoder = new TextEncoder();
  const chunks = [];
  let length = 0;
  const pushText = (str) => {
    const buf = encoder.encode(str);
    chunks.push(buf);
    length += buf.length;
  };
  const pushBytes = (buf) => {
    chunks.push(buf);
    length += buf.length;
  };

  // Object numbering: 1 = Catalog, 2 = Pages, then 3 objects per page (Page, Contents, Image XObject).
  const totalObjects = 2 + pages.length * 3;
  const offsets = new Array(totalObjects + 1).fill(0);

  pushText('%PDF-1.7\n%\xff\xff\xff\xff\n');

  offsets[1] = length;
  pushText('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

  const kids = pages.map((_, idx) => `${3 + idx * 3} 0 R`).join(' ');
  offsets[2] = length;
  pushText(`2 0 obj\n<< /Type /Pages /Count ${pages.length} /Kids [ ${kids} ] >>\nendobj\n`);

  pages.forEach((img, idx) => {
    const pageObj = 3 + idx * 3;
    const contentObj = pageObj + 1;
    const imageObj = pageObj + 2;
    const contentBytes = encoder.encode(`q\n${img.width} 0 0 ${img.height} 0 0 cm\n/Im0 Do\nQ\n`);

    offsets[pageObj] = length;
    pushText(
      `${pageObj} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [ 0 0 ${img.width} ${img.height} ] `
      + `/Resources << /XObject << /Im0 ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>\nendobj\n`,
    );

    offsets[contentObj] = length;
    pushText(`${contentObj} 0 obj\n<< /Length ${contentBytes.length} >>\nstream\n`);
    pushBytes(contentBytes);
    pushText('\nendstream\nendobj\n');

    offsets[imageObj] = length;
    const parms = img.decodeParms ? ` ${img.decodeParms}` : '';
    pushText(
      `${imageObj} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} `
      + `/ColorSpace ${img.colorSpace} /BitsPerComponent 8 /Filter ${img.filter}${parms} /Length ${img.stream.length} >>\nstream\n`,
    );
    pushBytes(img.stream);
    pushText('\nendstream\nendobj\n');
  });

  const xrefOffset = length;
  pushText(`xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`);
  for (let id = 1; id <= totalObjects; id++) {
    pushText(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  }
  pushText(`trailer\n<< /Size ${totalObjects + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const pdfBytes = concatChunks(chunks);
  const safeTitle = (courseName || ui('考试重点')).replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60);
  return new File([pdfBytes], `${safeTitle}-${ui('重点图片')}.pdf`, { type: 'application/pdf' });
}
