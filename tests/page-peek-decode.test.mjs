/* global window */
/* 看原页 on a scanned book, in a real browser (2.6.1): the page peek's real renderer (pdf.js and the shipped wasm / CMap chunks) draws
   a page whose picture is a CCITT G4 scan (jbig2.wasm, the decoder JBIG2 scans use too) and a JPX scan (openjpeg.wasm); without the
   decoders the same page comes out blank and the renderer says so. Also a page set in a non-embedded Chinese font asks for its CMap
   through the factory. The PDFs are generated here. No network. */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { brokenImageBytes, ccittG4Bytes } from './helpers/scan-pdfs.mjs';

const bundle = await build({ stdin: { contents: `
  import { createPeekRenderer } from './ui/document-preview/peek/renderer.js';
  import { peekAssetLoaders } from './ui/document-preview/peek/pdf-asset-data.js';
  /** Draw page 1 of the PDF; { dark, undecoded, requested: [assets pdf.js asked for] }. broken: the decoders cannot be loaded (what 2.6.0 did). */
  window.peekDecode = async (bytes, { broken = false } = {}) => {
    const requested = [];
    const loaders = {};
    for (const type of ['wasm', 'cmap', 'font']) loaders[type] = async request => {
      requested.push(type + ':' + request.name);
      if (broken) throw new Error('not available');
      return peekAssetLoaders[type](request);
    };
    const renderer = await createPeekRenderer(new Uint8Array(bytes), { loaders });
    let undecoded = -1;
    const bitmap = await renderer.render(1, { scale: 1, onReport: report => { undecoded = report.undecoded; } });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width; canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] < 128 && data[i + 3] > 0) dark += 1;
    bitmap.close();
    await renderer.destroy();
    return { dark, undecoded, requested, width: canvas.width, height: canvas.height };
  };`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', platform: 'browser', loader: { '.css': 'text' }, logLevel: 'silent' });
const script = bundle.outputFiles[0].text;

let browser, unavailable = false;
try { browser = await launchChromium(); }
catch (error) { if (!/Executable doesn't exist|browserType\.launch/.test(String(error.message))) throw error; unavailable = true; }
after(() => browser?.close());

/* ---------- generated PDFs ---------- */

/** A one-page PDF (600 x 800) from page `resources`, a content stream and further objects; objects are Buffers or strings, numbered from 5. */
function pdf({ resources, content, extra = [] }) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Contents 4 0 R /Resources ${resources} >>`, stream('', Buffer.from(content)), ...extra];
  const parts = [Buffer.from('%PDF-1.5\n')], offsets = [];
  objects.forEach((body, index) => {
    offsets.push(parts.reduce((sum, part) => sum + part.length, 0));
    parts.push(Buffer.from(`${index + 1} 0 obj\n`), Buffer.isBuffer(body) ? body : Buffer.from(body), Buffer.from('\nendobj\n'));
  });
  const xref = parts.reduce((sum, part) => sum + part.length, 0);
  parts.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
  return [...Buffer.concat(parts)];
}
function stream(dictionary, data) { return Buffer.concat([Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`), data, Buffer.from('\nendstream')]); }
const image = (dictionary, data) => pdf({ resources: '<< /XObject << /Im0 5 0 R >> >>', content: 'q 400 0 0 400 100 200 cm /Im0 Do Q', extra: [stream(`/Type /XObject /Subtype /Image ${dictionary}`, data)] });

// A 64 x 64 JPEG 2000 picture: a black square (33 x 33) on white; 631 bytes made with Pillow's OpenJPEG, kept here as text.
const JPX = Buffer.from('AAAADGpQICANCocKAAAAFGZ0eXBqcDIgAAAAAGpwMiAAAAAtanAyaAAAABZpaGRyAAAAQAAAAEAAAwcHAAAAAAAPY29scgEAAAAAABAAAAIqanAyY/9P/1EALwAAAAAAQAAAAEAAAAAAAAAAAAAAAEAAAABAAAAAAAAAAAAAAwcBAQcBAQcBAf9SAAwAAAABAAUEBAAB/1wAE0BASEhQSEhQSEhQSEhQSEhQ/2QAJQABQ3JlYXRlZCBieSBPcGVuSlBFRyB2ZXJzaW9uIDIuNS4y/5AACgAAAAABowAB/5PfSFAK1FDmFt9IUArUUOYW30hQCtRQ5hbPjCT7wWHwBg/OIYoP0Uy2IRB5IM+MJPvBYfAGD84hig/RTLYhEHkgz4wk+8Fh8AYPziGKD9FMtiEQeSDPlFz5RcfEJAnrg6buaSFBPoioHQGuBZYx5Bs1teMkvGCYE+EVxzzPlFz5RcfEJAnrg6buaSFBPoioHQGuBZYx5Bs1teMkvGCYE+EVxzzPlFz5RcfEJAnrg6buaSFBPoioHQGuBZYx5Bs1teMkvGCYE+EVxzzPgLnwFBnMVmkO6/1cDTV7IN0NbHSmf54jS8+AufAUGcxWaQ7r/VwNNXsg3Q1sdKZ/niNLz4C58BQZzFZpDuv9XA01eyDdDWx0pn+eI0vOInDgctONfgLEDwUuQt0h6L8hziJw4HLTjX4CxA8FLkLdIei/Ic4icOBy041+AsQPBS5C3SHovyHOKnEgtZ8/8AGLVHYaO5Y4p9p2G0wUk84qcSC1nz/wAYtUdho7ljin2nYbTBSTzipxILWfP/ABi1R2GjuWOKfadhtMFJP/2Q==', 'base64');

const SCANS = {
  flate: { pdf: () => image('/Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode', deflateSync(Buffer.from(Array.from({ length: 64 * 64 }, (_, i) => (i >> 6) < 24 ? 255 : 0)))), minDark: 50000 },
  jpx: { pdf: () => image('/Width 64 /Height 64 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /JPXDecode', JPX), minDark: 20000 },
  ccitt: { pdf: () => image('/Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 64 /Rows 64 >>', ccittG4Bytes()), minDark: 50000 },
};

/** Draw page 1 of `bytes` in a fresh page of the browser. */
async function decode(bytes, options) {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html><html><body></body></html>');
    await page.addScriptTag({ content: script });
    return await page.evaluate(([data, opts]) => window.peekDecode(data, opts), [bytes, options]);
  } finally { await page.close(); }
}

