import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { publishDecision, releaseAssetNames, runPublish } from '../scripts/release-publish.mjs';
import { retrievalAssetName, retrievalChecksumsName } from '../packages/studyhub-desktop/scripts/pack-retrieval.mjs';

/* 5.4.2: release.yml published the release (plugin packages only) about 20 minutes before release-desktop.yml uploaded the
   installers and latest.json. In that window desktop 5.4.1 announced 5.4.2 and its one-click update failed on a 404 manifest.
   The release must stay a draft until every asset is attached, and only scripts/release-publish.mjs may publish it. */

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = name => parse(readFileSync(join(root, '.github', 'workflows', name), 'utf8'));
const release = workflow('release.yml');
const desktop = workflow('release-desktop.yml');
const steps = flow => Object.values(flow.jobs).flatMap(job => job.steps.map(step => ({ ...step, job })));
const runOf = step => String(step.run || '');
const PUBLISH_SCRIPT = 'scripts/release-publish.mjs';

const VERSION = '5.4.3', TAG = `v${VERSION}`;
const assets = names => names.map(name => ({ name }));

test('a release carries 19 assets: the 11 release.yml checks and the 8 release-desktop.yml checks', () => {
  const names = releaseAssetNames(VERSION);
  assert.equal(names.plugin.length, 11);
  assert.equal(names.desktop.length, 8);
  assert.equal(new Set(names.all).size, 19);
  assert.match(runOf(steps(release).find(step => runOf(step).includes('"${#ASSETS[@]}" -ne 11'))), /ASSETS=/, 'release.yml still counts its 11 assets');
  assert.equal(names.plugin.filter(name => name.endsWith('.tgz')).length, 8, 'eight archives, as scripts/qa/release-artifacts.mjs checks');
  assert.ok(names.desktop.includes('latest.json'));
  assert.ok(names.desktop.includes(retrievalAssetName(VERSION)) && names.desktop.includes(retrievalChecksumsName(VERSION)));
  // Every desktop name is one the attach step's own filter uploads.
  const attach = steps(desktop).find(step => runOf(step).includes('Get-ChildItem -Path "packages/studyhub-desktop/dist/release"'));
  const filter = new RegExp(/-match '([^']+)' }\s*\n\s*\$assets =/.exec(runOf(attach))[1]);
  for (const name of names.desktop) assert.match(name, filter, `${name} is uploaded by release-desktop.yml`);
});

test('a draft is published only when all 19 assets are there, latest.json included; a published release is left alone', () => {
  const { plugin, desktop: desk, all } = releaseAssetNames(VERSION);
  assert.equal(publishDecision({ isDraft: true, assets: assets(plugin) }, VERSION).action, 'wait', 'plugin assets alone (5.4.2 at 14:50)');
  const noManifest = publishDecision({ isDraft: true, assets: assets(all.filter(name => name !== 'latest.json')) }, VERSION);
  assert.deepEqual(noManifest, { action: 'wait', missing: ['latest.json'] });
  assert.equal(publishDecision({ isDraft: true, assets: assets(desk) }, VERSION).action, 'wait', 'desktop first: waits for release.yml');
  assert.deepEqual(publishDecision({ isDraft: true, assets: assets(all) }, VERSION), { action: 'publish', missing: [] });
  assert.equal(publishDecision({ isDraft: true, assets: assets(releaseAssetNames('5.4.2').all) }, VERSION).action, 'wait', 'assets of another version do not count');
  assert.equal(publishDecision({ isDraft: false, assets: assets(plugin) }, VERSION).action, 'published');
  assert.equal(publishDecision(null, VERSION).action, 'wait');
});

function fakeGh(states) {
  const calls = [];
  let at = 0;
  const gh = async args => {
    calls.push(args);
    if (args[1] === 'view') return JSON.stringify(states[Math.min(at++, states.length - 1)]);
    if (args[1] === 'edit') return '';
    throw new Error(`unexpected gh ${args.join(' ')}`);
  };
  return { gh, calls, edits: () => calls.filter(args => args[1] === 'edit') };
}

