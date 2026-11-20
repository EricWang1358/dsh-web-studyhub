/* Renderers and transports for a PAGED original (too big to send whole to the browser):
   - Primary (`createRangeTransport`): pdf.js `PDFDataRangeTransport` subclass backed by `materials.document.range`
     with 64 KB aligned blocks, a 32-block LRU cache (max ~2 MB), in-flight deduplication, buffer-copy isolation,
     abort safety, and I/O timing stats so chunk fetches never trigger false main-thread slow-page timeouts.
   - Fallback (`createPagedRenderer`): legacy `materials.document.pages` per-page PDF renderer with live `assetStats()`
     that accurately reports both in-flight page fetches and active wasm/CMap asset downloads. */

import { LruCache } from './peek-logic.js';

const OPEN_PAGES = 3;
export const RANGE_CHUNK_SIZE = 65536;
export const RANGE_LRU_CHUNKS = 32;

/**
 * Create a pdf.js `PDFDataRangeTransport` instance over `source` (`{ bytes, fetchRange(begin, end) }`).
 * Requests are aligned to `chunkSize` (64 KB) blocks, cached in a 32-block LRU, deduplicated while in flight,
 * and copied before delivery so worker transfers never detach cached buffers.
 */
export function createRangeTransport(pdfjsLib, source, { chunkSize = RANGE_CHUNK_SIZE, maxCachedChunks = RANGE_LRU_CHUNKS, onError } = {}) {
  const Base = pdfjsLib?.PDFDataRangeTransport;
  if (typeof Base !== 'function') throw new Error('pdf.js PDFDataRangeTransport is unavailable');
  const totalBytes = source.bytes;
  const blockSize = Number.isSafeInteger(chunkSize) && chunkSize > 0 ? chunkSize : RANGE_CHUNK_SIZE;
  const capacity = Number.isSafeInteger(maxCachedChunks) && maxCachedChunks >= 0 ? maxCachedChunks : RANGE_LRU_CHUNKS;

  class StudyHubRangeTransport extends Base {
    constructor() {
      super(totalBytes, null);
      this._cache = new LruCache(capacity);
      this._inFlight = new Map();
      this._aborted = false;
      this._ioMs = 0;
      this._ioActive = 0;
      this._hits = 0;
      this._misses = 0;
    }

    async _loadBlock(blockIndex) {
      const cached = this._cache.get(blockIndex);
      if (cached) {
        this._hits += 1;
        return cached;
      }
      const existing = this._inFlight.get(blockIndex);
      if (existing) return existing;
      this._misses += 1;
      const blockBegin = blockIndex * blockSize;
      const blockEnd = Math.min(blockBegin + blockSize, totalBytes);
      const started = performance.now();
      this._ioActive += 1;
      const pending = Promise.resolve()
        .then(() => source.fetchRange(blockBegin, blockEnd))
        .then(chunk => {
          const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          if (!this._aborted) this._cache.set(blockIndex, bytes);
          return bytes;
        })
        .finally(() => {
          this._ioActive = Math.max(0, this._ioActive - 1);
          this._ioMs += Math.max(0, performance.now() - started);
          this._inFlight.delete(blockIndex);
        });
      this._inFlight.set(blockIndex, pending);
      return pending;
    }

    requestDataRange(begin, end) {
      if (this._aborted) return;
      const safeBegin = Math.max(0, Math.min(begin, totalBytes));
      const safeEnd = Math.max(safeBegin, Math.min(end, totalBytes));
      if (safeEnd <= safeBegin) {
        this.onDataRange(safeBegin, new Uint8Array(0));
        return;
      }
      const startBlock = Math.floor(safeBegin / blockSize);
      const endBlock = Math.floor((safeEnd - 1) / blockSize);
      const indexes = [];
      for (let index = startBlock; index <= endBlock; index += 1) indexes.push(index);
      Promise.all(indexes.map(index => this._loadBlock(index))).then(blocks => {
        if (this._aborted) return;
        const firstBegin = startBlock * blockSize;
        if (blocks.length === 1 && safeBegin === firstBegin && safeEnd - safeBegin === blocks[0].byteLength) {
          // Always copy so pdf.js worker transfers cannot detach our LRU-cached buffer.
          this.onDataRange(safeBegin, blocks[0].slice());
          return;
        }
        const assembled = new Uint8Array(safeEnd - safeBegin);
        let writeAt = 0;
        for (let i = 0; i < blocks.length; i += 1) {
          const block = blocks[i];
          const blockStart = (startBlock + i) * blockSize;
          const sliceStart = Math.max(0, safeBegin - blockStart);
          const sliceEnd = Math.min(block.byteLength, safeEnd - blockStart);
          if (sliceEnd > sliceStart) {
            assembled.set(block.subarray(sliceStart, sliceEnd), writeAt);
            writeAt += sliceEnd - sliceStart;
          }
        }
        this.onDataRange(safeBegin, assembled);
      }, error => {
        if (this._aborted) return;
        this._aborted = true;
        onError?.(error);
      });
    }

    abort() {
      this._aborted = true;
      this._inFlight.clear();
      this._cache.clear();
    }

    stats() {
      return {
        totalMs: this._ioMs,
        active: this._ioActive,
        hits: this._hits,
        misses: this._misses,
        cachedChunks: this._cache.size,
      };
    }
  }

  return new StudyHubRangeTransport();
}

