const text = value => String(value ?? '').trim();

/** The exact fields one card translation covers, shared by caching and public projections. */
export function translateSource(card) {
  const source = {
    lang: 'en', kind: card.kind, prompt: text(card.prompt), answer: text(card.answer), explanation: text(card.explanation),
  };
  if (card.kind === 'cloze') {
    source.clozeText = text(card.cloze?.text);
    source.blanks = (card.cloze?.answers || []).map(({ id, value }) => ({ id: text(id), value: text(value) }));
  }
  if (card.kind === 'quiz' || card.kind === 'multi')
    source.options = (card.options || []).map(({ id, text: value, explanation }) => ({ id: text(id), text: text(value), explanation: text(explanation) }));
  return { source, digest: JSON.stringify(source) };
}

export function currentTranslation(card) {
  if (!card.translation || typeof card.translation !== 'object') return null;
  return card.translation?.digest === translateSource(card).digest ? card.translation : null;
}
