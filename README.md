# StudyHub

English · [简体中文](README.zh-CN.md)

StudyHub turns your course materials into practice questions that show where each answer comes from. Add PDFs, slides, notes or lecture recordings. StudyHub drafts questions that cite the source passage, and you review and publish them. SM-2 spaced repetition (the algorithm behind Anki's classic scheduler) then brings each question back when it is due. Your library stays on your computer, and the interface is in English or Chinese.

StudyHub is a plugin for [DeepSeek Harness (DSH)](https://www.deepseek.com/en/harness/), an AI agent app. DSH runs as a desktop app or as a web page served from your own computer, and StudyHub opens inside it.

[Try the demo](https://daily-flashcard-demo.ziangw1358.chatgpt.site) · [Install guide](docs/install.md) · [Release 2.6.1](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.6.1) · [Changelog](CHANGELOG.md)

The demo runs in your browser with sample questions and prepared AI replies. It needs no install and no key, and your progress there stays in that browser.

## At a glance

- **Made for:** students who learn from slides, PDFs, notes and recorded lectures, in English or Chinese.
- **Cost:** StudyHub is free and open source (MIT). Browsing sources, answering questions and review scheduling are free, with no model calls. Generating questions and AI help are billed by your model provider. StudyHub shows the estimated tokens before a generation run and the actual tokens after it, and **Statistics** totals the last 7 or 30 days.
- **Network and cost:** supported regions, free allowances and pricing depend on each provider’s current terms. If installing from the GitHub address fails, see the notes under [Quick start](#quick-start).
- **Computers:** the install links below cover Windows x64 and macOS on Apple silicon. For other systems, check current DSH support or use the web version with Node.js 22.19 or later.
- **Requires:** DSH 0.2 (0.2.0-rc.2 or later, below 0.3).
- **Your data:** the library is a folder on your computer. [Data and privacy](#data-and-privacy) lists what is sent where.

## What you can do

- **Make questions from your own sources.** Pick pages or chapters and generate flashcards, single- or multiple-choice, open-response or fill-in-the-blank questions. Every question cites its passage, and you review the draft before you publish it.
- **Move between questions and sources.** A citation opens the passage it came from. In a source, paragraph and table markers lead to the questions and explanations linked to them.
- **Practise and review.** Start today's study from the **Study library**, follow a **Learning flow** (a short lesson, then practice), click **Help me understand** on any question, and let SM-2 schedule your reviews.
- **Find weak points.** Use **Mistakes & weak points**, **Statistics** and **Mock exam**, which offers a multiple-choice paper, a case paper or an oral interview.
- **Finish with a daily recap.** After answering 10 distinct questions in one course on the same day, generate one recap across its chapters. Retries count once. Choose a friendly or professional tone and opt into automatic generation in Settings. Recaps use the source reader; saving one as a source and publishing on CSDN are separate actions.
- **Turn recordings into text.** Import a lecture recording, or transcribe a **Live class** as it happens, and get a Chinese–English transcript you can generate questions from.
- **Read and organise.** The reader has a table of contents, search, **Translate this page** and **Practise these pages**. Courses, **Study notes**, **Tasks** and a **Knowledge outline** keep a term's work together.

## Quick start

| You want to | You need | Cost |
| --- | --- | --- |
| Take the sample course and tour, browse sources, practise existing questions | StudyHub only | Free, no model calls |
| Generate questions, explanations and **Help me understand** | A model provider key in DSH **Settings › Models** | Billed by your provider, for example the [DeepSeek API](https://platform.deepseek.com/) |
| Turn recordings into text | A transcription key in StudyHub **Settings › Audio transcription** | SiliconFlow SenseVoice supports recording transcription. Gemini and Groq availability and allowances depend on the provider |

1. **Install DSH** (skip this if you have it). Use the official [Windows x64 installer](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe) or [macOS Apple silicon installer](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg). On any other computer, install Node.js 22.19 or later and run `npx @deepseek-ai/dsh web`.
2. **Install StudyHub.** In DSH, open **Plugins**, click **Add plugin**, paste this address and click **Enable**:

   ```text
   https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.6.1/ericwang1358-dsh-daily-flashcard-2.6.1.tgz
   ```

   Check that the package is `@ericwang1358/dsh-daily-flashcard`, version **2.6.1**. StudyHub then opens by itself. Later, open it from **StudyHub** in DSH's left sidebar (the session tab and the right sidebar also work); you do not need to send a chat message first.
3. **Take the tour (optional, about 3 minutes).** On the welcome page, click **Load the sample and start the tour**. The 21-step tour moves through sources, generation, practice, mistakes, exams and statistics and points at the real controls. The sample makes no model calls and can be removed with one click.
4. **Add a model.** Paste a key in DSH **Settings › Models** and choose a model in your session. Until then, StudyHub shows **Open model settings** wherever a step needs a model, instead of letting the step fail later.
5. **Start with your own material.** Click **Add source** and drop several PDFs, slides or notes at once. Then use **Generate from sources**, review the draft, publish it and practise.

Notes on installing:

- **Already use DSH?** Install only the plugin. Keep your current desktop app or web server, profile, model settings and workspace.
- **GitHub address does not work?** Download the `.tgz` from the [release page](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.6.1) in your browser and give **Add plugin** its absolute path. The file must be on the computer or server that runs DSH.
- **Which file on the release page?** Only the complete package, `ericwang1358-dsh-daily-flashcard-<version>.tgz`, and you normally do not need to download it: step 2 pastes its address. The other files are the six separate components, the search extension (StudyHub installs it when you click **Install the search extension**), the checksum list and two setup guides.
- More options, including the command line: [installation and model setup guide](docs/install.md). Setup guides you can open in a browser: [English](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.6.1/StudyHub-2.6.1-Setup.html) · [Chinese](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.6.1/StudyHub-2.6.1-Setup.zh-CN.html). DSH itself comes only from the official sources in step 1.

## Use StudyHub

### Add sources

Click **Add source**, choose the course, then drop several files at once or paste text. Recordings go in the **Audio / recording** tab of the same window.

| Format | Limit | Notes |
| --- | --- | --- |
| PDF | 8 MB, 200 pages | Kept as one document that you expand to pages. For bigger books, see below |
| Word (.docx), PowerPoint (.pptx) | 40 MB | Only text is read. Pictures, charts and SmartArt are skipped, and so are Word text boxes, headers and footers. A .pptx keeps one page per slide, with its speaker notes |
| Markdown, HTML, TXT | 8 MB | |
| JSON deck | 2 MB | Questions you already have, or ones written elsewhere ([format](docs/json-import.md)) |
| Subtitles (.srt, .vtt) | 8 MB | Needs the audio component |
| Audio (MP3, WAV, M4A, AAC, OGG, FLAC, OPUS, WEBM, AIFF) | 512 MB, 8 hours | See [Transcribe recordings](#transcribe-recordings) |

Old .doc and .ppt files (and .wps, .key, .pages) are not read. Save them as .docx, .pptx or PDF first.

**Large textbooks** (over 8 MB or 200 pages):

- Click **Convert with MinerU** in the import window. StudyHub converts PDFs up to 800 MB and imports the result as one paged book that you can choose by chapter.
- Start with local `mineru`: install it, then download and enable the parsing models in Settings. The PDF stays on your computer. **Cloud conversion is temporarily unavailable; use local models first.** The cloud option remains available for manual selection after service recovers; it requires your own MinerU token and upload consent.
- To practise across a whole book, use the search extension or the **Step-by-step path** on **Create deck**.

See [large textbooks](docs/large-documents.md) and [MinerU conversion](docs/mineru-conversion.md).

For another route, open the [external Marker guide](docs/marker-external.md) from Add material, download a script to run yourself, then choose its paginated Markdown output. Install Marker and its models separately; code and model licences apply separately.

### Generate a deck

1. Open **Create deck**. On the **Generate from sources** tab, choose sources by document (or by chapter for a big book), then the question type, count and difficulty. Not sure what to focus on? **Suggest a focus** proposes topics from your source titles and headings, without sending the full text.
2. Click **Generate & check deck**. The job runs in the background; you can keep studying.
3. Review the draft and its citations, then publish it. Publishing checks every question again; questions with a problem stay in the draft. Drafts stay separate from published questions.

To add to an existing deck, choose that deck: approved questions are added, and the old questions and their review progress stay. To bring in questions you already have, use the **Import JSON deck** tab.

<details>
<summary>How generation checks questions</summary>

- Each batch gets one independent review. Questions that pass are kept, and any shortfall is reported. Version 2.5.8 introduced one citation repair; the current workflow verifies knowledge points and answers first, corrects those preparation stages when needed, then writes and independently reviews questions without a candidate repair loop.
- When you add to an existing deck, reviewed questions are saved even if the generation budget runs out, with no second publish step.
- Citations and question structure are checked in code. The content itself can still be wrong, so read the draft. More in [question quality checks](docs/assessment-quality.md).
- Source text is given to the model as evidence, never as instructions to follow.
- Courses label sources and decks; folders only group decks for display. Every action uses only the courses, sources and decks you selected.

</details>

Save a default question type, count, content language, difficulty and focus in **Settings › Question defaults**; each new request can override them. Questions per batch, parallel batches and the time budget are there too, initially 5, 3 and 20 minutes. Started tasks and continued drafts keep their original choices. See [Generation pace](docs/generation-agents-sidebar.md#what-a-generation-task-does).

### Practise and review

Today's learning plan connects tasks to the library home. Ask AI for a plan based on real due reviews, weak areas, available materials, unfinished learning flows and accepted tasks. Give feedback to revise it, or accept. Each action has a reason and estimated duration; suggestions become board tasks only after acceptance, with direct start and resume controls.

Today's time budget is separate from your saved weekday/weekend pace; zero minutes supports a rest day. Unfinished actions are allocated within the budget, and completed actions still count toward today's workload. Record actual time after completion. After at least five comparable completed-day records, the median estimates your usual pace; explicitly saved preferences always take priority.

Practice progress counts actual answers, flows use completed steps, and you explicitly mark a reading block complete. Opening content or skipping questions does not count, and completing an action does not establish mastery. AI sees compact titles, progress and exam dates, not full materials. Invalid or unavailable AI results are clearly labelled as local suggestions. Plans are saved by library and date, alongside ordinary board tasks.

- Answer, then read the explanation. **Help me understand** asks a tutor about the current question.
- Rate flashcards and open answers from 0 to 5; SM-2 picks the next review date. Answering and scheduling make no model calls.
- **Mistakes & weak points** groups wrong answers by topic and can **Generate variants**. **Mock exam** and **Statistics** show what still needs work.

<details>
<summary>How Help me understand keeps context</summary>

When DSH supports local subagents, repeated **Help me understand** on the same question keeps the same tutor and its conversation, and follow-ups sent together are answered in order. Moving to another question, editing the question or switching model starts a new tutor. A tutor is released after 2 idle minutes or 8 rounds; a new one receives the last 3 answered exchanges. Earlier answers stay saved with the question.

</details>

### Read your sources

- Sources keep their original file and earlier versions, and open full screen.
- **Original page** shows the PDF page behind a citation, **Translate this page** adds a translation, and **Practise these pages** (shortcut P) quizzes you on the pages you are reading.
- Select a passage to ask about it, or to generate candidate questions that you review and add to an existing deck.
- A source imported as text only can get its original back with **Add the original file**, with no reimport.
- When a source changes and a linked position is no longer certain, StudyHub asks you to relocate it instead of guessing.
- Explanations, notes, **Tasks** and the **Inbox** link back to the question or source they are about. The reader and question links help you return to the current question.
- Press `?` to see every keyboard shortcut.

## Choose a model

Generation, explanations and learning help use the model selected in your DSH session. To use a different model for StudyHub, open **Settings › Library & model** and change **Generation model** from **Follow current session**. DSH stores the model credentials.

- **Everyday use:** the [official DeepSeek API](https://platform.deepseek.com/).
- **Heavy use:** a Coding Plan, but only if it gives you an API key and allows DSH and your actual study use. Before you buy, check its supported tools, endpoint, models, concurrency and quota rules.
- **Subscriptions are not keys:** Claude Pro/Max and ChatGPT/Codex subscriptions do not provide a general API key for DSH. Separately billed Anthropic or OpenAI APIs can be added as third-party providers.

Setup steps: [configure a model provider](docs/install.md#configure-a-model-provider). For how many tokens each feature uses, see [token usage and estimates](docs/token-usage.md).

## Transcribe recordings

1. Open **Settings › Audio transcription** and add a key. SiliconFlow SenseVoice supports recording transcription. Gemini (Google AI Studio) and Groq are also supported.
2. Open **Audio transcription**, click **Add audio** and then **Start import**. Nothing is uploaded until a provider is set up.
3. The transcript is saved as a source. Generate questions from it like any other source.

Only transcription uses these keys. Proofreading and translation use your DSH model by default, so their tokens are billed by your model provider and appear under **Model usage** in **Statistics**. **Live class** transcribes in real time and supports only Gemini.

<details>
<summary>More about audio</summary>

- With several keys, StudyHub tries Gemini free, then SiliconFlow, Groq and Gemini paid. A single import can be set to use paid keys only.
- M4A recordings over 1 hour can be split losslessly with one click.
- Recordings are processed one at a time; within a recording, 2–3 proofreading and translation windows run in parallel. Finished windows are checkpointed, and a retry reuses them.
- The **Proofreading & translation** panel sets the reasoning level for each step: Low, Medium, High or Model default. Higher levels take longer and do not guarantee better accuracy. A level the model does not support falls back to its default. Only high-confidence corrections that pass the source-location check rewrite the text; the rest are left as suggestions for you to check.
- The **Usage console** on the audio page records this plugin's requests to the transcription providers (failures and retries included), tokens and audio minutes. It shows free and paid keys separately, with a 7-day trend, and keeps 31 days. Groq's remaining daily quota comes from its responses; for Gemini, you can enter the daily limit shown in AI Studio to get an estimate. Requests from other apps, live-class streams and DSH model tokens are not counted there.
- Keys are stored in `study/audio.json` in your DSH home (by default `~/.dsh/study/audio.json`), outside the library. The interface shows only whether a key is set and its last 4 characters. Keys never enter library exports or chats. The environment variables `GEMINI_FREE_API_KEY`, `GEMINI_PAID_API_KEY`, `GROQ_API_KEY` and `SILICONFLOW_API_KEY` fill in a key that is not saved.

</details>

See [audio import](docs/audio-import.md) and [live class](docs/live-class.md).

## Use StudyHub from the DSH chat

- **Study mode preset.** For a new session, pick the agent preset **学习模式 · StudyHub** (Study mode; the label is in Chinese in both languages). The assistant then takes "materials", "my notes" or "this lecture" to mean your StudyHub library, asks when a request is ambiguous, and never runs commands or edits your files.
- **Ask about your library** in the main chat: see [query sources and decks from the main chat](docs/main-session-queries.md).
- **Save a question you could not answer.** Type `/study-spar <your question>` in a DSH chat. StudyHub files it in your question bank as a flashcard. Add `--mq` for single choice or `--multi` for multiple choice; start with `--pre` to file it as a prerequisite of the question you are working on.
- **Follow background tasks** in DSH's sidebar: see [background tasks and the sidebar](docs/generation-agents-sidebar.md).

## Update StudyHub

DSH plugins do not update themselves, and restarting DSH alone keeps the old version.

- **2.1.2 and later:** StudyHub asks GitHub for a new release at most every 6 hours. When there is one, a **Version x.y.z available** chip appears in its sidebar, where x.y.z is the new version. Click it, then **Upgrade to x.y.z** and **Upgrade now**. StudyHub downloads the package, checks it against the release's `SHA256SUMS-x.y.z.txt` and hands it to DSH's plugin manager. If background tasks are running, **Stop tasks and upgrade** stops them and keeps their finished parts. The check sends no study data; switch it off in **Settings › About & updates**.
- **Older versions, or a DSH that cannot install from inside the app:** finish or cancel background tasks, open **Plugins**, uninstall StudyHub, then use **Add plugin** with the new release's package address.

Then restart DSH. Quit the desktop app fully (including the tray icon) and reopen it, or restart the web service with its original profile and reload the page. A browser refresh alone does not load new plugin code. Your library and settings are kept.

## Data and privacy

**Stays on your computer**

- The library: sources and their original files, decks, answers and review schedules, saved in shards. By default it is in the DSH session's workspace folder; choose another folder in **Settings › Library & model**.
- Transcription keys and the MinerU token, in `study/` in your DSH home (by default `~/.dsh/study/`). They never enter the library, exports or backups. DSH keeps the model keys.
- The usage frequency record, if you turn it on in **Settings › Usage frequency record**. It is off by default, and StudyHub never sends it anywhere ([details](docs/usage-frequency.md)).

**Leaves your computer only when you use the feature**

- Generating questions or asking for help sends the selected source text to your model provider through DSH. **Suggest a focus** sends only titles and headings.
- Recordings go to your transcription provider. MinerU cloud conversion uploads the PDF to MinerU after you agree.
- The update check asks GitHub for the latest version and sends no study data.

**Backups and older libraries**

- In **Settings › Import, schedule and backup**, **Backup & restore** exports one JSON file with your sources, decks, review progress and answers. Original files that were copied into the library are included; originals attached by reference are only listed.
- A restore first saves the current library under `backups/`. It is refused while a generation job is running.
- An older library is migrated on its first write, and its original file is backed up. Libraries missing newer optional fields stay usable, and data from a plugin that is not installed is kept.
- To import a library from the older `study-lib-spar` tool, use the same Settings category and choose the folder that holds `study-lib.json`, `nodes/` and `quizzes/` (not the tool's source code). The import only reads those files, keeps the due dates, intervals and sources it can parse, and importing again does not overwrite existing progress.
- Clearing finished task cards keeps the sources and questions they produced. Audio usage records and keys are not part of library backups.

## Interface language

The interface starts in Chinese when your browser's first preferred language is Chinese, and in English otherwise. Switch it with **Language** at the bottom of the sidebar; StudyHub remembers your choice. Buttons, errors, background progress, notifications, messages handed to the chat and new AI explanations follow it.

Switching does not translate what you saved: sources, file names, questions, notes and provider replies stay in their original language. New questions use the interface language unless you choose another in the **Language** field of **Create deck**. To read English under a Chinese question while you practise, click **EN** on the practice toolbar ([details](docs/translate-en.md)). Audio transcripts keep their own source and translation languages.

## Choose components

The complete package installs seven components. DSH's own plugin manager lists them as **StudyHub** (the main package), **StudyHub · Core**, **StudyHub · Materials**, **StudyHub · Question bank**, **StudyHub · Question generation**, **StudyHub · Practice & review** and **StudyHub · Audio**. Turn each one on or off there. Saved data is kept while a component is off.

- **Create deck** needs Materials, Question bank and Question generation. Practice, **Mistakes & weak points**, **Mock exam** and **Statistics** need Question bank and Practice & review.
- A component that is off hides its pages or says that it is turned off.
- If several installed packages provide the same component, turn all of them off to switch it off.
- The release page also has each component as a separate package.

Details and safe source deletion: [customise components](docs/install.md#customise-components). Command-line installs: [install from the command line](docs/install.md#install-from-the-command-line).

## Development

StudyHub is an ES-module DSH plugin built on Cordis, with a React interface bundled by esbuild. Its seven components work together through public plugin APIs; see [architecture](docs/architecture.md). The package is named `@ericwang1358/dsh-daily-flashcard`; the product name is StudyHub.

```sh
npm install --legacy-peer-deps
npm run verify         # lint, tests and build
npm run test:fast      # the tests without browser, ffmpeg and program-starting files, for quick iteration
npm run dev            # preview at http://127.0.0.1:4178 (after a build)
npm run build:demo     # static demo in output/static-demo-site/dist
npm run release:pack   # release packages and SHA256SUMS-<version>.txt in output/release-<version>
```

- `npm run dev` needs `npm run build` (or `npm run verify`) first, because it serves `dist/`. It uses a throwaway library in `output/preview-library` and keeps global study files in `output/preview-home`, never in `~/.dsh`. Add `-- --library=<dir>` to open another library, and set `STUDY_FAKE_MODEL=1` for a deterministic fake model.
- `npm run release:pack` does not build; run `npm run verify` first.
- `npm test` (and so `npm run verify` and CI) always runs every test file, starting the longest first from the durations of the last run (cached in `node_modules/.cache/studyhub-tests/`). Full runs on one machine take turns through a lock file in `~/.cache/studyhub-tests/`: a second run prints one line and waits (at most 20 minutes, then it goes ahead with fewer workers); set `STUDY_TEST_NO_LOCK=1` to skip the queue. `npm test -- tests/<file>.test.mjs` runs just those files without queueing.
- `npm run test:fast` skips the files named in `tests/slow-tests.json`: those that launch a browser, run ffmpeg or start another program. `tests/slow-tests-list.test.mjs` fails when a new test file does one of these and is not listed, so the fast tier stays fast; run `npm run verify` before a pull request.
- The host supplies the DSH SDKs `@deepseek-ai/dsh-tools` and `@deepseek-ai/dsh-llm` (optional peers, `>=0.2.0-rc.2 <0.3`). Tests that need a missing SDK report an explicit skip.
- CI runs `npm ci --legacy-peer-deps` and `npm run verify` on Node 22, on Ubuntu and Windows, for every pull request.
- The [static demo](docs/static-demo.md) (in Chinese) runs the real interface with public examples and prepared replies instead of a live model.

## Documentation

- **Install:** [installation and model setup](docs/install.md)
- **Sources:** [PDF to quizzes and flashcards](docs/pdf-workflow.md) · [large textbooks](docs/large-documents.md) · [MinerU conversion](docs/mineru-conversion.md) · [JSON deck import](docs/json-import.md)
- **Science tools and media:** [display settings and local tools](docs/science-settings.md) · [images and formulas](docs/images-latex.md) · [calculation guidance](docs/calculation-guidance.md)
- **Questions:** [quality checks](docs/assessment-quality.md) · [your own reference questions](docs/reference-questions.md) · [adding questions to a deck](docs/supplementation.md) · [retiring a question](docs/slay.md) · [showing questions in English](docs/translate-en.md) · [token usage](docs/token-usage.md)
- **Studying:** [learning flows](docs/study-workflows.md) · [coaching and personalised questions](docs/coach.md) · [follow-up questions](docs/followup.md)
- **Audio:** [audio import](docs/audio-import.md) · [live class](docs/live-class.md)
- **Chat and tasks:** [main chat queries](docs/main-session-queries.md) · [background tasks and the sidebar](docs/generation-agents-sidebar.md)
- **Optional:** [usage frequency record](docs/usage-frequency.md) · [Jev decision layer (experimental)](docs/jev-experimental.md)
- **Developers:** [architecture](docs/architecture.md) · [verification records](docs/verification.md) · [SM-2 scheduling](references/sm2-scheduling.md) · [legacy study-lib-spar format](references/library-schema.md)

## Join the project

Interested in contributing code, testing, improving documentation or sharing feedback? Join the StudyHub QQ group to discuss the project. Scan the code below with QQ, or [open the full-size image](docs/assets/studyhub-qq-group.jpg).

<img src="docs/assets/studyhub-qq-group.jpg" alt="QR code for joining the StudyHub project group on QQ" width="360">

## Feedback and license

Report a bug or ask a question in [GitHub Issues](https://github.com/EricWang1358/dsh-web-studyhub/issues).

MIT License; see [LICENSE](LICENSE). The learning-quality and scheduling references are in [`references/`](references/).
