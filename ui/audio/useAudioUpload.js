import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createAudioUploader } from './audio-upload.js';

/**
 * The audio form's uploads: `upload` is the progress row ({ name, size, sent } or { …, error }) or null. `onFile(entry)`
 * receives each finished upload. The verbs are those of createAudioUploader (sendFiles, run, cancel, dismiss, claim,
 * release, isBusy); leaving the form drops whatever it still owns on the host.
 */
export function useAudioUpload({ call, onFile }) {
  const latest = useRef(onFile);
  latest.current = onFile;
  const uploader = useMemo(() => createAudioUploader({ call, onFile: (file) => latest.current(file) }), [call]);
  useEffect(() => () => uploader.dispose(), [uploader]);
  const { upload } = useSyncExternalStore(uploader.subscribe, uploader.getState, uploader.getState);
  return { upload, sendFiles: uploader.sendFiles, run: uploader.run, cancel: uploader.cancel, dismiss: uploader.dismiss,
    claim: uploader.claim, release: uploader.release, isBusy: uploader.isBusy };
}
