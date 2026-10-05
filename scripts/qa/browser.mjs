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

/** Launch headless Chromium through the repository's Playwright.
 *  STUDY_QA_ACTION_TIMEOUT_MS (set by scripts/test.mjs) stretches Playwright's 30 s waits for the launch and for every action and navigation of the pages
 *  made from this browser: a whole test suite shares the machine, and a wait is a deadline for something to happen, not a measure of speed. */
export async function launchChromium(options = {}) {
  const { chromium } = await import("playwright");
  const executablePath = await findChromium();
  const patience = Number(process.env.STUDY_QA_ACTION_TIMEOUT_MS) || 0;
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...(patience ? { timeout: patience } : {}), ...options });
  if (patience) {
    const newContext = browser.newContext.bind(browser), newPage = browser.newPage.bind(browser);
    browser.newContext = async (...args) => { const context = await newContext(...args); context.setDefaultTimeout(patience); return context; };
    browser.newPage = async (...args) => { const page = await newPage(...args); page.setDefaultTimeout(patience); return page; };
  }
  return browser;
}
