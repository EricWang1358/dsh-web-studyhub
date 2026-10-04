/* What a failure says, as plain text. Nothing here touches the interface language, so the logic modules that run (and are tested)
   in plain Node can use it; what reaches the learner goes through errorMessage (ui/i18n.js) or uiMessage on the way. */

/** The message of a thrown value, or the value itself as text; '' for nothing. */
export const failureText = (failure) => String(failure?.message || failure || '');
