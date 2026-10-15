import { access, mkdir, readFile, readdir, rename, rm, rmdir, stat, statfs, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { runLocalCommand } from './local-command.js';
import { UnsupportedVersionError, knownVersion } from './stored-version.js';

/* The one-click install engine shared by the local tools StudyHub can install for the learner (Marker: lib/marker-install.js; MinerU:
   lib/mineru-install.js). A spec says what is installed and how (its stages, its plan, its words); the engine owns what must be the same for
   every tool:
   - one install folder per tool, marked by a sentinel file written before anything is downloaded; a folder without that sentinel is never
     installed into (a non-empty foreign folder gets a "<picked>\<folderName>" inside it) and never deleted from;
   - deletion only ever of the known children of a sentinel folder, then the sentinel, then the folder and the parents the install created,
     each only when empty: never a recursive delete of the root;
   - the durable state file (a restart reads it: a run that was live when the app stopped reads as interrupted) with its format version;
   - one live run per state file (a second start is refused), cancel through the run's AbortController (the process tree is killed);
   - stages in a fixed order, each declaring whether it changes the folder (a Job never repeats one blindly); a stage that finds its work
     already done completes at once, so "继续安装" and "修复" are the same start again;
   - the log (bounded, secrets in URLs hidden) and an optional `row` seam that shows the run in the shared task console. */

export class InstallError extends Error {
  constructor(code, message, options) { super(message, options); this.name = 'InstallError'; this.code = code; }
}

const clip = (value, length) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);
const hide = line => line.replace(/\/\/[^/\s:@]+:[^/\s@]+@/g, '//***@');
export const flavourOf = platform => (platform === 'win32' ? path.win32 : path.posix);

/* ---------- folders ---------- */

export async function exists(file) { try { await stat(file); return true; } catch { return false; } }

/** The nearest folder (or file) on the way up from `target` that exists: { path, directory } or null. */
export async function nearestExisting(target, flavour = path) {
  let current = target;
  for (;;) {
    try { const info = await stat(current); return { path: current, directory: info.isDirectory() }; }
    catch { const parent = flavour.dirname(current); if (parent === current) return null; current = parent; }
  }
}

/** Free megabytes on the disk a folder (or its nearest existing parent) is on, or null when that cannot be read. */
export async function freeMegabytes(folder, platform = process.platform) {
  const near = await nearestExisting(folder, flavourOf(platform));
  if (!near) return null;
  try { const info = await statfs(near.path); return Math.floor((Number(info.bavail) * Number(info.bsize)) / 1_048_576); } catch { return null; }
}

/** The sentinel of a folder this tool created, or null. */
export async function readSentinel(folder, { sentinel, createdBy }, platform = process.platform) {
  try {
    const value = JSON.parse(await readFile(flavourOf(platform).join(folder, sentinel), 'utf8'));
    return value?.createdBy === createdBy ? value : null;
  } catch { return null; }
}
async function emptyFolder(folder) { try { return !(await readdir(folder)).length; } catch { return false; } }

/** The folder an install would really use: the one asked for when it is new, empty or ours, else a `folderName` folder inside it.
 *  Resolves { folder, adjusted? } or { problem: 'bad-location' | 'folder-in-use', folder }. */
export async function resolveInstallFolder(location, { spec, platform = process.platform, defaultFolder }) {
  const flavour = flavourOf(platform);
  const asked = typeof location === 'string' && location.trim() ? location.trim() : defaultFolder;
  if (/[\u0000\r\n]/.test(asked) || !flavour.isAbsolute(asked)) return { problem: 'bad-location', folder: asked };
  const folder = flavour.resolve(asked);
  let info = null;
  try { info = await stat(folder); } catch { /* it will be created */ }
  if (!info) return { folder };
  if (!info.isDirectory()) return { problem: 'bad-location', folder };
  if ((await emptyFolder(folder)) || await readSentinel(folder, spec, platform)) return { folder };
  const inner = flavour.join(folder, spec.folderName);
  let innerInfo = null;
  try { innerInfo = await stat(inner); } catch { /* new */ }
  if (!innerInfo) return { folder: inner, adjusted: true };
  if (innerInfo.isDirectory() && ((await emptyFolder(inner)) || await readSentinel(inner, spec, platform))) return { folder: inner, adjusted: true };
  return { problem: 'folder-in-use', folder };
}

/** Whether the nearest existing folder of `folder` can be written to: 'ok', 'not-writable' or 'bad-location' (a file is in the way). */
export async function writable(folder, platform = process.platform) {
  const near = await nearestExisting(folder, flavourOf(platform));
  if (!near) return 'bad-location';
  if (!near.directory) return 'bad-location';
  try { await access(near.path, constants.W_OK); return 'ok'; } catch { return 'not-writable'; }
}

