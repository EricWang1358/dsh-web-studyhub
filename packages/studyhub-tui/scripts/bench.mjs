/**
 * Performance & Memory NFR Benchmark for StudyHub TUI:
 * 1. Code-split dist entry bundle size
 * 2. Cold CLI spawn latency (`--version`)
 * 3. Instant ShellBootFrame Time-To-First-Frame (before StudyRuntime loads)
 * 4. Full interactive app ready latency + steady-state RSS & V8 heapUsed
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distCli = resolve(root, 'dist', 'cli.mjs');
const distBootFrame = resolve(root, 'dist', 'boot-frame.mjs');
const distApp = resolve(root, 'dist', 'App.mjs');
const distHost = resolve(root, 'dist', 'host.mjs');

async function measureCli(args) {
  const t0 = performance.now();
  const { stdout } = await execFileAsync(process.execPath, [distCli, ...args], {
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 15_000,
  });
  return { ms: Math.round(performance.now() - t0), stdout: stdout.trim() };
}

const info = await stat(distCli);
const sizeKb = Number((info.size / 1024).toFixed(1));

// 1. Cold CLI spawn (warm page cache once, then 5 runs)
await measureCli(['--version']);
const runs = [];
for (let i = 0; i < 5; i += 1) {
  runs.push((await measureCli(['--version'])).ms);
}
runs.sort((a, b) => a - b);
const medianMs = runs[Math.floor(runs.length / 2)];

// 2. Standalone ShellBootFrame Time-To-First-Frame (before AppShell / marked / StudyRuntime load)
let bootFrameMs = null;
{
  const tBoot0 = performance.now();
  const [{ createElement }, { render }, { ShellBootFrame }] = await Promise.all([
    import('react'),
    import('ink'),
    import(pathToFileURL(distBootFrame).href),
  ]);
  const bootStdout = new PassThrough();
  const bootStdin = new PassThrough();
  Object.assign(bootStdout, { columns: 120, rows: 36, isTTY: true });
  Object.assign(bootStdin, { isTTY: true, setRawMode: () => bootStdin, ref: () => bootStdin, unref: () => bootStdin });

  let gotBootFrame = false;
  const bootFrameReady = new Promise((done) => {
    bootStdout.on('data', (chunk) => {
      if (!gotBootFrame && String(chunk).includes('StudyHub')) {
        gotBootFrame = true;
        bootFrameMs = Math.round(performance.now() - tBoot0);
        done();
      }
    });
  });

  const bootInstance = render(
    createElement(ShellBootFrame, { label: 'Starting StudyHub runtime…' }),
    { stdout: bootStdout, stdin: bootStdin, exitOnCtrlC: false, patchConsole: false },
  );
  await Promise.race([bootFrameReady, new Promise((r) => setTimeout(r, 5000))]);
  bootInstance.unmount();
  bootStdout.destroy();
  bootStdin.destroy();
}

// 3. Full interactive first-frame + steady-state RSS/heap in clean temp library
let interactiveReadyMs = null;
let interactiveRssMb = null;
let interactiveHeapMb = null;
const tempDir = await mkdtemp(join(tmpdir(), 'studyhub-tui-bench-'));
try {
  const tFrame0 = performance.now();
  const [{ createElement }, { render }, { StudyHubTuiApp }, { createTuiHost }] = await Promise.all([
    import('react'),
    import('ink'),
    import(pathToFileURL(distApp).href),
    import(pathToFileURL(distHost).href),
  ]);

  const host = await createTuiHost({
    libraryRoot: join(tempDir, 'lib'),
    env: { ...process.env, DSH_HOME: join(tempDir, 'dsh') },
    skipAutoProbe: true,
  });
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { columns: 120, rows: 36, isTTY: true });
  Object.assign(stdin, { isTTY: true, setRawMode: () => stdin, ref: () => stdin, unref: () => stdin });

  let gotFrame = false;
  const frameReady = new Promise((done) => {
    stdout.on('data', (chunk) => {
      if (!gotFrame && String(chunk).length > 40) {
        gotFrame = true;
        interactiveReadyMs = Math.round(performance.now() - tFrame0);
        done();
      }
    });
  });

  const instance = render(
    createElement(StudyHubTuiApp, { host, autoLaunchpad: true }),
    { stdout, stdin, exitOnCtrlC: false, patchConsole: false },
  );
  await Promise.race([frameReady, new Promise((r) => setTimeout(r, 5000))]);
  const mem = process.memoryUsage();
  interactiveRssMb = Number((mem.rss / 1048576).toFixed(1));
  interactiveHeapMb = Number((mem.heapUsed / 1048576).toFixed(1));
  instance.unmount();
  await host.dispose();
  stdout.destroy();
  stdin.destroy();
} finally {
  await rm(tempDir, { recursive: true, force: true }).catch(() => {});
}

console.log(JSON.stringify({
  cliEntrySizeKb: sizeKb,
  coldSpawnMsRuns: runs,
  coldSpawnMedianMs: medianMs,
  bootFrameReadyMs: bootFrameMs,
  interactiveReadyMs,
  interactiveRssMb,
  interactiveHeapMb,
  nfrTargetColdMs: 350,
  passColdStart: medianMs <= 350,
  passInteractiveMemory: interactiveRssMb !== null && interactiveRssMb < 260,
}, null, 2));
