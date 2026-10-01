// Size limits per document format. One constant per format, shared by the
// server (lib/documents.js, lib/contexts/materials) and the import hub UI.
// Pure data: safe to bundle into the browser.

const MB = 1024 * 1024;

/** PDF and text documents. */
export const MAX_TEXT_DOCUMENT_BYTES = 8 * MB;

/**
 * Word and PowerPoint. Slides with pictures are large while only their text is
 * read. 40 MB keeps the base64 request (about 53 MB) under the 64 MB transport cap.
 */
export const MAX_OFFICE_BYTES = 40 * MB;

export const MAX_DOCUMENT_BYTES = Object.freeze({
  pdf: MAX_TEXT_DOCUMENT_BYTES, md: MAX_TEXT_DOCUMENT_BYTES, html: MAX_TEXT_DOCUMENT_BYTES, txt: MAX_TEXT_DOCUMENT_BYTES,
  docx: MAX_OFFICE_BYTES, pptx: MAX_OFFICE_BYTES,
});

/** The largest allowed file for a format (the text limit for unknown formats). */
export const maxBytesFor = format => MAX_DOCUMENT_BYTES[format] ?? MAX_TEXT_DOCUMENT_BYTES;

/** Whole megabytes, for messages: 8 -> "8 MB". */
export const megabytes = bytes => Math.round(bytes / MB);

export const OFFICE_FORMATS = Object.freeze(['docx', 'pptx']);
export const isOfficeFormat = format => OFFICE_FORMATS.includes(format);
