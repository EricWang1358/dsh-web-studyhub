/* The wording a translation job says on its own account when the runtime (not the waves) stops it. Source text is the English the in-process path
   already used; the interface translates it like every other translation message. */
/** What the card says from the moment a stop is asked until the waves have ended (the job table's own words for it). */
export const TRANSLATION_STOPPING = 'Stopping; translated paragraphs are kept';
export const TRANSLATION_STOP_MESSAGES = Object.freeze({
  'user-cancel': 'Translation stopped; translated paragraphs are kept',
  unloaded: 'Translation stopped because the plugin was unloaded; translated paragraphs are kept',
});
