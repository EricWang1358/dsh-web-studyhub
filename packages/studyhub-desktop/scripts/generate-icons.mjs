import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';
import { crc32 } from './zip-utils.mjs';

const desktopRoot = fileURLToPath(new URL('../', import.meta.url));
const BG = [0x21, 0x1f, 0x1b, 0xff];
const PAGE = [0xed, 0xe7, 0xdb, 0xff];
const SPINE = [0xbd, 0x60, 0x49, 0xff];
const INK = [0x21, 0x1f, 0x1b, 0xff];
const CLEAR = [0, 0, 0, 0];

function insideRoundedRect(x, y) {
  const radius = 14;
  if (x < 0 || y < 0 || x > 64 || y > 64) return false;
  const cx = x < radius ? radius : x > 64 - radius ? 64 - radius : x;
  const cy = y < radius ? radius : y > 64 - radius ? 64 - radius : y;
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function insideInkLine(x, y) {
  const line1 = x >= 29 && x <= 40 && y >= 24.5 && y <= 27.5;
  const line2 = x >= 29 && x <= 40 && y >= 32.5 && y <= 35.5;
  const line3 = x >= 29 && x <= 36 && y >= 40.5 && y <= 43.5;
  return line1 || line2 || line3;
}

function sampleMark(x, y) {
  if (!insideRoundedRect(x, y)) return CLEAR;
  if (x >= 18 && x <= 23 && y >= 14 && y <= 52) return SPINE;
  if (x > 23 && x <= 46 && y >= 14 && y <= 52) {
    return insideInkLine(x, y) ? INK : PAGE;
  }
  return BG;
}

function samplePixel(px, py, size) {
  const samples = 4;
  let r = 0;
  let g = 0;
  let b = 0;
  let a = 0;
  for (let sy = 0; sy < samples; sy += 1) {
    for (let sx = 0; sx < samples; sx += 1) {
      const gx = ((px + (sx + 0.5) / samples) / size) * 64;
      const gy = ((py + (sy + 0.5) / samples) / size) * 64;
      const color = sampleMark(gx, gy);
      r += color[0] * color[3];
      g += color[1] * color[3];
      b += color[2] * color[3];
      a += color[3];
    }
  }
  const total = samples * samples;
  if (a === 0) return CLEAR;
  return [
    Math.round(r / a),
    Math.round(g / a),
    Math.round(b / a),
    Math.round(a / total),
  ];
}

function pngChunk(type, payload) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(payload.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, payload])), 0);
  return Buffer.concat([lenBuf, typeBuf, payload, crcBuf]);
}

export function renderPng(size) {
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * stride;
    raw[rowStart] = 0;
    for (let x = 0; x < size; x += 1) {
      const rgba = samplePixel(x, y, size);
      const idx = rowStart + 1 + x * 4;
      raw[idx] = rgba[0];
      raw[idx + 1] = rgba[1];
      raw[idx + 2] = rgba[2];
      raw[idx + 3] = rgba[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);

  const entries = [];
  let offset = 6 + images.length * 16;
  for (const image of images) {
    const entry = Buffer.alloc(16);
    entry[0] = image.size >= 256 ? 0 : image.size;
    entry[1] = image.size >= 256 ? 0 : image.size;
    entry[2] = 0;
    entry[3] = 0;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(image.png.length, 8);
    entry.writeUInt32LE(offset, 12);
    entries.push(entry);
    offset += image.png.length;
  }
  return Buffer.concat([header, ...entries, ...images.map((item) => item.png)]);
}

function encodeIcns(entries) {
  const chunks = entries.map(({ tag, png }) => {
    const header = Buffer.alloc(8);
    header.write(tag, 0, 4, 'ascii');
    header.writeUInt32BE(8 + png.length, 4);
    return Buffer.concat([header, png]);
  });
  const totalSize = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const rootHeader = Buffer.alloc(8);
  rootHeader.write('icns', 0, 4, 'ascii');
  rootHeader.writeUInt32BE(totalSize, 4);
  return Buffer.concat([rootHeader, ...chunks]);
}

export async function generateIcons(outDir = join(desktopRoot, 'src-tauri', 'icons')) {
  await mkdir(outDir, { recursive: true });
  const sizes = [16, 32, 48, 64, 128, 256, 512];
  const bySize = new Map(sizes.map((size) => [size, renderPng(size)]));

  const outputs = [
    ['32x32.png', bySize.get(32)],
    ['128x128.png', bySize.get(128)],
    ['128x128@2x.png', bySize.get(256)],
    ['icon.png', bySize.get(512)],
    ['icon.ico', encodeIco([16, 32, 48, 64, 128, 256].map((size) => ({ size, png: bySize.get(size) })))],
    [
      'icon.icns',
      encodeIcns([
        { tag: 'ic07', png: bySize.get(128) },
        { tag: 'ic08', png: bySize.get(256) },
        { tag: 'ic09', png: bySize.get(512) },
      ]),
    ],
  ];

  await Promise.all(outputs.map(([name, data]) => writeFile(join(outDir, name), data)));
  return outputs.map(([name, data]) => ({ name, bytes: data.length }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const outArg = process.argv.find((arg) => arg.startsWith('--outdir='))?.slice(9);
  const generated = await generateIcons(outArg ? resolve(outArg) : undefined);
  console.log(`Generated ${generated.length} StudyHub Desktop icons in src-tauri/icons`);
}
