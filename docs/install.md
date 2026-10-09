# Install StudyHub and set up a model

English · [简体中文](install.zh-CN.md)

StudyHub is a study plugin for DeepSeek Harness (DSH). DSH runs as a desktop app or as a web page in your browser. You install DSH, add StudyHub through DSH's plugin manager, then connect a model for question generation. For a one-page version to open in your browser, download the [English setup guide](https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.3.0/StudyHub-3.3.0-Setup.html).

| Your situation | Start here |
| --- | --- |
| No DSH yet | [Install DSH](#install-dsh), then [install StudyHub in DSH](#install-studyhub-in-dsh) |
| DSH desktop or web is already running | [Install StudyHub in DSH](#install-studyhub-in-dsh). Your models, workspace and profile stay as they are |
| An older StudyHub is installed | [Update StudyHub](#update-studyhub) |

**What you need**

- **DSH 0.2.** StudyHub 3.3.0 declares DSH `>=0.2.0-rc.2 <0.3`. DSH and StudyHub have separate version numbers.
- **A supported computer.** The desktop installers in this guide are for Windows x64 and Macs with Apple silicon. On any other system, check the official DSH site or use the DSH web version with Node.js 22.19 or later.
- **A model, only for AI features.** Generation and explanations need one; see [Configure a model provider](#configure-a-model-provider). Installing, the sample tour, browsing sources and practising existing decks do not.

## Install DSH

Skip this section if DSH already runs on your computer or server.

| Platform | Route |
| --- | --- |
| Windows x64 | [Download the .exe installer](https://download.deepseek.com/desktop/dsh-latest-windows-x64.exe), run it and open DeepSeek Harness. |
| macOS, Apple silicon | [Download the .dmg installer](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg), copy DSH into **Applications** as prompted and open it. |
| Linux, or browser only on any system | Install Node.js 22.19 or later, then start the web version below. |

The desktop installers come from the [official DSH site](https://www.deepseek.com/en/harness/) and include their own runtime, so they need no Node.js. This guide links only these two verified installers. For an Intel Mac or Windows on ARM, check the official site for current support, or use the web version.

To start the web version, run this in a terminal:

```sh
npx @deepseek-ai/dsh web
```

DSH opens at `http://127.0.0.1:3080` by default. Keep the process running while you use DSH. If you already run DSH web, skip this step. The [official run instructions](https://github.com/deepseek-ai/deepseek-harness/blob/master/README.md#run) have the details.

## Install StudyHub in DSH

These steps work in desktop and web DSH. Web users need no desktop client and no new profile.

1. In DSH, open **Plugins › Add plugin**.
2. Paste the complete package address:

   ```text
   https://github.com/EricWang1358/dsh-web-studyhub/releases/download/v3.3.0/ericwang1358-dsh-daily-flashcard-3.3.0.tgz
   ```

3. After it installs, check that the package is `@ericwang1358/dsh-daily-flashcard`, version 3.3.0.
4. Click **Enable** for StudyHub and the components you want. If DSH asks to reload, finish or cancel background tasks first.
5. StudyHub opens by itself the first time. Later, open **StudyHub** from DSH's left sidebar; you do not need to send a chat message first. StudyHub is also a tab in each session and in DSH's right sidebar.

On an empty library, the welcome page leads with **Add source**. To look around first, click **Load the sample and start the tour**. It loads a sample course (one lecture handout, nine cited questions and three weeks of practice history) and starts a short tour (8 steps, a minute or two). Neither needs a model, and **Remove sample data** clears the sample whenever you like.

StudyHub keeps your library in the workspace folder of the current DSH session. If it shows **Open a session first**, start or open a session in DSH.

### If DSH cannot download from GitHub

1. Download `ericwang1358-dsh-daily-flashcard-3.3.0.tgz` from the [3.3.0 release page](https://github.com/EricWang1358/dsh-web-studyhub/releases/tag/v3.3.0). The same page lists the checksums in `SHA256SUMS-3.3.0.txt`.
2. In **Add plugin**, enter the absolute path of that file instead of the address.

The file must be on the **computer or server that runs DSH**. With a remote DSH web server, a download path on your laptop does not exist on the server. Copy the file to the server, or use the HTTPS address above.

## Configure a model provider

Question generation, explanations, **Help me understand**, proofreading and translation call a model. Installing, the sample tour, browsing sources and practising existing decks do not. DSH stores the model keys, and StudyHub uses the models you configure there. Model use is billed by your provider.

### Start with the official DeepSeek API

1. Create an API key on the [DeepSeek platform](https://platform.deepseek.com/) and check that the account can call models. Check the provider’s current region and account requirements.
2. In DSH, open **Settings › Models**, enter the key on the DeepSeek card and save it.
3. Choose a model in your session's model picker.

The built-in DeepSeek card needs no endpoint. For a custom integration, use `https://api.deepseek.com` and a supported model ID from the [DeepSeek API documentation](https://api-docs.deepseek.com/).

By default StudyHub generates with the model selected in the chat input (**Follow current session**). To use a different configured model for questions and explanations only, open StudyHub **Settings › Library & model** and choose a **Generation model**. The chat model stays unchanged.

StudyHub has no key field: the key is stored only in DSH. To see whether a model is ready, open StudyHub **Settings › Library & model**. The top of the page shows **Model connected: the model name**, or **Model not connected** with the reason and the steps above. **Model connected** means DSH has a key for that model; whether the key is valid only shows when it is used. After you save the key in DSH, the status updates by itself, and **Check again** reads it at once. Wherever a step needs a model, StudyHub says so first, with a **Go to settings** link, instead of letting the step fail.

### For heavier use, check a Coding Plan first

A Coding Plan can suit heavy use, but only if it gives you an API key and its terms allow DSH and your study use. Before you buy, check:

- which tools and uses the plan permits;
- its dedicated base URL and model IDs;
- its concurrency limits and when the quota resets.

A key alone does not make a plan usable from any application. Some plans allow only named coding tools; the [GLM Coding Plan FAQ](https://docs.bigmodel.cn/cn/coding-plan/faq) (in Chinese) is one example. StudyHub does not promise that any particular plan permits study use, batch generation or audio proofreading.

To add a permitted plan or another provider:

1. In DSH **Settings › Models**, choose **Add model provider**.
2. Pick a provider DSH already lists, enter its key and save. For any other endpoint, choose **Custom model API** and enter the provider's base URL, API protocol, key and model ID.
3. Choose the protocol the endpoint actually supports.

A plan's dedicated endpoint and its ordinary API may draw on different quotas. DSH's [model configuration guide](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/guide/providers.md) covers the fields.

### Claude and ChatGPT subscriptions are not API keys

DSH's model settings do not accept OAuth subscriptions such as Codex. A Claude Pro/Max or ChatGPT/Codex subscription is not a general API key you can paste into DSH. You can add the separately paid Anthropic or OpenAI API as a third-party provider; it is billed separately from the subscription. See [Claude's explanation of subscription and API billing](https://support.claude.com/en/articles/9876003-i-have-a-paid-claude-subscription-pro-max-team-or-enterprise-plans-why-do-i-have-to-pay-separately-to-use-the-claude-api-and-console) and [OpenAI's explanation of separate API billing](https://help.openai.com/en/articles/9039756-managing-billing-for-chatgpt-and-the-api-platform).

### Set up transcription for recordings

Turning recordings into text needs a transcription provider of its own. Add its key in StudyHub **Settings › Audio transcription**:

- **SiliconFlow SenseVoice** supports recording transcription.
- **Gemini** and **Groq** are also supported. Availability, allowances and pricing depend on each provider’s current terms.

Real-time transcription in **Live class** works only with Gemini. After transcription, proofreading and translation use your DSH session model by default, billed by your provider. See [Audio import](audio-import.md) and [Live class](live-class.md).

### Keep keys out of your study files

- Save model keys only in DSH **Settings › Models**.
- Save transcription keys only in StudyHub **Settings › Audio transcription**. StudyHub stores them outside the library, so they never appear in exports or backups.
- Never paste a key into a chat, a source, a deck or a setup guide. This guide collects no keys.

## Choose English or Chinese

- On first use, StudyHub follows your browser: Chinese if its preferred language is Chinese, English otherwise.
- Switch with **Language** at the bottom of StudyHub's sidebar. This browser remembers your choice.
- Switching does not translate saved sources, questions, notes or file names. New explanations and feedback follow the interface language.
- For a new deck, set the question language in the **Language** field of **Create deck**. To show English under a Chinese question while you practise, use the **EN** button on the practice toolbar ([details](translate-en.md)).

## Update StudyHub

DSH plugins do not update themselves, and restarting DSH alone keeps the installed version. Your library and settings stay through every update.

### Upgrade in one click (2.1.2 and later)

Automatic update checks normally use a 6-hour cache and retry sooner after a failure. **Check for updates** queries immediately, even within that window or with automatic checks off. Checks send no study data and do not install anything. If GitHub's API is rate limited (anonymous requests are capped at 60 an hour per network address, which people sharing one outgoing address can exhaust) or unreachable, StudyHub asks the plain GitHub release page for the newest version instead; that answer carries no release notes, so use the release page link. Only when both routes fail does the page report the failure, and a rate limit is reported as a rate limit with the time it should recover, not as a network problem. When a release is newer than the installed version, a **Version x.y.z available** chip appears in StudyHub's sidebar, where x.y.z is the new version.

**Settings › About & updates** separates the current running version, the installed version and the latest known release. For example, 2.5.8 can still be running while 2.5.10 is installed and waiting for a restart. If 3.3.0 becomes available, you can install it directly and then restart once; the pending restart does not hide that upgrade. The same or an older release is not installed again. A failed check keeps the last known release and shows a separate connection notice.

1. Click the chip, then **Upgrade to x.y.z** and **Upgrade now**.
2. If background tasks are running, StudyHub says how many. **Stop tasks and upgrade** stops them and keeps the parts already finished. You can also wait until they are done.
3. StudyHub downloads the package from the GitHub release, checks its SHA-256 against `SHA256SUMS-x.y.z.txt` and hands it to DSH's plugin manager. You can keep studying until you restart.
4. Restart DSH:
   - **Desktop:** quit DSH fully, including the tray icon, and open it again.
   - **Web:** stop the DSH service, start it again the way you usually do (same profile), then reload the page.

Reloading the browser alone does not load new plugin code.

**Remind me later** hides the chip for that version. You can still upgrade from **Settings › About & updates**, where **Check for updates** checks at once and **Check for updates automatically** turns the 6-hour check off. If GitHub cannot be reached, StudyHub tries again later.

### Upgrade manually

Use these steps before 2.1.2, when DSH cannot install plugins from inside the app, or after a failed upgrade (the dialog then offers **Upgrade manually instead**). Finish or cancel background tasks first.

1. Copy the new release's package address from the upgrade dialog or the release page.
2. Open DSH's **Plugins** page, find StudyHub and click **Uninstall**.
3. On the same page, click **Add plugin**, paste the address and click **Enable** once it installs.
4. Restart DSH as described above.

If you installed the search extension, **Settings › About & updates** also tells you when it needs updating and offers **Update the search extension**. Restart DSH after that update too.

## Customise components

The complete package installs seven components. Turn them on or off in **DSH's own plugin manager**; StudyHub has no separate component manager.

| Component in DSH's plugin manager | Provides |
| --- | --- |
| StudyHub | The main package: the StudyHub page and the features every page shares |
| StudyHub · Core | The library runtime that every component shares |
| StudyHub · Materials | **Sources**: PDFs, notes and web pages imported as citable sources |
| StudyHub · Question bank | Decks and questions, with their edit history |
| StudyHub · Question generation | Cited, reviewed questions generated from your sources |
| StudyHub · Practice & review | Spaced review, mock exams and **Mistakes & weak points** |
| StudyHub · Audio | **Audio transcription** and **Live class** |

- **Create deck** needs Materials, Question bank and Question generation.
- Practice, **Mistakes & weak points**, **Mock exam** and **Statistics** need Question bank and Practice & review.
- When a page's components are off, StudyHub hides the page or says the feature is off. Saved sources, decks and progress stay and come back when you turn the component on again.
- Finish related background tasks before you turn a component off.
- Turn on Question bank and Practice & review before you delete a source, so StudyHub can check the saved questions, drafts and study records that cite it.
- If more than one installed package provides a component, turn it off in all of them. An old complete package still provides everything, so update it before you customise.

The release page also has each component as a standalone package. Add one through the same plugin manager.

### Install from the command line

If you manage a DSH web profile from a terminal, keep its profile name. `dsh web` uses the profile `web`:

```sh
dsh plugin --profile web add <package-URL-or-absolute-path>
```

Replace `web` with your own profile name if you use a custom one. For desktop DSH, use the plugin manager. A command-line install works only after desktop DSH is fully quit, including the tray icon.

Use the linked official documentation for current download routes, model availability and account requirements.
