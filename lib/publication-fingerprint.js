import { createHash } from 'node:crypto';

/* What a published card IS, as far as a later look at the library can tell: its id and everything that says what it asks and answers, in the form `draft.publish` writes it
   (after the part stamp and every other normalisation of the write). Not what belongs to the learner's own use of it - when it was added, its review schedule, flags, links,
   revisions - which the write sets or keeps and which change as soon as the card is studied. */
const OWN = ['addedAt', 'review', 'flag', 'suspended', 'requires', 'revisions'];

export function publishedFingerprint(card) {
  const content = Object.fromEntries(Object.entries(card).filter(([key]) => !OWN.includes(key)).sort(([a], [b]) => a.localeCompare(b)));
  return createHash('sha256').update(JSON.stringify(content)).digest('hex').slice(0, 24);
}
