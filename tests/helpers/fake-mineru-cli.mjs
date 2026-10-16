#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* A stand-in for the local `mineru` command line (4.0.x), built from what was measured on a real install:
   `mineru parse <pdf> --tier T --pages A-B --wait N --json -o out.md --force` writes Markdown whose pages are delimited by
   `<!-- page N of TOTAL -->` (N is the original page number, even when --pages selects a range); the DEFAULT is only the
   first 10 pages; without a running local service `parse` fails with "本地 mineru 服务未运行…"; `server status|start|stop`,
   `config get|show|set`. Like the real CLI, `config ...` is answered BY the running service (its settings live in the service's own
   store, not in a file): with the service stopped every `config` call exits non-zero with only the Chinese error below, and
   `server status` prints `服务未在运行。` (exit code 1, or 0 with `statusExitsZero`). Behaviour comes from the JSON file named by FAKE_MINERU_STATE (the tests edit it). Every call is logged to
   the file named by FAKE_MINERU_LOG, one JSON line per call, so a test can see exactly what was run. An optional synthetic `finishSignal`
   file holds parse completion until the test has observed the running window (`queueSignal` holds the "pending" state the same way). No real configuration or material is read.

   Timing (all optional, in the state file): `perPageMs` per page, `overheadMs` per call, `firstCallMs` once (the model load of the first parse),
   `delayMs` flat; the parse record the service would show for the run is visible to `list parses --json [--status S]` while it runs
   when `trackParses: true` (`queueMs`: first "pending", then "parsing"; `idleParses: true`: the service never reports it; `listFails: true`: the command fails), and
   `device` is shown by `server status` and `config show` the way a CLI that exposes it would. `failStarts: [page, ...]` fails every window starting there.
   `server status --json` answers the way the real one is understood to (`workers.parse_running`, `parse_queue_length`, `parse_server.local.healthy|starting`; `unhealthy`, `starting`, `statusJsonFails`
   shape it), `probeDelayMs` delays each read-only status/list answer (busy CLI startup), and `slowFromPage` + `slowMs` make every window starting at or after that page take that much longer (QA). */

