/* Chromium for QA scripts. Playwright's pinned browser build may be missing,
   so use PLAYWRIGHT_CHROMIUM or the newest Chromium already installed under
   %LOCALAPPDATA%/ms-playwright (chromium-<build>/chrome-win64/chrome.exe). */
import { readdir, access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const EXECUTABLES = [
  ["chrome-win64", "chrome.exe"], ["chrome-win", "chrome.exe"], ["chrome-linux64", "chrome"], ["chrome-linux", "chrome"],
  ["chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"], ["chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"],
];
const exists = (path) => access(path).then(() => true, () => false);

function cacheDirs(env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH) return [env.PLAYWRIGHT_BROWSERS_PATH];
  const dirs = [];
  if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "ms-playwright"));
  else if (process.platform === "darwin") dirs.push(join(homedir(), "Library", "Caches", "ms-playwright"));
  else if (process.platform !== "win32") dirs.push(join(homedir(), ".cache", "ms-playwright"));
  return dirs;
}

/** Absolute path of a Chromium executable, or null to let Playwright use its own. */
export async function findChromium(env = process.env) {
  if (env.PLAYWRIGHT_CHROMIUM && await exists(env.PLAYWRIGHT_CHROMIUM)) return env.PLAYWRIGHT_CHROMIUM;
  for (const dir of cacheDirs(env)) {
    let builds = [];
    try { builds = (await readdir(dir)).filter((name) => /^chromium-\d+$/.test(name)); } catch { continue; }
    builds.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
    for (const build of builds)
      for (const parts of EXECUTABLES) {
        const path = join(dir, build, ...parts);
        if (await exists(path)) return path;
      }
  }
  return null;
}

/** Launch headless Chromium through the repository's Playwright. */
export async function launchChromium(options = {}) {
  const { chromium } = await import("playwright");
  const executablePath = await findChromium();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...options });
}
