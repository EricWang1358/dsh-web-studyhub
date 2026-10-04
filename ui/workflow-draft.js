import { draftKey as writingKey, readDraft as readSaved, writeDraft, clearDraft as clearSaved } from './writing-drafts.js';
import { readJSON, removeKey } from './storage.js';

/* The unsaved text of a guided-study step is a recovery draft (ui/writing-drafts.js): storage that is missing, full or
   blocked never breaks typing, and a late save clears only its own revision. `session` is the workflow session
   ({ id, currentStepId, version, records }); `libraryKey` names the library. */

export const savedOutput = (session) => session.records[session.currentStepId]?.output || '';
const keyOf = (session, libraryKey) => writingKey(libraryKey, 'workflow-step', [session.id, session.currentStepId]);
/** Where drafts lived before the shared format; read once and removed. */
const legacyKeyOf = (session, libraryKey) => `study-workflow-output:${libraryKey}:${session.id}:${session.currentStepId}`;

/** { output, base, version } of the step's unsaved text, or null. */
export function readStepDraft(session, libraryKey, storage = globalThis.localStorage) {
  const saved = readSaved(keyOf(session, libraryKey), storage);
  if (saved) return saved.value;
  const legacy = readJSON(legacyKeyOf(session, libraryKey), null, storage);
  if (legacy) removeKey(legacyKeyOf(session, libraryKey), storage);
  return legacy;
}

/** Remember the text of the step (and the saved text it was written over). */
export function keepStepDraft(session, output, libraryKey, storage = globalThis.localStorage) {
  try { writeDraft(keyOf(session, libraryKey), { output, base: savedOutput(session), version: session.version }, storage); } catch { /* the text stays on screen; only recovery is lost */ }
}

export function clearStepDraft(session, libraryKey, storage = globalThis.localStorage) {
  try { clearSaved(keyOf(session, libraryKey), undefined, storage); } catch { /* nothing stored, or storage is blocked */ }
}
