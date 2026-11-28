/* scripts/qa/dsh-upgrade.mjs is the end-to-end proof of the in-app upgrade. It went stale without anyone noticing: its fake release was older than
   the package (so the update chip never appeared), it accepted one host release only, and it read the result after a fixed 1.5 s. These tests hold the
   parts of the proof that can be checked without DSH, against StudyHub's own update code. */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fakeRelease, hostProblem, installVerdict, noticeVerdict, offlineEnv, parseArgs, relabelRelease, runningBeforeRestart, systemTar, upgradeTestVersion }
  from "../scripts/qa/dsh-upgrade-checks.mjs";
import { isNewerVersion } from "../lib/semver.js";
import { releaseFromGithub, updateView } from "../lib/update-check.js";

const PACKAGE_VERSION = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;

test("the fake release is newer than the package under test, whatever its version is", () => {
  for (const current of [PACKAGE_VERSION, "5.4.0", "6.0.0-test", "10.2.3", "99.0.0"]) {
    const next = upgradeTestVersion(current);
    assert.ok(isNewerVersion(next, current), `${next} must be newer than ${current}`);
    // Marked -test, so the fake can never carry the number of a real release.
    assert.match(next, /^\d+\.0\.0-test$/, `${next} is marked as a test release`);
  }
  assert.throws(() => upgradeTestVersion("latest"), /version/i);
});

test("StudyHub's own update check offers the fake release to the package under test", () => {
  const version = upgradeTestVersion(PACKAGE_VERSION), name = `ericwang1358-dsh-daily-flashcard-${version}.tgz`;
  const release = releaseFromGithub(fakeRelease("https://github.com", version, name));
  assert.ok(release, "the fake GitHub answer is a release StudyHub reads");
  const view = updateView({ release }, PACKAGE_VERSION, PACKAGE_VERSION);
  assert.equal(view.newer, true, "so the update chip appears");
  assert.equal(view.upgradeAvailable, true);
  assert.equal(view.assetName, name);
  assert.ok(view.assetUrl && view.sha256Url, "one-click upgrade has both addresses");
});

test("tar is the Windows system tar on Windows (GNU tar from Git Bash reads D: as a remote host)", () => {
  assert.equal(systemTar({ platform: "win32", env: { SystemRoot: "C:\\Windows" } }), join("C:\\Windows", "System32", "tar.exe"));
  assert.equal(systemTar({ platform: "win32", env: {} }), join("C:\\Windows", "System32", "tar.exe"));
  assert.equal(systemTar({ platform: "linux", env: {} }), "tar");
  assert.equal(systemTar({ platform: "darwin", env: {} }), "tar");
});

test("the relabelled release differs in every shipped module, as a real release does", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studyhub-relabel-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib", "plugins"), { recursive: true });
  await mkdir(join(dir, "docs"), { recursive: true });
  const files = { "lib/index.js": "export const a = 1;\n//# sourceMappingURL=index.js.map", "lib/plugins/bank.mjs": "export const b = 2;\n",
    "lib/data.json": "{\"keep\":true}\n", "docs/install.md": "# keep\n" };
  for (const [path, text] of Object.entries(files)) await writeFile(join(dir, path), text);
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "5.4.0", dependencies: { yaml: "^2" } }));

  const stamped = await relabelRelease(dir, "6.0.0-test");

  assert.equal(stamped, 2);
  const manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  assert.equal(manifest.version, "6.0.0-test");
  assert.deepEqual(manifest.dependencies, { yaml: "^2" }, "nothing but the version changes in the manifest");
  for (const path of ["lib/index.js", "lib/plugins/bank.mjs"]) {
    const after = await readFile(join(dir, path), "utf8");
    assert.ok(after.startsWith(files[path]), `${path} keeps its code`);
    assert.match(after.slice(files[path].length), /6\.0\.0-test/, `${path} differs, so DSH sees a changed module`);
  }
  for (const path of ["lib/data.json", "docs/install.md"]) assert.equal(await readFile(join(dir, path), "utf8"), files[path]);
});

test("a package with no module to change is refused rather than proving an upgrade DSH would not notice", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "studyhub-relabel-empty-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "lib"), { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  await assert.rejects(relabelRelease(dir, "2.0.0-test"), /module/i);
});

const expected = { version: "6.0.0-test", packageName: "ericwang1358-dsh-daily-flashcard-6.0.0-test.tgz" };
const answered = (value) => ({ type: "server-response", result: { ok: true, value } });
const onDisk = { installed: expected.version, dependency: `file:/home/study/updates/${expected.packageName}` };
const installed = { status: "installed", version: expected.version, application: "applied", restartRequired: false };

test("the verdict is what the host answered to the click, confirmed on disk", () => {
  assert.deepEqual(installVerdict(answered(installed), onDisk, expected), { ok: true, application: "applied", restartRequired: false });
  assert.deepEqual(installVerdict(answered({ ...installed, application: "restart-required", restartRequired: true }), onDisk, expected),
    { ok: true, application: "restart-required", restartRequired: true });
});

