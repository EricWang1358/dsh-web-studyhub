// @ts-check

/** @typedef {import('./contracts.js').LibraryPlace} LibraryPlace */

const DRIVE_LETTER_RE = /^([a-z]):(?![^\\/])/i;

/**
 * The drive letter a path starts with (`C` for `c:\x`), or '' for a network path, a path with no drive, or a drive-relative `C:x`.
 * @param {string} path
 * @returns {string}
 */
function driveLetterOf(path) {
  return DRIVE_LETTER_RE.exec(String(path ?? '').trim())?.[1].toUpperCase() ?? '';
}

/**
 * Is the library folder on the system drive? Both words are compared as drive letters, so `c:/x` is on `C:`, and `c:` or `C:` plus a slash name the same drive.
 * The system drive is injected (the entry reads it from the environment); with none named, nothing is on it.
 * @param {string} root
 * @param {string} systemDrive
 * @returns {boolean}
 */
export function isOnSystemDrive(root, systemDrive) {
  const system = driveLetterOf(systemDrive);
  return Boolean(system) && driveLetterOf(root) === system;
}

/**
 * Where the library lives, as the page needs it: has the learner settled it, and does it sit on the system drive.
 * The variable STUDYHUB_LIBRARY (`rootSource: 'config'`) decides the folder, so there is nothing to confirm then.
 * @param {{ confirmed: boolean, rootSource: string, root: string, systemDrive: string }} facts
 * @returns {LibraryPlace}
 */
export function libraryPlaceOf({ confirmed, rootSource, root, systemDrive }) {
  return { confirmed: confirmed === true || rootSource === 'config', onSystemDrive: isOnSystemDrive(root, systemDrive) };
}
