import { GENERATION_FIELDS, presentGeneration } from '../../jobs/generation-view.js';

/** What a translation card shows beyond what every generation card does: the document, the target, the paragraphs and where they stand. */
const OWN_FIELDS = Object.freeze(['origin', 'semantic', 'documentId', 'requestedId', 'revision', 'scopeLabel', 'target', 'total', 'done', 'translated', 'reused',
  'rejected', 'outcome', 'runStartedAt']);
export const TRANSLATION_FIELDS = Object.freeze([...new Set([...GENERATION_FIELDS, ...OWN_FIELDS])]);
const plain = value => JSON.parse(JSON.stringify(value));

/** Presentation reader of a translation: the generation card's (identity, lifecycle and calls from the runtime) plus the fields of the translation. */
export function presentTranslation(view) {
  const reader = presentGeneration(view);
  return observed => {
    const shown = reader(observed);
    return { ...shown, legacy: { ...shown.legacy, ...Object.fromEntries(OWN_FIELDS.filter(key => view[key] !== undefined).map(key => [key, plain(view[key])])) } };
  };
}
