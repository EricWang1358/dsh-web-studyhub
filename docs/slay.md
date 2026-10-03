# Retire a question

[中文](slay.zh-CN.md)

Retire a question you no longer want to study. It leaves practice and review straight away, but nothing is deleted. Its content, review progress and answer history are kept, and you can restore it to its original deck at any time.

## Retire a question

- **During practice:** open **More** in the toolbar and click **Retire question**. Practice moves on to the next question.
- **From deck management:** open the deck with **Manage deck** and click **Retire** under the question.

The first time you retire a question, StudyHub creates the retired deck. Each library has exactly one.

## Undo right away

After you retire a question during practice, the notice offers **Undo**. It puts the question back in its original deck at once, with its review schedule unchanged. The question does not come back into the current practice session.

## Find retired questions

On the **Study library** page, do either of these:

- Open **Organise & add** above the deck list and choose **Retired deck (N)**.
- Turn on the **Archived** filter. The retired deck is listed with your archived decks.

Each question there shows its original deck and the date you retired it.

## Restore a question

Open the retired deck and click **Restore to original deck** under the question.

- It keeps its review progress.
- If you had paused it before retiring it, it stays paused. Otherwise it is active again.
- If you merged the original deck into another deck, the question goes to the deck it was merged into.
- If the original deck is archived, the deck stays archived.
- If the original deck, or a draft you are editing for it, already has 100 questions, restoring is refused. Organise that deck first, then restore.

## What retiring changes

- **The question moves.** It goes to the retired deck and is paused there.
- **Practice sessions drop it.** The question and its retry copies leave every unfinished practice session, without a new grade. Finished sessions and past answers stay as they were.
- **The retired deck is never studied.** It is left out of daily review, learning paths and mock exams. You cannot unarchive it or study it as a whole; restore questions one at a time.
- **The retired deck is locked.** You cannot edit the retired deck or pause the questions in it. Restore a question first.
- **Edit drafts stay in step.** If you are editing the original deck, its draft drops the retired question, so publishing the draft from an old window cannot bring it back. Restoring adds the question back to the draft.
- **Prerequisite links follow the question.** While it is retired, it is not listed among prerequisites to learn. After you restore it, its links work again.
- **No size limit.** The retired deck can hold any number of questions.

## For agents and developers

The Chinese interface calls this action 斩 and the retired deck 斩题组. The API and code call them slay and slain.

- `card.slay {cardId, deckId?, runId?}` retires a question. Call it only when the learner asks.
  - With `runId`, it first checks that the question is still the current one in that practice session, then returns the updated practice view.
  - Without `runId`, it returns the retired deck's ID and the card ID.
- `card.restore {cardId, deckId?}` restores a retired question to its original deck and returns the deck ID, card ID and deck title.
