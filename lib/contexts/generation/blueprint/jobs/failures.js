import { FAILURES } from './messages.js';

/* The failures of a build: each an Error with a code and a message in the learner's words (the console shows the message as it is). */
const coded = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

/** A chunk of paper or a window of slides the model gave no usable answer for, twice. */
export const unreadable = (input, where) => coded('blueprint-window-unreadable', FAILURES.unreadable(input.language, where));
export const noPoints = input => coded('blueprint-no-points', FAILURES.noPoints(input.language));
/** What was made did not pass the checks of the list (the English reason of the validator stays in `cause`, out of the learner's sight). */
export const saveInvalid = (input, cause) => coded('blueprint-save-invalid', FAILURES.saveInvalid(input.language), cause);
export const saveFailed = (input, cause) => coded('blueprint-save-failed', FAILURES.saveFailed(input.language), cause);
