import React from 'react';
import { ui } from './i18n.js';
import { RadioCard, RadioCardGroup } from './components/index.js';
import { draftPart, nextPartOfSummary } from '../lib/deck-parts.js';
import { asNewDeckLabel, intoDeckLabel, partDraftLine, partTitle } from './deck-parts.js';

/* A draft made as the next part of a published deck (lib/deck-parts.js): the draft page says whose part it is before anything is published, and when it is published the learner chooses
   where it goes: into the deck (the default, its next part) or into any other deck that holds the same material's questions, or a deck of its own. Nothing touches a deck before that. */

export const NEW_DECK = '';

/**
 * Where a part can go: the decks of the snapshot that hold the questions of its material (the sources' `usedBy`), its own deck first, each with the part it would be.
 * -> null for a draft that is not a part | { part, deck, candidates: [{ id, title, n }] }   `deck` is its own deck's entry (null when it was archived or deleted).
 */
export function partTargets(draft, data) {
  const part = draftPart(draft);
  // What a publication left of a part (a repair of the deck it went into) goes back to that deck: there is nothing to choose.
  if (!part || draft.editingDeckId || draft.editorial?.repairOfDeckId) return null;
  const decks = new Map((data?.decks || []).filter((deck) => !deck.archived && !deck.systemKind).map((deck) => [deck.id, deck]));
  const wanted = new Set(draft.editorial?.generation?.sourceIds || []), ids = [part.deckId];
  for (const source of data?.sources || []) if (wanted.has(source.id)) for (const ref of source.usedBy || []) if (ref.kind === 'deck' && !ref.archived && !ids.includes(ref.id)) ids.push(ref.id);
  const candidates = ids.filter((id) => decks.has(id)).map((id) => ({ id, title: decks.get(id).title, n: nextPartOfSummary(decks.get(id)) }));
  return { part, deck: candidates.find((item) => item.id === part.deckId) || null, candidates };
}

/** The line under the page's header: 「这份草稿是「期中复习」的第二部分。…」 */
export function DraftPartLine({ targets }) {
  if (!targets?.deck) return null;
  return <p className="draft-part-line" data-draft-part>{partDraftLine(targets.deck.title, targets.deck.n)}</p>;
}

/** The choice of where the part goes when it is published. `value`: a deck id, or NEW_DECK. */
export function PartTargetChoice({ targets, value, onChange, disabled = false }) {
  if (!targets) return null;
  return <RadioCardGroup legend={ui('发布到')} className="draft-part-target" data-part-choice>
    {targets.candidates.map((item) => <RadioCard key={item.id} name="draft-part-target" value={item.id} checked={value === item.id} disabled={disabled}
      title={intoDeckLabel(item.title, item.n)} onSelect={onChange} data-part-target={item.id} />)}
    <RadioCard name="draft-part-target" value={NEW_DECK} checked={value === NEW_DECK} disabled={disabled} title={asNewDeckLabel()} onSelect={onChange} data-part-target="new" />
  </RadioCardGroup>;
}

/** The default target: its own deck while it is there, else the first deck that holds the material, else a deck of its own. */
export const defaultPartTarget = (targets) => (targets?.deck?.id ?? targets?.candidates?.[0]?.id ?? NEW_DECK);

/** The title of a part where a job or a row names it: 「期中复习 · 第二部分」. */
export const draftPartTitle = (targets) => (targets?.deck ? partTitle(targets.deck.title, targets.deck.n) : '');
