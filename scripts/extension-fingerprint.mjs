/* Which search extension (packages/studyhub-retrieval) ships, as a fingerprint of the files a learner runs. Every release repacks the
   extension under its own version, so the version says nothing about whether its code changed; this does. The version field, line
   endings and the documentation (README, LICENSE) are left out, so a release's version bump, a Windows checkout or a README edit never
   asks anyone to update. lib/retrieval-extension.js EXTENSION_BUILD records the fingerprint and the first release that shipped it;
   tests/retrieval-extension-build.test.mjs and the release pack (scripts/release-alpha.mjs) check that record here. */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { compareVersions, parseVersion } from '../lib/semver.js';

const DOCUMENTATION = new Set(['README.md', 'LICENSE']);
const literal = text => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

/** The package's shipped files (its package.json `files`, a `*` allowed in the last segment) apart from the documentation, sorted. */
async function shippedFiles(dir, patterns) {
  const found = new Set(['package.json']);
  for (const pattern of patterns) {
    const folder = posix.dirname(pattern), name = posix.basename(pattern);
    if (!name.includes('*')) { found.add(pattern); continue; }
    const match = new RegExp(`^${name.split('*').map(literal).join('[^/]*')}$`);
    for (const entry of await readdir(join(dir, folder)).catch(() => [])) if (match.test(entry)) found.add(folder === '.' ? entry : `${folder}/${entry}`);
  }
  return [...found].filter(path => !DOCUMENTATION.has(path)).sort();
}

/** SHA-256 over the extension in `dir` as a learner runs it: package.json without its version, then each shipped file with LF line endings. */
export async function extensionFingerprint(dir) {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  const hash = createHash('sha256');
  for (const path of await shippedFiles(dir, manifest.files || [])) {
    let text;
    if (path === 'package.json') { const { version: _version, ...rest } = manifest; text = JSON.stringify(rest); }
    else {
      try { text = (await readFile(join(dir, path), 'utf8')).replace(/\r\n/g, '\n'); } catch { continue; }
    }
    hash.update(`${path}\0${text}\0`);
  }
  return hash.digest('hex');
}

/**
 * Why the extension in `dir` does not match `build` ({ since, fingerprint }) next to StudyHub `version`, or '' when it does.
 * `release`: `version` is being packed, so `since` may not be above it (every later release would then ask for an update of the same code).
 */
export async function extensionBuildProblem({ dir, build, version, release = false }) {
  const fingerprint = await extensionFingerprint(dir);
  const current = parseVersion(version);
  if (fingerprint !== build?.fingerprint) {
    const next = current ? `${current.major}.${current.minor}.${current.patch + 1}` : 'the next release';
    return `packages/studyhub-retrieval changed, so learners with the extension of an earlier release must update it. In lib/retrieval-extension.js set EXTENSION_BUILD to { since: '<the release that will ship it, above ${version}, e.g. ${next}>', fingerprint: '${fingerprint}' }.`;
  }
  if (!parseVersion(build.since)) return `EXTENSION_BUILD.since (${build.since}) is not a version.`;
  if (release && current && compareVersions(build.since, version) > 0)
    return `EXTENSION_BUILD.since is ${build.since}, above the release being packed (${version}). Set it to ${current.text}, the release that ships this extension.`;
  return '';
}
