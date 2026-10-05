/* 看原页: what the browser-side pdf.js needs to draw a scanned book, and how it gets it. No DOM and no pdf.js here (the generator
   scripts/pdf-assets.mjs and the tests import it too).

   A scanned page is an image in a format the browser cannot decode: JBIG2 and CCITT (jbig2.wasm), JPX (openjpeg.wasm); a CJK font
   that is not embedded needs the document's CMap. pdf.js fetches those by URL (`wasmUrl`, `cMapUrl`, `standardFontDataUrl`), and
   without them it drops the image and goes on: the page comes out blank. DSH serves a plugin's `client.*.js` chunks and nothing
   else, so there is no URL to give. The bytes travel as lazily loaded chunks (assets/*.js, made by scripts/pdf-assets.mjs from
   pdfjs-dist) and are handed to pdf.js through a BinaryDataFactory, which it calls from its (main thread) worker whenever it needs
   one. Nothing is loaded until pdf.js asks, and a page without scans never asks.

   Left out: qcms_bg.wasm and the ICC profiles (pdf.js uses the alternate colour space instead), the *_nowasm_fallback.js decoders (a
   browser that cannot run wasm is rare, and the fallbacks are loaded by URL), the Foxit/Liberation standard fonts other than Symbol
   and ZapfDingbats (the peek opens documents with `useSystemFonts`, so the system draws the rest) and the UTF8/UTF32 CMaps (not PDF
   predefined CMaps). */

/** The CMap script groups; each is one chunk, so a Chinese book loads the Chinese CMaps and nothing else. */
export const CMAP_GROUPS = Object.freeze(['gb', 'cns', 'japan', 'korea']);

/** The wasm files pdf.js asks for by name -> the loader's name. */
export const WASM_FILES = Object.freeze({ 'jbig2.wasm': 'jbig2', 'openjpeg.wasm': 'openjpeg' });
/** The standard fonts that are still asked for with system fonts on (pdf.js never uses a system font for these two). */
export const FONT_FILES = Object.freeze(['FoxitSymbol.pfb', 'FoxitDingbats.pfb']);

const NAME = /^[A-Za-z0-9][A-Za-z0-9-]*$/;

/** True for a CMap that is shipped: a PDF predefined CMap or one of those continues from (the UTF8/UTF32 ones are neither). */
export const shipsCMap = name => typeof name === 'string' && NAME.test(name) && !/-UTF(?:8|32)-[HV]$/.test(name);

/** The script group of a CMap: 'gb' | 'cns' | 'korea' | 'japan' (also the old generic Japanese ones: H, V, EUC, Roman, Katakana...). */
export function cmapGroup(name) {
  if (/^(?:GB|UniGB-|Adobe-GB1-)/.test(name)) return 'gb';
  if (/^(?:B5|CNS|ETen|ETHK|HK|UniCNS-|Adobe-CNS1-)/.test(name)) return 'cns';
  if (/^(?:KSC|UniKS-|Adobe-Korea1-)/.test(name)) return 'korea';
  return 'japan';
}

/**
 * What a request of pdf.js (`kind` is its API option name, `filename` the file it would have fetched by URL) is, or null for what is not shipped:
 * { type: 'wasm', name } | { type: 'cmap', name, group } | { type: 'font', name }.
 */
export function assetRequest(kind, filename) {
  if (typeof filename !== 'string') return null;
  if (kind === 'wasmUrl') return Object.hasOwn(WASM_FILES, filename) ? { type: 'wasm', name: WASM_FILES[filename] } : null;
  if (kind === 'standardFontDataUrl') return FONT_FILES.includes(filename) ? { type: 'font', name: filename } : null;
  if (kind === 'cMapUrl') {
    if (!filename.endsWith('.bcmap')) return null;
    const name = filename.slice(0, -'.bcmap'.length);
    return shipsCMap(name) ? { type: 'cmap', name, group: cmapGroup(name) } : null;
  }
  return null;
}

/** Base64 text -> Uint8Array (atob: every browser has it; Uint8Array.fromBase64 is too new). */
export function decodeBase64(text) {
  const binary = atob(text), bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * The BinaryDataFactory class for pdf.js's `BinaryDataFactory` option. `loaders` = { wasm(request), cmap(request), font(request) }, each
 * resolving to the bytes. pdf.js builds it with its URL options (all unset here) and calls `fetch({ kind, filename })`; it gets a copy,
 * because it may transfer what it gets and the loaders keep theirs.
 */
export function createBinaryDataFactory(loaders) {
  return class PeekBinaryDataFactory {
    async fetch({ kind, filename }) {
      const request = assetRequest(kind, filename);
      if (!request) throw new Error(`Unable to load ${kind} data at: ${filename} (not shipped with the page preview)`);
      let bytes;
      try { bytes = await loaders[request.type]?.(request); }
      catch (error) { throw new Error(`Unable to load ${kind} data at: ${filename} (${error?.message || error})`); }
      if (!(bytes instanceof Uint8Array)) throw new Error(`Unable to load ${kind} data at: ${filename} (no bytes)`);
      return bytes.slice();
    }
  };
}

/** The options pdf.js is opened with for a peek. `useWorkerFetch: false` makes it ask the factory (main thread) instead of fetching URLs. */
export function peekDocumentOptions(bytes, BinaryDataFactory) {
  return { data: bytes, isEvalSupported: false, useSystemFonts: true, enableXfa: false, useWasm: true, useWorkerFetch: false, BinaryDataFactory, verbosity: 0 };
}