/** mkdir -p that says which folders it made (outermost first), so an uninstall can remove exactly those when they are empty. */
export async function makeFolder(folder, platform = process.platform) {
  const flavour = flavourOf(platform), missing = [];
  let current = folder;
  while (!(await exists(current))) { missing.unshift(current); const parent = flavour.dirname(current); if (parent === current) break; current = parent; }
  await mkdir(folder, { recursive: true });
  return missing.slice(0, -1);
}

/* ---------- reading why a command failed ---------- */

/** What the output of a failed command says, as a code shared by the tools (null when it says nothing known). */
export function classifyFailure(text) {
  const said = String(text ?? '');
  if (/No space left|ENOSPC|not enough space|磁盘空间不足|os error 112/i.test(said)) return 'no-space';
  if (/os error 206|path too long|filename or extension is too long|文件名或扩展名太长/i.test(said)) return 'path-too-long';
  if (/DLL load failed|vcruntime140|msvcp140|找不到指定的模块/i.test(said)) return 'vc-runtime';
  if (/端口被占用|address already in use|os error 10048|\b10048\b/i.test(said)) return 'port-in-use';
  if (/Permission denied|Access is denied|EACCES|WinError 5\b|os error 5\b|拒绝访问/i.test(said)) return 'not-writable';
  if (/error sending request|Failed to fetch|dns error|tcp connect error|operation timed out|Could not find a version|No matching distribution|Connection|timed out|Temporary failure|Name or service not known|getaddrinfo|ProxyError|SSLError|Max retries|ECONNRESET|ENOTFOUND|ETIMEDOUT|fetch failed|network/i.test(said)) return 'network';
  return null;
}

/* ---------- durable state ---------- */

