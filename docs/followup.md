# Asking follow-up questions about explanations

[中文](followup.zh-CN.md)

After answering, open **Explanation**. **Follow-up?** suggests three questions, or **Your question** accepts up to 1,000 characters. Selecting a suggestion or **Answer and add** asks the model to refine and answer it. Q&A appends to the explanation and stays on the card after switching questions, refreshing, and future reviews.

The model receives the question, cited text, and the last 12 Q&A entries for its current version. Beyond-source explanations must be labeled supplementary. Follow-ups do not alter the prompt, answer, revision history, or schedule, and remain hidden until answer reveal.

After a question is edited, old Q&A remains stored but is not displayed in the new version. Editing during generation prevents outdated answers from being saved.

With automatic preparation enabled, new follow-ups enter its existing queue and can produce source-verifiable reinforcement questions under **For you**, labeled as follow-up reinforcement. Capacity and batching settings still apply. Follow-ups do not enable preparation, count as wrong answers, or let AI answers become source evidence.

Suggestions are cached by question version and existing Q&A across restarts. New Q&A or edits invalidate the next request. Concurrent requests share one call. Invalid output receives at most one correction retry.

- `card.followup.suggest {deckId?, cardId}` returns `{questions: string[3]}`.
- `card.followup {deckId?, cardId, question}` returns `{deckId, cardId, item}`, with refined question, original question, and answer. Same-version identical retries reuse saved answers; concurrent requests coalesce; different questions append separately.

Tests cover persistence, answer hiding, context, duplicates, concurrency, model errors, edit conflicts, and preparation. Browser checks use `scripts/fake-model.mjs`; simulated output does not prove real teaching quality.
