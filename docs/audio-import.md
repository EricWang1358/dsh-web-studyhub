# Audio import: recordings to bilingual transcripts

[中文](audio-import.zh-CN.md)

Recordings are source material. Import creates one English–Chinese transcript, or several for very long text, in **Sources**. Question generation remains a separate **Sources → Generate** workflow.

## Get started

1. In **Settings → Audio transcription**, configure Google AI Studio keys and choose **Verify keys**. Optional Groq-only configuration also works.
2. Open **Audio transcription**. Drag a file into the drop area, click to select it, search **Find in workspace**, or choose **Select a file with @ in the conversation**. Optionally describe the recording and add terminology, then start import. **Add source → Audio / recording** remains available.
3. Processing runs in the background. Task cards show measured stage progress: transcription, correction, and translation use estimated overall weights of 25% / 30% / 45%, with completed/total segment counts inside each stage. Cards show the active segment and elapsed time. Once a segment completes, its observed speed supports a remaining-time estimate. A single long request has no measurable internal percentage; its moving indicator explains that it is still running. Recording duration and processing elapsed time are separate.
4. Stop at any time; saved transcription checkpoints remain. Inbox notifications follow actual processing order: transcription, correction, translation, then final saved output. They open the saved source, or the transcription page before saving. Partial correction failure does not claim complete correction. Notifications persist in the library.
5. Open the finished transcript in Sources. Its header lists applied terminology corrections and uncertain suggestions left for you to check.

Supported formats: MP3, WAV, M4A, AAC, OGG, FLAC, OPUS, WEBM, and AIFF. Limits: 512 MB and eight hours.

## Usage and reasoning settings

The usage console shows model requests, audio minutes, tokens, throttling/failures, and seven-day trends for current keys. It records actual HTTP requests, including failures and retries, from the time this feature is enabled. Key checks, uploads, cache hits, live classroom streams, and DSH model tokens are excluded. Today's counters use Pacific time to align with Gemini daily resets.

Groq remaining daily requests come from valid response headers and become unknown when stale. Viewing the console does not make another provider call. Enter Gemini free daily limits from AI Studio to obtain estimates based on local records; other applications or keys in the same project are not included. Unknown limits do not appear as zero. Check provider consoles for paid balances.

Correction and translation can independently use low, medium, high, or model-default reasoning. Both the two-dimensional selector and individual controls save settings for the next job. The grid describes reasoning depth, not measured accuracy. Timing samples are grouped by actual depth; model and segment size also affect time.

DSH uses reasoning levels supported by its model catalog. Gemini 3 uses `thinkingLevel`, Gemini 2.5 uses `thinkingBudget`, and supported Groq GPT OSS models use `reasoning_effort`. Rejected parameters fall back to model defaults; execution records show the actual level. Changed levels invalidate correction/translation caches while retaining raw transcription. Existing finished sources are not rewritten automatically.

Usage logs live under the DSH user directory at `study/audio-usage/YYYY-MM-DD.jsonl`, retain 31 days, and omit keys and request/response bodies. Reads stream in 16 KiB blocks and aggregate daily/model counts. Polling and listeners stop on leaving the page, and background refresh pauses while the window is hidden.

## File selection and execution records

- **Drag or choose:** the browser uploads 3 MB chunks into the library's `audio-uploads/`, retaining the filename. Successful completion removes the temporary copy and leaves results in `audio-cache/`. Canceling upload or leaving the page cleans unfinished uploads; unclaimed copies older than 24 hours are cleaned on the next upload.
- **Find in workspace:** searches only the current conversation workspace, skipping hidden folders, `node_modules`, and `dist`, to depth six. Newest files appear first. The original file is read directly; only its name, size, and date return to the panel.
- **Select with @:** prefills the conversation input without sending. Use DSH's @ file selector and submit; the agent calls `audio.import`. If the selector does not open, press @ manually.
- **Paste a path:** available under Advanced; quoted or unquoted absolute paths are accepted.
- **View execution process:** lists transcription, correction windows, translation parts, and title requests with state and duration. Host-model text processing uses restricted, read-only, tool-free DSH subagents when supported. **View subagent** opens the real session. Unsupported hosts show direct model execution explicitly.

## Provider order: free Gemini → Groq → paid Gemini

Use separate Google Cloud projects for free and paid keys. The free key must belong to a project without billing; enabling billing on that project removes its free tier. Paid keys belong to a billing-enabled, funded project.

Requests begin with the free key. Per-minute throttling waits according to Google's response, at most twice and at most 65 seconds each. Continued throttling or exhausted daily quota advances to Groq if configured, otherwise paid Gemini; that attempt does not return to the free key.

