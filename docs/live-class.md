# Live class

[中文](live-class.zh-CN.md)

Record a class as it happens and follow it sentence by sentence: the original transcript, with a Simplified Chinese translation under each sentence. While the class goes on, you can turn selected passages into questions. When it ends, you can save the whole class as sources, together with class notes. Available since 1.4.0.

## Before you start

You need:

- **A transcription engine**, one of:
  - **Local transcription (audio stays here).** It runs on this computer, needs no key and is installed with one click; see [Local transcription](#local-transcription-audio-stays-here).
  - **A Gemini key** for Google Gemini's live interface. Check Gemini’s current account, region and quota requirements. Paste the key into the Google Gemini card in **Settings › Audio transcription** and click **Save and verify**.

  Until one of them can run, the page shows **Set up a transcription engine first** with the local engine's card and a **Use a Gemini key instead** button (or, on a computer without a local engine, **Live class needs a Gemini key**).
- **A model for translation and correction.** By default StudyHub uses its generation model (it follows the main chat by default) when there is one, and Gemini otherwise. See [Settings](#settings).
- **StudyHub's generation model** (it follows the main chat by default), if you want to create questions during class.
- **A browser that can capture audio:** a current Chrome or Edge, with the page opened over HTTPS or localhost. Allow the microphone, or share the tab when the browser asks.

SiliconFlow SenseVoice and Groq handle recorded files only. If neither engine can run here, record the class another way and import the file on the **Audio transcription** page afterwards. See [audio import](audio-import.md).

Review the Gemini privacy and region notices on the card, and Google’s current terms, before uploading a recording.

## Local transcription (audio stays here)

The local engine is SenseVoice (FunAudioLLM) speech recognition with a silero voice detector, run through sherpa-onnx in a background thread of StudyHub. It understands Mandarin, English, Cantonese, Japanese and Korean, and writes Chinese as Chinese. The audio never leaves the computer. Installing it downloads the engine and the model once; translation and polishing still use your text model if you set one up (see below). The idea and the first port come from the community package StudyHub for ZCode by BAXUIE.

- **Install.** Click **Install local transcription engine** on the **Live class** page or under **Settings › Audio transcription › Live class transcription**. It installs in three steps: **Install the speech engine**, **Download the speech model**, **Check that it works**. Progress is shown on the card and in **Tasks**; **Pause** keeps what was downloaded, and **Continue install** goes on from there.
- **Where it goes.** By default into `StudyHub\LiveLocal` on the non-system drive with the most free space (**Choose location** to change it): `engine\node_modules` holds the engine and `models\sense-voice` the model. Nothing is added to StudyHub's own package or to the system.
- **Size.** The first install downloads about 239 MB on Windows: the speech model about 228 MB, the voice detector about 2 MB and the engine about 9 MB. Once installed it uses about 253 MB.
- **What is downloaded, and how it is checked.** The engine is the npm package `sherpa-onnx-node` and this computer's prebuilt package at version 1.13.8, from npmmirror (or registry.npmjs.org), each compared with the sha512 integrity the npm registry publishes for that version. The model files come from ModelScope at a fixed revision, each compared with the sha256 in ModelScope's file metadata. A file that does not match is deleted and downloaded again; a download that stopped continues from its `.part` file. A model the community package already downloaded to `~/.dsh/live-models/sense-voice` is reused when it matches.
- **Which computers.** Windows on x64 is tested. macOS (Apple silicon and Intel) and 64-bit Linux use the same release of prebuilt engines but are not tested yet; other computers (for example Windows on ARM) are told up front that there is no local engine.
- **Accuracy and speed.** Good for clearly spoken Mandarin and English; with a strong accent, background noise or many technical terms it does worse than the cloud. Text appears about 1 second after a sentence ends. Loading the model takes about 2 seconds when a class starts.
- **Translation and correction.** These still use the text model you set up (the text is sent to that model's provider). Without a text model the class shows the original only. A sentence that is already Chinese is not sent for translation.
- **Repair.** If an engine file is deleted or changed after the install (an antivirus quarantining the addon, for example), the card says **Needs repair** instead of ready, and **Repair** reinstalls only that part. Each engine file's size and checksum are recorded at install; the native libraries are checked again whenever the status is read.
- **Disk space.** **Continue install**, **Retry** and **Repair** need room only for what is not done yet, not for the whole install again.
- **Remove.** **Remove local transcription engine** in Settings deletes only what StudyHub installed. It is refused while a class in any library uses the engine.
- **Which engine a class uses.** **Automatic** (the default) uses Gemini when a Gemini key is set and the local engine when there is none. **Local transcription (audio stays here)** and **Gemini (cloud)** are kept as chosen: a class never switches to the other engine on its own. When both can run, the start form also offers **Transcription** for this class. **Continue recording** uses the engine the class was recorded with; if that engine cannot run now, the page says so and offers the other one as a separate button. Only you choose the engine: the assistant in the main chat cannot change it.

## Record a class

1. Open **Live class** in the sidebar, in the **Setup & manage** group.
2. Enter a **Class title**. If you leave it empty, StudyHub names the class "Live class recording" followed by the date and time.
3. Choose an **Audio source**: **Microphone (in-person class)** or **Tab / system audio (online class)**.
4. Optional: choose a **Course**. Open **Subject and terminology (optional)** to fill in **Subject** and **Terms (comma or line separated)**.
5. Optional, Gemini only: tick **Use paid key only** to skip the free Gemini key.
6. Click **Start recording**. For an online class, choose the tab where the class is playing in the browser's sharing dialog and turn on **Share tab audio**. StudyHub sends only the audio, never the picture.

Terms help recognition, translation and correction. StudyHub puts your terms first, then adds deck titles and question topics from the chosen course, up to 100 terms in total.

As the teacher speaks, the transcript fills in:

- Each sentence shows the original text first, with the Simplified Chinese translation below it. **Translating…** shows until the translation arrives.
- Text that is still being recognised appears at the bottom, followed by "…". You cannot select it yet.
- The translation is always Simplified Chinese, even when the interface is in English.
- **Following latest** keeps the newest sentence in view. When you scroll up, it changes to **Jump to latest**.

### If the browser refuses to share a tab

If you choose **Tab / system audio** and the browser refuses, the red message says which of these happened, and the buttons under it take the next step:

- **The sharing window opened and you closed it.** Click **Start recording** again, pick the tab and turn on **Share tab audio**.
- **No window opened at all (the refusal came within a fraction of a second).**
  - **In an app's built-in window** (an app that embeds a browser view): the app does not allow sharing, so trying again will not help. Click **Switch to microphone and start**, or open StudyHub in a separate Chrome or Edge window.
  - **Inside another page** whose permissions policy does not allow screen sharing: the same remedy.
  - **In a regular window on Windows or Linux:** sharing a tab normally needs no system permission. The usual cause is a work or school policy: type `chrome://policy` or `edge://policy` in the address bar and look for screen-capture entries. Click **Try sharing again** after it is changed, or use the microphone.
  - **On macOS:** open System Settings › Privacy & Security › Screen & System Audio Recording, turn on the switch for your browser, quit the browser completely, open it again, then click **Try sharing again**.

**What the browser reported**, under the message, lists what StudyHub observed: the browser, the system, whether this is a standalone page, an embedded one or an app's window, whether the permissions policy allows sharing, and how many milliseconds after your click the refusal came. Include it if you ask for help.

The microphone source needs no sharing permission: play the class through the speakers and the microphone picks it up (headphones will not work).

### Record the computer's sound without sharing (Windows)

Inside an app window that cannot share, you can still record what the computer plays, because Windows can offer it as a recording device:

1. Right-click the speaker icon in the taskbar, open **Sound settings**, then **More sound settings**, and go to the **Recording** tab.
2. Look for **Stereo Mix**. If it is not listed, right-click an empty area and tick **Show Disabled Devices**, then right-click **Stereo Mix** and choose **Enable**.
3. Right-click **Stereo Mix** and choose **Set as Default Device**.
4. In **Live class**, choose **Microphone (in-person class)** and click **Start recording**. StudyHub now hears what the computer plays, with no speakers and no microphone noise.
5. When the class is over, set your real microphone as the default recording device again. While Stereo Mix is the default, meeting software hears the computer's sound instead of your voice.

**Stereo Mix only mixes what the sound card itself plays.** If the class plays through Bluetooth headphones (a separate device), use a virtual cable such as VB-Audio Virtual Cable instead: set the class's output to **CABLE Input** (the browser or system output), set **CABLE Output** as the default recording device, and to hear the class open the properties of **CABLE Output**, go to **Listen**, tick **Listen to this device** and choose your headphones.

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
- Each request shows **Queued**, **Working**, **Completed** or **Retry available**. Click **Retry historical correction** to run the failed ones again.
- Before merging a result, StudyHub checks that the sentences have not changed since the request. Stale, timed-out (after 60 seconds) and failed results are not merged and stay available for retry. They are never reported as done.

The model that runs it follows **Model for proofreading and translation** (see [Settings](#settings)):

- **Gemini:** a direct Gemini call. No DSH subagent is involved.
- **StudyHub's generation model:** a DSH subagent that has no tools and cannot delegate further. If DSH cannot run subagents, StudyHub calls the same model directly. Once a subagent has started, a failure does not switch to another route; the request is kept for retry.

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
- In **Archived classes**, use **Open**, **Restore** or **Delete**. Delete asks nothing: the class leaves the list and a notice offers **Undo** for about 8 seconds; the transcript, translation and class notes are deleted when that notice leaves (sources you saved from the class stay).
- To continue an archived class, restore it first.
- Permanent deletion removes the class's transcript, translations and class notes, and cannot be undone. Sources you saved from the class stay in the library.

In the main chat, StudyHub can also list your classes, read a class's transcript and translation, and save a finished class as sources. Recording itself starts only on the **Live class** page.

## Settings

Live class uses the engine choice, the Gemini keys and the models in **Settings › Audio transcription**. The model options are under **Advanced › Expert options**.

| Setting | Options and effect |
| --- | --- |
| **Which engine live classes use** | **Automatic (recommended)**: Gemini when a Gemini key is set, the local engine otherwise. **Local transcription (audio stays here)** or **Gemini (cloud)**: always that engine; a class that cannot use it says why instead of using the other one. The local engine's card (install, progress, remove) is under the choice. |
| **Model for proofreading and translation** | **Automatic (StudyHub's generation model when there is one, otherwise Gemini)** is the default. The other options are **Gemini (free first, then paid)** and **StudyHub's generation model (follows the main chat by default)**. Live translation, context correction and historical correction follow this choice. |
| **Live transcription model** | The Gemini live model. Default `gemini-3.5-transcribe-live`. |
| **Live translation model** | The Gemini model for live translation and context correction. Default `gemini-3.5-flash-lite`. Hidden when **StudyHub's generation model (follows the main chat by default)** is selected. |
| **Reasoning strength of live class context correction** | The current model's own levels or **Model default**; **Low** by default. A strength the model does not offer maps to the nearest level and the list says so. Applies to context correction and historical correction. |
| **Gemini paid key (optional)** | Directly under **Advanced**. Used when the free allowance runs out, or always with **Use paid key only**. |

How the reasoning setting is applied:

- On StudyHub's generation model, correction never inherits a higher reasoning level from the main chat. If the model has no low level, it uses its default.
- On Gemini, Gemini 3 models get a low thinking level and Gemini 2.5 models a small thinking budget. Other models use their defaults.

## Costs, keys and privacy

- Live class uses the free Gemini key first. It switches to the paid key when the free allowance runs out or is rate-limited, and tries the other key if one is rejected. These switches appear under **Connection and quota notices**.
- **Use paid key only** skips the free key for transcription, translation and correction.
- **Estimated paid transcription**, at the bottom of the page, covers paid transcription only. It excludes translation and correction.
- Correction on StudyHub's generation model is billed by your provider through DSH. It is not counted in the Gemini figures.
- Correction requests share a fixed prompt prefix, so the provider can reuse its cache, and StudyHub records the cached input tokens the provider reports. A local cache also reuses up to 8 identical results. Cache hits and discounts are not guaranteed, and StudyHub creates no separately billed explicit cache.
- With local transcription the audio is not uploaded and nothing is billed for it: the class shows no free or paid minutes. Translation and polishing, if a text model is set up, send the text to that model's provider.
- Keys stay in the audio settings file on this computer. They never travel in the browser's audio messages and are never written into a class file. Do not paste keys into the main chat.

## Storage and recovery

- Each class is saved in the current library as `live/<id>.json`. Raw audio is never saved.
- StudyHub saves about 3 seconds after each change, one save at a time. If a save fails, the page says so and the text stays in memory.
- A crash or power loss can lose the last few unsaved seconds. Because the audio is not kept, those seconds cannot be recovered.
- After you close the page, unfinished translation and correction keep running in StudyHub's backend.
- After DSH restarts, unfinished translations show as failed and interrupted historical requests show **Retry available**; retry them from the page. Notes, the correction position, historical requests and the archive status are kept.
- **Continue recording** and deletion first wait for pending processing and saves. This stops an old copy from overwriting a resumed class or bringing back a deleted one.
- Class files are kept apart from the library's main data, so they are not sources and are not in library backups. Click **Save as source** to turn a class into ordinary sources.

## How it works

- **Capture.** In the browser, an AudioWorklet mixes the input to mono and converts it to 16 kHz, 16-bit little-endian PCM, in frames of about 100 ms. The microphone uses echo cancellation and noise suppression. The worklet source is kept as a literal string so that production minification cannot break it.
- **Connection.** StudyHub's backend holds the WebSocket to Gemini Live and sends audio only after Google confirms the setup. A connection lasts at most 10 minutes, so StudyHub opens the next one at 8 minutes 45 seconds, or earlier if Google announces a close. Final text from the old connection appears before text from the new one.
- **Reconnecting.** Switching connections is not server-side session resumption, and a failure can lose words that were not yet final. After a drop, StudyHub reconnects with increasing waits and buffers at most the last 30 seconds of audio. If it cannot reconnect, the status changes to **Disconnected**; the text so far is saved, and you can click **Continue recording**.
- **Local engine.** A worker thread runs the recognizer. A loopback socket speaks the same messages as Gemini Live, so the session, the page and saved classes work the same way. The voice detector ends a sentence after 0.5 seconds of silence; the sentence in progress is decoded about every 0.6 seconds for the grey line. There is no 10-minute limit and no hand-over.
- **Time stamps.** The time beside each sentence counts the audio recorded so far, without pauses. Use it to find your place; it is not a word-level timestamp.
- **Translation.** Sentences are translated in order, up to 6 sentences or 900 characters per request, with the 3 previous translated sentences as context. Each sentence gets up to 3 attempts. The translator is asked to write a key term as 中文（English term） the first time it appears.

## Verification status

- Simulated WebSocket and model tests cover transcription, translation, free/paid switching, connection loss and rotation, persistence, recovery, question selection, stopping and retries.
- Browser checks with synthetic audio and simulated live responses exercise the real AudioWorklet, pause, page navigation, track release and saving.
- Not yet verified: real Gemini recognition quality, latency and billing, and the microphone and screen-sharing permissions inside DSH. Optional DSH SDK checks were skipped where the SDK was unavailable.
- Local engine: tests with a stand-in engine in a real worker thread cover partial and final sentences, the end of a stream and a broken engine; the install is tested with a stand-in download for checksum mismatches, resuming a `.part` file and pausing. On Windows x64 the real install (about 2 minutes) and a real class from synthetic Chinese and English speech were run with `scripts/live-local-smoke.mjs`. Not yet verified: macOS and Linux, a real microphone in DSH, and accuracy on real lectures.

See [verification](verification.md) for the records.

## References

- [Google live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe)
- [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia). Whether audio can be shared depends on the platform and on what you share.
