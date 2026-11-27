import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

/* The CI gates decide whether a main-product change may merge. StudyHub Spring is a beta experiment, so its workflow may block only
   changes to Spring itself, and a release of the main product must never build Spring installers. These tests run the workflow's own
   shell steps (as GitHub's `bash -e` does) and evaluate its own release condition. */

const root = fileURLToPath(new URL('../', import.meta.url));
const workflow = name => parse(readFileSync(join(root, '.github', 'workflows', name), 'utf8'));
const verify = workflow('verify.yml');
const spring = workflow('spring-platform.yml');

/** GitHub's Windows runners and Git for Windows ship bash next to git; elsewhere it is on PATH. */
function findBash() {
  if (process.platform !== 'win32') return 'bash';
  const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim();
  const candidate = exec ? resolve(exec, '..', '..', '..', 'bin', 'bash.exe') : '';
  return candidate && existsSync(candidate) ? candidate : null;
}
const bash = findBash();
const noBash = bash ? false : 'needs Git for Windows bash';

function runStep(script, env, cwd = root) {
  const result = spawnSync(bash, ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd, encoding: 'utf8', env: { ...process.env, ...env }, windowsHide: true,
  });
  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

const gateStep = verify.jobs.verify.steps.find(step => step.name === 'Lint and every test shard passed');
const passingPullRequest = {
  EVENT: 'pull_request', LINT: 'success', TEST: 'success', TEST_WIN: 'skipped', WIN_SMOKE: 'success', TUI_TEST: 'success',
  TUI_WIN_SMOKE: 'success', BROWSER: 'success', SPRING: 'success', SPRING_REQUIRED: 'false',
};

test('the verify gate reads whether Spring blocks this change from the Spring workflow itself', () => {
  assert.equal(gateStep.env.SPRING_REQUIRED, '${{ needs.spring.outputs.required }}');
  assert.equal(spring.on.workflow_call.outputs.required.value, '${{ jobs.inputs.outputs.required }}');
  assert.equal(spring.jobs.inputs.outputs.required, '${{ steps.changes.outputs.required }}');
});

test('a failing Spring run is reported but does not fail verify for a change outside Spring', { skip: noBash }, () => {
  const result = runStep(gateStep.run, { ...passingPullRequest, SPRING: 'failure', SPRING_REQUIRED: 'false' });
  assert.equal(result.code, 0, result.out);
  assert.match(result.out, /::warning title=StudyHub Spring/);
  assert.equal(runStep(gateStep.run, { ...passingPullRequest, SPRING: 'cancelled', SPRING_REQUIRED: 'false' }).code, 0);
});

test('Spring blocks verify when the change touches Spring, or when the Spring workflow could not say', { skip: noBash }, () => {
  assert.notEqual(runStep(gateStep.run, { ...passingPullRequest, SPRING: 'failure', SPRING_REQUIRED: 'true' }).code, 0);
  assert.notEqual(runStep(gateStep.run, { ...passingPullRequest, SPRING: 'failure', SPRING_REQUIRED: '' }).code, 0);
  assert.equal(runStep(gateStep.run, { ...passingPullRequest, SPRING: 'success', SPRING_REQUIRED: 'true' }).code, 0);
});

test('the main-product jobs, the Linux browser job included, still block verify', { skip: noBash }, () => {
  assert.equal(runStep(gateStep.run, passingPullRequest).code, 0);
  for (const failed of ['LINT', 'TEST', 'TUI_TEST', 'BROWSER', 'WIN_SMOKE', 'TUI_WIN_SMOKE']) {
    assert.notEqual(runStep(gateStep.run, { ...passingPullRequest, [failed]: 'failure' }).code, 0, failed);
  }
  const mainPush = { ...passingPullRequest, EVENT: 'push', TEST_WIN: 'success', WIN_SMOKE: 'skipped', TUI_WIN_SMOKE: 'skipped' };
  assert.equal(runStep(gateStep.run, mainPush).code, 0);
  assert.notEqual(runStep(gateStep.run, { ...mainPush, TEST_WIN: 'failure' }).code, 0);
});

