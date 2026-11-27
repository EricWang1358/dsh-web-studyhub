// Installer verification harness: runs the installed launcher with a private library.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as wait } from 'node:timers/promises';
import { chromium } from 'playwright';
import { revealNavRow } from '../../../../scripts/qa/nav-reveal.mjs';

const [program, dataDir, phase] = process.argv.slice(2);
assert.ok(['seed', 'upgraded', 'restored'].includes(phase));
const data = await realpath(await mkdir(dataDir, { recursive: true }).then(() => dataDir));
const log = join(data, phase + '.log');
const native = phase === 'upgraded';
const config = { server: { port: 0 }, logging: { file: { name: log } },
  studyhub: { 'data-dir': data, headless: !native } };
const child = spawn(await realpath(program), [], {
  stdio: 'ignore', windowsHide: true, env: { ...process.env, SPRING_APPLICATION_JSON: JSON.stringify(config),
    ...(native ? { WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-address=127.0.0.1 --remote-debugging-port=0' } : {}) },
});
const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve); });
let browser;

async function until(label, check, timeout = 90_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (child.exitCode !== null || child.signalCode) throw new Error('Launcher exited before ' + label);
    const result = await check();
    if (result) return result;
    await wait(150);
  }
  throw new Error('Timed out waiting for ' + label + ', see ' + log);
}

try {
  const port = await until('loopback listener', async () =>
    (await readFile(log, 'utf8').catch(() => '')).match(/Tomcat started on port (\d+)/)?.[1]);
  const base = 'http://127.0.0.1:' + port;
  const token = (await (await fetch(base, { signal: AbortSignal.timeout(15_000) })).text())
    .match(/window\.STUDY_TOKEN="([a-f0-9]+)"/)?.[1];
  assert.ok(token, 'UI bootstrap');
  const rpc = async (action, args) => {
    const r = await fetch(base + '/api/call', { method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { 'Content-Type': 'application/json', 'X-Study-Token': token }, body: JSON.stringify({ action, args }) });
    const result = await r.json();
    assert.ok(result.ok, JSON.stringify(result));
    return result.value;
  };
  const courseName = 'Installer upgrade · 编译原理';
  if (phase === 'seed') await rpc('course.save', { name: courseName });
  assert.ok((await rpc('course.list', {})).courses.some(item => item.name === courseName));
  if (native) {
    const file = join(data, 'config', 'webview', 'EBWebView', 'DevToolsActivePort');
    const inspector = await until('embedded WebView2 DevTools port', async () => {
      const [value] = (await readFile(file, 'utf8').catch(() => '')).split(/\r?\n/);
      return /^\d+$/.test(value) && value;
    });
    browser = await chromium.connectOverCDP('http://127.0.0.1:' + inspector);
    const page = await until('installed renderer at the launched origin', () =>
      browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().startsWith(base + '/')));
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    // Reload after installing the observers so they include a complete navigation.
    await page.reload();
    await (await revealNavRow(page, 'sources')).click();
    await page.locator('.sources-page [data-tour="sources-list"]').first().waitFor();
    assert.deepEqual(errors, []);
    const tray = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('./windows-tray.ps1', import.meta.url)), '-HostPath', join(dirname(program), 'app', 'StudyHub.WebView.exe')],
      { encoding: 'utf8', windowsHide: true, timeout: 45_000 });
    if (tray.error) throw tray.error;
    assert.equal(tray.status, 0, String(tray.stdout) + String(tray.stderr));
    console.log(tray.stdout.trim());
    assert.equal((await fetch(base + '/health')).status, 200, 'Gateway survives closing the window to the tray');
  }
  console.log('Installed launcher verified: ' + phase);
} finally {
  if (child.exitCode === null && !child.signalCode) child.kill();
  const timer = new AbortController();
  try { await Promise.race([exited, wait(15_000, null, { signal: timer.signal }).then(() => { throw new Error('Launcher did not stop'); })]); }
  finally { timer.abort(); await browser?.close().catch(() => {}); }
}
