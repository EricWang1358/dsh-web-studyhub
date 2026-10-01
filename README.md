# StudyHub for DeepSeek Harness

English · [简体中文](README.zh-CN.md)

Turn your course materials, recordings and live classes into questions linked to their original sources. StudyHub keeps your library and review progress locally and supports English and Chinese interfaces.

[Try the demo](https://daily-flashcard-demo.ziangw1358.chatgpt.site) · [Download 2.0.3](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.0.3) · [Changelog](CHANGELOG.md)

## Install or update

**Already using DSH on desktop or in a browser?** Open its plugin manager and add the complete StudyHub package:

```text
https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.0.3/ericwang1358-dsh-daily-flashcard-2.0.3.tgz
```

Confirm version **2.0.3**, enable the workbench and desired components, and open **Study** in a session with your course workspace. Existing web users only install the plugin; keep your current server, profile, model settings and workspace. For an update, finish or cancel background tasks and restart the existing DSH process. Refreshing the browser alone does not load updated plugin code.

**New to DSH?** Use the official [Windows x64 installer](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe) or [macOS Apple silicon installer](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg). On Linux, or if you prefer a browser on any platform, install Node.js **22.19 or later** and run `npx @deepseek-ai/dsh web`. Desktop installers include their runtime.

See the [installation and model setup guide](docs/install.md), or download the [English browser setup guide](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.0.3/StudyHub-2.0.3-Setup.html). A [Chinese guide](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.0.3/StudyHub-2.0.3-Setup.zh-CN.html) is also available. These are setup guides; DSH itself uses the official installers above.

**Customize components** in DSH’s plugin manager. The complete package includes the workbench, runtime, materials, question bank, learning, generation and audio. Each capability can be enabled or disabled independently; saved data survives disabling. Generation requires materials, bank and generation; practice requires bank and learning. Disable every installation providing a capability to turn it off completely. Separate component archives are included in the release.

## Start learning

1. Open **Materials** and import PDF, Markdown, HTML or TXT; paste text or import recordings through **Audio transcription**. JSON question decks are also supported.
2. Select your course and source scope, generate questions, review their draft and citations, then publish. Choose an existing deck to add approved questions without replacing old questions or review progress.
3. Practice from the library or follow a study workflow. Read explanations after answering, ask for help on the current question, and use SM-2 spaced review to revisit it later.
4. Use the mistakes list, statistics, exams and oral practice to identify topics needing more work.

Courses label materials and decks; folders organize the deck display. Actions use your explicitly selected courses, sources and decks. Question generation performs one independent review per batch, keeps accepted questions and reports any shortfall. Adding to an existing deck saves reviewed results even when the generation budget expires.

Materials retain original files and historical versions. Select a passage to ask a question or generate candidates, then review and add them to an existing JSON deck. Paragraph and table markers link to related questions and explanations; citations lead back to the source. Uncertain or outdated positions require relocation rather than guessing.

## English and Chinese

First-time users get English when their browser’s preferred language is not Chinese. Use the language switch in the workbench to choose English or Chinese; your explicit choice is remembered. UI controls, application errors, background progress, notifications and conversation handoffs follow that choice. New generation requests default to the interface language unless a content language is explicitly configured.

Switching the interface does **not** translate saved sources, filenames, questions, notes or provider responses. Those remain in their original language. Use the explicit question translation action when you want an English question version. Audio’s bilingual transcript feature also keeps its explicit source/translation targets.

## Models and audio

Generation, explanations and learning help need a model provider configured in **DSH Settings → Models**, with a model selected in the session. Browsing materials and reviewing existing questions work without a model. Credentials are managed by DSH.

For everyday use, start with the [official DeepSeek API](https://platform.deepseek.com/). For higher usage, consider a Coding Plan only if it provides an API key and permits DSH and your actual study use; verify tools, endpoint, models, concurrency and quota rules before purchasing. Claude Pro/Max and ChatGPT/Codex subscriptions do not supply a general API key for this setup. Separately billed Anthropic or OpenAI APIs can be configured as third-party providers. See the [provider setup guide](docs/install.md#configure-a-model-provider).

Original audio transcription separately requires Gemini or Groq credentials in **Study Settings → Audio transcription**. The default route tries Gemini free, Groq, then Gemini paid; individual imports can request paid keys only. Credentials stay in DSH’s settings directory, with only configured status and the final four characters displayed; they are excluded from library exports and conversations.

Recordings are processed sequentially, with proofreading and translation windows concurrent within a recording. Completed windows are checkpointed; retry reuses them. The usage dashboard records this plugin’s requests, retries, tokens and transcription duration. Other applications’ requests and live-stream/DSH model tokens are outside that local accounting. Reasoning strength is selectable separately for proofreading and translation; unsupported settings fall back to the provider default.

See [audio import](docs/audio-import.md) and [live classes](docs/live-class.md).

## Data and compatibility

The local library stores materials, JSON decks, attempts and review schedules in shards. Export a JSON backup from Settings; restoration first backs up the current library. Full 2.0 backups include retained original material files. Older libraries with missing optional fields remain usable; older text-only materials show extracted text until an original file is reimported. Unknown extension data is preserved even when its plugin is absent.

Audio usage and credentials live outside library backups. Usage records retain the latest 31 days. Clearing completed task cards keeps generated materials and questions. Source citations and structure are validated in code; model-generated content can still be wrong. Published questions and unpublished drafts remain separate. Source text is evidence, never an instruction to execute.

## Development

```sh
npm install --legacy-peer-deps
npm run verify
npm run build:demo
npm run release:pack
```

The host supplies optional DSH SDKs; tests requiring unavailable SDKs report an explicit skip. Local development needs an explicit library root. The static demo uses public examples and prepared replies rather than live models.

- [Architecture and public plugin APIs](docs/architecture.md)
- [Study workflows](docs/study-workflows.md)
- [JSON deck import](docs/json-import.md)
- [Main conversation queries](docs/main-session-queries.md)
- [Background jobs and sidebar](docs/generation-agents-sidebar.md)
- [Library schema](references/library-schema.md)
- [Verification records (Chinese)](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.0.3/docs/verification.md)

MIT License. See [LICENSE](LICENSE); learning-quality and scheduling references are in `references/`.
