/** The `version` each single-file format of the library writes (job-archive.json, the PDF conversion manifest, marker-install.json), as release 2.7.1 wrote it
 * (tests/fixtures/release-2.7.1/stored-versions.json). A reader accepts these (a file with no `version` is an older v1) and refuses any other number: a later release's
 * file is not read as v1 and not written over as v1. */
export const STORED_VERSIONS = Object.freeze({ jobArchive: Object.freeze([1]), pdfConvertManifest: Object.freeze([1]), markerInstall: Object.freeze([1]) });

const LABELS = Object.freeze({ jobArchive: 'job archive', pdfConvertManifest: 'PDF conversion manifest', markerInstall: 'Marker install state' });

export class UnsupportedVersionError extends Error {
  constructor(format, version) {
    super(`This ${format} was written by a newer version of StudyHub (format version ${String(version).slice(0, 20)}); this version leaves it untouched`);
    this.name = 'UnsupportedVersionError'; this.code = 'unsupported-store-version'; this.format = format; this.version = version;
  }
}

/** Is `value.version` one this release writes (or absent)? */
export const knownVersion = (format, value) => !value || typeof value !== 'object' || value.version === undefined || STORED_VERSIONS[format].includes(value.version);

/** Throws UnsupportedVersionError for a file of a version this release does not know. */
export function assertKnownVersion(format, value) {
  if (!knownVersion(format, value)) throw new UnsupportedVersionError(LABELS[format], value.version);
  return value;
}
