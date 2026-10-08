/* 备考补习: the create form, kept while the learner steps out to Settings (the model, or their defaults) and back. Opening Settings leaves the
   page, which drops the form's state; the page keeps the form here for the library it belongs to, and takes it back when it is opened again.
   It lives as long as the app session and no longer than KEEP_MS: a form left for an hour is not what the learner expects to find. */

export const KEEP_MS = 30 * 60 * 1000;

let kept = null;

/** Keep `state` ({ form, more }) for the library `root`. */
export const keepForm = (root, state, now = Date.now()) => { kept = { root, state, at: now }; };

/** The form kept for `root`, or null when there is none, it is another library's, or it is too old. */
export const keptForm = (root, now = Date.now()) => kept && kept.root === root && now - kept.at < KEEP_MS ? kept.state : null;

export const dropForm = () => { kept = null; };
