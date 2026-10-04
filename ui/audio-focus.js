/* "Open audio settings" from another page: Settings opens the audio category, the section scrolls into view and focuses its first empty key.
   One flag in its own module, so the Settings page can ask whether a request is pending without loading the audio pane. */
let requested = false;
export const requestAudioSettingsFocus = () => { requested = true; };
/** Has another page asked for the audio key? */
export const audioFocusPending = () => requested;
/** The audio section took the request (it scrolled and focused). */
export const takeAudioSettingsFocus = () => { const was = requested; requested = false; return was; };
