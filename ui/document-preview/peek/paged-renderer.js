/* A renderer (the interface of renderer.js createPeekRenderer) for a PAGED original: the file is on the host and only the pages asked for are sent, each as a small PDF.
   A page is opened through `open(bytes)` (the ordinary renderer of that one-page PDF, drawn as its page 1), and kept for the next draw of it (its size, its picture and its
   words each ask for it); only a few stay open, the oldest closed first, so turning pages never piles them up. */

const OPEN_PAGES = 3;

/** source: { total, fetchPage(n) -> bytes } (peek/paged-original.js); open(bytes) -> a renderer of a PDF. */
export async function createPagedRenderer(source, open) {
  const pages = new Map(), sizes = new Map();
  let closed = false, assetMs = 0;

  const forget = async name => {
    const entry = pages.get(name);
    pages.delete(name);
    if (entry) { const renderer = await entry.catch(() => null); if (renderer) { assetMs += renderer.assetStats?.().totalMs || 0; await renderer.destroy(); } }
  };
  /** The one-page renderer of page `number`: the one open, else fetched and opened now (two asks at once share it). */
  const pageOf = number => {
    if (closed) return Promise.reject(new Error('The original was closed'));
    if (pages.has(number)) { const entry = pages.get(number); pages.delete(number); pages.set(number, entry); return entry; } // most recently used last
    const entry = source.fetchPage(number).then(open);
    pages.set(number, entry);
    entry.catch(() => { if (pages.get(number) === entry) pages.delete(number); });
    while (pages.size > OPEN_PAGES) void forget(pages.keys().next().value);
    return entry;
  };

  // The file's own page count comes with any page the host gives: page 1 is asked for now (and kept for the first draw), so the reader can check it against its text at once.
  await pageOf(1);
  return {
    numPages: source.numPages || source.total,
    cachedPageSize: number => sizes.get(number) || null,
    assetStats: () => ({ totalMs: assetMs, active: 0 }),
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
    async destroy() { closed = true; sizes.clear(); for (const name of [...pages.keys()]) await forget(name); },
  };
}
