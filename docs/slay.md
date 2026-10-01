# Removing a question from active study

[中文](slay.zh-CN.md)

**Slay** is available during question, flashcard, cloze, and open-response practice and in deck management. First use creates the workspace's single system deck for removed questions, accessible above the library list and among archived decks.

During practice, **Undo** immediately restores a card to its original deck. It does not return to the current round.

Slaying moves and suspends the original card, retaining its ID, content, progress, original deck name, removal time, and history. Practice advances. The card and retry copies leave all unfinished runs without a new grade. Finished runs and historical answers remain unchanged.

This system deck is excluded from daily review, learning paths, and mock exams. It cannot be unarchived or resumed as a whole. Restore individual cards with **Restore to original deck**, retaining original progress and suspended status. An archived original deck stays archived. If the original deck or edit draft has 100 questions, organize it before restoring.

Movement synchronizes the original edit draft and version so old windows cannot republish removed cards. Prerequisite links move too; removed cards are excluded from pending prerequisites and links work again after restoration. The system deck may exceed the ordinary 100-question limit.

API: `card.slay {deckId,cardId,runId?}`. With `runId`, it validates the current question and returns the updated practice view; otherwise it returns destination deck and card IDs. `card.restore {deckId,cardId}` restores the original deck.
