# Live classroom recording

[中文](live-class.zh-CN.md)

Open **Live class**. Use the microphone for in-person classes or **Tab / system audio** for online classes, enabling audio sharing in the browser picker. Only audio goes to transcription; screen images are not sent.

1. Configure Gemini keys in **Settings → Audio transcription**. Advanced settings independently select live transcription and translation models; translation can use the conversation model.
2. Enter a class name and, if useful, course context and terminology, then start recording.
3. Original text appears first, followed by Simplified Chinese translation. Provisional recognition cannot be selected for questions. This is an explicitly bilingual feature; English interface language does not remove its Chinese translation.
4. **Input volume** shows the device and relative outgoing PCM level. It distinguishes quiet input, device mute, capture interruption, missing frames, and excessive level. **Audio received** and **Backend received** are separate timings: upload acknowledgment does not prove Google has recognized text. Volume is neither calibrated decibels nor speech detection.
5. Select sentences, drag-select original/translated text, or choose **Latest 8 sentences**. With about 120 original characters, generate 1–15 questions while recording continues. Selected originals become citable source snapshots and use existing generation, review, and draft publication.
6. Pause stops uploads; End releases audio tracks. Switching plugin pages keeps recording active. Closing the page or switching libraries ends capture.
7. **View class notes**, above the transcript, shows cumulative summary, batch notes, and historical ambiguity correction. Sentence numbers jump to original text. After ending, save sources and a separate class note containing summary, notes, and citations. Terminology correction before saving is a background task. Failed translation can be retried separately.
8. Reopen, continue, or archive historical classes. Archived classes can be opened, restored, or permanently deleted. End an active recording before archiving; restore before continuing. Permanent deletion removes the live transcript, translation, and notes but keeps separately saved library sources.

## Contextual correction and notes

Every 30 seconds, a sequential check processes up to eight new sentences per batch with the prior batch's last two sentences as overlap. It drains the backlog present when the check began; arrivals join the next check and finalization handles the tail. No new sentences means no call. Failure retains the cursor and pending text. Coverage means submitted for correction, not guaranteed accuracy.

A solid green dot marks a corrected sentence; hover for its reason and expand the original recognition to compare. An empty green circle means checked without changes. No marker means not yet checked. Counts and the legend show these states. Markers identify high-confidence changes, not proof that other sentences are correct.

Correction reads nearby sentences, context, terminology, up to 1,600 characters of cumulative summary, and the last three notes. It updates batch notes and summary without resending the entire growing history. Only existing sentence IDs and high-confidence original/Simplified Chinese corrections are accepted. Original recognition remains folded for comparison. Earlier translation requests cannot overwrite corrected sentences. Previously selected generation sources remain independent snapshots.

For suspected mistakes outside the current window, the corrector queues specific old sentence IDs and doubts separately. One historical task runs at a time, checking at most 20 specified sentences with the triggering window as evidence; main correction does not wait. Native subagents have no write tools or further delegation. The backend validates sentence versions before merging. Stale, timed-out, or failed output remains retryable.

Historical correction follows the selected audio text-model route. Gemini uses Gemini directly; a host model prefers an official restricted subagent and uses a direct call to the same model when native capabilities are unavailable. Gemini keys alone do not supply a DSH subagent. Actual model/capability failures preserve retryable requests and are not presented as successful work. Once native work has started, failure does not trigger another execution route. Final save waits for active correction and lists unfinished historical requests in notes.

Correction reasoning defaults to `low`, with `default` available. Host models do not inherit high/max from a parent; unsupported low uses default. Gemini 3 uses low when supported. Calls use a fixed prompt prefix and record actual cached-input tokens; a local cache retains up to eight results. Cache hits/discounts are not guaranteed, and no separately billed explicit storage cache is created. Host subagent usage is excluded from Gemini correction counts.

Free/paid fallback follows audio settings, including paid-only mode. Displayed money estimates cover paid transcription, not text translation/correction. Keys stay on the backend and never travel in browser audio messages.

## Persistence and recovery

Records persist in the current library at `live/<id>.json`; raw audio is not saved. Saves execute in order and disk failures are visible. Crashes or power loss can lose the last unwritten seconds; complete audio recovery is not guaranteed.

Pending translation/correction can continue in memory after closure. After restart, unfinished work is retryable. Notes, correction cursor, historical tasks, and archival status persist. Continuing or deleting waits for pending processing/saves and prevents old instances from overwriting resumed or deleted records. Live files are separate from the library manifest; choose **Save as sources** for ordinary source export.

## Technical and verification limits

Browser AudioWorklet converts input to 16 kHz, 16-bit little-endian PCM, approximately 100 ms per frame. The backend waits for Gemini WebSocket setup before sending audio. Before the ten-minute connection limit, it starts another connection and presents old final text before new text.

Connection rotation is not server session resumption. Failure can lose unconfirmed words, and reconnect buffering is bounded. Time markers derive from accumulated sent audio and support navigation; they are not word-level timestamps.

Simulated WebSocket/model tests cover transcription, translation, provider fallback, connection loss/rotation, persistence, recovery, question selection, stopping, and retries. Browser checks use synthetic audio and simulated live responses to exercise real AudioWorklet, pause, navigation, track release, and saving. Historical checks did not establish real Gemini recognition quality, latency, billing, or DSH microphone/screen-sharing permissions; optional unavailable SDK checks were skipped.

References: [Google live transcription](https://ai.google.dev/gemini-api/docs/live-api/live-transcribe) and [MDN getDisplayMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia). Audio sharing depends on platform and selected source.
