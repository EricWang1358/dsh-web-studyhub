# Open reference-question sources

Inspected on 2026-10-03. These are candidates for examining question structure and worked explanations, not a bundled question bank or proof of better generation quality. This release supports the learner's own reference material first.

The current product focus is textbook questions and existing flashcard/question kinds. Arithmetic word problems are not a default reference for flashcards. GSM8K is recorded for research only; no external dataset is automatically supplied to generation.

| Source | Useful examples | License and boundary |
| --- | --- | --- |
| [GSM8K](https://github.com/openai/grade-school-math/tree/3101c7d5072418e28b9008a6636bde82a006892c) | Human-written arithmetic word problems and multi-step worked answers; useful for explicit conditions and calculation explanations | The repository's [MIT license](https://github.com/openai/grade-school-math/blob/3101c7d5072418e28b9008a6636bde82a006892c/LICENSE) requires retaining its copyright and permission notice when redistributing its content. The dataset is elementary arithmetic, not a general subject or multiple-choice quality standard. |
| [Ai2 SciQ](https://huggingface.co/datasets/allenai/sciq/blob/main/README.md) | Science multiple-choice questions with correct answers, distractors and support passages | The publisher's dataset card states CC BY-NC 3.0. Its noncommercial restriction matters; do not treat it as an unrestricted default bank. |
| [OpenStax Exercises](https://exercises.openstax.org/copyright) | Textbook exercises across subjects | The publisher says many questions use Creative Commons Attribution licenses and requires checking each question's own copyright and license. The [application repository](https://github.com/openstax/exercises/tree/515a95e9224f301dcd702ea836e6f2277a3b511d) has separate AGPL licensing; that code license does not establish every question's content license. |

No third-party question text or code from these projects is included in this change. A future curated pack should record the exact source, question identifier, license, required attribution, subject, question kind and human review for each example. Dataset popularity or an answer key alone is not a quality review.

Reference questions should guide structure, difficulty, wording and explanation style. Their facts and answer keys cannot replace the learner's selected knowledge sources or validate a new question's answer. Questions generated with references still need the normal evidence and independent quality checks.