export async function readState(file, versionKey) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    // A state file of a later format is not read as v1: it shows as idle, and writeState refuses to write over it.
    if (!knownVersion(versionKey, value)) return { laterVersion: value.version };
    return value && typeof value === 'object' ? value : {};
  } catch { return {}; }
}
export async function writeState(file, state, { versionKey, label }) {
  const current = await readState(file, versionKey);
  if (current.laterVersion !== undefined) throw new UnsupportedVersionError(label, current.laterVersion);
  const temp = `${file}.${randomUUID()}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(temp, `${JSON.stringify({ version: 1, ...state }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temp, file);
}

/** Runs by state file: a restart (a new process, or a new service) finds the file, not the run. Marker and MinerU have separate slots. */
const live = new Map();
/** The live run of a state file (for a caller that must know whether an install is running right now). */
export const liveRun = file => live.get(file) || null;

export const samePath = (a, b, platform) => (platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
export const inside = (child, parent, platform) => {
  const flavour = flavourOf(platform), relative = flavour.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !flavour.isAbsolute(relative);
};

/**
 * The installer of one tool. `spec` (see the files of each tool) and `seams` (tests and previews: platform, the tool's own stand-ins, and `row(run)`
 * which may return { update(state), close(state) } to show the run in the task console).
 * Resolves { plan, start, status, cancel, uninstall, idle, prepare, claim, release, begin, removeCreated }.
 */
export function createToolInstaller(spec, seams = {}) {
  const platform = seams.platform || process.platform, flavour = flavourOf(platform);
  const file = () => spec.stateFile();
  const fail = (code, message, options) => (spec.error ? spec.error(code, message, options) : new InstallError(code, message, options));
  const store = { versionKey: spec.versionKey, label: spec.label };
  const logLines = spec.logLines ?? 200, lineLength = spec.lineLength ?? 300;
  const sentinelOf = folder => flavour.join(folder, spec.sentinel);
  const ours = folder => readSentinel(folder, spec, platform);

  const view = async (state, run) => {
    const status = state.status === 'running' && !run ? 'interrupted' : state.status || 'idle';
    const error = status === 'interrupted' ? { code: 'interrupted', message: spec.messages.interrupted } : state.error || null;
    const installed = !!state.installedFolder && !!(await ours(state.installedFolder)) && await spec.installedProgram(state.installedFolder, { platform, seams });
    return spec.view(state, { status, error, installed, platform, seams });
  };

  async function status() {
    const run = live.get(file());
    // A run that has just ended is still writing its result: wait for it, so whoever reads the state file next (which program runs) agrees with this answer.
    if (run && run.state.status !== 'running' && run.promise) { await run.promise.catch(() => {}); return view(await readState(file(), spec.versionKey), null); }
    return view(run ? run.state : await readState(file(), spec.versionKey), run);
  }

  const plan = (args = {}) => spec.plan(args, { platform, seams, ours, live: () => live.get(file()) });

  /** Refuse while an install is running; a run that just ended may still be writing its result, so wait for that before anything else writes the state. */
  async function quiet(message) {
    const run = live.get(file());
    if (!run) return;
    if (run.state.status === 'running') throw fail('busy', message);
    await run.promise;
  }

  /** Remove one folder this installer created: its known children, the sentinel, then the folder and the parents it created, each only when empty. */
  async function removeCreated(folder) {
    const sentinel = folder ? await ours(folder) : null;
    if (!sentinel) throw fail('not-ours', spec.messages.notOurs);
    for (const child of spec.children) await rm(flavour.join(folder, child), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await rm(sentinelOf(folder), { force: true });
    await rmdir(folder).catch(() => {});
    const parents = Array.isArray(sentinel.createdParents) ? [...sentinel.createdParents].reverse() : [];
    for (const parent of parents) if (typeof parent === 'string' && inside(folder, parent, platform)) await rmdir(parent).catch(() => {});
    await spec.onRemove?.(folder, { platform, seams });
  }

  /** Everything a start checks before any process or file exists: the confirmation, that no install is running, and the plan.
   * Resolves what a run needs (plain data, so it can also travel as a Job's input); a refusal is the spec's error. */
  async function prepare(args = {}) {
    if (args.confirm !== true) throw fail('need-confirm', spec.messages.needConfirm);
    await quiet(spec.messages.busy);
    const checked = await plan({ ...args });
    const blocking = checked.problems[0];
    if (blocking) throw fail(blocking.code, blocking.message);
    const before = await readState(file(), spec.versionKey), folder = checked.folder;
    if (before.laterVersion !== undefined) throw new UnsupportedVersionError(spec.label, before.laterVersion);
    const previous = args.removePrevious === true && before.installedFolder && !samePath(before.installedFolder, folder, platform) ? before.installedFolder : '';
    return { confirm: true, folder, previous, installedFolder: before.installedFolder || '', ...(spec.prepare ? spec.prepare(checked, args, before) : {}) };
  }

  /** Take the one install slot of this tool, whichever installer object (or Job) asks. `controller` is the legacy run's own stop; a Job passes its signal. */
  function claim(prepared, { controller, signal = controller?.signal } = {}) {
    const key = file();
    if (live.has(key)) throw fail('busy', spec.messages.busy);
    const state = { status: 'running', stage: spec.stages[0].id, folder: prepared.folder, ...(spec.stateOf ? spec.stateOf(prepared) : {}), startedAt: new Date().toISOString(),
      finishedAt: '', lastLine: '', log: [], error: null, command: '', ...(prepared.installedFolder ? { installedFolder: prepared.installedFolder } : {}) };
    const run = { state, controller, signal, timer: null, row: null };
    live.set(key, run);
    return run;
  }

  /** Give the slot back without having run (a Job stopped before its first stage). */
  function release(run) { const key = file(); if (live.get(key) === run) live.delete(key); }

  /** Write the state down and start the stages; resolves with the run's first state on disk, `run.promise` ends when the run does.
   * `observe(kind, work, { sideEffect })` runs one piece of work that starts a process: directly, or as an observed Call of a Job. */
  async function begin(prepared, run, observe = (_kind, work) => work(run.signal)) {
    const key = file(), { state, signal } = run, { folder, previous } = prepared;
    run.row = seams.row?.(run) || null;
    const tell = () => { try { run.row?.update(state); } catch { /* the console row is best effort */ } };
    const persist = async () => { clearTimeout(run.timer); run.timer = null; tell(); await writeState(key, state, store).catch(() => {}); };
    const flush = () => { run.timer ||= setTimeout(() => { run.timer = null; tell(); void writeState(key, state, store).catch(() => {}); }, 1000); };
    const push = line => {
      const text = hide(clip(line, lineLength));
      if (!text) return;
      state.lastLine = text; state.log.push(text);
      if (state.log.length > logLines) state.log.splice(0, state.log.length - logLines);
      flush();
    };
    const stage = async name => { state.stage = name; delete state.stageFraction; push(`== ${name} ==`); await persist(); };
    const ctx = { folder, prepared, state, signal, platform, seams, observe, push, data: {},
      /** How far the current stage is, 0..1 (a parsed percentage or bytes downloaded), for the progress bar. */
      progress(fraction) { if (Number.isFinite(fraction)) { state.stageFraction = Math.max(0, Math.min(1, fraction)); flush(); } },
      /** Run one command: logged, observed (with the stage's side effect unless said otherwise), its failure explained by the spec. Resolves the result. */
      async go(name, cli, argv, { timeoutMs, sideEffect, onText, allowFailure = false } = {}) {
        let tail = '';
        push(`$ ${[cli.file, ...(cli.prefix || []), ...argv].join(' ')}`);
        const mutating = sideEffect ?? !!spec.stages.find(item => item.id === name)?.mutating;
        const result = await observe(name, runSignal => runLocalCommand(cli, argv, { signal: runSignal, timeoutMs,
          onLine: line => { tail = `${tail}\n${line}`.slice(-4000); push(line); }, ...(onText ? { onText } : {}) }), { sideEffect: mutating });
        if (result.code !== 0 && !allowFailure) {
          const failure = spec.explain(name, tail || `${result.stderr}\n${result.stdout}`);
          throw fail(failure.code, failure.message);
        }
        return result;
      },
      fail };
    await persist();
    run.promise = (async () => {
      try {
        await spec.before?.(ctx);
        const createdParents = await makeFolder(folder, platform);
        const had = await ours(folder);
        // The sentinel first: written before anything is downloaded, so a cancelled or failed folder can always be uninstalled cleanly.
        const parents = [...new Set([...(Array.isArray(had?.createdParents) ? had.createdParents : []), ...(spec.trackParents ? createdParents : [])])];
        await writeFile(sentinelOf(folder), `${JSON.stringify({ createdBy: spec.createdBy, version: 1, createdAt: had?.createdAt || state.startedAt, ...(parents.length ? { createdParents: parents } : {}) }, null, 2)}\n`, 'utf8');
        await spec.ready?.(ctx);
        state.done = [];
        for (const item of spec.stages) {
          await stage(item.id);
          if (item.isDone && await item.isDone(ctx)) { push(`(${item.id}: already done)`); state.done.push(item.id); continue; }
          await item.run(ctx);
          state.done.push(item.id);
        }
        state.installedFolder = folder;
        await spec.after?.(ctx);
        if (previous) { try { await removeCreated(previous); push(`removed the previous environment: ${previous}`); } catch (error) { push(`kept the previous environment: ${error.message}`); } }
        Object.assign(state, { status: 'complete', stage: 'done', error: null });
        delete state.stageFraction;
      } catch (error) {
        if (signal.aborted) Object.assign(state, { status: 'cancelled', error: { code: 'cancelled', message: spec.messages.cancelled } });
        else {
          const known = !!error?.code && (error instanceof InstallError || error.name === spec.errorName);
          if (!known) push(clip(error?.message || error, lineLength));
          const fallback = spec.unknownFailure(state.stage);
          Object.assign(state, { status: 'failed', error: { code: known ? error.code : fallback.code, message: known ? error.message : fallback.message } });
        }
      } finally {
        state.finishedAt = new Date().toISOString();
        await persist();
        try { run.row?.close(state); } catch { /* best effort */ }
        live.delete(key);
      }
    })();
  }

  async function start(args = {}) {
    const prepared = await prepare(args), run = claim(prepared, { controller: new AbortController() });
    await begin(prepared, run);
    return view(run.state, run);
  }

  async function cancel() {
    const run = live.get(file());
    if (run) run.controller?.abort(new Error('cancelled'));
    return status();
  }

  async function uninstall(args = {}) {
    if (args.confirm !== true) throw fail('need-confirm', spec.messages.needConfirmUninstall);
    await quiet(spec.messages.uninstallBusy);
    const state = await readState(file(), spec.versionKey);
    if (state.laterVersion !== undefined) throw new UnsupportedVersionError(spec.label, state.laterVersion);
    const folders = [...new Set([state.installedFolder, state.folder].filter(Boolean))];
    await spec.beforeUninstall?.({ state, folders, platform, seams });
    let removed = 0;
    const gone = [];
    for (const folder of folders) {
      if (await ours(folder)) { await removeCreated(folder); removed += 1; gone.push(folder); }
    }
    if (!removed) throw fail('not-ours', spec.messages.notOurs);
    await writeState(file(), { status: 'idle' }, store);
    return { ...(await status()), removed, ...(spec.reportRemoved ? { removedFolders: gone } : {}) };
  }

  /** Resolves when the run in progress (if any) has ended: for tests and for a caller that must wait. */
  const idle = async () => { await live.get(file())?.promise; };
  return { plan, start, status, cancel, uninstall, idle, prepare, claim, release, begin, removeCreated, live: () => live.get(file()) || null };
}
