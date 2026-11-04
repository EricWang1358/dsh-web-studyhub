/* "Open audio settings" from another page: Settings opens the audio category, the section scrolls into view and focuses its first empty key.
   One flag in its own module, so the Settings page can ask whether a request is pending without loading the audio pane. */
let requested = false, target = '';
/** `field` names a field of the audio section to scroll to instead of the first empty key (a data-tour id, e.g. settings-live-pause). */
export const requestAudioSettingsFocus = (field = '') => { requested = true; target = typeof field === 'string' ? field : ''; };
/** Has another page asked for the audio key? */
export const audioFocusPending = () => requested;
/** The field the pending request names, or '' (the section's first empty key). */
export const audioFocusTarget = () => target;
/** The audio section took the request (it scrolled and focused). */
export const takeAudioSettingsFocus = () => { const was = requested; requested = false; target = ''; return was; };
/** The click handler of every "audio settings" link: ask for the audio section (or one field of it), then open Settings (undefined when the page cannot navigate). */
export const openAudioSettings = (openSettings, field = '') => (openSettings ? () => { requestAudioSettingsFocus(field); openSettings(); } : undefined);
