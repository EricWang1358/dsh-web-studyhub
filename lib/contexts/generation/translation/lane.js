/** The chain of the library queue a translation waits in. Until `runtime.pilot.translationParallel` it is the library's own chain (the library root), so a translation
 * and every generation job are one at a time, in the order accepted. With the switch it is a chain of its own per document: a translation then waits only for another
 * translation of the same document (they write the same record), and no longer for generation, supplement, selection fill, repair or publish, which read the
 * sources and write drafts and decks, never a translation (what each writes is listed in docs/job-contract.md, S4-3). */
export function translationLane({ root, documentId, parallel }) {
  return parallel && documentId ? `${root}\u0000translation:${documentId}` : root;
}
