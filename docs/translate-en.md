# Optional English translations of questions

[中文](translate-en.zh-CN.md)

The practice toolbar's **EN** button beside **Hint / Explanation** adds English beneath the original Chinese prompt and options. After reveal, it adds an English reference answer, option explanations, and main explanation. Select EN again to hide additions.

The preference persists across sessions without changing original questions. Mock exams omit it to avoid exposing answers before submission. It is separate from interface language: switching the UI to English does not translate saved content.

Initial translation uses the lowest reasoning level and at most one format-correction retry. The card's `translation` field caches output by a digest of prompt, answer, explanation, option text/explanations, and cloze answers. Reopening uses the cache; `card.update` changes invalidate it. Same-version concurrent requests coalesce; edits during generation reject stale output.

Translation does not enter revision history, reset SM-2, or require a new answer. Active cards synchronize additions without altering submitted answers or option order.

Before answering, only the translated prompt and option text are public. Answers and explanations arrive with the solution after reveal/submission. Cloze translations must preserve all `{{id}}` markers and use original IDs for answers. Failed validation receives one retry, then an explicit error without saving invalid output.

API: `card.translate {deckId,cardId}` → `{deckId,cardId,cached,translation}`. Agents can also call it for bilingual teaching or English additions to a card.
