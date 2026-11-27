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

/** One loopback Playwright server for a full local suite. Each connection owns its browser contexts. */
export async function startTestChromium() {
  const executablePath = await findChromium();
  const { chromium } = await import('playwright');
  return chromium.launchServer({ ...(executablePath ? { executablePath } : {}), headless: true, host: '127.0.0.1', port: 0,
    handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
}

/** Put keyboard focus on `locator`, the way a person who is on the keyboard does. A tooltip opens on :focus-visible, which a script's focus() gets only when
 *  the last input was a key (after a mouse press it does not: that is the point of the shared Tooltip). A Shift press first makes it one. */
export async function focusByKeyboard(locator) {
  await locator.page().keyboard.press("Shift");
  await locator.focus();
}

/** A developer without the optional browser can run the rest of the suite. CI requires every smoke test to execute. */
export function skipMissingChromium(t, error) {
  if (process.env.STUDY_QA_REQUIRE_BROWSER === '1' || !/Executable doesn't exist/.test(error.message)) throw error;
  t.skip('Chromium unavailable');
}

/** Launch headless Chromium through the repository's Playwright.
 *  STUDY_QA_ACTION_TIMEOUT_MS (set by scripts/test.mjs) stretches Playwright's 30 s waits for the launch and for every action and navigation of the pages
 *  made from this browser: a whole test suite shares the machine, and a wait is a deadline for something to happen, not a measure of speed. */
export async function launchChromium(options = {}) {
  const { chromium } = await import("playwright");
  const patience = Number(process.env.STUDY_QA_ACTION_TIMEOUT_MS) || 0;
  const shared = process.env.STUDY_TEST_BROWSER_ENDPOINT;
  const timeout = patience ? { timeout: patience } : {};
  let browser;
  if (/^ws:\/\/127\.0\.0\.1:\d+\/[\w-]+$/.test(shared || '') && !Object.keys(options).length) {
    // A previous fixture may have crashed Chromium. Later fixtures still run with a fresh, real browser.
    browser = await chromium.connect(shared, timeout).catch(() => null);
  }
  if (!browser) {
    const executablePath = await findChromium();
    try {
      browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}), ...timeout, ...options });
    } catch (error) {
      // Some suites skip when Chromium is optional. In required mode even
      // those workers must return a failed exit status with the launch error.
      if (process.env.STUDY_QA_REQUIRE_BROWSER === '1') {
        process.exitCode = 1;
        console.error(error.message);
      }
      throw error;
    }
  }
  if (patience) {
    const newContext = browser.newContext.bind(browser), newPage = browser.newPage.bind(browser);
    browser.newContext = async (...args) => { const context = await newContext(...args); context.setDefaultTimeout(patience); return context; };
    browser.newPage = async (...args) => { const page = await newPage(...args); page.setDefaultTimeout(patience); return page; };
  }
  return browser;
}
