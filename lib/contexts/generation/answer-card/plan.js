import { createHash } from 'node:crypto';
import { boundedMaterials, courseProfileFromState, isCaseDeck, isEnglish, scenarioParagraphs } from '../../../case-study.js';
import { caseTypesFor, guessCaseType } from '../../../case-types.js';
import { answerCardBasis, answerCardState } from '../../../answer-card.js';
import { isLibraryListSource } from '../../../exam-point-list.js';
import { REFUSALS, jobTitle } from './jobs/messages.js';

/* The plan of one answer-card task, pure: no model, no write, no clock. It finds the question (an open card with rubric criteria), refuses one in an
   open mock exam (the card is the answer: it waits for the submit), and gathers what the card is written from and checked against: the stem (the
   question and its case), the deck's generation sources (bounded like the case papers' materials), the question types of its course (lib/case-types.js)
   and the basis digest the save is compared with (lib/answer-card.js). It refuses, in the learner's words and with a code, before anything starts. */

export const MATERIAL_CHARS = 24000;
const refuse = (code, language) => Object.assign(new Error(REFUSALS[code](language)), { code });
const clip = (value, size) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, size);

/** The course materials of a deck's questions: its generation sources, else what its questions cite; never the scenario, never a list or the book. */
function materialsOf(state, deck, scenarioId) {
  const usable = source => source && typeof source.text === 'string' && source.text.trim() && source.id !== scenarioId && !isLibraryListSource(source) && !source.archived;
  const byId = new Map((state.sources || []).map(source => [source.id, source]));
  const named = [...new Set(deck.editorial?.generation?.sourceIds || deck.sourceIds || [])].map(sourceId => byId.get(sourceId)).filter(usable);
  if (named.length) return named;
  const cited = new Set((deck.cards || []).flatMap(card => (card.citations || []).map(citation => citation.sourceId)));
  return [...cited].map(sourceId => byId.get(sourceId)).filter(usable);
}

/**
 * @param request { deckId?, cardId, again?, language } (`language`: the wording of the task; the card is written in the deck's own language)
 * @returns { deckId, cardId, n, language, cardLanguage, prompt, marks, criteria, paragraphs, stem, materials, bounded, types, guess, numbers, basis, key, title }
 */
export function planAnswerCard(state, request = {}) {
  const language = request.language === 'en' ? 'en' : 'zh';
  const deck = (state.decks || []).find(item => (request.deckId ? item.id === request.deckId : (item.cards || []).some(card => card?.id === request.cardId)));
  const card = deck?.cards?.find(item => item?.id === request.cardId);
  if (!card) throw refuse('answer-card-no-card', language);
  if (card.kind !== 'open' || !Array.isArray(card.rubricCriteria) || !card.rubricCriteria.length) throw refuse('answer-card-not-case', language);
  const holds = run => (run.entries || []).some(entry => (entry.deckId ?? run.deckId) === deck.id && entry.card?.id === card.id);
  const inExam = (state.runs || []).some(run => run.mode === 'exam' && !run.closedAt && holds(run));
  if (inExam) throw refuse('answer-card-in-exam', language);
  if (card.answerCard && request.again !== true && answerCardState(card) !== 'edited') throw refuse('answer-card-exists', language);
  const scenarioId = isCaseDeck(deck) ? deck.case.sourceId : null;
  const scenario = scenarioId ? (state.sources || []).find(source => source.id === scenarioId)?.text ?? '' : '';
  const sources = materialsOf(state, deck, scenarioId);
  const materials = sources.map((source, at) => ({ id: source.id, ref: `M${at + 1}`, title: source.title || '', text: source.text }));
  const bounded = boundedMaterials(sources, MATERIAL_CHARS).map((source, at) => ({ ref: `M${at + 1}`, title: source.title, text: source.text }));
  const profile = courseProfileFromState(state, deck.course ?? deck.folder ?? '');
  const types = caseTypesFor(profile.caseTypes);
  const guess = guessCaseType(`${card.prompt}\n${card.topic || ''}`, types);
  const basis = answerCardBasis(card);
  const key = createHash('sha1').update(JSON.stringify([deck.id, card.id, basis])).digest('hex').slice(0, 16);
  return { deckId: deck.id, cardId: card.id, n: card.caseQuestion || null, language, cardLanguage: isEnglish(deck.case?.language || deck.language) ? 'en' : 'zh',
    prompt: card.prompt, marks: Number(card.marks) || 0, criteria: card.rubricCriteria, referenceAnswer: card.answer || '', paragraphs: scenarioParagraphs(scenario),
    stem: [{ id: 'prompt', text: card.prompt }, ...(scenario ? [{ id: 'case', text: scenario }] : [])], materials, bounded, types, guess: guess.id,
    numbers: types.flatMap(type => type.formulas || []), basis, key, title: jobTitle(language, card.caseQuestion, clip(card.prompt, 40)) };
}
