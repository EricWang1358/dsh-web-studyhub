# StudyHub for DeepSeek Harness

English · [简体中文](README.zh-CN.md)

Turn your course materials, recordings and live classes into questions linked to their original sources. StudyHub keeps your library and review progress locally and supports English and Chinese interfaces.

[Try the demo](https://daily-flashcard-demo.ziangw1358.chatgpt.site) · [Download 2.1.0](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v2.1.0) · [Changelog](CHANGELOG.md)

## Quick start

| You want to | You need | Cost |
| --- | --- | --- |
| Take the sample course and feature tour, browse sources, practise existing questions | The plugin only | Free, no model calls |
| Generate questions from your sources, explanations, "Help me understand" | One AI model key (DSH **Settings → Models**) | Billed by your model provider, e.g. the [DeepSeek API](https://platform.deepseek.com/) |
| Turn recordings into text | One transcription key (StudyHub **Settings → Audio transcription**) | SiliconFlow SenseVoice is free and reachable from mainland China; Gemini and Groq have free tiers but need an overseas network there |

1. **Install DSH** (skip if you have it): use the official Windows / macOS installers below, or install Node.js 22.19+ and run `npx @deepseek-ai/dsh web`.
2. **Install StudyHub**: in DSH open **Plugins → Add plugin**, paste the package address from *Install or update* below, then click DSH's enable button. StudyHub opens by itself; afterwards use **StudyHub** in DSH's left sidebar — no chat message needed.
3. **Take the tour (optional, about 3 minutes)**: on the welcome page choose **Load the sample and start the tour**. The 17-step tour switches between sources, generation, practice, mistakes, exams and statistics and points at the real controls. The sample makes no model calls and can be removed with one click.
4. **Add an AI model**: paste a key in DSH **Settings → Models**. Until then StudyHub tells you right where a model is needed instead of letting a request fail later.
5. **Start with your own material**: click **Add source**, drop several PDFs, slides or notes at once (each PDF is kept as one document), then **Generate from sources** → review the draft → publish → practise.

Want the chat assistant to use only what you stored in StudyHub? Pick the **学习模式 · StudyHub** agent preset for a new session: it treats "materials", "my notes" or "this lecture" as your StudyHub library, asks when a request is ambiguous, and never runs commands or edits your files.

## Install or update

**Already using DSH on desktop or in a browser?** Open its plugin manager and add the complete StudyHub package:

```text
https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.1.0/ericwang1358-dsh-daily-flashcard-2.1.0.tgz
```

Confirm version **2.1.0** and enable it. StudyHub opens by itself; afterwards use **StudyHub** in DSH’s left sidebar (the session tab and right sidebar also work). Existing web users only install the plugin; keep your current server, profile, model settings and workspace.

**Updating.** DSH plugins do not update themselves, and restarting DSH alone keeps the installed version. From 2.1.1, StudyHub asks GitHub for a newer release (at most every 12 hours; switch it off in **Settings › About & updates**) and shows a chip in its sidebar. **Upgrade** downloads the release package, checks its SHA-256 against the release's `SHA256SUMS` file and installs it through DSH's plugin manager. On older versions, or a host without in-app installs, open **Plugins**, uninstall StudyHub, then **Add plugin** with the new release's package address. Either way, finish or cancel background tasks first and restart DSH afterwards: quit desktop DSH fully and reopen it, or restart your web service with its original profile. A browser refresh alone does not load new plugin code. Your library and settings are kept.

**New to DSH?** Use the official [Windows x64 installer](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe) or [macOS Apple silicon installer](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg). On Linux, or if you prefer a browser on any platform, install Node.js **22.19 or later** and run `npx @deepseek-ai/dsh web`. Desktop installers include their runtime.

See the [installation and model setup guide](docs/install.md), or download the [English browser setup guide](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.1.0/StudyHub-2.1.0-Setup.html). A [Chinese guide](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v2.1.0/StudyHub-2.1.0-Setup.zh-CN.html) is also available. These are setup guides; DSH itself uses the official installers above.

**Customize components** in DSH’s plugin manager. The complete package includes the workbench, runtime, materials, question bank, learning, generation and audio. Each capability can be enabled or disabled independently; saved data survives disabling. Generation requires materials, bank and generation; practice requires bank and learning. Disable every installation providing a capability to turn it off completely. Separate component archives are included in the release.

## Start learning

1. Click **Add source**, choose the course first, then drop several PDF, Markdown, HTML, TXT, JSON-deck or subtitle files at once, or paste text; recordings use the **Audio / recording** tab of the same window. Each PDF is kept as one document you can expand to pages.
2. In **Create deck**, choose sources by document, generate questions, review their draft and citations, then publish. If you already have questions (or ones generated elsewhere), import a JSON deck from the second tab. Choose an existing deck to add approved questions without replacing old questions or review progress.
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

Original audio transcription needs a transcription provider in **Study Settings → Audio transcription**. SiliconFlow SenseVoice is free and reachable from mainland China; Gemini and Groq are also supported. With several keys the route tries Gemini free, SiliconFlow, Groq, then Gemini paid; individual imports can request paid keys only. Until a provider is set, the import page asks you to configure one before any upload starts. M4A recordings over an hour can be split losslessly with one click. Credentials stay in DSH’s settings directory, with only configured status and the final four characters displayed; they are excluded from library exports and conversations.

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
- [Verification records (Chinese)](https://github.com/EricWang1358/dsh-web-studyhub/blob/v2.1.0/docs/verification.md)

MIT License. See [LICENSE](LICENSE); learning-quality and scheduling references are in `references/`.