test('a page that needs no decoder is drawn and loads nothing (the control)', { skip: unavailable }, async () => {
  const result = await decode(SCANS.flate.pdf());
  assert.ok(result.dark >= SCANS.flate.minDark, JSON.stringify(result));
  assert.equal(result.undecoded, 0);
  assert.deepEqual(result.requested, [], 'a page without scans never asks for the wasm chunks');
});

for (const [name, wasm] of [['ccitt', 'jbig2'], ['jpx', 'openjpeg']]) {
  test(`a ${name} scan is drawn with the ${wasm} decoder, loaded only because the page asked for it`, { skip: unavailable }, async () => {
    const result = await decode(SCANS[name].pdf());
    assert.ok(result.dark >= SCANS[name].minDark, `the scan is on the page: ${JSON.stringify(result)}`);
    assert.equal(result.undecoded, 0);
    assert.deepEqual(result.requested, [`wasm:${wasm}`]);
  });

  test(`without the decoders the same ${name} page is blank, and the renderer says an image did not decode`, { skip: unavailable }, async () => {
    const result = await decode(SCANS[name].pdf(), { broken: true });
    assert.equal(result.dark, 0, `this is what the owner saw: ${JSON.stringify(result)}`);
    assert.ok(result.undecoded >= 1, 'so the popover can say it instead of showing an empty page');
  });
}

test('a damaged scan that no decoder can read is reported even though the decoders are there', { skip: unavailable }, async () => {
  const result = await decode(image('/Width 64 /Height 64 /ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JPXDecode', brokenImageBytes()));
  assert.equal(result.dark, 0);
  assert.ok(result.undecoded >= 1, JSON.stringify(result));
});

test('a page set in a non-embedded Chinese font gets its CMap through the factory, from the Chinese group only', { skip: unavailable }, async () => {
  const font = '<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /DW 1000 >>] >>';
  const bytes = pdf({ resources: `<< /Font << /F1 ${font} >> >>`, content: 'BT /F1 48 Tf 50 700 Td <4E2D65876D4B8BD5> Tj ET' });
  const result = await decode(bytes);
  assert.ok(result.requested.includes('cmap:UniGB-UCS2-H'), JSON.stringify(result.requested));
  assert.ok(result.requested.every(request => !/^cmap:(?:UniJIS|UniKS|UniCNS|Adobe-Japan|Adobe-Korea|Adobe-CNS)/.test(request)), 'only what the document needs');
  assert.equal(result.undecoded, 0);
});
