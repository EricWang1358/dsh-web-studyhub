import { bytesHash, formatFor } from './files.js';
import { copyOriginalFile, decodeUpload, externalRecord, hashFile, inspectFile, originalStatus, ORIGINAL_MAX_BYTES, readFileChecked, storeOriginalBytes } from './original-file.js';
import { verifyOriginal } from './original-verify.js';

/* materials.original.* : attach the ORIGINAL file to a document that only has its text (probe / attach / detach / status).
   Metadata only: the stored text, the revision, citations, selections and card links are never touched. A legacy document
   (text only, no record of its own) gets a record with exactly the identity it already had, so everything that named it
   keeps resolving. The caller wires `locate` (document + revision + its sources), `describe` and the library `update`. */

const MODES = new Set(['reference', 'copy']);
const clean = value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

/** Pages the document has, or its sections when it has none (what a person calls "pages"). */
const pagesOf = sources => Math.max(sources.length, ...sources.map(source => source.document?.totalPages || 0));

export function createOriginalOperations({ root, read, update, locate }) {
  const reports = new Map();
  const remember = (key, report) => { reports.set(key, report); if (reports.size > 24) reports.delete(reports.keys().next().value); return report; };

  /** The document, its revision and its text, for a request; refuses what has no file to attach. */
  async function target(args) {
    const state = await read();
    const found = locate(state, args);
    if (found.sources.some(source => source.audio)) throw new Error('An audio transcript has no original file to attach');
    return found;
  }

  /** The supplied file: a path (read in chunks, never copied here) or the bytes of a file the browser chose. */
  async function supplied(args, { document, version, mode }) {
    if (args.path !== undefined && args.dataBase64 !== undefined) throw new Error('Provide exactly one of path or dataBase64');
    let path = args.path;
    if (path === undefined && args.dataBase64 === undefined && mode === 'copy' && version.external) path = version.external.path;
    if (path === undefined && args.dataBase64 === undefined) throw new Error(mode === 'copy' ? 'Provide the original file: a file path or dataBase64' : 'Provide the original file path');
    if (path !== undefined) {
      const file = await inspectFile(path, document.format);
      const { hash, bytes } = await hashFile(file.path, { limit: ORIGINAL_MAX_BYTES });
      if (bytes !== file.bytes) throw new Error('The file changed while it was being read; try again');
      return { kind: 'path', file, hash, size: bytes };
    }
    const own = formatFor({ filename: args.filename, format: args.format || (args.filename ? undefined : document.format) });
    if (own !== document.format) throw new Error(`The file must be the same type as the document (${document.format}), not ${own}`);
    const bytes = decodeUpload(args.dataBase64);
    return { kind: 'bytes', bytes, hash: bytesHash(bytes), size: bytes.length, filename: args.filename || `document.${document.format}` };
  }

  async function verify(input, { document, version, sources }) {
    const key = `${document.id}|${version.revision}|${input.hash}`;
    if (reports.has(key)) return reports.get(key);
    const knownHashes = [version.attachment?.hash, version.external?.hash, ...sources.map(source => source.document?.id)]
      .concat(version.revision.split('-')[0]).filter(value => /^[a-f0-9]{64}$/.test(value || ''));
    let bytes = input.bytes;
    if (!bytes && !knownHashes.includes(input.hash)) {
      bytes = await readFileChecked(input.file.path, { bytes: input.size, hash: input.hash });
    }
    const filename = input.file?.path ? input.file.path.replace(/^.*[\\/]/, '') : input.filename;
    return remember(key, { ...await verifyOriginal({ bytes, hash: input.hash, format: document.format, filename, sources, knownHashes }),
      format: document.format, bytes: input.size, hash: input.hash });
  }

  const describeState = async (found) => {
    const summary = await originalStatus(root, found.version);
    return clean({ documentId: found.document.id, revision: found.version.revision, format: found.document.format, mode: summary.mode, status: summary.status,
      pages: pagesOf(found.sources), path: summary.path, bytes: summary.bytes, verifiedAt: summary.verifiedAt, reason: summary.reason,
      ...(found.version.originalCheck ? { check: found.version.originalCheck } : {}) });
  };

  return {
    'materials.original.status': async args => describeState(await target(args)),

    'materials.original.probe': async args => {
      const found = await target(args);
      const input = await supplied(args, { ...found, mode: 'probe' });
      return { ...await verify(input, found), documentId: found.document.id, revision: found.version.revision };
    },

    'materials.original.attach': async args => {
      const mode = args.mode;
      if (!MODES.has(mode)) throw new Error('mode must be "reference" or "copy"');
      if (mode === 'reference' && args.dataBase64 !== undefined) throw new Error('Reference mode needs a file path; send the bytes only with mode "copy"');
      const found = await target(args);
      const input = await supplied(args, { ...found, mode });
      const report = await verify(input, found);
      const identity = { documentId: found.document.id, revision: found.version.revision };
      if (!report.accepted && !args.confirm) return { status: 'needs-confirmation', mode, ...identity, report };
      const verifiedAt = new Date().toISOString();
      const attachment = mode === 'copy'
        ? (input.kind === 'path' ? await copyOriginalFile(root, input.file.path, found.document.format) : await storeOriginalBytes(root, input.bytes, found.document.format)) : null;
      if (attachment && attachment.hash !== input.hash) throw new Error('The file changed while it was being copied; try again');
      const external = mode === 'reference' ? externalRecord(input.file, input.hash, found.document.format, verifiedAt) : null;
      const check = { verdict: report.verdict, similarity: report.similarity, pages: report.pages, checked: report.checked, matched: report.matched,
        confirmed: !report.accepted, verifiedAt };
      let unchanged = false;
      await update(state => {
        state.documents ||= [];
        let record = state.documents.find(item => item.id === found.document.id);
        const current = locate(state, { documentId: found.document.id, revision: found.version.revision });
        if (!record) record = state.documents[state.documents.push(structuredClone(current.document)) - 1];
        const version = record.versions.find(item => item.revision === found.version.revision);
        if (!version) throw new Error('Material document revision not found');
        const same = mode === 'copy' ? version.attachment?.hash === attachment.hash && !version.external
          : version.external && !version.attachment && version.external.path === external.path && version.external.hash === external.hash && version.external.realPath === external.realPath;
        if (same && (mode === 'copy' || version.external.mtimeMs === external.mtimeMs)) { unchanged = true; return; }
        if (mode === 'copy') { version.attachment = attachment; delete version.external; }
        else { version.attachment = null; version.external = external; }
        version.originalCheck = check;
        unchanged = !!same;
      });
      const original = await describeState(await target({ documentId: identity.documentId, revision: identity.revision }));
      return { status: 'attached', mode, ...identity, ...(unchanged ? { unchanged: true } : {}), report, original, originalAvailable: original.status === 'ok' };
    },

    'materials.original.detach': async args => {
      const found = await target(args);
      await update(state => {
        const record = state.documents?.find(item => item.id === found.document.id);
        const version = record?.versions.find(item => item.revision === found.version.revision);
        if (!version) return;
        version.attachment = null; delete version.external; delete version.originalCheck;
      });
      return { status: 'detached', documentId: found.document.id, revision: found.version.revision };
    },
  };
}