test('the workflow wall time, queueing included, is reported and never fails verify', { skip: noBash }, t => {
  const step = verify.jobs.verify.steps.find(candidate => candidate.name?.startsWith('Measure workflow wall time'));
  const dir = mkdtempSync(join(tmpdir(), 'studyhub-wall-time-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const fakeGh = join(bin, 'gh');
  writeFileSync(fakeGh, '#!/bin/sh\n[ -n "$FAKE_GH_FAIL" ] && exit 1\necho "$FAKE_STARTED"\n');
  chmodSync(fakeGh, 0o755);
  const summary = join(dir, 'summary.md');
  const env = {
    PATH: `${bin}${delimiter}${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary,
    GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '1', GITHUB_RUN_ATTEMPT: '1', GH_TOKEN: 'unused',
  };

  const slow = runStep(step.run, { ...env, FAKE_STARTED: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(slow.code, 0, slow.out);
  assert.match(slow.out, /::warning title=Workflow wall time::/);
  assert.match(readFileSync(summary, 'utf8'), /\b36\d\ds\b/);

  const fast = runStep(step.run, { ...env, FAKE_STARTED: new Date(Date.now() - 60_000).toISOString() });
  assert.equal(fast.code, 0, fast.out);
  assert.doesNotMatch(fast.out, /::warning/);

  const unreadable = runStep(step.run, { ...env, FAKE_GH_FAIL: '1' });
  assert.equal(unreadable.code, 0, unreadable.out);
  assert.match(unreadable.out, /::warning title=Workflow wall time::/);
});

test('the Spring change detector says build for anything Spring ships with, and blocking only for Spring itself', { skip: noBash }, t => {
  const step = spring.jobs.inputs.steps.find(candidate => candidate.id === 'changes');
  const repo = mkdtempSync(join(tmpdir(), 'studyhub-spring-changes-'));
  t.after(() => rmSync(repo, { recursive: true, force: true, maxRetries: 3 }));
  const git = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...args], { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const put = (file, text) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  };
  git('init', '-q');
  for (const file of ['packages/studyhub-spring/pom.xml', '.github/workflows/spring-platform.yml', 'lib/service.js', 'docs/notes.md']) put(file, 'v1\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const detect = (file, baseSha = base) => {
    git('checkout', '-q', '--detach', base);
    if (file) {
      put(file, 'v2\n');
      git('commit', '-q', '-am', `change ${file}`);
    }
    const output = join(repo, '..', `${repo.split(/[\\/]/).pop()}-output`);
    writeFileSync(output, '');
    t.after(() => rmSync(output, { force: true }));
    const result = runStep(step.run, { BASE: baseSha, GITHUB_OUTPUT: output }, repo);
    assert.equal(result.code, 0, result.out);
    return Object.fromEntries(readFileSync(output, 'utf8').trim().split(/\r?\n/).map(line => line.split('=')));
  };

  assert.deepEqual(detect('packages/studyhub-spring/pom.xml'), { build: 'true', required: 'true' });
  assert.deepEqual(detect('.github/workflows/spring-platform.yml'), { build: 'true', required: 'true' });
  assert.deepEqual(detect('lib/service.js'), { build: 'true', required: 'false' }, 'a shared-code change still exercises Spring, without blocking');
  assert.deepEqual(detect('docs/notes.md'), { build: 'false', required: 'false' });
  assert.deepEqual(detect(null, ''), { build: 'true', required: 'false' }, 'a release or manual run has no base and builds');
});

/** GitHub's tag filter: `*` is any run of characters but `/`, `[0-9]` a class. */
const tagFilter = pattern => new RegExp(`^${pattern.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
const mainReleaseTags = ['release.yml', 'release-desktop.yml'].flatMap(name => workflow(name).on.push.tags).map(tagFilter);
const springTag = 'spring-v0.1.0-beta.1';

test('only a Spring prerelease builds Spring installers; a main-product release never does', () => {
  const condition = spring.jobs.inputs.if;
  // The condition is GitHub expression syntax that is also valid JavaScript once startsWith is supplied (case-insensitive, like GitHub's).
  const evaluate = new Function('github', 'startsWith', `return Boolean(${condition});`);
  const startsWith = (text, prefix) => String(text).toLowerCase().startsWith(String(prefix).toLowerCase());
  const release = (tag_name, prerelease) => evaluate({ event_name: 'release', event: { release: { tag_name, prerelease } } }, startsWith);
  assert.equal(release('v4.16.0', false), false);
  assert.equal(release('v5.0.0-rc.1', true), false, 'a main-product prerelease is not Spring');
  assert.equal(release(springTag, false), false, 'a Spring tag published as a full release is refused');
  assert.equal(release(springTag, true), true);
  for (const event_name of ['pull_request', 'push', 'workflow_dispatch']) assert.equal(evaluate({ event_name, event: {} }, startsWith), true, event_name);
  for (const [name, job] of Object.entries(spring.jobs)) {
    if (name !== 'inputs') assert.ok([job.needs].flat().includes('inputs'), `${name} runs only after the release guard`);
  }
});

test('the Spring tag scheme never starts a main-product release', () => {
  assert.ok(mainReleaseTags.every(filter => filter.test('v4.16.0')), 'the filters are read as GitHub reads them');
  assert.ok(mainReleaseTags.every(filter => !filter.test(springTag)));
});
