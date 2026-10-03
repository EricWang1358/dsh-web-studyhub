# Show questions in English

[中文](translate-en.zh-CN.md)

Turn on **EN** in practice to read each question in Chinese with an English version underneath. The original question stays as it is.

EN is separate from the interface language. Switching the interface to English changes StudyHub's own labels, not the questions you saved.

## Turn EN on or off

1. Open a question in practice.
2. Click **EN** in the toolbar. It sits next to **Hint** (or **Explanation** after you reveal the answer) and **Help me understand**.
3. Click **EN** again to hide the English.

- While a question is being translated, the button reads **EN…**.
- With EN on, every new question you open is translated automatically.
- The same browser remembers the setting across sessions; it does not sync to other browsers or devices.
- Mock exams have no **EN** button, so a translation cannot give away an answer before you submit.

## What appears in English

Before you answer, only question-side text is shown in English. Answer-side English appears after you reveal or submit your answer.

| Question type | Before you answer | After you reveal or submit |
| --- | --- | --- |
| Single choice, Multiple choice | The question and each option | Why each option is right or wrong |
| Flashcard, Open response | The question, on the front of the card | The reference answer, on the back of the card |
| Fill in the blank | The sentence, with each blank shown as ＿＿ | The answer for each blank |

The **Understand this question** explanation also gets an English version after the reveal. Open-response questions marked against scoring criteria show English only there.

## Model use

- The first time a question is shown in English, StudyHub makes one model call. It uses the model StudyHub uses for generating questions (**Settings › Library & model**), at its lowest reasoning effort. The call is billed by your provider.
- The translation is saved with the question, so showing the same version again does not call the model. Editing translated content hides its older English; with EN on, StudyHub translates the current version again.
- Without a working model, EN shows the error "Translating this question requires an available model".

## What EN does not change

- The translation is not part of the question. It is not added to the revision history, does not reset the spaced-repetition (SM-2) schedule and does not ask you to answer again.
- If you are already working on the question, the English is added without changing an answer you submitted or the order of the options.

## When a translation fails

StudyHub checks each reply before saving it:

- the question, answer and explanation each have English text;
- every option has English text and an English explanation;
- every blank has an English answer;
- a fill-in-the-blank sentence keeps all of its `{{id}}` blank markers.

If the check fails, the model gets one more try with the error. If that also fails, you see an error and nothing is saved.

## For agents and developers

- **Action:** `card.translate {cardId, deckId?}` returns `{deckId, cardId, cached, translation}`. In the main chat, the agent can call it to teach a question in both languages or to add English to a question.
- **Model call:** a light call (lowest reasoning effort) with at most one corrective retry.
- **Cache:** the result is stored in the card's `translation` field with a digest of everything it covers: question type, prompt, answer, explanation, option text and explanations, and the fill-in-the-blank sentence and blank answers. While the digest matches, the call returns the stored result with `cached: true`. After any of those fields changes, the next call translates again.
- **Concurrency:** requests for the same question version share one model call. If the question is edited while a translation is running, the result is discarded with "The question changed; translate it again".
- **Answer safety:** before the reveal, the public card carries only `translation.prompt`, `translation.clozeText` and `translation.options[].text`. The answer side (`answer`, `explanation`, `options[].explanation`, `blanks`) arrives with the solution after the reveal or submission.
- **Blank markers:** the English fill-in-the-blank sentence must contain exactly the original `{{id}}` markers, and each blank answer uses the original blank ID.