const statePath = process.env.FAKE_MINERU_STATE, logPath = process.env.FAKE_MINERU_LOG;
const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// The test edits the state file while this process starts (a read can land in the middle of its replacement): read it again until it parses.
const readState = () => {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(readFileSync(statePath, 'utf8')); }
    catch (error) { if (attempt > 400) throw error; pause(15); }
  }
};
const state = readState();
// The state is written from several processes (this one, its parse, the test): replace it whole, never half-written.
const saveAtomic = () => {
  const temporary = `${statePath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  for (let attempt = 0; ; attempt++) {
    try { return renameSync(temporary, statePath); }
    catch (error) { if (attempt > 200 || !['EPERM', 'EBUSY', 'EACCES'].includes(error.code)) throw error; pause(15); }
  }
};
const save = saveAtomic;
const argv = process.argv.slice(2);
// The variables the one-click install sets are logged too, so a test can see which phase a call ran in (MINERU_MODEL_SOURCE local / modelscope / huggingface).
const seen = Object.fromEntries(['MINERU_HOME', 'MINERU_MODEL_SOURCE', 'HF_HUB_DISABLE_XET', 'TEMP'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
if (logPath) appendFileSync(logPath, `${JSON.stringify({ argv, pid: process.pid, at: Date.now(), ...(Object.keys(seen).length ? { env: seen } : {}) })}\n`);
const out = text => process.stdout.write(`${text}\n`);
const fail = (text, code = 1) => { process.stderr.write(`${text}\n`); process.exit(code); };
const flag = name => { const at = argv.indexOf(name); return at < 0 ? undefined : argv[at + 1]; };

const SERVICE_DOWN = "错误: 本地 mineru 服务未运行。请先运行 'mineru server start'。";
const needService = () => { if (state.configFails) fail('unexpected failure while reading the config', 2); if (state.running) return; if (state.errorOnStdout) { out(SERVICE_DOWN); process.exit(1); } fail(SERVICE_DOWN); };

const [command, sub] = argv;
if (state.probeDelayMs && ((command === 'server' && sub === 'status' && argv.includes('--json')) || (command === 'list' && sub === 'parses')))
  await new Promise(resolve => setTimeout(resolve, state.probeDelayMs));
if (command === '--version' || command === '-V') out(`mineru, version ${state.version ?? '4.0.10'}`);
else if (command === 'config' && sub === 'show') {
  needService();
  out(`parse_server:\n  local:\n    mode: ${state.mode ?? 'disabled'}\n    managed_tier: ${state.tier ?? 'flash'}${state.device ? `\n    device: ${state.device}` : ''}`);
} else if (command === 'config' && sub === 'get') {
  needService();
  const key = argv[2];
  // The real CLI prints the whole line, not the bare value: `parse_server.local.mode = managed  [override]` (or `[default]`).
  if (key === 'parse_server.local.mode') out(`${key} = ${state.mode ?? 'disabled'}  [${state.mode === undefined ? 'default' : 'override'}]`);
  else if (key === 'parse_server.local.managed_tier') out(`${key} = ${state.tier ?? 'flash'}  [${state.tier === undefined ? 'default' : 'override'}]`);
  else fail(`unknown key ${key}`);
} else if (command === 'config' && sub === 'set') {
  needService();
  const [key, value] = [argv[2], argv[3]];
  // The models are ready when the state says so, or (an install with MINERU_HOME) when their folder is on disk.
  const onDisk = !!process.env.MINERU_HOME && existsSync(join(process.env.MINERU_HOME, 'models', state.tier === 'standard' ? 'MinerU2.5-Pro-2509-1.2B-GGUF' : 'MinerU-4_models_onnx'));
  if (key === 'parse_server.local.mode' && value === 'managed' && !state.modelsReady && !onDisk) fail(`Local managed tier '${state.tier}' requires model files that are not ready ... Run: mineru-kit models download --tier ${state.tier}`);
  if (key === 'parse_server.local.mode') state.mode = value;
  if (key === 'parse_server.local.managed_tier') state.tier = value;
  save(); out('ok');
} else if (command === 'server' && sub === 'status' && argv.includes('--json')) {
  // What the real CLI's `server status --json` shows about the workers (read-only): a stopped service says so and exits non-zero.
  if (!state.running) { out('服务未在运行。'); process.exit(state.statusExitsZero ? 0 : 1); }
  if (state.statusJsonFails) fail('unexpected failure while reading the status', 2);
  const active = !state.idleParses && state.active ? state.active : null;
  out(JSON.stringify({ running: true, pid: 12345, workers: { parse_running: active?.status === 'parsing' ? 1 : 0, parse_queue_length: active?.status === 'pending' ? 1 : 0 },
    parse_server: { local: { healthy: !state.unhealthy, starting: !!state.starting } } }, null, 2));
} else if (command === 'server' && sub === 'status') {
  if (state.running || state.statusStuck) {
    out(`┏━━━━━━━━━━┳━━━━━━━━━━┓\n┃ PID      ┃ 12345    ┃\n┃ Uptime   ┃ 2m       ┃\n┃ Version  ┃ 4.0.10   ┃${state.device ? `\n┃ Device   ┃ ${state.device.padEnd(8)} ┃` : ''}\n┗━━━━━━━━━━┻━━━━━━━━━━┛`);
  } else { out('服务未在运行。'); process.exit(state.statusExitsZero ? 0 : 1); }
} else if (command === 'server' && (sub === 'start' || sub === 'restart')) {
  if (state.vcRuntime) fail('ImportError: DLL load failed while importing onnxruntime_pybind11_state: 找不到指定的模块。');
  if (state.startFails || state.portInUse) fail('服务启动失败：端口被占用');
  // A service that crashes as it starts: what a learner must never read (a Python traceback in English).
  if (state.startTraceback) fail('Traceback (most recent call last):\n  File "mineru\\cli\\server.py", line 88, in start\n    raise RuntimeError("worker exited with code 3")\nRuntimeError: worker exited with code 3');
  if (state.startBlocksMs) await new Promise(resolve => setTimeout(resolve, state.startBlocksMs));
  state.running = true; state.starts = (state.starts || 0) + 1; save(); out('server started');
} else if (command === 'server' && sub === 'stop') { state.running = false; save(); out('server stopped'); }
else if (command === 'list' && sub === 'parses') {
  if (!state.running) fail(SERVICE_DOWN);
  if (state.listFails) fail('unexpected failure while listing parses', 2);
  const wanted = flag('--status'), active = !state.idleParses && state.active ? [state.active] : [];
  const rows = active.filter(row => !wanted || row.status === wanted).map(row => ({ priority: 0, privacy: 'local', via: null, coverage: null, created_at: 1, updated_at: 2, done_at: null, error_code: null, error_msg: null, short_id: 'abc', ...row }));
  out(JSON.stringify({ parses: rows, coverage: null, total: rows.length, limit: 50, offset: 0 }, null, 2));
} else if (command === 'parse') {
  if (!state.running) fail("本地 mineru 服务未运行。请先运行 'mineru server start'");
  const pdf = argv[1], output = flag('-o');
  // `totalFromPdf`: the page count of the PDF itself, for a test that converts books of different lengths with one fake.
  if (state.totalFromPdf) state.total = (await (await import('pdf-lib')).PDFDocument.load(readFileSync(pdf), { updateMetadata: false })).getPageCount();
  const pages = state.ignorePages ? '1-10' : flag('--pages') ?? '1-10'; // the real default: only the first 10 pages (ignorePages: a CLI that does not honour --pages)
  const range = /^(\d+)-(\d+)$/.exec(pages) ?? [null, pages, pages];
  const [first, last] = [Number(range[1]), Math.min(Number(range[2]), state.total)];
  if (state.failWindowsOnce?.includes(first)) { state.failWindowsOnce = state.failWindowsOnce.filter(item => item !== first); save(); fail('parse failed: model crashed', 2); }
  if (state.failStarts?.includes(first)) fail('parse failed: model crashed', 2);
  if (state.dieOnFirst && first === state.dieOnFirst) { state.running = false; save(); fail('connection to the local server was lost'); }
  const delay = (state.loaded ? 0 : state.firstCallMs || 0) + (state.overheadMs || 0) + (state.perPageMs || 0) * (last - first + 1) + (state.delayMs || 0)
    + (state.slowFromPage && first >= state.slowFromPage ? state.slowMs || 0 : 0); // a machine that is fast until some page and then very slow (QA)
  const tracked = !!state.trackParses && !state.idleParses;
  if (tracked) {
    state.nextParseId = (state.nextParseId || 100) + 1;
    state.active = { id: state.nextParseId, sha256: state.sha256 || 'fake-sha', tier: flag('--tier') ?? 'basic', page_range: `${first}-${last}`, status: state.queueMs || state.queueSignal ? 'pending' : 'parsing' };
    saveAtomic();
    if (state.queueMs) setTimeout(() => { state.active = { ...state.active, status: 'parsing' }; saveAtomic(); }, state.queueMs);
    else if (state.queueSignal) { // queued until the test has seen the queue (a synthetic hold, like `finishSignal`)
      const leaveQueue = () => { if (existsSync(state.queueSignal)) { state.active = { ...state.active, status: 'parsing' }; saveAtomic(); } else setTimeout(leaveQueue, 25); };
      leaveQueue();
    }
  }
  const finish = () => {
    if (tracked || state.firstCallMs) { delete state.active; state.loaded = true; saveAtomic(); }
    const eol = state.crlf ? '\r\n' : '\n';
    const parts = [];
    for (let page = first; page <= last; page++) {
      parts.push(`<!-- page ${page} of ${state.total} -->`);
      if (state.blank?.includes(page)) continue;
      parts.push(`## Chapter ${Math.ceil(page / 10)}: 简介 ${page}`, 'Chapter 1: Introduction', `${state.text ?? '这是第'} ${page} 页的正文。`,
        `![Image block](doc:5008352/tier:${flag('--tier') ?? 'basic'}/page:${page}/block:1)`, '• 要点一', '• 要点二', `${page}`);
    }
    writeFileSync(output, `${parts.join(eol)}${eol}`, 'utf8');
    if (argv.includes('--json')) out(JSON.stringify({ status: 'done', pdf, pages, output }));
    process.exit(0);
  };
  const finishWhenReleased = () => {
    if (state.finishSignal && !existsSync(state.finishSignal)) { setTimeout(finishWhenReleased, 25); return; }
    finish();
  };
  if (delay) setTimeout(finishWhenReleased, delay); else finishWhenReleased();
} else if (command === 'models' && (sub === 'download' || sub === 'verify')) {
  // mineru-kit models download --tier T --source S | models verify --tier T: the models live under $MINERU_HOME/models (the install sets it), in the folder the real tool names.
  const tier = flag('--tier') ?? 'basic', home = process.env.MINERU_HOME || state.home;
  const folder = home ? join(home, 'models', tier === 'standard' ? 'MinerU2.5-Pro-2509-1.2B-GGUF' : 'MinerU-4_models_onnx') : null;
  if (sub === 'verify') {
    if (folder && existsSync(folder) && !state.modelsBroken) { out(`models of tier ${tier}: ok`); process.exit(0); }
    fail(`models of tier ${tier} are missing`, 1);
  }
  out(`Downloading ${tier} models from ${flag('--source') ?? 'huggingface'} ...`); out(' 45%|####5     | 360M/800M');
  if (state.downloadFails) fail(state.downloadError || 'error sending request for url (https://www.modelscope.cn/models): network error while downloading');
  const finish = () => {
    if (folder) { mkdirSync(folder, { recursive: true }); writeFileSync(join(folder, 'model.onnx'), 'fake model'); }
    state.modelsReady = true; state.modelSource = flag('--source'); save(); out('100%|##########| 800M/800M'); process.exit(0);
  };
  if (state.downloadDelayMs) setTimeout(finish, state.downloadDelayMs); else finish();
} else if (command === '--tier') { // the old separate model downloader: mineru-models-download --tier T
  out(`Downloading ${argv[1]} models ...`); out('50%');
  if (state.downloadFails) fail('network error while downloading');
  const finish = () => { state.modelsReady = true; save(); out('100% done'); process.exit(0); };
  if (state.downloadDelayMs) setTimeout(finish, state.downloadDelayMs); else finish();
} else fail(`unknown command ${argv.join(' ')}`);
