import { fieldTooLong, filesLimit, termsInvalid } from '../../audio-messages.js';

/* What an audio request may hold, in one place: the longest text of each field, and how many files one check looks at. */

/** The longest text (characters) a request may give for each field of an import. */
export const IMPORT_FIELD_LIMITS = Object.freeze({ title: 200, subject: 300, course: 200 });
/** Subtitle files add their file name; a live class adds the saved class it resumes. */
export const SUBTITLE_FIELD_LIMITS = Object.freeze({ filename: 300, ...IMPORT_FIELD_LIMITS });
export const LIVE_FIELD_LIMITS = Object.freeze({ ...IMPORT_FIELD_LIMITS, resumeId: 64 });
/** The most recordings one pre-flight check looks at. */
export const MAX_PREFLIGHT_FILES = 50;

/** Refuse a text field that is not a string or is longer than its limit. */
export function assertTextFields(args, limits = IMPORT_FIELD_LIMITS) {
  for (const [field, limit] of Object.entries(limits))
    if (args[field] !== undefined && (typeof args[field] !== 'string' || args[field].length > limit)) throw new Error(fieldTooLong(field, limit));
}
/** `terms` is one string or a list of them. */
export function assertTerms(args) {
  if (args.terms !== undefined && typeof args.terms !== 'string' && !Array.isArray(args.terms)) throw new Error(termsInvalid);
}
/** The list of files a pre-flight check is given. */
export function assertFileList(files) {
  if (!Array.isArray(files) || files.length > MAX_PREFLIGHT_FILES) throw new Error(filesLimit(MAX_PREFLIGHT_FILES));
}