**Optional Groq:** create a key at [Groq Console](https://console.groq.com/) and save it in audio settings or `GROQ_API_KEY`. Default transcription is `whisper-large-v3`; correction, translation, and titles use `openai/gpt-oss-120b`. Advanced settings can change both. Groq works without Gemini keys.

Historical documented free-tier limits are not a current quota guarantee: Whisper was listed at 20 requests/minute, 2,000/day, 7,200 audio seconds/hour, and 28,800/day; GPT OSS at 30 requests/minute, 1,000/day, 8,000 tokens/minute, and 200,000/day. A one-hour lecture may require tens of thousands of text tokens. Use current provider dashboards and response headers. Per-minute waits cap at 65 seconds; hourly/daily exhaustion temporarily sets Groq aside according to the reported delay, up to six hours, and advances to the next provider.

### Groq file handling

Groq's documented free upload limit is 25 MB. Large recordings are divided and their text recombined:

- WAV is converted to 16 kHz mono and split near speech pauses.
- MP3 is split at frame boundaries without re-encoding.
- M4A, OGG, Opus, FLAC, WebM, AAC, and AIFF use **ffmpeg** when splitting or format conversion is required. A decoding pass locates quiet cuts, then creates 16 kHz mono 16-bit FLAC parts, approximately 11 minutes and no more than 21 MB each. Parts are produced and uploaded one at a time. Temporary files are removed after use; interrupted files older than a day are cleaned during later splitting.
- Set `FFMPEG_PATH` or place `ffmpeg` on PATH. Without ffmpeg, supported M4A/OGG/FLAC/WebM files up to 24 MB can be sent whole. Larger or unsupported inputs advance to the next provider with an explanatory message.
- After throttling, upload resumes from the unfinished part without resending completed parts.

Whisper lacks the cleaned transcription style and a custom vocabulary interface. Terminology becomes a prompt of approximately 224 tokens, truncated if longer, so later correction matters more. Provider data policies differ. **Paid key only** skips both free Gemini and Groq for confidential recordings.

Groq requests appear separately from Gemini counts; Groq costs are not converted to a monetary estimate. Saved transcription records its provider.

Invalid free keys or unsupported regions also advance to paid Gemini with a reason. Paid-balance exhaustion (HTTP 402) stops and asks you to fund the account rather than returning to free. Free Gemini submissions may be used for product improvement and human review; the original provider guidance requires paid access in the EU, Switzerland, and UK. Confirm the current provider terms before submitting sensitive content.

Free Gemini timeouts/server errors advance directly to Groq when available. Groq failures—including absent models, rejected parameters, missing ffmpeg, timeout, and server errors—advance to the next provider. Only rejected credentials (401/403) permanently disable that route. Failure of the final configured paid route ends the request. Without Groq, free-to-paid behavior is unchanged.

The historical published `gemini-3.5-transcribe` estimate was about $0.005 per audio minute including input/output. Cards show an all-paid estimate and actual paid transcription portion; correction/translation requests and tokens are counted without a monetary conversion. Current pricing remains provider-controlled.

Gemini request counts accumulate across attempts for the recording in `audio-cache/…/usage.json`; cards also show this attempt separately. Cache reuse can mean zero new requests with a nonzero lifetime total. Older caches infer one request per saved transcription segment where no usage record exists. Host-model correction/translation is not included in Gemini counts and is labeled accordingly.

Keys are stored in the DSH user directory's `~/.dsh/study/audio.json`, honoring `DSH_HOME`. This is an unencrypted local file. `GEMINI_FREE_API_KEY` and `GEMINI_PAID_API_KEY` are also supported. Keys do not enter the library, backups, snapshots, task records, or conversation. Do not paste keys into chat.

## Processing

1. **Detect and split:** format detection reads bytes, not the extension. A WAV named MP3 is processed as WAV with a warning. MP3 inputs with less than half their bytes recognized as audio are rejected. Inputs below about 59.5 minutes fit one transcription request; longer MP3/WAV inputs split into the fewest balanced parts without ffmpeg or re-encoding. 16-bit PCM WAV cuts move toward nearby quiet 200 ms intervals; MP3 cuts follow frames. Advanced settings allow a 5–59 minute limit, default 59. M4A longer than one hour is rejected with a request to convert to MP3; other formats are submitted whole for API length validation.
2. **Timeouts:** transcription response time allows three minutes plus 0.6 seconds per audio second, bounded to 5–30 minutes. Upload time assumes 100 KB/second, bounded to 2–40 minutes. Requests use `node:https` for these deadlines and support `NODE_USE_ENV_PROXY`. Timeout receives one retry because each attempt may consume quota.
3. **Transcribe:** `gemini-3.5-transcribe` defaults to cleaned speech with repetition/filler removal and paragraphs; verbatim mode is available. Up to 100 terms combine course/deck topics with your terminology list. Rejected vocabulary falls back without it and reports the change. Inputs up to 12 MB are inline; larger inputs use Files API uploads per key, deleted afterward.
4. **Parameter fallback:** after a Gemini HTTP 400 rejection, retries first change inline/file delivery, then remove vocabulary, style, and language options in order, finally trying no transcription options. Successful settings are reused for later segments and recorded. Exhaustion reports the segment and provider field. Credential, balance, and connectivity failures do not use this parameter-correction loop.
5. **Correct terminology:** the model returns proposed small replacements with exact surrounding quotations rather than rewriting the transcript. The service requires a verbatim location, complete-word boundaries, and a small single-line edit. Under the current confidence policy, only **high-confidence** valid suggestions modify text; medium, low, and invalid confidence suggestions remain in the skipped list. Earlier confirmed corrections inform later windows, without rechecking earlier windows.
6. **Translate:** parts are approximately 3,500 characters, each with English/Chinese titles and aligned paragraphs. Missing paragraph numbers receive one retry. English recordings retain corrected English, followed by Chinese translation; Chinese recordings retain corrected Chinese, followed by English translation. First-use key terms include their English equivalents.
7. **Save:** transcripts contain bilingual headings and paired original/translated paragraphs. Above roughly 400,000 characters they split at part boundaries with continuing numbering. The original language and explicit bilingual format remain regardless of interface language.

Text processing defaults to **Automatic**: use the DSH conversation model when available, otherwise Gemini. Advanced settings can pin Gemini or the conversation model; live translation follows the same choice. Groq transcription is an alternative to Gemini, so transcription itself is not necessarily a Gemini request.

## Queue and window concurrency

Recordings run one at a time within the same host. Libraries, single imports, and batch members share that queue in arrival order. Legacy multiple-recording concurrency settings normalize to one.

Inside one recording, correction and translation each process concurrent windows: default maximum three, configurable to two under Advanced. A window group shares a consistent prior terminology/title context; results merge in original order before the next group. All correction finishes before translation begins. Each completed window saves a checkpoint immediately. Cancellation or fatal errors stop sibling tasks. Retries reuse completed windows. Concurrency does not increase normal request counts, but can increase minute-level throttling.

Changes apply to the next run or continuation without interrupting active recordings or releasing a second recording. Queued jobs can be stopped and resumed. Identical bytes under different filenames are deduplicated: the later job waits and reuses saved sources. Live-session correction/save uses the same queue.

## Interruptions and retries

Transcription segments, correction windows, and translation parts persist under `audio-cache/`, along with single/batch task manifests. Failed, canceled, and host-interrupted task cards reappear. **Continue** completes the original submission scope using saved checkpoints. Changed or deleted local files require re-import to avoid attaching old progress to another recording. Uploaded originals retain a manifest-owned copy until completion or dismissal.

Raw transcription caches use model, style, and language rather than terminology. Adding terms redoes correction/translation while retaining transcription. Current text-cache policy may invalidate older correction results, but raw audio transcription caches remain.

Continue does not require choosing the file again and reports saved stage counts. Repeated identical correction errors stop after two occurrences. Resuming removes the previous incomplete notification; another failure creates a new one. Legacy jobs with only inbox failure records require reselecting the original file and confirming prior parameters rather than offering an unreliable one-click resume; matching checkpoints remain reusable. Old notices disappear only after successful resubmission.

Source identity depends on bytes and text-processing settings. Identical re-imports reuse sources; changed terms or course save another version, and old sources can be removed manually. Saved old transcripts are never automatically rewritten.

## Conversation API

`audio.import {path or uploadId, title?, subject?, terms?, course?, paidOnly?}` accepts quoted, @-prefixed, or workspace-relative paths. Panel uploads use `audio.upload.start/chunk/finish`. `audio.settings.get` reports configuration presence and only the final four key characters; use `audio.settings.set` and `audio.test` to configure/check. Tasks support `job.wait`, `job.cancel`, and `job.dismiss`. Completion notifies the conversation that sources were saved without generating questions.

Host-model text requests use one-shot restricted subagents. The plugin collects, validates, and saves their output directly; completed text does not return as a full continuable-subagent notification in the main conversation. Jobs and sources remain visible in the panel and inbox.

## Connectivity and verification limits

A Google connectivity error may require a proxy. Node requests do not ordinarily read system proxy settings. On supported Node versions (22.21 or later), start DSH with environment variables such as:

```powershell
$env:NODE_USE_ENV_PROXY = "1"
$env:HTTPS_PROXY = "http://127.0.0.1:7890"
```

Use your actual proxy address. A location-not-supported response requires an eligible network/region.

Mock Gemini/Groq services cover splitting, provider order, throttling, uploads/deletion, parameter fallback, safe correction, output, resumption, and key isolation. Real ffmpeg fixtures cover supported conversion formats and pause-sensitive cuts; optional checks skip when ffmpeg is absent. These tests do not verify current quotas, provider behavior, real transcription quality, or real model JSON/reasoning support. Historical API checks used documentation dated 2026-09-29; the implementation uses Gemini `generateContent`, not the newer Interactions API.

Terminology can still be wrong or uncertain. Check the correction header and original sources. Speaker separation and word-level timestamps are not provided.
