import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const UI_BUILD_MARKER_PREFIX = 'studyhub-ui@';
export const UI_BUILD_MARKER_DEFINE = '__STUDYHUB_UI_BUILD__';
export const CLIENT_BUNDLE_NAME_RE = /^client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/;
export const PACKED_CLIENT_BUNDLE_RE = /^package\/lib\/client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/;

const UI_BUILD_MARKER_RE = /(?<![0-9A-Za-z._-])studyhub-ui@([0-9A-Za-z](?:[0-9A-Za-z.+-]*[0-9A-Za-z])?)/g;

/** Format the dedicated StudyHub UI build marker for a release version (`studyhub-ui@X.Y.Z`). */
export function uiBuildMarker(version) {
  const normalized = typeof version === 'string' ? version.trim() : '';
  assert.ok(normalized.length > 0, 'UI build marker version must be a non-empty string');
  return `${UI_BUILD_MARKER_PREFIX}${normalized}`;
}

/** Build-time esbuild `define` entry injecting the dedicated StudyHub UI marker (#1782). */
export function uiBuildDefine(version) {
  return { [UI_BUILD_MARKER_DEFINE]: JSON.stringify(uiBuildMarker(version)) };
}

/** Extract all distinct `studyhub-ui@<version>` markers emitted inside a JS bundle string. */
export function extractUiBuildMarkers(text) {
  const found = new Set();
  for (const match of String(text ?? '').matchAll(UI_BUILD_MARKER_RE)) {
    found.add(match[0]);
  }
  return [...found].sort();
}

/** Verify that compiled UI client bundles contain the expected `studyhub-ui@<version>` marker and zero stale/mismatched markers. */
export function assertUiBuildMarker(bundles, expectedVersion) {
  const expected = uiBuildMarker(expectedVersion);
  const items = Array.isArray(bundles) ? bundles : [...(bundles || [])];
  const matchedFiles = [];
  const mismatched = [];

  for (const item of items) {
    const file = item?.name ?? item?.path ?? '<unknown>';
    const markers = extractUiBuildMarkers(item?.text);
    for (const marker of markers) {
      if (marker === expected) matchedFiles.push(file);
      else mismatched.push(`${file}: ${marker}`);
    }
  }

  if (mismatched.length > 0) {
    assert.fail(
      `Stale or mismatched StudyHub UI build marker found in packaged client bundles: expected only "${expected}", `
      + `but found ${mismatched.join(', ')}. Run \`npm run build\` before packing.`
    );
  }
  if (matchedFiles.length === 0) {
    assert.fail(
      `Missing StudyHub UI build marker "${expected}" across ${items.length} checked client bundle(s). `
      + 'Packaged UI may be stale or built without the dedicated UI marker. Run `npm run build` before packing.'
    );
  }
  return { expected, matchedFiles, checkedFiles: items.length };
}

/** Verify the unpacked `@ericwang1358/dsh-daily-flashcard` workbench package contains `lib/client.js` and matching UI build markers across all `lib/client*.js` files. */
export async function verifyPackedWorkbenchBundle(packageRoot, archiveFiles, expectedVersion) {
  assert.ok(archiveFiles.includes('package/lib/client.js'), 'workbench archive includes built UI client bundle (package/lib/client.js)');
  const clientFiles = archiveFiles.filter(file => PACKED_CLIENT_BUNDLE_RE.test(file)).sort();
  const bundles = await Promise.all(clientFiles.map(async file => ({
    name: file,
    text: await readFile(join(packageRoot, file.slice('package/'.length)), 'utf8'),
  })));
  return assertUiBuildMarker(bundles, expectedVersion);
}
