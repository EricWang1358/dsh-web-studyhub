/* File names, whatever the platform wrote them with. */

/** The lower-case suffix with its dot (".mp3"); '' when the name has none, so a name without a dot is not its last letter. */
export const extensionOf = (name) => /\.[^./\\]+$/.exec(String(name || '').toLowerCase())?.[0] || '';

/** The last segment of a path written with / or \ ; '' for nothing. */
export const baseName = (path) => String(path || '').replace(/^.*[\\/]/, '');
