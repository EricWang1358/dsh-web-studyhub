# Follow-up questions on an explanation

English · [简体中文](followup.zh-CN.md)

Each question keeps the extra explanations you ask for, as Q&A. They are saved on the question, appear with its explanation after you answer, and can become new questions.

## Ask about a question

Both ways need a model.

- **While practising:** click **Help me understand** in the question toolbar. Choose one or more of **Explain simply**, **Another perspective**, **A concrete example**, **Step by step**, **Review prerequisites** and, after you answer, **Explain my mistake**. You can add your own question of up to 1,000 characters. Click **Send to background assistant**. The answer is added to the question as a Q&A and also arrives in the **Inbox**, so you can keep practising meanwhile. [Background tasks and the right sidebar](generation-agents-sidebar.md#get-help-on-a-question-in-the-background) explains how the assistant runs.
- **In the main chat:** ask about the question. StudyHub can save an explanation from the chat to the question, answer a follow-up and save it, or suggest 3 follow-up questions.

## Read saved Q&A

- After you answer, the explanation (**Understand this question**) opens with the saved Q&A at its end. When the answer is shown before you have answered, click **Explanation** in the toolbar to open it.
- The newest Q&A is open and the earlier ones are folded. With more than one, use **Expand all** or **Collapse all**. **Collapse** at the end of a long answer folds it back to its question.
- Q&A stay hidden until the answer is shown, and mock exams never show them.
- Q&A are saved on the question. They stay after you switch questions, refresh or restart, and in every later review.
- In the document reader, **Questions and explanations linked to this source** lists each linked question with its Q&A under **Follow-ups**, newest first.

## Turn a Q&A into a question

Under each saved Q&A:

- **Make a prerequisite question** writes a new flashcard and links it as a prerequisite of this question.
- **Make a separate question** writes a new flashcard on its own.

A background assistant writes the flashcard into the same deck, and the result arrives in the **Inbox**. If the deck already has a question with the same prompt, StudyHub reuses it as the prerequisite, or does not save a duplicate. If the link would create a loop or pass the prerequisite limit, the new question is kept without the link.

## What follow-ups do not change

- The question's text, answer, revision history and review schedule stay as they are.
- A follow-up never counts as a wrong answer.
- AI answers never become source evidence for new questions.
- The model is told to mark anything beyond your sources as supplementary, and never to present it as coming from the source.

## When a question is edited

- Q&A stay on the question and stay visible after the edit.
- If the edit changes the question itself (its stem, answer, options or blanks), the Q&A are still kept. StudyHub records that they were asked about the earlier version.
- Cached follow-up suggestions are dropped.
- If the question changes while an answer is being written, that answer is not saved. Ask again on the updated question.

## Get practice questions from follow-ups

This needs **Prepare variations and application questions in the background while I practise** turned on, in **Settings › Study profile and tour** (**Study coach** section).

- Each new follow-up that StudyHub answers in the main chat joins the existing preparation queue. It can produce one practice question about that specific doubt.
- A practice question that passes the source checks appears under **Personalised**, labelled **Follow-up practice**.
- Answers from **Help me understand** are saved as Q&A but do not add a practice question.
- The usual preparation limits apply, including at most 12 prepared questions waiting at a time.
- A follow-up does not turn preparation on. The AI answer is context only: the practice question and its answer must be supported by your sources, or the follow-up is skipped.

## How requests are handled

- **What the model receives.** A follow-up answered through the main chat sends the question with its citations and the last 12 Q&A. **Help me understand** sends the question, nearby source text and the last 3 Q&A.
- **Model.** Follow-up answers and suggestions use the same model as other StudyHub work, at its lowest reasoning level.
- **Suggestions are cached** on the question by question version, existing Q&A and interface language. Reopening or restarting reuses them. A new Q&A or an edit gives fresh suggestions next time.
- **Repeated requests.** Identical requests at the same time share one model call. Asking the same question again on the same version returns the saved answer. Different questions are added separately.
- **Malformed output** gets one corrective retry. A failed suggestion is not cached.
- **Limits.** A question can have up to 1,000 characters and an answer up to 8,000. Suggestions are exactly 3, each up to 200 characters.

## For developers

- `card.followup.suggest {deckId?, cardId}` returns `{questions: string[3]}`.
- `card.followup {deckId?, cardId, question}` returns `{deckId, cardId, item}`. `item` holds the polished question, the original question and the answer. An identical retry on the same version reuses the saved answer, concurrent identical requests are coalesced, and different questions append separately.
- `card.followup.add {deckId?, cardId, question, answer}` saves an answer written elsewhere, such as in the main chat or by **Help me understand**. It does not queue a practice question.
- `ui/ExplanationFollowup.jsx` also contains suggestion and question controls, but the practice page renders it read-only, so they are not shown.
- `tests/followup.test.mjs` covers persistence, hiding answers before they are shown, context, duplicates, concurrency, model errors, edit conflicts and preparation. Browser checks use `scripts/fake-model.mjs`; simulated output does not prove real teaching quality.
