import { uploadInChunks } from '../upload.js';

/* The audio form's way of getting browser files to the host: one transfer at a time through `audio.upload.*`
   (ui/upload.js owns the protocol), the progress row, cancelling, and which uploads the form still owns.
   No React: ui/audio/useAudioUpload.js binds it to the form and tests/wpx-audio-split.test.mjs drives it directly.

   An upload belongs to the form until an import takes it over (claim) or the form lets it go (release / dispose);
   the host drops what nobody claims. */

// The host's own piece size (lib/audio-upload.js UPLOAD_CHUNK_BYTES): a host that names a smaller one is obeyed.
const PIECE_CAP = 3 * 1024 * 1024;

export function createAudioUploader({ call, onFile, maxChunkBytes = PIECE_CAP }) {
  let state = { upload: null }, sending = false, cancelled = false, controller = null, openId = '';
  const pending = new Set(), listeners = new Set();
  const set = (upload) => { state = { upload }; for (const listener of [...listeners]) listener(); };
  const hostCancel = (uploadId) => { if (uploadId && call) void Promise.resolve(call('audio.upload.cancel', { uploadId })).catch(() => {}); };

  /** Run `task(cancelled)` if nothing else is running; resolves whether it ran. `cancelled()` turns true after cancel() or dispose(). */
  async function run(task) {
    if (sending) return false;
    sending = true;
    cancelled = false;
    try { await task(() => cancelled); return true; }
    finally { sending = false; }
  }

  return {
    getState: () => state,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    isBusy: () => sending,
    pendingIds: () => pending,
    run,

    /** Upload each file in turn and hand each finished one to `onFile({ kind: 'upload', uploadId, name, size })`. */
    sendFiles: (files) => run(async (isCancelled) => {
      controller = new AbortController();
      let current;
      try {
        for (const chosen of files) {
          current = chosen;
          if (isCancelled()) throw new Error('cancelled');
          set({ name: chosen.name, size: chosen.size, sent: 0 });
          let finished;
          try {
            finished = await uploadInChunks(call, 'audio', chosen, { signal: controller.signal, maxChunkBytes,
              onStart: (started) => { openId = started.uploadId; pending.add(openId); },
              onProgress: (_fraction, sent) => { if (state.upload) set({ ...state.upload, sent }); } });
          } catch (failure) {
            // uploadInChunks has already told the host to drop its copy.
            pending.delete(openId);
            openId = '';
            throw failure;
          }
          if (isCancelled()) throw new Error('cancelled');
          onFile({ kind: 'upload', uploadId: finished, name: chosen.name, size: chosen.size });
          openId = '';
        }
        set(null);
      } catch (error) {
        hostCancel(openId);
        pending.delete(openId);
        openId = '';
        set(isCancelled() ? null : { name: current?.name, size: current?.size, sent: 0, error: String(error?.message || error) });
      }
    }),

    /** Stop the transfer in progress (it is not an error). */
    cancel() { cancelled = true; controller?.abort(); },
    /** Close the error row so the learner can choose again. */
    dismiss() { set(null); },
    /** An import took these uploads over: the form no longer owns them. */
    claim(uploadIds) { for (const id of uploadIds) pending.delete(id); },
    /** The learner removed this file from the list: drop the host's copy. */
    release(uploadId) { pending.delete(uploadId); hostCancel(uploadId); },
    /** The form is gone: stop transferring and drop every upload nobody claimed. */
    dispose() {
      cancelled = true;
      controller?.abort();
      for (const id of pending) hostCancel(id);
      pending.clear();
    },
  };
}