test('runPublish edits only a complete draft, with --draft=false --latest, and verifies the result', async () => {
  const { all, plugin } = releaseAssetNames(VERSION);
  const log = () => {};
  const waiting = fakeGh([{ isDraft: true, assets: assets(plugin) }]);
  assert.equal((await runPublish({ tag: TAG, repo: 'o/r', gh: waiting.gh, log })).action, 'wait');
  assert.deepEqual(waiting.edits(), []);

  const done = fakeGh([{ isDraft: false, assets: assets(all) }]);
  assert.equal((await runPublish({ tag: TAG, repo: 'o/r', gh: done.gh, log })).action, 'published');
  assert.deepEqual(done.edits(), [], 'an old tag re-run is not marked latest again');

  const ready = fakeGh([{ isDraft: true, assets: assets(all) }, { isDraft: false, assets: assets(all) }]);
  assert.equal((await runPublish({ tag: TAG, repo: 'o/r', gh: ready.gh, log })).action, 'publish');
  assert.deepEqual(ready.edits(), [['release', 'edit', TAG, '-R', 'o/r', '--draft=false', '--latest']]);

  const stuck = fakeGh([{ isDraft: true, assets: assets(all) }, { isDraft: true, assets: assets(all) }]);
  await assert.rejects(runPublish({ tag: TAG, repo: 'o/r', gh: stuck.gh, log }), /did not verify/);
  await assert.rejects(runPublish({ tag: 'spring-v0.1.0-beta.1', gh: ready.gh, log }), /vX\.Y\.Z/);
});

test('both release workflows create the release as a draft and never publish it themselves', () => {
  for (const [name, flow] of [['release.yml', release], ['release-desktop.yml', desktop]]) {
    const all = steps(flow);
    const creates = all.filter(step => /gh release create/.test(runOf(step)));
    assert.ok(creates.length > 0, `${name} can create the release`);
    for (const step of creates) {
      // A command continued with a trailing backslash is one command.
      const create = /gh release create[^\n]*/.exec(runOf(step).replace(/\\\s*\n/g, ' '))[0];
      assert.match(create, /--draft(?![=\w-])/, `${name} › ${step.name} creates a draft`);
      assert.match(create, /--verify-tag/, `${name} › ${step.name} keeps --verify-tag`);
      assert.doesNotMatch(create, /--latest/, `${name} › ${step.name}`);
    }
    // The publish step too: it only runs the script, which decides.
    for (const step of all) {
      assert.doesNotMatch(runOf(step), /--draft=false|--latest|draft=false|make_latest/, `${name} › ${step.name} must not publish; ${PUBLISH_SCRIPT} does`);
    }
  }
});

test('release-desktop.yml publishes only after its asset check and the latest.json upload, under the same condition', () => {
  const build = desktop.jobs['build-release'].steps;
  const attachAt = build.findIndex(step => /\$hasLatestJson/.test(runOf(step)) && /gh release upload/.test(runOf(step)));
  const publishAt = build.findIndex(step => runOf(step).includes(PUBLISH_SCRIPT));
  assert.ok(attachAt >= 0, 'the attach step checks latest.json and uploads');
  assert.ok(publishAt > attachAt, 'the publish step comes after the attach step');
  assert.equal(build.filter(step => runOf(step).includes(PUBLISH_SCRIPT)).length, 1);
  assert.equal(build[publishAt].if, build[attachAt].if, 'no publish when the assets were not attached');
  assert.match(runOf(build[attachAt]), /throw "Expected desktop setup\.exe/, 'a missing desktop asset still fails before anything is uploaded');
  assert.ok(runOf(build[attachAt]).indexOf('throw "Expected desktop') < runOf(build[attachAt]).indexOf('gh release'), 'the asset check runs before gh');
  assert.match(runOf(build[publishAt]), /\$LASTEXITCODE -ne 0/, 'a failed publish fails the job');
});

test('release.yml publishes only after uploading and verifying its 11 assets', () => {
  const publish = release.jobs.publish.steps;
  const uploadAt = publish.findIndex(step => /gh release upload/.test(runOf(step)) && /Release verification failed/.test(runOf(step)));
  const publishAt = publish.findIndex(step => runOf(step).includes(PUBLISH_SCRIPT));
  assert.ok(uploadAt >= 0 && publishAt > uploadAt);
  assert.equal(publish.filter(step => runOf(step).includes(PUBLISH_SCRIPT)).length, 1);
  assert.doesNotMatch(runOf(publish[uploadAt]), /isDraft !== false/, 'the upload step accepts a draft');
  assert.match(runOf(publish[uploadAt]), /--notes-file "\$NOTES_FILE"/, 'the changelog stays the release notes');
});