test("a refusal, a transport error, an unfinished answer or a disk that disagrees fails the proof and says why", () => {
  const reason = (answer, disk = onDisk) => {
    const verdict = installVerdict(answer, disk, expected);
    assert.equal(verdict.ok, false, JSON.stringify(answer));
    return verdict.reason;
  };
  assert.match(reason(answered({ status: "failed", code: "UPDATE_INSTALL", kind: "network" })), /UPDATE_INSTALL.*network/);
  assert.match(reason({ result: { ok: false, error: { message: "plugin disposed" } } }), /plugin disposed/);
  assert.match(reason(answered({ status: "jobs-running", jobs: 2 })), /jobs-running/);
  // The host says it installed something, but not the release that was offered (the disk agrees with the offer).
  assert.match(reason(answered({ ...installed, version: "5.4.0" })), /installed 5\.4\.0, not 6\.0\.0-test/);
  assert.match(reason(answered(installed), { ...onDisk, installed: "5.4.0" }), /node_modules.*5\.4\.0/);
  assert.match(reason(answered(installed), { ...onDisk, dependency: "file:/pack/old-5.4.0.tgz" }), /dependency/);
  assert.match(reason(undefined), /no answer/i);
});

test("which code runs before the restart is read from Settings, and the restart chip must agree with it", () => {
  const versions = { before: "5.4.0", next: "6.0.0-test" };
  assert.deepEqual(runningBeforeRestart({ current: "6.0.0-test", restartChip: false }, versions), { running: "new" });
  assert.deepEqual(runningBeforeRestart({ current: "5.4.0", restartChip: true }, versions), { running: "old" });
  assert.throws(() => runningBeforeRestart({ current: "6.0.0-test", restartChip: true }, versions), /restart chip/);
  assert.throws(() => runningBeforeRestart({ current: "5.4.0", restartChip: false }, versions), /restart chip/);
  assert.throws(() => runningBeforeRestart({ current: "—", restartChip: false }, versions), /Current version/);
});

const said = (step, text = "已升级到 6.0.0-test") => ({ step, text });
const noticeOf = (running, shown, reports = ["6.0.0-test"]) => noticeVerdict({ running, shown, reports }, expected);

test("the upgrade notice is shown once, for the installed version, by whichever code runs first", () => {
  assert.deepEqual(noticeOf("new", [said("one-click-upgrade")]), { shownIn: "one-click-upgrade" });
  assert.deepEqual(noticeOf("new", [said("second-start", "Upgraded to 6.0.0-test")]), { shownIn: "second-start" });
  assert.deepEqual(noticeOf("old", [said("new-version-active")]), { shownIn: "new-version-active" });
});

test("never, twice, another version, the wrong side of the restart or a wrong report to the host fails the proof", () => {
  assert.throws(() => noticeOf("new", []), /appeared 0 times/);
  assert.throws(() => noticeOf("new", [said("before-restart"), said("second-start")]), /appeared 2 times.*before-restart.*second-start/);
  assert.throws(() => noticeOf("new", [said("before-restart", "已升级到 6.0.0")]), /does not name 6\.0\.0-test/);
  assert.throws(() => noticeOf("new", [said("new-version-active")]), /until after it/);
  assert.throws(() => noticeOf("old", [said("before-restart")]), /old code/);
  assert.throws(() => noticeOf("new", [said("before-restart")], []), /tell the host once/);
  assert.throws(() => noticeOf("new", [said("before-restart")], ["6.0.0-test", "6.0.0-test"]), /tell the host once/);
});

test("--from starts the proof on an already packed release instead of the current code", () => {
  assert.equal(parseArgs(["--from", "old.tgz"]).from, resolve("old.tgz"));
  assert.equal(parseArgs([]).from, undefined);
});

test("the proof runs on whichever host release it is given; --dsh-version only adds a check when asked for", () => {
  for (const version of ["0.2.2-rc.5", "0.2.1-rc.2", "0.3.0"]) assert.equal(hostProblem(version, undefined), null, version);
  assert.equal(hostProblem("0.2.2-rc.5", "0.2.2-rc.5"), null);
  assert.match(hostProblem("0.2.2-rc.5", "0.2.1-rc.2"), /0\.2\.2-rc\.5.*0\.2\.1-rc\.2/);
  assert.match(hostProblem("command not found", undefined), /version/i);
});

test("--offline sets the variable this pnpm reads (pnpm 11 ignores npm_config_offline)", () => {
  assert.deepEqual(offlineEnv(false), {});
  assert.deepEqual(offlineEnv(true), { pnpm_config_offline: "true", npm_config_offline: "true" });
  assert.equal(parseArgs(["--offline", "--dsh-bin", "x.js"]).offline, true);
  assert.equal(parseArgs(["--dsh-bin", "x.js"]).offline, false);
  assert.equal(parseArgs(["--offline", "--dsh-version=0.2.2-rc.5"]).dshVersion, "0.2.2-rc.5");
  assert.equal(parseArgs([]).dshVersion, undefined);
});
