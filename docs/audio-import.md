# Audio import: recordings to bilingual transcripts

[中文](audio-import.zh-CN.md)

Turn a lecture recording into an English–Chinese transcript that you can read, search and cite in **Sources**. StudyHub transcribes the audio, proofreads misrecognised terms, translates the text paragraph by paragraph and saves the result as a source. It does not write questions: when you want some, use **Create deck** as usual.

## What you need

- **One transcription provider key.** Any one of these is enough:

  | Provider | Cost and network | Used for | Per request or file |
  | --- | --- | --- | --- |
  | SiliconFlow SenseVoice | See current provider terms | Transcription only | 50 MB and 1 hour; larger audio is cut into pieces |
  | Groq | See current provider terms | Transcription (Whisper); also proofreading and translation when those run on Gemini | 25 MB; larger audio is cut into pieces |
  | Google Gemini (AI Studio), free key | See current provider terms | Transcription, proofreading and translation; the only provider for **Live class** | 1 hour; longer recordings are split |
  | Google Gemini, paid key (optional) | Billed by your provider | Last in line, or the only one used with **Use the paid key only** | 1 hour |

- **A model for proofreading and translation.** By default this is your DSH session's model. SiliconFlow cannot do these steps, so with only a SiliconFlow key you need a conversation model, or a Gemini or Groq key as well.
- **ffmpeg (optional).** SiliconFlow and Groq need it only for OGG, Opus, FLAC, WebM, AAC and AIFF files that must be cut or converted. MP3, WAV and plain M4A files never need it. See [Cutting audio for SiliconFlow and Groq](#cutting-audio-for-siliconflow-and-groq).

## Set up transcription

1. Open **Settings › Audio transcription**. Each provider has a card with three steps and links to the provider. The card marked **Recommended** comes first: SiliconFlow SenseVoice in the Chinese interface, Groq in the English one.
2. Follow the card's steps to create a key, then copy it.

   | Provider | Where to create a key |
   | --- | --- |
   | SiliconFlow SenseVoice | Sign up with a phone number at [cloud.siliconflow.cn](https://cloud.siliconflow.cn), then open the [API keys page](https://cloud.siliconflow.cn/account/ak) |
   | Groq | [Groq console › API Keys](https://console.groq.com/keys) |
   | Google Gemini | [AI Studio › Get API key](https://aistudio.google.com/apikey); keep billing off for that project |

3. Paste the key into the card and click **Save and verify**. "Works: the key is valid and the service is reachable" means you are done. The check only asks the provider for its model list; it never sends audio.

Later, **Verify** checks a saved key again and **Clear the saved key** removes it. A card shows only "Saved" and the key's last four characters.

Until a provider is set up, the **Audio transcription** page shows the recommended card's steps and key field in place of the drop area ("Transcription is not set up yet · about 2 minutes"). No file is uploaded before then. Subtitle files can still be imported there, because they skip transcription.

**Gemini free and paid keys.** The free key must come from a Google Cloud project without billing: enabling billing on a project removes its free tier. The optional paid key goes under **Settings › Audio transcription › Advanced › Gemini paid key (optional)**. It must come from a separate project with billing enabled and funded.

**Where keys are kept.** Keys are written only to `study/audio.json` in the DSH user directory (`~/.dsh`, or `DSH_HOME` when set). This is a plain, unencrypted file. Keys never enter the library, backups, panel snapshots, task records or the conversation. The environment variables `GEMINI_FREE_API_KEY`, `GEMINI_PAID_API_KEY`, `GROQ_API_KEY` and `SILICONFLOW_API_KEY` fill in any key the file lacks. Never paste a key into chat.

## Import a recording

1. Open **Audio transcription** in the sidebar. The **Audio / recording** tab of **Add source** on the **Sources** page opens the same form.
2. Choose one or more files. You never need to type a path:
   - drop them on the drop area, or click it to choose;
   - open **Find in the workspace**, search by file name and pick one;
   - click **Pick a file with @ in the conversation**. It fills the chat input without sending it; pick the files with DSH's @ selector, then send. If the selector does not open, type @ again;
   - open **Paste a file path (advanced)** and enter an absolute path, quoted or not.
3. Wait for the check under each file (see [Pre-flight check](#pre-flight-check)). It reads the file locally and sends nothing.
4. Optionally fill in **Transcript name**, **What the audio is about**, **Glossary** (commas or new lines) and **Course**. The course's deck titles and question topics join your glossary to help transcription and proofreading.
5. Tick **Use the paid key only** for a recording that must not go to a free plan (see [Privacy](#privacy)).
6. Click **Start import**. You can keep working. The transcript appears under **Today** on the **Sources** page when it is done.

Above **Start import**, an estimate shows the tokens that proofreading and translation are likely to use. See [Token usage and estimates](token-usage.md).

### Supported files and limits

- **Formats:** MP3, WAV, M4A, AAC, OGG, FLAC, OPUS, WEBM and AIFF (`.aif` too).
- **Size:** up to 512 MB per file.
- **Length:** up to 8 hours, for formats whose length can be read (MP3, WAV, M4A). The provider checks the length of other formats.
- **Detected by content:** the format is read from the bytes, not the extension. A WAV named `.mp3` is processed as WAV, with a warning.
- **Refused:** an MP3 in which less than half of the bytes are recognisable audio. A compressed (non-PCM) WAV over 1 hour, or an M4A over 1 hour that cannot be split locally (for example a fragmented MP4), is refused with a request to save it as MP3 first.

### Pre-flight check

Each file is checked as soon as it is added, and again when you click **Start import**. Nothing is sent to a provider until every file passes.

| Note under the file | What it means | What to do |
| --- | --- | --- |
| "about N min · M transcription request(s)" | Ready | Nothing |
| "about N min, over the one-hour limit per request → split losslessly into K parts (M requests)" | The recording needs more than one request | Click **Split and continue** to accept the extra requests |
| An error message | The file cannot be imported | Click **Skip this file and continue** (several files) or **Choose another file** |
| "Waiting for …" or "Not started: waiting for …" | Another file needs your answer first | Answer that file |

When SiliconFlow or Groq is first in line, the request count includes the pieces their file limits require.

### Several files as one transcript

Choose more than one file and they become one transcript, in the listed order. Drag them, or use the arrow buttons, to reorder. The files are processed one after another. The finished source has a heading for each file (`## 1. lecture-a.mp3`). Its default name is the first file name plus the number of other files.

If a file fails its check when the run starts, the others wait instead of being cancelled. The card then offers **Skip this file and continue** and **Continue after fixing**. A file whose content repeats an earlier one is not sent to a provider again: it reuses that file's saved work.

### Subtitle files

Timestamped subtitles downloaded from Bilibili or similar sites (SRT, VTT, JSON or TXT, up to 8 MB) skip transcription. They go straight to proofreading and translation, and each paragraph keeps its start time. Import one subtitle file at a time, without audio files. No transcription provider is needed, only a model for the text steps.


Preflight checks whether the recording can be split using the current **Longest per request** setting under **Settings › Audio transcription › Advanced › Expert options** (5–59 minutes). The notice reports the actual selected limit.
## Follow progress

Task cards appear on the **Audio transcription** page and at the top of **Sources**. A card shows:

- the current step and segment, the recording length ("recording length 47 min") and the time spent so far ("3 min 10 sec so far"). These are different numbers;
- an overall progress bar. Transcription counts for 25%, proofreading for 30% and translation for 45%; within a step, it counts finished segments. The weights are estimates;
- "Left in this step: about N min", once a segment has finished and its real pace is known;
- a moving section on the bar during one long request, with a note that it is not stuck: nobody can tell how far a single request has got;
- **N tasks running**, each with its runtime and waiting time, and **View task history** with each finished request's status, duration and reasoning level;
- **View subagent**, when a proofreading or translation request ran as a DSH subagent;
- warnings, for example when a provider was switched or an option was dropped.

Click **Stop (finished transcription is kept)** at any time.

The **Inbox** follows the actual order of work:

1. **Recording transcribed**
2. **Recording proofread**, or **Recording partially proofread** when some windows kept their original text
3. **Recording translated**
4. **Recording ready** once everything is saved, or **Recording processing incomplete**

A step that a resumed run found already saved is not announced again. A multi-file import sends only the final notice. Opening a notice shows the saved transcript, or the **Audio transcription** page if nothing is saved yet. Notices are kept in the library.

## Check the transcript

Open it with **Open transcript** on the card, or from **Sources**. The original speech always comes first. Section labels follow the interface language when the import ran. In the English interface a transcript looks like this:

```
================================================================================
Full Bilingual Transcript: lecture.mp3
<English title>
================================================================================

[Part 1: <English title of the part>]

[English original]
<proofread English paragraphs, separated by blank lines>

[Chinese translation]
<matching Chinese paragraphs>

--------------------------------------------------------------------------------

[Part 2: …]
```

- **Chinese interface:** the header reads 《lecture.mp3》全量中英对照逐字稿, each part has a Chinese and an English title, and the labels are 【英文原句】 and 【中文对照】.
- **Chinese recording:** when most of the text is Chinese, it is translated into English. The labels become `[Chinese original]` and `[English translation]` (【中文原文】 and 【英文对照】 in the Chinese interface).
- **Long transcripts:** above about 400,000 characters, the transcript is saved as several sources, split between parts. Part numbering continues across them.

**Proofreading results.** The source view has a fold, "N correction(s) · M doubtful spot(s) left unchanged". It lists every applied change with its reason and context, then the doubtful ones that were left alone. Click **Review these N passages with the model** to have the text model judge them again, with their paragraph and translation:

- confirmed ones update the transcript, and the same spot in the translation, in every volume;
- ones it finds already correct leave the list;
- ones it still cannot decide stay listed.

Each passage is reviewed only once. Speaker labels and word-level timestamps are not provided.

## Stop, continue and import again

Transcription segments, proofreading windows, translation parts and the title are each saved as soon as they finish.

- **Continue.** After a failure, a stop or a DSH restart, the card returns with **Continue (nothing is paid for twice)**. It finishes the original submission from the saved work, with the current settings. You do not choose the file again, and the card shows what is saved ("Saved: Transcription 3/3 · Proofreading 2/5").
- **Uploaded files** are kept until the import succeeds or you click **Got it**. A file taken from the workspace or a path is read in place, not copied. It must still exist unchanged; otherwise import it again as a new recording, so old progress is never attached to a different one.
- **Proofreading errors.** A window that fails keeps its original text and the run goes on. If two windows in a row fail with the same error, the job stops so that quota is not wasted on every window.
- **Notices.** **Continue** removes the old **Recording processing incomplete** notice; a new failure brings a new one.
- **Old failed imports.** Imports from versions that did not save the job show **Select the original recording to continue**. Choose the same file (same name) and check the course and glossary: the old options were not saved, so there is no one-click resume. Matching saved work is still reused. The old notice goes away once the new import starts.

**What is redone when you import again:**

| What changed | What is redone |
| --- | --- |
| Nothing: same content and settings, even under another file name | Nothing. The existing source is reused. A second copy started at the same time waits for the first. |
| Glossary, description, course, reasoning levels, or the model for proofreading and translation | Proofreading, translation and title. Transcription is reused. The result is saved as a new source next to the old one. |
| Only the transcription model, **Transcript style**, or **Longest per request** when it moves the cut points | Nothing while the earlier transcript is still in **Sources**: it is reused. Once that source is removed, or when a setting in the row above changed too, transcription is redone as well |

Finished transcripts are never rewritten automatically. Remove versions you no longer need in **Sources**.

## Provider order and fallback

Transcription tries the providers that have a key, in this order:

1. Gemini free key
2. SiliconFlow SenseVoice
3. Groq
4. Gemini paid key

Proofreading, translation and titles use the DSH conversation model by default (see [Which model proofreads and translates](#which-model-proofreads-and-translates)). When they run on Gemini instead, they try Gemini free → Groq → Gemini paid. SiliconFlow is never used for text.

How a request moves on:

| What happens | What StudyHub does |
| --- | --- |
| Per-minute rate limit | Waits as long as the provider asks (20 seconds if it does not say), at most twice and at most 65 seconds each, then moves to the next provider |
| Daily quota used up | Moves on. While this recording is processed, the Gemini free key is then skipped for 6 hours, and SiliconFlow or Groq for the delay they report (1 minute to 6 hours) |
| Key rejected (401 or 403), invalid Gemini key, or unsupported region | Skips that provider for the rest of this recording and moves on; the card gives the reason |
| SiliconFlow or Groq cannot take this audio (too large without ffmpeg, unknown model, rejected parameter) | Moves on |
| Timeout | Retries once, since each attempt may use quota. Then moves on if either this provider or the next one is SiliconFlow or Groq; otherwise the step fails |
| Server or network error | Retries twice, after 1.5 and 5 seconds, then behaves as for a timeout |
| Paid balance used up (HTTP 402) | Stops and asks you to add credit. It never falls back to a free provider |
| The last provider fails | The step fails. Saved work is kept for **Continue** |

### Privacy

- Review [Google’s current Gemini terms](https://ai.google.dev/gemini-api/terms) for your account tier, region and data use before uploading recordings.
- Groq and SiliconFlow have their own data policies.
- **Use the paid key only** skips the Gemini free key, SiliconFlow and Groq for that import.
- Check the providers' current terms before sending sensitive recordings.

### SiliconFlow SenseVoice

- The model is `FunAudioLLM/SenseVoiceSmall`; check SiliconFlow’s current availability and billing for your account.
- It only transcribes. It takes no glossary, style or language option and returns plain text, so proofreading matters more. A warning on the card says when it transcribed a segment.
- A file may be at most 50 MB and 1 hour long. Larger audio is cut into pieces (see below); pieces cut with ffmpeg are about 22 minutes each.

### Groq

- The defaults are `whisper-large-v3` for transcription and `openai/gpt-oss-120b` for text. Both can be changed under **Expert options**. Groq works on its own, without any Gemini key.
- Whisper has no cleaned-up style and no custom vocabulary. The glossary is sent as a prompt of at most 300 characters, cut at a term boundary, so proofreading matters more.
- Groq's free plan, as published on 2026-09-29 (may change):
  - Whisper: 20 requests per minute, 2,000 per day, 7,200 audio seconds per hour and 28,800 per day (about 8 hours of audio);
  - `gpt-oss-120b`: 30 requests per minute, 1,000 per day, 8,000 tokens per minute and 200,000 per day. Proofreading and translating a one-hour lecture can take tens of thousands of tokens.
- Check the Groq console and the response headers for the current limits.

### Cutting audio for SiliconFlow and Groq

Gemini takes up to an hour per request. SiliconFlow takes 50 MB per file and Groq 25 MB, so larger audio is cut into pieces and their text is joined:

- **WAV:** converted to 16 kHz mono first (about 115 MB per hour), then cut at speech pauses.
- **MP3:** cut at frame boundaries, without re-encoding.
- **M4A:** sent whole when under the limit. Otherwise it is cut with ffmpeg when ffmpeg is installed, or else remuxed into smaller M4A files without re-encoding. An M4A that cannot be remuxed this way needs ffmpeg.
- **OGG, Opus, FLAC, WebM:** sent whole when under the limit, otherwise cut with ffmpeg.
- **AAC, AIFF:** neither provider reads them as they are, so they always need ffmpeg.

With ffmpeg, the recording is decoded once to find the quietest points. Then each piece is made only when it is sent, as 16 kHz mono 16-bit FLAC (about 11 minutes per piece for Groq). Temporary files are deleted afterwards; ones left by a crash are removed by a later cut once they are a day old. StudyHub uses `FFMPEG_PATH` if it is set, otherwise `ffmpeg` on PATH. Without ffmpeg, such audio moves to the next provider with a message saying ffmpeg is missing.

After a rate-limit wait, sending resumes at the first unfinished piece.

## How a recording is processed

1. **Read and split.** Free quotas count requests, so a recording goes in as few requests as possible. A recording no longer than **Longest per request** (default 59 minutes) is sent whole. Longer MP3, WAV and M4A recordings are split into the fewest equal parts, without re-encoding or ffmpeg:
   - MP3 at frame boundaries;
   - M4A remuxed losslessly;
   - 16-bit PCM WAV with each cut moved to the quietest 200 ms within 30 seconds, so sentences are not cut in half.

   Other formats are sent whole.
2. **Transcribe.** On Gemini (`gemini-3.5-transcribe`):
   - The default **Transcript style** is **Cleaned up**, without filler or repeats and split into paragraphs. **Verbatim** keeps every word.
   - Up to 100 terms, your glossary first and then the course's deck titles and question topics, go in as a custom vocabulary.
   - Audio up to 12 MB is sent inline. Larger audio is uploaded through the Files API, once per key, and deleted afterwards.
   - If Google rejects a request with HTTP 400, StudyHub retries in plainer forms, in a fixed order: the other way of sending the audio, then without the vocabulary, the style and the language, and finally with no transcription options. The form that worked is reused for later segments, and the card says what was dropped. If every form fails, the error names the segment and the field Google objected to. Key, balance and network failures are not retried this way.
3. **Proofread.** The transcript is read in windows of about 6,000 characters. The model never rewrites it. It returns a list of suspected misrecognitions (in Chinese, mostly homophones), each quoting the surrounding words exactly. A change is applied only when all of these hold:
   - the model's confidence is **high** (medium, low and invalid ones go to the doubtful list);
   - the quoted context appears word for word in the transcript and contains the wrong word exactly once;
   - a Latin-script word matches as a whole word (`patient` never changes `patients`), and a Chinese term has at least 2 characters;
   - the edit is small and stays on one line.

   The last 30 applied fixes are passed to later windows, so the same error is fixed the same way; earlier windows are not checked again. A reply that is not valid JSON is asked for once more. If it fails again, that window keeps its original text.
4. **Translate.** The proofread text is translated in parts of about 3,500 characters. Each part gets a Chinese and an English title and a paragraph-by-paragraph translation. Every paragraph must come back with its number; a reply that fails this check is asked for once more. A part that still fails stops the job, and saved work is kept. The original-language text is the proofread transcript itself, not a model rewrite. When translating into Chinese, a key term is written 中文（English） the first time it appears in a part.
5. **Title and save.** One English title is written from the part titles; if that fails, the file name is used. The transcript is saved as described in [Check the transcript](#check-the-transcript).

When Gemini rejects a proofreading or translation request with HTTP 400, it is retried without the reasoning setting, then without JSON mode. If a proofreading window still fails, it keeps its original text; if a translation part still fails, the job stops and names the part.

### Timeouts

- A Gemini transcription request waits 3 minutes plus 0.6 seconds per second of audio, between 5 and 30 minutes. A 13.7-minute segment waits about 11 minutes; a 47.8-minute one waits 30.
- An upload is given time for a slow 100 KB per second, between 2 and 40 minutes.
- SiliconFlow and Groq pieces wait between 2 and 10 minutes, depending on their length. Gemini and Groq text requests wait 4 minutes.
- Node's built-in fetch gives up after 5 minutes, so these requests use `node:https` with their own deadlines. `NODE_USE_ENV_PROXY` is supported.
- A request that times out is retried once, never more: it may already have run and used quota.

If Google transcription keeps timing out, lower **Longest per request**. Segments already transcribed are cached.

### Which model proofreads and translates

Choose under **Settings › Audio transcription › Advanced › Expert options › Model for proofreading and translation**:

- **Automatic** (default): the conversation model when DSH has one, otherwise Gemini.
- **Gemini (free first, then paid)**: Gemini free → Groq → Gemini paid.
- **The model the conversation uses**.

When the DSH model does this work, each request runs as a one-shot DSH subagent with no tools: no shell, no file writes and no further delegation. StudyHub collects, checks and saves the output itself, so these results do not come back into the main chat. **View subagent** opens the real session. If the host cannot start subagents, the request runs as a direct model call and the task history says so. DSH model work is not included in the Gemini counts, and the card says so. **Live class** translation follows the same setting.

## Queue and concurrency

- **Transcription queues, proofreading and translation are pipelined.** Per DSH host, transcription is queued in arrival order (by default one recording at a time, across all libraries). As soon as a recording is transcribed its slot goes to the next recording while its own proofreading and translation continue, so file 2 is transcribed while file 1 is proofread and translated. Single imports, the files of a multi-file import and **Proofread and save** in **Live class** share this queue. A waiting card shows **Queued**. Subtitle imports and correction reviews do not wait in it.
- **Proofreading and translation run on a sliding pool.** 3 windows at a time by default, 1 to 6 under **Expert options**; a whole batch shares that number. The moment a window finishes the next one starts, so one slow window no longer leaves the other slots idle. Results are still merged in source order. A window starts with the fixes and part titles of the windows already finished at that moment (windows that start together do not see each other's fixes; later windows see more than a wave could give them). All proofreading finishes before translation begins. Each finished window is saved at once. A cancel or a fatal error stops every window in flight, and a retry reuses finished windows.
- **Automatic back-off.** If the model answers "too many requests / too many at once" (429, a sub-agent limit), the rest of the run lowers its parallelism, the refused window is retried after a short wait (it is not failed), and the pool climbs back toward your setting once things are stable. The card shows, for example, "4 in parallel (lowered from 6 because of rate limits)".
- **Transcription parallelism** can be set to 1 to 3 under **Expert options**, default 1; free quotas and per-minute limits are small, so raising it is rarely useful.
- **Effect of concurrency.** It does not add requests, but it makes per-minute limits more likely. A change applies to the next run or **Continue**; it never interrupts a running recording.
- **Queued jobs** can be stopped. They hold no place, and the card still offers **Continue**.
- **Identical files** (even with different names) are never transcribed at the same time: the later one waits, then reuses the saved source instead of paying again.

## Usage console

At the bottom of the **Audio transcription** page, the fold **Usage and limits** ("N requests today") opens the **Usage console**. It appears once a provider is set up and at least one request has been recorded. It refreshes every 15 seconds only while it is open, and pauses while the window is hidden. Viewing it never calls a provider.

For the keys configured now, it shows:

- today's model requests, minutes of audio transcribed, input and output tokens, and rate-limited and other failed requests;
- each provider (Gemini Free, SiliconFlow, Groq, Gemini Paid) with its models and their daily request quota;
- a 7-day trend;
- the **Proofreading & translation** panel (see [Proofreading and translation depth](#proofreading-and-translation-depth));
- **Set Gemini free daily limits**.

**What it counts.** Every HTTP request this plugin sends to Gemini `generateContent`, to Groq transcription and chat, and to SiliconFlow transcription, including failures and retries, since this record was introduced. Key checks, file uploads, reused saved work, **Live class** audio streams and DSH model tokens are not counted. A request to a model endpoint the console does not know, or made with a key that is not any configured key, is still recorded and shown as **Other**, never dropped. When a recording is resumed from a saved transcript the card says "Reused the saved transcript", so a count of 0 requests is explained. "Today" and the 7-day chart use **your own calendar days** (your time zone); the Gemini free quota keeps Google's day, which resets at midnight Pacific time, and the console says so next to the quota together with the reset time in your local time.

**Remaining quota:**

- SiliconFlow and Groq: taken from the rate-limit headers of their latest reply, and shown as unknown once those are out of date.
- Gemini free: enter each model's requests per day (RPD) from AI Studio under **Set Gemini free daily limits**. The console subtracts this plugin's requests, so the result is an estimate: other apps or keys in the same Google project are not included. Rate-limited requests and requests that never reached Google are not subtracted. 0 means unknown.
- Unknown quota is shown as unknown, never as zero. Check paid balances in the provider's console.

**On the task card.** The card lists this recording's own requests:

- Gemini free and paid requests across all attempts, plus "This run";
- SiliconFlow and Groq requests on lines of their own.

When saved work is reused, "This run" can be 0 while the total still includes the first transcription. For older saved work without a record, one request is counted per saved transcription segment. The card also shows an estimate of what transcription would cost on the paid key and, when the paid key was used, of that part. Proofreading and translation are counted in requests and tokens, not money. Your provider's console has the actual figures.

## Proofreading and translation depth

**Settings › Audio transcription › Advanced › Proofreading and translation** offers three presets. A change applies from the next run.

| Preset | Proofreading | Translation |
| --- | --- | --- |
| **Faster** | Low | Low |
| **Balanced** (default) | Model default | Low |
| **More accurate** | High | Medium |

For other combinations, use the **Proofreading & translation** panel, found under **Expert options** and in the Usage console. It has a 3×3 grid of Low, Mid and High, plus two lists that also offer **Model default**. Each list shows the average time of the last 7 days' samples at the chosen level. The grid describes reasoning depth, not measured accuracy; the model and segment size also affect the time.

How the level reaches the model:

- the DSH model uses the levels its model catalogue supports;
- Gemini 3 models get `thinkingLevel`, Gemini 2.5 models get `thinkingBudget`;
- Groq GPT OSS models get `reasoning_effort`.

A model that rejects the setting runs at its default, and the task history shows the requested and the actual level. A new level redoes proofreading and translation on the next import of a recording; transcription is reused and finished sources are not changed.

## Settings reference

Everything below is in **Settings › Audio transcription**.

| Setting | Where | Default | Notes |
| --- | --- | --- | --- |
| Provider keys | Provider cards | None | One is enough |
| **Proofreading and translation** | **Advanced** | **Balanced** | **Faster**, **Balanced** or **More accurate** |
| **Gemini paid key (optional)** | **Advanced** | None | Separate, billed Google project |
| **Model for proofreading and translation** | **Advanced › Expert options** | **Automatic** | See [Which model proofreads and translates](#which-model-proofreads-and-translates) |
| **Transcription model** | **Expert options** | `gemini-3.5-transcribe` | Gemini |
| **Gemini text model** | **Expert options** | `gemini-3.8-flash` | Hidden when **The model the conversation uses** is chosen |
| **SiliconFlow transcription model** | **Expert options** | `FunAudioLLM/SenseVoiceSmall` | |
| **Groq transcription model** / **Groq text model** | **Expert options** | `whisper-large-v3` / `openai/gpt-oss-120b` | The text model is hidden when **The model the conversation uses** is chosen |
| **Proofreading and translation in parallel** | **Expert options** | 3 | 1 to 6 |
| **Transcriptions in parallel** | **Expert options** | 1 | 1 to 3 |
| **Longest per request** | **Expert options** | 59 minutes | 59, 45, 30, 20 or 10 minutes |
| **Transcript style** | **Expert options** | **Cleaned up** | Or **Verbatim** |
| **Proofreading & translation** panel | **Expert options** | Model default / Low | Same as the presets, with every combination |

**Expert options** also holds the **Live class** models and **Context correction reasoning**; see [Live class](live-class.md).

## If Google cannot be reached

For "Unable to connect to Google", check service availability, your network and your proxy. Node does not automatically use the desktop system proxy. On Node 22.21+ or 24.5+, follow the [official Node proxy instructions](https://nodejs.org/learn/http/enterprise-network-configuration): set these variables and start DSH web from the same terminal:

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
$env:NO_PROXY = "localhost,127.0.0.1"
npx @deepseek-ai/dsh web
```

Replace the address with your own proxy. "Gemini API is unavailable in the current network region" (Google's "Location is not supported") means you need a network in a region Gemini supports. Check each provider’s current supported regions.

## What has and has not been verified

- **Mock services.** Automated tests use local mock Gemini, SiliconFlow and Groq services. They cover splitting, provider order, rate-limit waits, uploads and deletion, parameter fallback, the proofreading safety rules, the transcript format, resuming and keeping keys out of records. They show that the code handles these responses as intended. They do not show real transcription quality, current quotas or provider behaviour.
- **Real ffmpeg.** Cutting with ffmpeg was tested on one-minute recordings with pauses in M4A, Ogg Vorbis, Opus, WebM, FLAC, AAC and AIFF: every piece decodes, the pieces add up to the original length, the cuts fall in pauses and temporary files are removed. These tests skip themselves when ffmpeg is missing. Lossless M4A splitting was tested on a real AAC recording.
- **Real APIs.** Request fields follow the Gemini and Groq documentation as read on 2026-09-29: Gemini `generateContent` (not the newer Interactions API), Groq `/openai/v1/audio/transcriptions` and `/openai/v1/chat/completions`. They were not called with real keys. Whether Groq's text model supports JSON mode and `reasoning_effort` is unverified. If Google's API changes, only `lib/gemini.js` needs updating.
- **DSH subagents.** Proofreading and translation through DSH subagents were tested with a simulated host only. Starting a real subagent and opening it with **View subagent** have not been checked in a real DSH.
- **The @ selector.** Whether DSH opens its file selector after **Pick a file with @ in the conversation** has not been checked; if it does not, type @ again.
- **Progress weights.** The 25% / 30% / 45% split is a rule of thumb. Real step times vary with the recording and the model, so the overall percentage is an estimate; "Left in this step" uses measured pace.
- **Terminology.** Transcription can still contain misrecognised words that proofreading missed or was unsure about. Check the doubtful list in each transcript.

## Development

### Conversation operations

The agent reaches audio through the `study_audio` tool:

- `audio.import {path | uploadId | files:[{path | uploadId}], title?, subject?, terms?, course?, courses?, paidOnly?}` starts a background job. A path from the conversation may be quoted, start with @, or be relative to the workspace. `files` keeps its order and makes one transcript. Completion tells the conversation that sources were saved; it never generates questions.
- `audio.retry {jobId}` continues a failed or cancelled job, only when the learner asks.
- `audio.settings.get` reports whether each key is set and its last four characters. Keys are never asked for or accepted in chat; saving and testing keys (`audio.settings.set`, `audio.test`) happen in the panel.
- `audio.subtitles.import`, `audio.corrections.review`, `results`, `result.get`, `jobs`, `job.wait` (up to 60 seconds), `job.cancel`, and `live.list`, `live.get`, `live.save` are also available.

The panel uploads files with `audio.upload.start`, `audio.upload.chunk` (3 MB chunks), `audio.upload.finish` and `audio.upload.cancel`, checks them with `audio.preflight`, reads the console with `audio.usage` and clears finished cards with `job.dismiss`. **Find in the workspace** searches only the current session's workspace, at most 6 levels deep, newest first. It skips hidden folders, `node_modules`, `dist`, `build`, Python environments and StudyHub's own data folders. Only each file's name, size and date reach the panel.

### Where things are stored

| What | Where |
| --- | --- |
| Keys | `study/audio.json` in the DSH user directory (`~/.dsh` or `DSH_HOME`), unencrypted |
| Usage record | `study/audio-usage/YYYY-MM-DD.jsonl` in the same directory. Kept 31 days. Holds no keys (only a short hash) and no request or response bodies. Read as a stream in 16 KiB blocks and summed by day and model |
| Panel uploads | `<library>/audio-uploads/`. Unsubmitted uploads are removed when you cancel or leave the page; unclaimed ones older than 24 hours are removed at the next upload |
| Job manifests and copies of uploaded files | `<library>/audio-batches/` |
| Checkpoints | `<library>/audio-cache/<recording>/`: raw transcription segments (each noting the provider that transcribed it), proofreading windows, translation parts, title and `usage.json` (this recording's request tally) |

Raw transcription checkpoints are keyed by transcription model, style, language and cut points, not by the glossary. Proofreading and translation checkpoints also depend on the text model, reasoning levels, description and vocabulary. Settings saved by older versions with several recordings at once are read as one.
