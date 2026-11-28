/* What scripts/qa/dsh-upgrade.mjs (the end-to-end proof of the in-app upgrade) decides without a host: its arguments, the fake release
   it publishes and how it judges what it saw. Kept apart from the script so tests/qa-upgrade-proof.test.mjs starts no browser and no
   program, and stays in `npm run test:fast`: the proof itself is not part of npm test, and it once went stale without anyone noticing. */
import { appendFile, readdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "../../lib/semver.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
export const REPO = "EricWang1358/dsh-web-studyhub";

/** A fake release the package under test is older than, whatever its version has become: the next major, marked -test. */
export function upgradeTestVersion(current) {
  const parsed = parseVersion(current);
  if (!parsed) throw new Error(`${current} is not a version`);
  return `${parsed.major + 1}.0.0-test`;
}

/** The Windows system tar on Windows: GNU tar (first on PATH from Git Bash) reads `D:\...` as a file on a remote host `D`. */
export const systemTar = ({ platform = process.platform, env = process.env } = {}) =>
  platform === "win32" ? join(env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";

/** Why the host cannot be used, or null. Any release can, unless --dsh-version names the one wanted. */
export function hostProblem(found, wanted) {
  if (!parseVersion(found)) return `the host did not answer with a version: ${found}`;
  return wanted && found !== wanted ? `DSH ${found} found; --dsh-version wants ${wanted}` : null;
}

/** What --offline adds to the environment of every child. npm reads the second name, the pnpm that DSH runs reads the first. */
export const offlineEnv = (offline) => offline ? { pnpm_config_offline: "true", npm_config_offline: "true" } : {};

export function parseArgs(argv = []) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match) throw new Error(`Unexpected argument ${argv[i]}`);
    if (match[1] === "offline") { values.offline = true; continue; }
    values[match[1]] = match[2] ?? argv[++i];
  }
  const port = Number(values.port ?? 3220);
  return { dshBin: values["dsh-bin"] || process.env.DSH_QA_BIN || join(repoRoot, "output/qa/dsh-cli/node_modules/@deepseek-ai/dsh/lib/bin.js"),
    dshVersion: values["dsh-version"], offline: values.offline === true, port, modelPort: port + 1, feedPort: port + 2,
    from: values.from ? resolve(values.from) : undefined,
    lang: values.lang === "en" ? "en" : "zh", out: resolve(values.out ?? join(repoRoot, "output/qa/wp15-upgrade")) };
}

/** Rewrites an unpacked package (a fresh extraction, never an installed copy) into release `version`: the manifest's version,
    and one comment at the end of every module under lib/. Resolves to the number of modules changed. */
export async function relabelRelease(packageDir, version) {
  const manifestPath = join(packageDir, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, version }, null, 2) + "\n");
  let modules = 0;
  for (const entry of await readdir(join(packageDir, "lib"), { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.[cm]?js$/.test(entry.name)) continue;
    await appendFile(join(entry.parentPath, entry.name), `\n/* StudyHub QA release ${version} */\n`);
    modules++;
  }
  if (!modules) throw new Error(`no module under ${join(packageDir, "lib")} to change`);
  return modules;
}

/** GitHub's releases/latest answer for the fake release; `origin` stands in for github.com. */
export function fakeRelease(origin, version, packageName) {
  const download = `${origin}/${REPO}/releases/download/v${version}`;
  return { tag_name: `v${version}`, name: `StudyHub ${version}`, draft: false, prerelease: false, published_at: new Date().toISOString(),
    html_url: `${origin}/${REPO}/releases/tag/v${version}`,
    body: "## QA build\n- The current code with every module changed, to prove the in-app upgrade.",
    assets: [{ name: packageName, browser_download_url: `${download}/${packageName}` },
      { name: `SHA256SUMS-${version}.txt`, browser_download_url: `${download}/SHA256SUMS-${version}.txt` }] };
}

/** What the host answered to the click, held against the profile on disk. `answer` is the server's response to update.install. */
export function installVerdict(answer, disk, { version, packageName }) {
  const fail = (reason) => ({ ok: false, reason });
  if (!answer) return fail("no answer to update.install");
  if (!answer.result?.ok) return fail(`update.install failed in the host: ${answer.result?.error?.message || JSON.stringify(answer.result ?? answer)}`);
  const value = answer.result.value ?? {};
  if (value.status !== "installed") return fail(`update.install answered ${[value.status, value.code, value.kind, value.detail].filter(Boolean).join(" ")}`);
  if (value.version !== version) return fail(`update.install installed ${value.version}, not ${version}`);
  if (disk.installed !== version) return fail(`the host says installed, but node_modules has ${disk.installed}`);
  if (!String(disk.dependency).includes(packageName)) return fail(`the host says installed, but the profile dependency is ${disk.dependency}`);
  return { ok: true, application: value.application, restartRequired: value.restartRequired };
}

/** The sentence the new code announces an upgrade with, in either language (the dialog quotes it too, inside quotation marks). */
export const UPGRADE_NOTICE = /(?:已升级到|Upgraded to)\s+([0-9A-Za-z.+-]+)/;
const AFTER_RESTART = ["restart-dsh", "new-version-active"];

/** What the learner was told. `shown`: every upgrade notice the page showed from the click on, as { step, text }; `reports`: each version the page told
    the host it had announced; `running`: what ran before the restart (runningBeforeRestart). It has to be said exactly once, for the installed version:
    before the restart when the new code already ran then, after it when the old code was still running. */
export function noticeVerdict({ running, shown, reports }, { version }) {
  const said = shown.map(({ step, text }) => `${step}: ${text}`).join(" | ") || "never";
  if (shown.length !== 1) throw new Error(`the upgrade notice should appear exactly once, and appeared ${shown.length} times (${said})`);
  const [{ step, text }] = shown;
  if (UPGRADE_NOTICE.exec(text)?.[1] !== version) throw new Error(`the notice does not name ${version} (${said})`);
  if (running === "old" && !AFTER_RESTART.includes(step)) throw new Error(`the old code still ran before the restart, yet it announced the upgrade (${said})`);
  if (running === "new" && AFTER_RESTART.includes(step)) throw new Error(`the new code ran before the restart, but nothing was said until after it (${said})`);
  if (reports.length !== 1 || reports[0] !== version) throw new Error(`the page should tell the host once that it announced ${version}: ${JSON.stringify(reports)}`);
  return { shownIn: step };
}

/** Which code runs before any restart, by Settings' own 当前版本; the restart chip has to agree with it. */
export function runningBeforeRestart({ current, restartChip }, { before, next }) {
  if (current !== before && current !== next) throw new Error(`Current version reads ${current}, neither ${before} nor ${next}`);
  const running = current === next ? "new" : "old";
  if ((running === "old") !== restartChip)
    throw new Error(running === "old" ? `the old code (${before}) still runs, but there is no restart chip`
      : `the new code (${next}) already runs, but the restart chip is still shown`);
  return { running };
}
