/* Import failures the panel explains in its own words. The host keeps its message (logs, tools and older panels read it)
   and adds a stable code and, when a limit was the reason, that limit: bytes for a size, a count of pages or characters.
   The panel maps code -> copy and prints the number it was sent (ui/ImportHub.jsx), so a limit changed here changes
   what the learner reads. Codes are lower-case words joined by "-", the only shape lib/host.js lets through to the panel.
   Word and PowerPoint files fail with OfficeFileError (lib/office/zip.js), which carries its own code ('corrupt',
   'encrypted', 'zip64', 'bomb', ...); the panel maps those too.
   Pure data (no Node imports): the panel and the host import the same module. */

export const IMPORT_ERROR = Object.freeze({
  PDF_INVALID: 'pdf-invalid',
  DOCUMENT_TOO_LARGE: 'document-too-large',
  OFFICE_TOO_LARGE: 'office-too-large',
  TOO_MANY_PAGES: 'pdf-too-many-pages',
  TEXT_TOO_LONG: 'text-too-long',
  NOT_UTF8: 'text-not-utf8',
  UNSUPPORTED_FORMAT: 'format-unsupported',
  UPLOAD_INCOMPLETE: 'upload-incomplete',
});

/** An Error with the host's wording plus `code` and, for a limit, `limit`. */
export const importError = (message, code, limit) => Object.assign(new Error(message), { code, ...(limit === undefined ? {} : { limit }) });
