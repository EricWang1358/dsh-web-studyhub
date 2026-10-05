# Live class

[中文](live-class.zh-CN.md)

Record a class as it happens and follow it sentence by sentence: the original transcript, with a Simplified Chinese translation under each sentence. While the class goes on, you can turn selected passages into questions. When it ends, you can save the whole class as sources, together with class notes. Available since 1.4.0.

## Before you start

You need:

- **A Gemini key.** Live transcription works only with Google Gemini's live interface. Check Gemini’s current account, region and quota requirements. Paste the key into the Google Gemini card in **Settings › Audio transcription** and click **Save and verify**. Until a key is saved, the page shows **Live class needs a Gemini key**, with setup steps and an **Open audio settings** button.
- **A model for translation and correction.** By default StudyHub uses the DSH conversation model when there is one, and Gemini otherwise. See [Settings](#settings).
- **A DSH conversation model**, if you want to create questions during class.
- **A browser that can capture audio:** a current Chrome or Edge, with the page opened over HTTPS or localhost. Allow the microphone, or share the tab when the browser asks.

SiliconFlow SenseVoice and Groq handle recorded files only. If you cannot use Gemini, record the class another way and import the file on the **Audio transcription** page afterwards. See [audio import](audio-import.md).

Review the Gemini privacy and region notices on the card, and Google’s current terms, before uploading a recording.

## Record a class

1. Open **Live class** in the sidebar, in the **Setup & manage** group.
2. Enter a **Class title**. If you leave it empty, StudyHub names the class "Live class recording" followed by the date and time.
3. Choose an **Audio source**: **Microphone (in-person class)** or **Tab / system audio (online class)**.
4. Optional: choose a **Course**. Open **Subject and terminology (optional)** to fill in **Subject** and **Terms (comma or line separated)**.
5. Optional: tick **Use paid key only** to skip the free Gemini key.
6. Click **Start recording**. For an online class, choose the tab where the class is playing in the browser's sharing dialog and turn on **Share tab audio**. StudyHub sends only the audio, never the picture.

Terms help recognition, translation and correction. StudyHub puts your terms first, then adds deck titles and question topics from the chosen course, up to 100 terms in total.

As the teacher speaks, the transcript fills in:

- Each sentence shows the original text first, with the Simplified Chinese translation below it. **Translating…** shows until the translation arrives.
- Text that is still being recognised appears at the bottom, followed by "…". You cannot select it yet.
- The translation is always Simplified Chinese, even when the interface is in English.
- **Following latest** keeps the newest sentence in view. When you scroll up, it changes to **Jump to latest**.

### Controls

| Control | What it does |
| --- | --- |
| **Pause** / **Resume** | Stops sending audio until you resume. Context correction waits too. |
| **End recording** | Stops capture and releases the microphone or shared tab. The remaining sentences are translated and checked in the background. |
| **Continue recording** | Appears on an ended class. Records more into the same class and keeps its title, course, subject and terms. |

### What keeps or ends a recording

- Moving to other StudyHub pages, such as **Tasks** or **Sources**, keeps the recording going.
- A library can record only one class at a time.
- Stopping the share in the browser ends the recording.
- Switching to another library ends the recording.
- Closing or reloading the page while recording first shows the browser's leave-page warning. If you close it anyway, capture stops at once, and StudyHub ends the class after 90 seconds without contact (30 minutes if it was paused). The text received so far is kept.

## Check the audio input

While StudyHub connects, an **Input level** panel shows. During recording, a slim bar under the class title shows the device name, a level meter and a status.

| Status | What to do |
| --- | --- |
| **Sound detected** | Nothing. Audio is arriving. |
| **Very quiet or silent**, **Device muted** | Microphone: speak toward it and watch the meter. If it stays still, check the system input, the mute switch and the distance. Tab: check that the class is playing, audio sharing is on and the player is not muted. |
| **Audio too loud** | Lower the system input volume or move away from the microphone. |
| **Browser audio interrupted**, **No audio frames received** | The browser is not delivering audio. Check the device or the sharing, and end and restart if needed. |
| **Waiting for audio permission** | Answer the browser's microphone or sharing prompt. |

**Transfer details** shows two separate timers:

- **Audio captured**: audio the browser has recorded.
- **Backend accepted**: audio that StudyHub's backend has received. This does not mean Google has turned it into text yet.

If uploads fall about 30 seconds behind, StudyHub stops the recording and keeps what it has received. Check your connection, then click **Continue recording**.

The meter shows the relative level of the audio actually sent for transcription. It is not calibrated decibels, and it does not detect speech.

## Create questions while recording

1. Select sentences in any of these ways:
   - tick the box next to a sentence;
   - drag across original or translated text, which selects every sentence the highlight touches;
   - click **Last 8 sentences**.
2. Select at least about 120 characters of original text and no more than 400 sentences. The selection bar shows how many more characters you need. **Clear** empties the selection.
3. Set **Questions** to a number from 1 to 15. The default is 5.
4. Click **Create questions from selection**. Recording continues.
5. When the draft is ready, open it from the **Inbox**, then review and publish it as usual.

What happens:

- StudyHub first saves the selection as a source named after the class and the time range. The source holds each selected sentence with its time and its Chinese translation, so questions can cite it. Later corrections do not change this snapshot.
- Generation uses the normal pipeline: generation, review and a draft. Questions use **Quiz + flashcards** with **Mixed** difficulty, in your interface language.
- Sentences you have used show **Used for questions**.

## Read the correction markers

While you record, StudyHub rechecks recent sentences against their context every 30 seconds and fixes clear recognition mistakes. A mark at the right of each sentence shows the result:

| Mark | Meaning |
| --- | --- |
| Solid green dot (**Polished**) | The sentence was changed. Hover over the dot to see why. Open **View original recognition** to compare it with the first recognition. |
| Green ring (**Checked**) | Checked and left unchanged. |
| No mark | Not checked yet. |

The **Context polish** line above the transcript counts the checked, polished and pending sentences, and shows a legend. **Details and usage** lists model calls, local cache hits and the cached input tokens the provider reports.

The marks show only changes the model made with high confidence. A ring or a missing mark does not prove a sentence is right. "Checked" means the sentence was submitted for correction, not that it is guaranteed accurate.

If a check fails, the error appears on the **Context polish** line and the pending sentences are kept. After the class ends, or after an error, click **Retry pending correction**.

### How the check works

- Checks run in order, in batches of up to 8 new sentences plus the last 2 sentences of the previous batch as overlap.
- Each check works through the whole backlog that existed when it started. Sentences that arrive during a check wait for the next one. **End recording** runs a final pass over the rest.
- A check with no new sentences makes no model call. Checks stop while recording is paused.
- Each batch reads its window, the subject, the terms, the cumulative summary (up to 1,600 characters) and the last 3 notes. It writes a note for the batch and updates the summary, so the growing history is never resent in full.
- Only high-confidence changes to existing sentences are accepted. The original and the Simplified Chinese are replaced together, and the first recognition stays folded under the sentence.
- A translation requested before a correction cannot overwrite the corrected sentence. Sources already created from a selection are independent snapshots and do not change.

## Read the class notes

**View class notes**, below the transcript, shows what correction has gathered so far:

- **Cumulative summary**: the class so far, updated after each batch.
- **Notes by batch**: learning points from each batch. Entries marked **Historical correction note** come from historical correction.
- **Historical ambiguity correction**: requests to recheck older sentences, with their status.

Click a sentence reference, such as **Sentence 12**, to jump to that sentence in the transcript.

### Historical ambiguity correction

Sometimes a later sentence shows that an older one, outside the current window, was misheard. The batch check then queues a separate request that names 1–20 specific older sentences and the reason.

- Requests run in the background, one at a time. Each uses the batch that raised it as evidence. Recording and batch correction do not wait for it.
- Each request shows **Queued**, **Working in background**, **Completed** or **Retry needed**. Click **Retry historical correction** to run the failed ones again.
- Before merging a result, StudyHub checks that the sentences have not changed since the request. Stale, timed-out (after 60 seconds) and failed results are not merged and stay available for retry. They are never reported as done.

The model that runs it follows **Model for proofreading and translation** (see [Settings](#settings)):

- **Gemini:** a direct Gemini call. No DSH subagent is involved.
- **The DSH conversation model:** a DSH subagent that has no tools and cannot delegate further. If DSH cannot run subagents, StudyHub calls the same model directly. Once a subagent has started, a failure does not switch to another route; the request is kept for retry.

## Save the class

After **End recording**, the bottom of the page offers:

| Button | What it does | Cost |
| --- | --- | --- |
| **Save as source** | Saves the bilingual transcript as it is, as one source (more for a very long class) with sections titled by time range. Waits while any sentence is still being translated; a sentence whose translation failed is saved without one. | Free, no model calls |
| **Proofread and save** | Runs a background task that proofreads misrecognised words, translates the transcript again and saves the result. It uses the **Proofreading and translation** level from audio settings and joins the same queue as audio imports, which handles one recording at a time. Saving the same class again with unchanged settings reuses the sources already saved. | Free allowance, or billed by your provider |
| **Open sources** | Opens the **Sources** page. | |

When there is a summary or notes, either save also stores a separate class notes source. It holds the summary, the batch notes and sentence references with their times. Historical requests that failed are listed in it under "Needs verification".

Both save buttons stay unavailable until context correction has covered every sentence and no historical correction is queued or running. If correction stopped with an error, click **Retry pending correction** first.

A translation that fails 3 times shows as unavailable. Click **Retry failed translations** above the transcript to try again.

## Manage previous classes

**Previous classes**, at the bottom of the page, lists your unarchived classes, newest first, with their duration and sentence count.

- **Open** shows a class. It is unavailable while you are recording.
- **Archive** moves a class to **Archived classes**. End an active recording first.
- In **Archived classes**, use **Open**, **Restore** or **Delete**. Delete asks you to confirm with **Delete permanently**.
- To continue an archived class, restore it first.
- Permanent deletion removes the class's transcript, translations and class notes, and cannot be undone. Sources you saved from the class stay in the library.

In the main chat, StudyHub can also list your classes, read a class's transcript and translation, and save a finished class as sources. Recording itself starts only on the **Live class** page.

## Settings

Live class uses the Gemini keys and models in **Settings › Audio transcription**. The model options are under **Advanced › Expert options**.

| Setting | Options and effect |
| --- | --- |
| **Model for proofreading and translation** | **Automatic (the conversation model when there is one, otherwise Gemini)** is the default. The other options are **Gemini (free first, then paid)** and **The model the conversation uses**. Live translation, context correction and historical correction follow this choice. |
| **Live transcription model** | The Gemini live model. Default `gemini-3.5-transcribe-live`. |
| **Live translation model** | The Gemini model for live translation and context correction. Default `gemini-3.5-flash-lite`. Hidden when **The model the conversation uses** is selected. |
| **Reasoning strength of live class context correction** | The current model's own levels or **Model default**; **Low** by default. A strength the model does not offer maps to the nearest level and the list says so. Applies to context correction and historical correction. |
| **Gemini paid key (optional)** | Directly under **Advanced**. Used when the free allowance runs out, or always with **Use paid key only**. |

How the reasoning setting is applied:

- On the conversation model, correction never inherits a higher reasoning level from the main chat. If the model has no low level, it uses its default.
- On Gemini, Gemini 3 models get a low thinking level and Gemini 2.5 models a small thinking budget. Other models use their defaults.

## Costs, keys and privacy

- Live class uses the free Gemini key first. It switches to the paid key when the free allowance runs out or is rate-limited, and tries the other key if one is rejected. These switches appear under **Connection and quota notices**.
- **Use paid key only** skips the free key for transcription, translation and correction.
- **Estimated paid transcription**, at the bottom of the page, covers paid transcription only. It excludes translation and correction.
- Correction on the conversation model is billed by your provider through DSH. It is not counted in the Gemini figures.
- Correction requests share a fixed prompt prefix, so the provider can reuse its cache, and StudyHub records the cached input tokens the provider reports. A local cache also reuses up to 8 identical results. Cache hits and discounts are not guaranteed, and StudyHub creates no separately billed explicit cache.
- Keys stay in the audio settings file on this computer. They never travel in the browser's audio messages and are never written into a class file. Do not paste keys into the main chat.

## Storage and recovery

- Each class is saved in the current library as `live/<id>.json`. Raw audio is never saved.
- StudyHub saves about 3 seconds after each change, one save at a time. If a save fails, the page says so and the text stays in memory.
- A crash or power loss can lose the last few unsaved seconds. Because the audio is not kept, those seconds cannot be recovered.
- After you close the page, unfinished translation and correction keep running in StudyHub's backend.
- After DSH restarts, unfinished translations show as failed and interrupted historical requests show **Retry needed**; retry them from the page. Notes, the correction position, historical requests and the archive status are kept.
- **Continue recording** and deletion first wait for pending processing and saves. This stops an old copy from overwriting a resumed class or bringing back a deleted one.
- Class files are kept apart from the library's main data, so they are not sources and are not in library backups. Click **Save as source** to turn a class into ordinary sources.

## How it works

- **Capture.** In the browser, an AudioWorklet mixes the input to mono and converts it to 16 kHz, 16-bit little-endian PCM, in frames of about 100 ms. The microphone uses echo cancellation and noise suppression. The worklet source is kept as a literal string so that production minification cannot break it.
- **Connection.** StudyHub's backend holds the WebSocket to Gemini Live and sends audio only after Google confirms the setup. A connection lasts at most 10 minutes, so StudyHub opens the next one at 8 minutes 45 seconds, or earlier if Google announces a close. Final text from the old connection appears before text from the new one.
- **Reconnecting.** Switching connections is not server-side session resumption, and a failure can lose words that were not yet final. After a drop, StudyHub reconnects with increasing waits and buffers at most the last 30 seconds of audio. If it cannot reconnect, the status changes to **Disconnected**; the text so far is saved, and you can click **Continue recording**.
- **Time stamps.** The time beside each sentence counts the audio recorded so far, without pauses. Use it to find your place; it is not a word-level timestamp.
- **Translation.** Sentences are translated in order, up to 6 sentences or 900 characters per request, with the 3 previous translated sentences as context. Each sentence gets up to 3 attempts. The translator is asked to write a key term as 中文（English term） the first time it appears.

## Verification status

- Simulated WebSocket and model tests cover transcription, translation, free/paid switching, connection loss and rotation, persistence, recovery, question selection, stopping and retries.
- Browser checks with synthetic audio and simulated live responses exercise the real AudioWorklet, pause, page navigation, track release and saving.
- Not yet verified: real Gemini recognition quality, latency and billing, and the microphone and screen-sharing permissions inside DSH. Optional DSH SDK checks were skipped where the SDK was unavailable.

See [verification](verification.md) for the records.

## References

- [Google live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia). Whether audio can be shared depends on the platform and on what you share.
