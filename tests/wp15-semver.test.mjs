/* WP15 · the version comparison behind the update check: semver 2.0 precedence,
   a leading "v" from release tags, and pre-release ordering. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, parseVersion, isNewerVersion } from '../lib/semver.js';

test('parses release tags with or without a leading v and rejects anything else', () => {
  assert.deepEqual(parseVersion('v2.1.0'), { major: 2, minor: 1, patch: 0, prerelease: [], text: '2.1.0' });
  assert.deepEqual(parseVersion('2.1.1-test.2+build.7'), { major: 2, minor: 1, patch: 1, prerelease: ['test', 2], text: '2.1.1-test.2' });
  for (const bad of ['', '2.1', 'v2', '2.1.x', 'latest', null, undefined, 3, '01.2.3', '2.1.0-'])
    assert.equal(parseVersion(bad), null, `${bad} is not a version`);
});

test('orders major, minor and patch numerically, not as text', () => {
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  assert.equal(compareVersions('v2.1.0', '2.1.0'), 0);
  assert.equal(compareVersions('2.1.1', '2.1.0'), 1);
  assert.equal(compareVersions('2.10.0', '2.9.9'), 1);
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1);
  assert.equal(compareVersions('1.4.6', '2.1.0'), -1);
});

test('a pre-release sorts below its release and pre-release identifiers follow semver precedence', () => {
  const ordered = ['2.1.0-alpha', '2.1.0-alpha.1', '2.1.0-alpha.beta', '2.1.0-beta', '2.1.0-beta.2', '2.1.0-beta.11', '2.1.0-rc.1', '2.1.0'];
  for (let i = 1; i < ordered.length; i++) {
    assert.equal(compareVersions(ordered[i], ordered[i - 1]), 1, `${ordered[i]} > ${ordered[i - 1]}`);
    assert.equal(compareVersions(ordered[i - 1], ordered[i]), -1, `${ordered[i - 1]} < ${ordered[i]}`);
  }
  assert.equal(compareVersions('2.1.1-test', '2.1.0'), 1, 'a pre-release of the next patch is newer than this release');
  assert.equal(compareVersions('2.1.0+build.1', '2.1.0+build.2'), 0, 'build metadata is ignored');
});

test('isNewerVersion is false for anything that cannot be compared', () => {
  assert.equal(isNewerVersion('2.1.1', '2.1.0'), true);
  assert.equal(isNewerVersion('2.1.0', '2.1.0'), false);
  assert.equal(isNewerVersion('2.0.9', '2.1.0'), false);
  assert.equal(isNewerVersion('nightly', '2.1.0'), false);
  assert.equal(isNewerVersion('2.1.1', ''), false);
  assert.throws(() => compareVersions('x', '2.1.0'), /version/);
});