/** source: { total, fetchPage(n) -> bytes } (peek/paged-original.js); open(bytes) -> a renderer of a PDF. */
export async function createPagedRenderer(source, open) {
  const pages = new Map(), resolved = new Map(), sizes = new Map();
  let closed = false, retiredAssetMs = 0, fetchMs = 0, fetchActive = 0;

  const forget = async name => {
    const entry = pages.get(name);
    pages.delete(name);
    const live = resolved.get(name);
    resolved.delete(name);
    if (entry) {
      const renderer = live || await entry.catch(() => null);
      if (renderer) {
        retiredAssetMs += renderer.assetStats?.().totalMs || 0;
        await renderer.destroy();
      }
    }
  };
  /** The one-page renderer of page `number`: the one open, else fetched and opened now (two asks at once share it). */
  const pageOf = number => {
    if (closed) return Promise.reject(new Error('The original was closed'));
    if (pages.has(number)) { const entry = pages.get(number); pages.delete(number); pages.set(number, entry); return entry; } // most recently used last
    const started = performance.now();
    fetchActive += 1;
    const fetched = Promise.resolve()
      .then(() => source.fetchPage(number))
      .finally(() => {
        fetchActive = Math.max(0, fetchActive - 1);
        fetchMs += Math.max(0, performance.now() - started);
      });
    const entry = fetched.then(open).then(renderer => {
      if (pages.get(number) === entry && !closed) resolved.set(number, renderer);
      return renderer;
    });
    pages.set(number, entry);
    entry.catch(() => { if (pages.get(number) === entry) { pages.delete(number); resolved.delete(number); } });
    while (pages.size > OPEN_PAGES) void forget(pages.keys().next().value);
    return entry;
  };

  // The file's own page count comes with any page the host gives: page 1 is asked for now (and kept for the first draw), so the reader can check it against its text at once.
  await pageOf(1);
  return {
    numPages: source.numPages || source.total,
    cachedPageSize: number => sizes.get(number) || null,
    // Report live asset + fetch I/O time from all currently open renderers (not only evicted ones) so first-load wasm/CMap or IPC wait is deducted from the render budget.
    assetStats: () => {
      let totalMs = retiredAssetMs + fetchMs;
      let active = fetchActive;
      for (const renderer of resolved.values()) {
        const stats = renderer.assetStats?.();
        if (stats) {
          totalMs += stats.totalMs || 0;
          active += stats.active || 0;
        }
      }
      return { totalMs, active };
    },
    async pageSize(number) {
      if (!sizes.has(number)) {
        const size = await (await pageOf(number)).pageSize(1);
        sizes.set(number, { width: size.width, height: size.height });
      }
      return sizes.get(number);
    },
    async render(number, options) {
      const bitmap = await (await pageOf(number)).render(1, options);
      return bitmap;
    },
    async textLayer(number, options) { return (await pageOf(number)).textLayer(1, options); },
    async destroy() { closed = true; sizes.clear(); for (const name of [...pages.keys()]) await forget(name); resolved.clear(); },
  };
}
