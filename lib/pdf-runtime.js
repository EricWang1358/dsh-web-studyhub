import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** PDF.js otherwise selects browser fetching for local assets in some Electron hosts. */
export class LocalPdfDataFactory {
  constructor({ cMapUrl, standardFontDataUrl, wasmUrl }) {
    this.paths = { cMapUrl, standardFontDataUrl, wasmUrl };
  }
  async fetch({ kind, filename }) {
    if (!Object.hasOwn(this.paths, kind) || typeof filename !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(filename)) {
      throw new Error('Invalid local PDF asset request');
    }
    const directory = this.paths[kind];
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error(`Missing local PDF asset directory: ${kind}`);
    return new Uint8Array(await readFile(path.join(directory, filename)));
  }
}

/** Load the local PDF.js worker explicitly: Electron hosts are not always detected as Node. */
export async function loadPdfjs() {
  const [pdfjs, { WorkerMessageHandler }] = await Promise.all([
    import('pdfjs-dist/legacy/build/pdf.mjs'),
    import('pdfjs-dist/legacy/build/pdf.worker.mjs'),
  ]);
  // Match the parser's installed version without a worker URL, network fetch or host detection.
  globalThis.pdfjsWorker = { ...globalThis.pdfjsWorker, WorkerMessageHandler };
  return pdfjs;
}
