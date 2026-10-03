# Use your own reference questions

On **Create a deck → Generate from sources**, select the textbook passages that will support answers. Open **Reference questions (optional)** to upload examples or select files already saved in your source library. The same optional selector is available when generating a new case paper.

TXT and Markdown work directly. PDF and Word use the existing document importer; convert images to text first. Include the question, correct answer and explanation where available. Imports remain in the source library for later reuse. A source cannot be selected both as factual material and as an example for the same run.

Customize the maximum number of source excerpts and their total character budget. Defaults are 5 excerpts and 12,000 characters. The count represents source pages or text excerpts, not individual questions inside them. Allowed settings are 1–50 excerpts and 1–100,000 characters to bound request size; your model's context capacity still applies. If your selection exceeds either limit, reduce it or adjust the settings. Examples are never silently shortened. The chosen limits are saved with the deck and reused for supplementation.

Tradeoff: a few relevant, consistent examples cost less and make the desired style easier to follow. More examples can cover additional forms and difficulty levels, but more text adds input tokens to the existing generation and review calls and can increase cost and waiting time. Irrelevant, repeated or conflicting styles can interfere with generation. Raising a limit alone adds no cost; the selected text determines usage, and characters are not tokens. Start small and increase only after inspecting the results. More examples do not increase the requested question count or guarantee a higher acceptance rate.

Examples guide compatible stem structure, option organization, difficulty and explanation format. Consistent format does not require identical scenarios or sentence patterns: prompts ask for questions, wording, scenarios and distractors adapted to each verified learning target, rather than repeating a template with nouns swapped. Author self-check and independent review assess both useful format adherence and content diversity. Variation must not invent facts, force scenarios or reduce readability; flashcards still prioritize focused recall.

Drag **Sample format adherence** between three levels. The default is **Balanced**. The setting is saved with the deck and reused for supplementation. These are instructions about style, not guaranteed adherence or acceptance rates:

| Level | Effect and tradeoff |
| --- | --- |
| Flexible | Borrow useful organization with more freedom to adapt structure; results may look less like the examples. |
| Balanced | Preserve the main question structure while adapting wording and scenarios to each learning target. |
| Close | Follow compatible stem, option and explanation structure more closely; formatting is more consistent with less stylistic freedom, but mechanical repetition must still be avoided. |

Every level retains evidence, accurate citations, readability and diversity requirements. Requested question-kind rules take priority over incompatible sample formats. Without selected examples, the slider adds no sample-style instructions.

Answers and quotations still have to come from the selected factual material. The generator is instructed to create new questions, preserve clear language and avoid copying sample wording or treating sample answers as verified facts. Single choice, multiple choice, flashcards, cloze, open response, mixed decks and newly generated case papers use their own format requirements. Importing an existing case does not rewrite it using examples.

No examples are selected by default. Selected examples carry into later supplementation of the generated deck; removing their source files requires choosing fresh examples. When you start generation, examples are sent with textbook material to your configured model. They add context to the existing generation and review calls, so token usage can increase; they do not add a new model stage. The estimate includes their context. They help express the style you want, but do not guarantee that every question passes review or that provider-generated language will always read naturally.

This release does not bundle third-party question banks. See the [open-source reference survey](reference-question-sources.md) for candidate sources and licence considerations. You can use your own textbook questions now.
