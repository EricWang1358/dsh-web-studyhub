import { CommandError, runLocalCommand } from './local-command.js';
import { redactSecrets } from './plain-reason.js';
import { VC_RUNTIME_FAILURE } from './tool-install.js';
import { existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, readdir, realpath as fsRealpath, rm, stat } from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import path from 'node:path';

/* The local `mineru` command line (free, nothing leaves the computer). StudyHub finds it, reads its state with read-only calls,
   and, only when the learner clicks, starts its service or sets it up; a conversion runs it on consecutive page windows
   (`--pages a-b` is native, so no PDF splitting is needed) and reads the Markdown it writes into the same page model the cloud
   route produces (lib/mineru-merge.js). What is known about the CLI (4.0.x) comes from a real install: Markdown output only,
   pages delimited by `<!-- page N of TOTAL -->` (N is the original page number), images only as placeholders, a local service
   that must be running, and a DEFAULT of just the first 10 pages: so every parse here states its pages explicitly. */

export const LOCAL = Object.freeze({
  /** The most pages one `mineru parse` call may take: the old fixed window, now the ceiling of the adaptive plan (and the size of a "fixed" plan). */
  windowPages: 50,
  /* The adaptive plan (the default), all its numbers in one place. Progress, resume and cancel work in windows of pages. The FIRST window is small, so the
     first progress, the first measured pace and the first estimate come quickly; the next ones ramp up (10, 20, 20); after that each window is sized from the
     measured seconds per page so that it lasts about `targetWindowSeconds`, within [minWindowPages, maxWindowPages]. A slow machine or a scanned book keeps
     small windows (the bar still moves about once a minute), a fast one grows to 50. Every window costs a fixed overhead (starting the command, reading the
     result), which is why a window is never smaller than `minWindowPages`. */
  firstWindowPages: 10, rampPages: Object.freeze([10, 20, 20]), targetWindowSeconds: 75, minWindowPages: 5, maxWindowPages: 50,
  /** The pace is read from the latest windows; a first window more than this many times slower per page than the rest (it also loads the model) is left out. */
  paceWindows: 3, slowFirstFactor: 1.5,
  /** How often a running window asks the service (read-only) whether it is working on it (0 turns the question off), when it asks first, how long a question may take,
   *  and when "no response" may be said: only when the service reports nothing parsing or queued for `idleProbes` answers in a row AND nothing was heard for `silentMs`. */
  livenessMs: 20_000, livenessFirstMs: 5_000, probeTimeoutMs: 10_000, silentMs: 120_000, idleProbes: 3,
  /** The pace is called unstable when the windows it comes from differ more than this factor; one window alone is only a first reading (the model load is in it). */
  unstableFactor: 1.5, etaSingleBand: Object.freeze([0.6, 1.1]),
  /** The tiers worth setting up ('flash' is the base package's text-only preview). */
  tiers: Object.freeze(['basic', 'standard', 'advanced']),
  /** The wait StudyHub asks the CLI for, per window: generous but bounded; the first window of a run also gets the time the model needs to load, and a slow machine
   *  (a measured pace) gets `waitPaceFactor` times its own seconds per page, so a slow scan is never cut off by a wait written for a fast one. */
  waitFloorSec: 120, waitPerPageSec: 8, waitCeilSec: 12 * 3600, loadAllowanceSec: 180, waitPaceFactor: 3,
  /** Measured once, on one CPU-only Windows laptop: seconds per page. An estimate for the learner, never a promise. */
  secondsPerPage: Object.freeze({ basic: 1.6, standard: 2.5 }),
  /** Models the learner is asked to confirm before they are downloaded (about, in MB; standard to be measured on a real install). */
  modelsMb: Object.freeze({ basic: 800, standard: 2000 }),
  /** When `parse-server` is still warming up or occupied by another parse (`engine_unavailable`), wait and retry instead of failing or halving windows. */
  engineBusyRetries: 8, engineBusyWaitMs: 5_000,
  commandTimeoutMs: 20_000,
  /** Making the settings folder private (secureMineruHome): at most this many files and folders below it are visited (a home holds about a hundred: config,
   *  logs, the models of a tier); the rest is left as it is and the result says so. Each one visited is read, and only one that does not already inherit
   *  exactly what the home gives is written; writing a folder also passes the change down to everything below it, so a healthy home costs reads only and a
   *  broken one about one pass. The whole step may take this long. */
  homeHealMaxEntries: 2000, homeSecureTimeoutMs: 60_000,
  /** The settings folder of a StudyHub install is `<install folder>/<homeFolderName>`, and the install folder carries `studyhubSentinel`: the only folder whose
   *  permissions StudyHub ever changes (secureMineruHome). */
  homeFolderName: 'home', studyhubSentinel: '.studyhub-mineru.json',
});

export class LocalMineruError extends Error {
  constructor(code, message, { retryable = false } = {}) { super(message); this.name = 'LocalMineruError'; this.code = code; this.retryable = retryable; }
}

export const LOCAL_MESSAGES = Object.freeze({
  notInstalled: '这台电脑上还没有可用的 MinerU：请在「设置 › PDF 转换」点「一键安装」。',
  serverStopped: '本机 MinerU 服务没有在运行，或解析到一半停了。点「接着做」会先启动服务，再从停下的那一段接着解析（已完成的段落会保留）。',
  engineBusy: '本机 MinerU 解析引擎正被其他任务占用或尚未就绪。请等正在进行的解析完成后点「接着做」继续（已完成的段落会保留）。',
  waitingEngine: '本机解析引擎正忙或正在就绪，等待空闲后自动继续…',
  timeout: '这一段本地解析用了太久，已先停下。可以点「接着做」重试这一段。',
  emptyOutput: '本地解析没有写出结果文件，请重试这一段。',
  headerFooter: '本地解析可能把页眉、页脚和页码也留在了正文里；它们没有被删除。',
  setupNeedsModels: '本机 MinerU 还没有下载模型：请在「设置 › PDF 转换」点「修复」。',
  badTier: '本地解析的档位只能是 basic 或 standard。',
  unreadable: '读不出本地 mineru 的设置，没法确认它能不能用。请先点「重新检测」。',
});

const clip = (value, length = 240) => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, length);

/* ---------- finding it ---------- */

/**
 * Where `mineru` is: MINERU_BIN, then PATH, then ~/.local/bin (where `uv tool install` puts it).
 * Resolves { file, prefix: [], env: {} } or null. `exists`, `homedir` and `platform` can be given for tests.
 */
export function locateMineru({ env = process.env, platform = process.platform, homedir = osHomedir(), exists = existsSync } = {}) {
  const flavour = platform === 'win32' ? path.win32 : path.posix;
  const name = platform === 'win32' ? 'mineru.exe' : 'mineru';
  const candidates = [];
  if (env.MINERU_BIN) candidates.push(env.MINERU_BIN);
  for (const folder of String(env.PATH ?? env.Path ?? '').split(platform === 'win32' ? ';' : ':').filter(Boolean)) candidates.push(flavour.join(folder, name));
  candidates.push(flavour.join(homedir, '.local', 'bin', name));
  const file = candidates.find(candidate => { try { return exists(candidate); } catch { return false; } });
  return file ? { file, prefix: [], env: {} } : null;
}

/* ---------- running it ---------- */

export async function runCli(cli, args, options) {
  try { return await runLocalCommand(cli, args, options); }
  catch (error) {
    if (error instanceof CommandError) throw new LocalMineruError(error.code, error.code === 'timeout' ? LOCAL_MESSAGES.timeout : LOCAL_MESSAGES.notInstalled, { retryable: error.code === 'timeout' });
    throw error;
  }
}

/* ---------- one honest state ---------- */

const firstLine = text => String(text ?? '').split(/\r?\n/).map(line => line.trim()).find(Boolean) ?? '';
const unquote = value => value.replace(/^['"]|['"]$/g, '');
/** The value of a `mineru config get` answer. The CLI prints the whole line, "parse_server.local.mode = managed  [override]"
 *  (the bracket says where the value comes from), not the bare value; a bare value is read too. */
const configValue = text => {
  const line = firstLine(text), match = /=\s*(\S+)/.exec(line);
  return unquote(match ? match[1] : line).toLowerCase();
};

/** The folders the real tool downloads a tier's models into (under <home>/models): basic is MinerU-4_models_onnx (or _torch), standard is
 *  MinerU2.5-Pro-…-GGUF. Neither is named after the tier, so a folder is also accepted when its name contains the tier word. */
const MODEL_FOLDERS = Object.freeze({ basic: /models_(?:onnx|torch)/i, standard: /gguf/i });
async function modelsFolder(home, tier) {
  const dir = path.join(home, 'models');
  try {
    // readdir follows a junction or a symbolic link: models are often moved to another drive.
    const entries = await readdir(dir);
    return { dir, present: entries.length > 0, downloaded: !!tier && entries.some(entry => MODEL_FOLDERS[tier]?.test(entry) || entry.toLowerCase().includes(tier)) };
  } catch { return { dir, present: false, downloaded: false }; }
}

export const STILL_STARTING = /still starting|仍在启动中/i;

/**
 * MinerU 4.1+ refuses to start `doclib` when `$MINERU_HOME` is writable by other users (`mineru/utils/private_file.py`):
 * on POSIX with `umask 0002`, `mkdir` leaves `0o775` (`st_mode & 0o022 != 0`); on Windows, non-profile folders such as
 * `D:\StudyHub\MinerU\home` inherit `Authenticated Users` / `BUILTIN\Users` write ACEs that Python 3.12's `makedirs` does not strip.
 * Tightens `$MINERU_HOME` (0700 on POSIX; protected DACL for current user + SYSTEM + Administrators on Windows) before starting MinerU.
 */
const WIN_SECURE_HOME_PY = [
  'import ctypes, sys, os, json',
  'from ctypes import wintypes as w',
  // A home that is itself a link or a junction is another folder: nothing is changed (secureMineruHome refuses it first; this is the second look).
  'if os.path.lexists(sys.argv[1]) and os.lstat(sys.argv[1]).st_file_attributes & 0x400: print(json.dumps({"refused": "link"})); sys.exit(0)',
  'p = ctypes.c_void_p; k = ctypes.WinDLL("kernel32", use_last_error=True); a = ctypes.WinDLL("advapi32", use_last_error=True)',
  'k.GetCurrentProcess.restype = w.HANDLE; k.CloseHandle.argtypes = [w.HANDLE]; k.LocalFree.argtypes = [p]',
  'a.OpenProcessToken.argtypes = [w.HANDLE, w.DWORD, ctypes.POINTER(w.HANDLE)]; a.OpenProcessToken.restype = w.BOOL',
  'a.GetTokenInformation.argtypes = [w.HANDLE, ctypes.c_int, p, w.DWORD, ctypes.POINTER(w.DWORD)]; a.GetTokenInformation.restype = w.BOOL',
  'a.ConvertSidToStringSidW.argtypes = [p, ctypes.POINTER(w.LPWSTR)]; a.ConvertSidToStringSidW.restype = w.BOOL',
  'a.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [w.LPCWSTR, w.DWORD, ctypes.POINTER(p), ctypes.POINTER(w.DWORD)]',
  'a.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = w.BOOL',
  'a.SetFileSecurityW.argtypes = [w.LPCWSTR, w.DWORD, p]; a.SetFileSecurityW.restype = w.BOOL',
  'tok = w.HANDLE(); sz = w.DWORD(); sid_s = w.LPWSTR(); sd = p()',
  'assert a.OpenProcessToken(k.GetCurrentProcess(), 8, ctypes.byref(tok))',
  'a.GetTokenInformation(tok, 1, None, 0, ctypes.byref(sz)); buf = ctypes.create_string_buffer(sz.value)',
  'assert a.GetTokenInformation(tok, 1, buf, sz, ctypes.byref(sz))',
  'sid = ctypes.cast(buf, ctypes.POINTER(p)).contents.value',
  'assert a.ConvertSidToStringSidW(sid, ctypes.byref(sid_s))',
  'sddl = f"D:P(A;OICI;FA;;;{sid_s.value})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"',
  'assert a.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(sd), None)',
  'ok = a.SetFileSecurityW(sys.argv[1], 0x80000004, sd)',
  'err = ctypes.get_last_error()',
  'k.LocalFree(sd); k.LocalFree(ctypes.cast(sid_s, p))',
  'if not ok: raise ctypes.WinError(err)',
  /* Then every file and folder already below it goes back to inheriting from it (an explicit empty list, unprotected: SetNamedSecurityInfoW computes the inherited part),
     top-down so each child inherits from a parent already repaired. SetFileSecurityW above does not pass the change down: files that were there keep their old entries,
     and a file whose list is empty (D:PAI, seen on a learner's machine) cannot even be read by its owner. Each entry is READ first and written only when it does not
     already hold exactly what the home gives (unprotected, every entry inherited, an allow of full control to this user, SYSTEM or Administrators): writing a folder
     passes the change down its whole subtree, so a healthy home costs reads only. Links and junctions (models moved to another drive) and files with another name
     elsewhere (a hard link: its list is shared with that name) are left alone, the home itself is never reset (that would undo its protection), and at most argv[2]
     entries are visited. `healed` counts what was written; `linked` counts the hard-linked files left alone whose list is not what the home gives (the repair
     is then not complete, and the result says so). */
  'a.InitializeAcl.argtypes = [p, w.DWORD, w.DWORD]; a.InitializeAcl.restype = w.BOOL',
  'a.SetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD, p, p, p, p]; a.SetNamedSecurityInfoW.restype = w.DWORD',
  'a.GetNamedSecurityInfoW.argtypes = [w.LPCWSTR, ctypes.c_int, w.DWORD, p, p, ctypes.POINTER(p), p, ctypes.POINTER(p)]; a.GetNamedSecurityInfoW.restype = w.DWORD',
  'a.GetSecurityDescriptorControl.argtypes = [p, ctypes.POINTER(w.WORD), ctypes.POINTER(w.DWORD)]; a.GetSecurityDescriptorControl.restype = w.BOOL',
  'a.GetAce.argtypes = [p, w.DWORD, ctypes.POINTER(p)]; a.GetAce.restype = w.BOOL',
  'a.EqualSid.argtypes = [p, p]; a.EqualSid.restype = w.BOOL',
  'a.ConvertStringSidToSidW.argtypes = [w.LPCWSTR, ctypes.POINTER(p)]; a.ConvertStringSidToSidW.restype = w.BOOL',
  'sids = [sid]',
  'for s in ("S-1-5-18", "S-1-5-32-544"):',
  '  q = p(); assert a.ConvertStringSidToSidW(s, ctypes.byref(q)); sids.append(q.value)',
  'def healthy(path):',
  '  dacl = p(); desc = p()',
  '  if a.GetNamedSecurityInfoW(path, 1, 4, None, None, ctypes.byref(dacl), None, ctypes.byref(desc)): return False',
  '  try:',
  '    ctl = w.WORD(); rev = w.DWORD()',
  '    if not dacl.value or not a.GetSecurityDescriptorControl(desc, ctypes.byref(ctl), ctypes.byref(rev)) or ctl.value & 0x1000: return False',
  '    count = ctypes.cast(dacl.value + 4, ctypes.POINTER(w.WORD)).contents.value; found = set()',
  '    for i in range(count):',
  '      ace = p()',
  '      if not a.GetAce(dacl, i, ctypes.byref(ace)): return False',
  '      kind, flags = ctypes.cast(ace.value, ctypes.POINTER(ctypes.c_ubyte * 2)).contents',
  '      mask = ctypes.cast(ace.value + 4, ctypes.POINTER(w.DWORD)).contents.value',
  '      if kind != 0 or not flags & 0x10 or flags & 0x08 or mask != 0x1F01FF: return False',
  '      match = [j for j, s in enumerate(sids) if a.EqualSid(ace.value + 8, s)]',
  '      if not match: return False',
  '      found.add(match[0])',
  '    return len(found) == 3',
  '  finally: k.LocalFree(desc)',
  'acl = ctypes.create_string_buffer(64); assert a.InitializeAcl(acl, 64, 2)',
  'limit = int(sys.argv[2]); seen = 0; changed = 0; linked = 0; bad = []; todo = [sys.argv[1]]; stopped = False',
  'while todo and not stopped:',
  '  try: entries = list(os.scandir(todo.pop()))',
  '  except OSError as e: bad.append(f"{e.filename}: {e.strerror}"); continue',
  '  for e in entries:',
  '    if seen >= limit: stopped = True; break',
  '    seen += 1',
  '    try: st = os.lstat(e.path)',
  '    except OSError as x: bad.append(f"{e.path}: {x.strerror}"); continue',
  '    if st.st_file_attributes & 0x400: continue',
  '    folder = e.is_dir(follow_symlinks=False)',
  '    if not folder and st.st_nlink > 1:',
  '      if not healthy(e.path): linked += 1',
  '      continue',
  '    if not healthy(e.path):',
  '      r = a.SetNamedSecurityInfoW(e.path, 1, 0x20000004, None, None, acl, None)',
  '      if r: bad.append(f"{e.path}: {ctypes.FormatError(r).strip()}"); continue',
  '      changed += 1',
  '    if folder: todo.append(e.path)',
  'k.CloseHandle(tok)',
  'print(json.dumps({"healed": changed, "linked": linked, "failed": len(bad), "first": bad[:1], "partial": stopped or (bool(todo) and seen >= limit)}))',
].join('\n');

/** The last line of a run's output that parses as JSON, or {}. */
const reportOf = text => { for (const line of String(text ?? '').split(/\r?\n/).reverse()) { try { const value = JSON.parse(line); if (value && typeof value === 'object') return value; } catch { /* not the report */ } } return {}; };

/** POSIX: the home 0700, and the files directly in it (config.yaml and whatever credential file MinerU keeps there) 0600; logs and models keep theirs. */
async function securePosixHome(home) {
  const changed = await chmod(home, 0o700).then(() => ({ ok: true }), error => ({ ok: false, error: error?.message || String(error) }));
  for (const entry of await readdir(home, { withFileTypes: true }).catch(() => [])) if (entry.isFile()) await chmod(path.join(home, entry.name), 0o600).catch(() => {});
  return changed;
}

/**
 * Why `home` is not a folder whose permissions StudyHub may change, or '' when it is: only `<a folder carrying StudyHub's sentinel>/home`, never a drive root
 * or the user's own folder, never a link or junction (that is another folder: the walk would change the permissions of its target). Another MinerU's
 * settings folder (~/.mineru, a MINERU_HOME of the learner's) is never StudyHub's to change.
 */
async function notOurHome(home) {
  const resolved = path.resolve(home), parent = path.dirname(resolved);
  const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (parent === resolved || same(resolved, path.parse(resolved).root)) return 'it is a drive root';
  if (same(resolved, path.resolve(osHomedir()))) return 'it is the user\'s own folder';
  if (path.basename(resolved) !== LOCAL.homeFolderName) return `it is not named "${LOCAL.homeFolderName}"`;
  if (!existsSync(path.join(parent, LOCAL.studyhubSentinel))) return 'the folder around it was not created by StudyHub';
  const link = await lstat(resolved).then(stats => stats.isSymbolicLink(), () => false);
  return link ? 'it is a link or junction to another folder' : '';
}

/**
 * Make the settings folder private, and set what is already inside it back to inheriting from it (Windows; on POSIX its files are made owner-only). Resolves
 * { ok: true, healed?, partial? } (done; `healed`: how many entries were changed; `partial`: it stopped after LOCAL.homeHealMaxEntries entries below the home and
 * left the rest as it was), { ok: false, error } (the permissions could not be changed, or some entries below could not be repaired: a start may then be refused
 * by MinerU), { ok: false, linked, healed?, error } (done except `linked` hard-linked files whose permissions were wrong and were left alone: the repair is not
 * complete), { ok: false, skipped: 'no-python', error } (Windows, no Python to change them with: not done), or { ok: false, skipped: 'not-ours', error } (not
 * the settings folder of a StudyHub install: nothing changed, nothing created). Never throws; homeNote says any of it in one line.
 */
export async function secureMineruHome(home, { pythonCli, cli, platform = process.platform, signal, maxEntries = LOCAL.homeHealMaxEntries, timeoutMs = LOCAL.homeSecureTimeoutMs } = {}) {
  if (!home) return { ok: true };
  const refused = await notOurHome(home);
  if (refused) return { ok: false, skipped: 'not-ours', error: refused };
  await mkdir(home, { recursive: true, mode: 0o700 }).catch(() => {});
  if (platform !== 'win32') return securePosixHome(home);
  if (process.platform !== 'win32') return { ok: true };
  let py = pythonCli || null;
  if (!py && cli?.file && /(?:^|[\\/])mineru(?:\.exe)?$/i.test(cli.file)) {
    const sibling = path.win32.join(path.win32.dirname(cli.file), 'python.exe');
    if (existsSync(sibling)) py = { file: sibling, prefix: [], env: cli.env || {} };
  }
  if (!py) return { ok: false, skipped: 'no-python', error: 'no Python found to change them with' };
  try {
    const result = await runCli(py, ['-c', WIN_SECURE_HOME_PY, home, String(maxEntries)], { signal, timeoutMs });
    if (result.code !== 0) {
      const said = `${result.stderr || ''}\n${result.stdout || ''}`.split(/\r?\n/).map(line => line.trim()).filter(Boolean).pop();
      return { ok: false, error: said || `exit ${result.code}` };
    }
    const report = reportOf(result.stdout), healed = Number(report.healed) || 0;
    if (report.refused) return { ok: false, skipped: 'not-ours', error: 'it is a link or junction to another folder' };
    if (report.failed > 0) return { ok: false, error: `${report.failed} item(s) below it could not be repaired, e.g. ${report.first?.[0] || '?'}`, healed };
    // Hard-linked files whose list is wrong were left alone (changing one changes the same file under its other name): not done, said with the count.
    const linked = Number(report.linked) || 0;
    if (linked > 0) return { ok: false, linked, ...(healed ? { healed } : {}), error: `${linked} linked file(s) were left alone` };
    return { ok: true, ...(healed ? { healed } : {}), ...(report.partial ? { partial: true } : {}) };
  } catch (error) {
    // runCli's own errors are worded for a parse or for a missing MinerU: the repair says what happened to it in its own words.
    if (signal?.aborted) return { ok: false, error: 'stopped' };
    if (error?.code === 'timeout') return { ok: false, error: `the permission repair took longer than ${Math.round(timeoutMs / 100) / 10} s and was stopped` };
    return { ok: false, error: `the Python used to change them (${py.file}) could not be run` };
  }
}

/** What a secureMineruHome result says about `home`, as one line for the install log and the detail of a failed start ('' when there is nothing to say). */
export function homeNote(result, home) {
  if (!result) return '';
  if (result.skipped === 'not-ours') return `left the permissions of ${home} as they are: ${result.error}`;
  if (result.linked > 0) return `restricted permissions on ${home}, but ${result.linked} file(s) below it were left alone because they are also linked from elsewhere (changing them would change that other place too), so the repair is not complete`;
  if (!result.ok) return `could not restrict permissions on ${home}: ${result.error}`;
  return result.partial ? `restricted permissions on ${home}, but looked at only the first ${LOCAL.homeHealMaxEntries} items below it (changed ${result.healed || 0}); the rest were left as they were` : '';
}

/* A permission failure is about the SETTINGS FOLDER (not the chosen location) when MinerU says its home or credentials are not private, or when the path IN a
   denial is inside the home: the location was writable (the plan checked it), so moving it fixes nothing; repairing the permissions does. Only the path the denial
   itself names counts: a log line elsewhere in the same text that mentions the home (a "see <home>\logs\…", a "Loading config from <home>\config.yaml") says nothing
   about what was denied. Python prints the path quoted with its backslashes doubled. */
const PRIVATE_HOME = /Credential configuration (?:directory|file)|cannot enforce private credential/i;
export const PERMISSION_DENIED = /Permission denied|Access (?:to the path .+? )?is denied|\bEACCES\b|WinError 5\b|os error 5\b|拒绝访问/i;
/** The path each denial in `text` names, as printed: Python ("Permission denied: '…'", "[WinError 5] Access is denied: '…'", "拒绝访问。: '…'"), .NET ("Access to
 *  the path '…' is denied"), Node ("EACCES: permission denied, open '…'") and Rust/uv ("`…`: Access is denied"). */
const DENIED_PATHS = Object.freeze([
  /(?:Permission denied|Access is denied|拒绝访问)[。.]?\s*[:：]\s*(['"])(.+?)\1/gi,
  /Access to the path (['"])(.+?)\1 is denied/gi,
  /\bEACCES\b[^'"\n]*?(['"])(.+?)\1/g,
  /`()([^`\n]+)`\s*:\s*(?:Access is denied|Permission denied|拒绝访问)/gi,
]);
const QUOTED_PATHS = /(['"`])([^'"`\n]+)\1/g;
/** `file` relative to `home` ('' for the home itself) when it is the home or inside it, else null: separators and case do not matter, a sibling such as
 *  `<home>2` is not inside, and a relative path is never inside. */
function insideHome(rawFile, home) {
  // Windows' long-path prefix (\\?\D:\…, \\?\UNC\server\share\…) names the same place, so it is compared without it. A short 8.3 name (PROGRA~1) is not
  // expanded: such a path is not recognised as inside the home and stays not-writable (a known limit).
  const unprefix = value => value.replace(/^[\\/]{1,2}\?[\\/]UNC[\\/]/i, '\\\\').replace(/^[\\/]{1,2}\?[\\/]/, '');
  const file = unprefix(rawFile);
  const single = value => value.replace(/([\\/])[\\/]+/g, '$1'), norm = value => single(unprefix(value)).replace(/\\/g, '/').toLowerCase();
  const base = norm(String(home || '')).replace(/\/+$/, '');
  if (!base || !/^(?:[A-Za-z]:)?[\\/]/.test(file)) return null;
  const target = norm(file).replace(/\/+$/, '');
  if (target === base) return '';
  return target.startsWith(`${base}/`) ? single(file).slice(base.length).replace(/^[\\/]+|[\\/]+$/g, '') : null;
}
/** { file } (the path below the home that was denied, '' when none is named) when `said` is a permission failure inside the settings folder `home`; otherwise null. */
export function homePermissionFailure(said, home) {
  const text = String(said ?? '').replace(/\\\\/g, '\\');
  for (const pattern of DENIED_PATHS) {
    for (const match of text.matchAll(pattern)) {
      const file = insideHome(match[2], home);
      if (file !== null) return { file };
    }
  }
  // MinerU's privacy complaint is about its settings folder whatever path it prints; the file is the one its own line quotes, when that is inside the home.
  const line = text.split(/\r?\n/).find(each => PRIVATE_HOME.test(each));
  if (!line) return null;
  for (const match of line.matchAll(QUOTED_PATHS)) {
    const file = insideHome(match[2], home);
    if (file !== null) return { file };
  }
  return { file: '' };
}

/* MinerU's background daemon logs under `<home>/logs/`, where `mineru server start` sends child tracebacks instead of printing them. The reason of a failed start is
   read only from the two error logs, and only from what that start wrote (markServerLogs before it, serverErrorsSince after): an earlier run's traceback or an
   ordinary line of the general doclib.log must never decide it. All three are shown (readMineruServerLogs). */
const SERVER_ERROR_LOGS = Object.freeze(['doclib.stderr.log', 'doclib.parse-server.stderr.log']);
const SERVER_LOGS = Object.freeze([...SERVER_ERROR_LOGS, 'doclib.log']);
/** The most of the end of one log that is ever read: the log of a service that has run for weeks has no size limit. */
const LOG_TAIL_BYTES = 64 * 1024;

/** The end of one file from byte `from` (at most LOG_TAIL_BYTES); '' when it is absent. A file now shorter than `from` was replaced: all of it is new. */
async function readLogTail(file, from = 0) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { size } = await handle.stat();
    const start = Math.max(size < from ? 0 : from, size - LOG_TAIL_BYTES), length = size - start;
    if (length <= 0) return '';
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}

/** Where each error log ends now ({ name: bytes }; 0 when it does not exist yet). Taken just before a start. */
export async function markServerLogs(home) {
  const mark = {};
  for (const name of SERVER_ERROR_LOGS) mark[name] = home ? await stat(path.join(home, 'logs', name)).then(info => info.size, () => 0) : 0;
  return mark;
}

/** What the error logs got since `mark`: the only log text a failed start's reason is read from. Not redacted, and never shown. */
export async function serverErrorsSince(home, mark = {}) {
  if (!home) return '';
  const parts = [];
  for (const name of SERVER_ERROR_LOGS) {
    const text = (await readLogTail(path.join(home, 'logs', name), mark[name] ?? 0)).trim();
    if (text) parts.push(text);
  }
  return parts.join('\n').slice(-4000);
}

/** The tail of each daemon log (the general one too), secrets hidden: for the install log and 详细信息. */
export async function readMineruServerLogs(home, { maxLines = 24, maxChars = 3200 } = {}) {
  if (!home) return '';
  const sections = [];
  for (const name of SERVER_LOGS) {
    const lines = (await readLogTail(path.join(home, 'logs', name))).split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).slice(-maxLines);
    if (lines.length) sections.push(`[${name}]\n${redactSecrets(lines.join('\n'))}`);
  }
  return sections.join('\n').slice(-maxChars);
}

/**
 * The state of the local mineru, from read-only calls only (--version, server status, config get):
 * 'not-installed' | 'server-stopped' | 'needs-models' (running, but not set up for a usable tier) | 'ready' | 'unknown'.
 * Resolves { state, next: null | 'install' | 'start-server' | 'download-models' | 'enable' | 'recheck', version, exe, tier, mode, running,
 * modelsDownloaded, modelsMb }. Never starts, installs or changes anything.
 *
 * The CLI keeps its settings in its own service, so `config get` only works while the service runs (stopped, it exits non-zero
 * with "本地 mineru 服务未运行…"). Hence the service is asked about FIRST: a stopped one is 'server-stopped' whatever was set up
 * before (tier, mode and models are then unknown: null/''), and only once it runs are the settings read. A settings read that
 * fails for any other reason is 'unknown': never taken for "not set up".
 */
export async function detectLocal({ cli, home, env = process.env, signal } = {}) {
  if (!cli) return { state: 'not-installed', next: 'install' };
  const run = args => runCli(cli, args, { signal }).catch(error => { if (error instanceof LocalMineruError && error.code === 'timeout') return { code: 124, stdout: '', stderr: '' }; throw error; });
  const said = result => `${result.stdout}\n${result.stderr}`;
  // Each call is a Python start-up (2 s for --version, 5 s for server status on a real install): the two that do not depend on each other go out together (#683).
  const [versionResult, status] = await Promise.all([run(['--version']), run(['server', 'status'])]);
  const version = (/(\d+\.\d+\.\d+(?:[.\w-]*)?)/.exec(firstLine(versionResult.stdout))?.[1]) ?? '';
  const where = home || cli.env?.MINERU_HOME || env.MINERU_HOME || path.join(osHomedir(), '.mineru');
  const unknown = { version, exe: cli.file, tier: '', mode: '', modelsDownloaded: null, modelsMb: LOCAL.modelsMb.basic };
  const stopped = { ...unknown, state: 'server-stopped', next: 'start-server', running: false };
  if (status.code === 124) return { ...unknown, state: 'unknown', next: 'recheck', running: false };
  const starting = status.code === 0 && STILL_STARTING.test(said(status));
  const running = status.code === 0 && !starting && /PID\D{0,40}\d{2,}/i.test(status.stdout) && !NOT_RUNNING.test(said(status));
  if (!running) return starting ? { ...stopped, starting: true } : stopped;
  const [mode, tier] = await Promise.all([run(['config', 'get', 'parse_server.local.mode']), run(['config', 'get', 'parse_server.local.managed_tier'])]);
  if ([mode, tier].some(result => NOT_RUNNING.test(said(result)))) return stopped; // it stopped between the two calls
  if (mode.code !== 0 || tier.code !== 0) return { ...unknown, state: 'unknown', next: 'recheck', running: true };
  const [modeName, tierName] = [configValue(mode.stdout), configValue(tier.stdout)];
  const folder = await modelsFolder(where, tierName);
  const base = { version, exe: cli.file, tier: tierName, mode: modeName, modelsDownloaded: folder.downloaded, modelsMb: LOCAL.modelsMb[LOCAL.tiers.includes(tierName) && LOCAL.modelsMb[tierName] ? tierName : 'basic'] };
  if (modeName !== 'managed' || !LOCAL.tiers.includes(tierName)) return { ...base, state: 'needs-models', next: folder.downloaded && LOCAL.tiers.includes(tierName) ? 'enable' : 'download-models', running: true };
  return { ...base, state: 'ready', next: null, running: true };
}

/* ---------- what is doing the work ---------- */

const DEVICE_LINE = /(?:^|[\s┃│|])(?:device|gpu|accelerator|compute device)\s*(?:[┃│|:=]\s*|\s{2,})([A-Za-z0-9_.+-]{2,30}(?: [A-Za-z0-9_.+-]{1,20})?)/im;
const samePath = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);

/**
 * What would do (or is doing) a local conversion, from read-only reads: the mineru version and tier (`status`, from detectLocal), the model folder of that
 * tier under <home>/models (the real tool names it, e.g. MinerU-4_models_onnx or MinerU2.5-Pro-…-GGUF), where the models are (and where a link points: they
 * are often moved to another drive), and a device ONLY when `server status` or `config show` says one. Never starts or changes anything; whatever cannot be
 * read is left out, not invented. Resolves { kind: 'local', mineruVersion?, tier?, model?, modelsPath?, modelsRealPath?, device? }.
 */
export async function readLocalEnvironment({ cli, home, status = {}, signal, realpath = fsRealpath, env = process.env } = {}) {
  const environment = { kind: 'local' };
  if (status.version) environment.mineruVersion = status.version;
  if (status.tier) environment.tier = status.tier;
  if (!cli || status.state === 'not-installed') return environment;
  const where = home || cli.env?.MINERU_HOME || env.MINERU_HOME || path.join(osHomedir(), '.mineru'), dir = path.join(where, 'models');
  try {
    const entries = await readdir(dir);
    const tier = status.tier, model = tier && (entries.find(entry => MODEL_FOLDERS[tier]?.test(entry)) ?? entries.find(entry => entry.toLowerCase().includes(tier)));
    if (model) environment.model = model;
    if (entries.length) {
      environment.modelsPath = dir;
      const real = await realpath(dir).catch(() => ''), base = await realpath(where).catch(() => where);
      // A temp or home folder that is itself reached through a link or a short name (8.3 on Windows) is not a moved models folder: compare with the home's own real path.
      if (real && !samePath(real, dir) && !samePath(real, path.join(base, 'models'))) environment.modelsRealPath = real;
    }
  } catch { /* no models folder yet */ }
  for (const args of [['server', 'status'], ['config', 'show']]) {
    if (environment.device) break;
    const said = await runCli(cli, args, { signal, timeoutMs: 10_000 }).then(result => `${result.stdout}\n${result.stderr}`, () => '');
    const device = DEVICE_LINE.exec(said)?.[1]?.trim();
    if (device) environment.device = device;
  }
  return environment;
}

/** How long a start may take: MINERU_LOCAL_API_STARTUP_TIMEOUT_SECONDS (the CLI's own wait, default 300 s) and 30 s more. */
export const startTimeoutMs = (env = process.env) => ((Number(env.MINERU_LOCAL_API_STARTUP_TIMEOUT_SECONDS) > 0 ? Number(env.MINERU_LOCAL_API_STARTUP_TIMEOUT_SECONDS) : 300) + 30) * 1000;

/** Why a start of the local service failed, one plain sentence per code. What the program printed (a traceback, English CLI text) is never part of it: it
 *  stays in the error's `detail`, for the 任务 log and 更多 › 详细信息. */
export const SERVICE_START_TEXT = Object.freeze({
  'port-in-use': '本机服务没能启动：它要用的端口被别的程序占用了。',
  'vc-runtime': '本机服务没能启动：这台电脑缺少微软 VC++ 运行库。',
  'not-writable': '本机服务没能启动：配置文件夹的权限不符合要求，或没有写入权限。',
  'home-permissions': '本机服务没能启动：MinerU 读不了配置文件夹里的文件，或认为它们不够私有。安装位置没问题，不用换位置。',
  'service-timeout': '本机服务没能启动：等了很久它还没有准备好。',
  'models-missing': '本机服务没能启动：模型文件不完整。',
  'service-failed': '本机服务没能启动：它一启动就退出了。',
});
/** home-permissions of a MinerU StudyHub did not install (MINERU_BIN, PATH): the folder is that MinerU's own, StudyHub has no location there and changes nothing in it. */
export const OTHER_HOME_TEXT = '本机服务没能启动：这份 MinerU 读不了它自己的配置文件夹里的文件，或认为它们不够私有。StudyHub 不改不是它创建的文件夹的权限。';

/** The code of a failed start from the text that may decide it (what the CLI printed, and what this start wrote to the error logs); `home` tells a file of the
 *  settings folder (home-permissions: repair, nothing to move) from any other permission failure (not-writable). */
const startFailureCode = (said, home) => (/端口被占用|address already in use|os error 10048|\b10048\b/i.test(said) ? 'port-in-use'
  : VC_RUNTIME_FAILURE.test(said) ? 'vc-runtime'
    : homePermissionFailure(said, home) ? 'home-permissions' : PERMISSION_DENIED.test(said) ? 'not-writable'
      : /requires model files|models? (?:\S+ )?(?:are |is )?(?:missing|not ready|not found)|mineru-kit models download|模型.{0,12}(?:不完整|不存在|没有下载|未下载)/i.test(said) ? 'models-missing'
        : 'service-failed');

/** A failed start (LocalMineruError 'server-start-failed' with `detail`, or a 'timeout'), as { code, message, detail, file? }: the code startServer decided (`reason`), else the
 *  code read from `detail`; the plain sentence of that code; the raw text (the last 4000 characters); and, for home-permissions, the file of the settings folder it names. */
export function explainStartFailure(error) {
  const detail = String(error?.detail ?? '').slice(-4000);
  const code = error?.code === 'timeout' ? 'service-timeout' : Object.hasOwn(SERVICE_START_TEXT, error?.reason ?? '') ? error.reason : startFailureCode(detail);
  const file = code === 'home-permissions' ? (typeof error?.file === 'string' ? error.file : homePermissionFailure(detail)?.file || '') : null;
  // `linked`: files the permission step of this start left alone (hard links): the card says the repair was not complete.
  const linked = Number(error?.linked) > 0 ? Number(error.linked) : 0;
  return { code, message: SERVICE_START_TEXT[code], detail, ...(file !== null ? { file } : {}), ...(linked ? { linked } : {}) };
}

const wait = (ms, signal) => new Promise((resolve, reject) => {
  const stop = () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')); };
  const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
  signal?.addEventListener('abort', stop, { once: true });
});

/** Start the local service (`restart`: stop it first, then start; the CLI's own `server restart` is undocumented). Resolves the state read again afterwards.
 *  A start that fails throws LocalMineruError 'server-start-failed': a plain message by its cause, what the CLI printed in `detail`. */
export async function startServer({ cli, home, restart = false, signal, timeoutMs = startTimeoutMs(), pollPauseMs = 2000, pollTries = 10 } = {}) {
  const where = home || cli?.env?.MINERU_HOME || process.env.MINERU_HOME || path.join(osHomedir(), '.mineru');
  const effectiveCli = home && cli && !cli.env?.MINERU_HOME ? { ...cli, env: { ...cli.env, MINERU_HOME: home } } : cli;
  // Every start makes the settings folder private and repairs what is inside it (修复权限并重启 is this start); what it could not do is said in a failed start's detail.
  const secured = home || cli?.env?.MINERU_HOME ? await secureMineruHome(where, { cli: effectiveCli, signal }) : null;
  if (restart) await runCli(effectiveCli, ['server', 'stop'], { signal, timeoutMs: 60_000 }).catch(error => { if (signal?.aborted) throw error; });
  const mark = await markServerLogs(where);
  const result = await runCli(effectiveCli, ['server', 'start'], { signal, timeoutMs });
  if (result.code !== 0 && !/already running|已在运行|正在运行/i.test(`${result.stdout}${result.stderr}`)) {
    const printed = [result.stderr || '', result.stdout || ''].filter(Boolean).join('\n');
    const said = `${printed}\n${await serverErrorsSince(where, mark)}`, reason = startFailureCode(said, where);
    // StudyHub's own line last, so the cut to the last 4000 characters keeps it.
    const detail = [printed, await readMineruServerLogs(where), homeNote(secured, where)].filter(Boolean).join('\n').trim().slice(-4000);
    throw Object.assign(new LocalMineruError('server-start-failed', SERVICE_START_TEXT[reason], { retryable: true }),
      { detail, reason, ...(reason === 'home-permissions' ? { file: homePermissionFailure(said, where)?.file || '' } : {}), ...(secured?.linked > 0 ? { linked: secured.linked } : {}) });
  }
  let detected = await detectLocal({ cli: effectiveCli, home, signal });
  if (STILL_STARTING.test(`${result.stdout}\n${result.stderr}`) || detected.starting) {
    for (let attempt = 0; attempt < pollTries && detected.starting; attempt++) {
      await wait(pollPauseMs, signal);
      detected = await detectLocal({ cli: effectiveCli, home, signal });
    }
  }
  return detected;
}

/** Stop the local service (更多 › 停止服务). Resolves the state read again afterwards. */
export async function stopServer({ cli, home, signal } = {}) {
  const effectiveCli = home && cli && !cli.env?.MINERU_HOME ? { ...cli, env: { ...cli.env, MINERU_HOME: home } } : cli;
  await runCli(effectiveCli, ['server', 'stop'], { signal, timeoutMs: 60_000 });
  return detectLocal({ cli: effectiveCli, home, signal });
}

/* ---------- windows of pages ---------- */

/** Consecutive windows of at most `size` pages: [{ index, startPage, endPage }] (1-based, inclusive). */
export function windowPlan(totalPages, size = LOCAL.windowPages) {
  const plan = [];
  for (let startPage = 1; startPage <= totalPages; startPage += size) plan.push({ index: plan.length, startPage, endPage: Math.min(totalPages, startPage + size - 1) });
  return plan;
}

/**
 * The pace of this machine from the windows measured so far (`windows`: [{ pages, ms }] in order; one without a measurement says nothing): the seconds
 * per page over the latest LOCAL.paceWindows windows. The first window also loads the model, so when it was much slower per page than the rest it is left
 * out. Resolves { secondsPerPage, windows (how many were measured), basis: 'measured', skippedFirst } or null.
 */
const perPage = list => list.reduce((sum, window) => sum + window.ms, 0) / list.reduce((sum, window) => sum + window.pages, 0) / 1000;
/** The measured windows the pace is read from: the latest few, without a first window that was much slower per page (it also loaded the model). */
function paceBasis(windows, { paceWindows, slowFirstFactor }) {
  const measured = windows.filter(window => window && window.pages > 0 && window.ms > 0);
  let used = measured, skippedFirst = false;
  if (measured.length >= 2) {
    const [first, ...rest] = measured;
    if (first.ms / first.pages / 1000 > slowFirstFactor * perPage(rest)) { used = rest; skippedFirst = true; }
  }
  return { measured, used: used.slice(-paceWindows), skippedFirst };
}
export function localPace(windows = [], { paceWindows = LOCAL.paceWindows, slowFirstFactor = LOCAL.slowFirstFactor } = {}) {
  const { measured, used, skippedFirst } = paceBasis(windows, { paceWindows, slowFirstFactor });
  if (!measured.length) return null;
  return { secondsPerPage: Math.round(perPage(used) * 100) / 100, windows: measured.length, basis: 'measured', skippedFirst };
}

/**
 * The next window of the adaptive plan, decided when the previous one has finished. `total` pages in the PDF, `covered` the [start, end] spans already
 * converted (never planned again), `from` the first page to consider, `windows` the finished windows [{ pages, ms }] (0 ms: restored, not measured),
 * `tier` for the published estimate when nothing was measured, `limits` to override the LOCAL numbers (firstPages, rampPages, targetSeconds, minPages, maxPages).
 * Resolves { startPage, endPage, pages, reason: 'first' | 'ramp' | 'pace' | 'estimate' } or null when every page is covered. A window never runs past the end
 * or into converted pages, and the tail is never fewer than the minimum: the last window takes the remainder.
 */
export function nextWindow({ total, covered = [], from = 1, windows = [], tier, limits = {} } = {}) {
  const first = limits.firstPages ?? LOCAL.firstWindowPages, ramp = limits.rampPages ?? LOCAL.rampPages, target = limits.targetSeconds ?? LOCAL.targetWindowSeconds;
  const min = limits.minPages ?? LOCAL.minWindowPages, max = limits.maxPages ?? LOCAL.maxWindowPages;
  const spans = [...covered].sort((a, b) => a[0] - b[0]);
  let startPage = Math.max(1, from);
  for (const [a, b] of spans) if (a <= startPage && startPage <= b) startPage = b + 1;
  if (startPage > total) return null;
  const room = Math.min(total, (spans.find(([a]) => a > startPage)?.[0] ?? total + 1) - 1) - startPage + 1;
  const done = windows.length, pace = localPace(windows);
  const estimate = LOCAL.secondsPerPage[tier];
  const bySpeed = seconds => Math.min(max, Math.max(min, Math.round(target / seconds)));
  let size, reason;
  if (!done) { size = Math.min(first, max); reason = 'first'; }
  else if (done < ramp.length) { size = pace ? Math.min(ramp[done], bySpeed(pace.secondsPerPage)) : ramp[done]; reason = 'ramp'; }
  else if (pace) { size = bySpeed(pace.secondsPerPage); reason = 'pace'; }
  else if (estimate) { size = bySpeed(estimate); reason = 'estimate'; }
  else { size = Math.min(max, LOCAL.windowPages); reason = 'estimate'; }
  size = Math.max(Math.min(size, max), Math.min(min, room));
  if (size >= room) size = room;
  else if (room - size < min) size = room <= max ? room : room - min;
  return { startPage, endPage: startPage + size - 1, pages: size, reason };
}

/** A window that failed, as two halves that tile it exactly; null for a single page. */
export function halveWindow({ startPage, endPage }) {
  const pages = endPage - startPage + 1;
  if (pages < 2) return null;
  const middle = startPage + Math.floor(pages / 2) - 1;
  return [{ startPage, endPage: middle }, { startPage: middle + 1, endPage }];
}

/**
 * What is left, in seconds: from the measured pace once there is one, from the tier's published figure before ("an estimate, not a promise"), nothing for a
 * tier without one. Resolves { basis: 'measured' | 'estimate' | 'none', secondsPerPage, etaSeconds, windowsMeasured }.
 */
export function localEta({ remainingPages, windows = [], tier } = {}) {
  const pace = localPace(windows);
  if (pace) return { basis: 'measured', secondsPerPage: pace.secondsPerPage, etaSeconds: Math.round(remainingPages * pace.secondsPerPage), windowsMeasured: pace.windows };
  const estimate = LOCAL.secondsPerPage[tier];
  if (estimate) return { basis: 'estimate', secondsPerPage: estimate, etaSeconds: Math.round(remainingPages * estimate), windowsMeasured: 0 };
  return { basis: 'none', secondsPerPage: null, etaSeconds: null, windowsMeasured: 0 };
}

/**
 * What is left as a range, because a pace measured on one window (it also loaded the model) or on windows that differ much is only about right. Resolves
 * { basis, etaSeconds, lowSeconds, highSeconds, stable, windowsMeasured }: `stable` when at least two windows agree within LOCAL.unstableFactor, so low = high;
 * otherwise the range runs from the fastest to the slowest window's pace (one window: LOCAL.etaSingleBand of its pace). An estimate that was never measured is
 * never stable. The card hides all of it until a window has finished.
 */
export function localEtaRange({ remainingPages, windows = [], tier, limits = {} } = {}) {
  const eta = localEta({ remainingPages, windows, tier });
  if (eta.etaSeconds === null) return { ...eta, lowSeconds: null, highSeconds: null, stable: false };
  if (eta.basis !== 'measured') return { ...eta, lowSeconds: eta.etaSeconds, highSeconds: eta.etaSeconds, stable: false };
  const { used } = paceBasis(windows, { paceWindows: limits.paceWindows ?? LOCAL.paceWindows, slowFirstFactor: limits.slowFirstFactor ?? LOCAL.slowFirstFactor });
  const speeds = used.map(window => window.ms / window.pages / 1000);
  const [lowest, highest] = [Math.min(...speeds), Math.max(...speeds)];
  if (used.length >= 2 && highest / lowest <= (limits.unstableFactor ?? LOCAL.unstableFactor)) return { ...eta, lowSeconds: eta.etaSeconds, highSeconds: eta.etaSeconds, stable: true };
  if (used.length < 2) return { ...eta, lowSeconds: Math.round(eta.etaSeconds * LOCAL.etaSingleBand[0]), highSeconds: Math.round(eta.etaSeconds * LOCAL.etaSingleBand[1]), stable: false };
  return { ...eta, lowSeconds: Math.round(remainingPages * lowest), highSeconds: Math.round(remainingPages * highest), stable: false };
}

/**
 * How long StudyHub asks the CLI to wait for one window (`--wait`): the floor, or per page the larger of the fixed figure and `waitPaceFactor` times the measured pace of
 * this machine, plus the time the model needs to load for the first window of a run. Until a window has been measured nothing is known about this machine, so the first
 * window of a run with no pace gets the ceiling (a runaway guard of hours): whether it is alive is decided by the liveness probe and the learner's Stop, not by a guess.
 * So a slow scan is not cut off by a wait written for a fast one.
 */
export function waitSeconds({ pages, pace = null, first = false } = {}) {
  if (first && !pace?.secondsPerPage) return LOCAL.waitCeilSec;
  const per = Math.max(LOCAL.waitPerPageSec, pace?.secondsPerPage ? pace.secondsPerPage * LOCAL.waitPaceFactor : 0);
  return Math.min(LOCAL.waitCeilSec, Math.max(LOCAL.waitFloorSec, Math.round(pages * per)) + (first ? LOCAL.loadAllowanceSec : 0));
}

/* ---------- is the window alive? (read-only questions to the service) ---------- */

/* `mineru parse --wait` prints nothing until it ends, so while a window runs StudyHub asks the SERVICE, never the process: `server status --json` (the workers and the
   health of the parse server) and `list parses --status pending|parsing --json`, matched to the window by tier and page range. Read-only, one question at a time, at
   LOCAL.livenessMs, only while a window runs; any failure of a question is "unknown", never "stuck". NOT VERIFIED against a real CLI: whether these reads can disturb a
   running parse (they only read) and the exact field names beyond what the first investigation found (workers.parse_running, parse_queue_length,
   parse_server.local.healthy/starting, parses[].tier/page_range/status). `limits.livenessMs: 0` (the seam of a test or a preview) turns all of it off. */

const whole = value => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : null);
const flagOf = value => (typeof value === 'boolean' ? value : null);
function jsonOf(text) {
  const raw = String(text ?? '').trim();
  const attempts = [raw];
  const open = raw.search(/[{[]/), close = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (open > 0 && close > open) attempts.push(raw.slice(open, close + 1));
  for (const attempt of attempts) { try { return JSON.parse(attempt); } catch { /* try the next reading */ } }
  return null;
}

/** The workers and the health of the parse server out of `mineru server status --json`: { parseRunning, queued, healthy, starting } (null for what it does not say), or null. */
export function parseServerStatus(text) {
  const data = jsonOf(text);
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const workers = data.workers && typeof data.workers === 'object' ? data.workers : {};
  const local = data.parse_server?.local && typeof data.parse_server.local === 'object' ? data.parse_server.local : {};
  return { parseRunning: whole(workers.parse_running ?? data.parse_running), queued: whole(workers.parse_queue_length ?? data.parse_queue_length), healthy: flagOf(local.healthy), starting: flagOf(local.starting) };
}

const pageSpan = value => {
  if (Array.isArray(value) && value.length === 2 && value.every(item => Number.isInteger(item))) return [value[0], value[1]];
  const match = typeof value === 'string' ? /^\s*(\d+)\s*(?:[-–—:]\s*(\d+))?\s*$/.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2] ?? match[1])] : [null, null];
};
/** The parses out of `mineru list parses --json`: [{ id, tier, startPage, endPage, status }], or null when it is not that. */
export function parseListedParses(text) {
  const data = jsonOf(text), rows = Array.isArray(data) ? data : data?.parses;
  if (!Array.isArray(rows)) return null;
  return rows.filter(row => row && typeof row === 'object').map(row => {
    const [startPage, endPage] = pageSpan(row.page_range);
    return { id: row.id ?? null, tier: typeof row.tier === 'string' ? row.tier : null, startPage, endPage, status: typeof row.status === 'string' ? row.status : null };
  });
}

/**
 * Ask the service about the window `tier` `startPage`-`endPage` (read-only). Never throws and never starts or changes anything. Resolves
 * { at, server: 'running' | 'stopped' | 'unknown', parseRunning, queued, healthy, starting, mine: 'parsing' | 'pending' | 'none' | 'unknown' }: `mine` is whether the service
 * lists a parse with this tier and page range; 'unknown' when no list could be read.
 */
export async function probeService({ cli, tier, startPage, endPage, signal, timeoutMs = LOCAL.probeTimeoutMs } = {}) {
  const unknown = { at: Date.now(), server: 'unknown', parseRunning: null, queued: null, healthy: null, starting: null, mine: 'unknown' };
  if (!cli || signal?.aborted) return unknown;
  const ask = async args => {
    try { const result = await runCli(cli, args, { signal, timeoutMs }); return { code: result.code, out: result.stdout, said: `${result.stdout}\n${result.stderr}` }; } catch { return null; }
  };
  const status = await ask(['server', 'status', '--json']);
  if (signal?.aborted) return unknown;
  if (status && NOT_RUNNING.test(status.said)) return { ...unknown, server: 'stopped' };
  const info = status?.code === 0 ? parseServerStatus(status.out) : null;
  const rows = [];
  let read = 0, stopped = false;
  // The status already says nothing is parsing or waiting: the lists could only repeat it, and every question costs the CLI's own start-up on a machine that is busy converting.
  if (info && info.parseRunning === 0 && info.queued === 0) return { at: Date.now(), server: 'running', ...info, mine: 'none' };
  for (const wanted of ['pending', 'parsing']) {
    const listed = await ask(['list', 'parses', '--status', wanted, '--json']);
    if (signal?.aborted) return unknown;
    if (listed && NOT_RUNNING.test(listed.said)) { stopped = true; break; }
    const parsed = listed?.code === 0 ? parseListedParses(listed.out) : null;
    if (parsed) { read++; rows.push(...parsed.map(row => ({ ...row, status: row.status === 'pending' || row.status === 'parsing' ? row.status : wanted }))); }
  }
  if (stopped) return { ...unknown, server: 'stopped' };
  if (!info && !read) return unknown;
  const found = rows.filter(row => row.tier === tier && row.startPage === startPage && row.endPage === endPage);
  const mine = found.some(row => row.status === 'parsing') ? 'parsing' : found.length ? 'pending' : read === 2 ? 'none' : 'unknown';
  return { at: Date.now(), server: 'running', parseRunning: info?.parseRunning ?? null, queued: info?.queued ?? null, healthy: info?.healthy ?? null, starting: info?.starting ?? null, mine };
}

/**
 * The honest state of a running window from one answer and what was heard before (`memory`: { lastSignalAt, idleStreak }, ms). Resolves
 * { state, lastSignalAt, idleStreak, silentForMs, at, parseRunning, queued, healthy } where state is
 *   'queued' (the service has the parse waiting), 'parsing' (it is working), 'starting' (the parse server is starting or loading),
 *   'quiet' (it says nothing about this window yet, or is busy with another: not a problem), 'silent' (no response), 'stopped', 'unknown' (could not ask).
 * 'silent' is only said when the service reports nothing parsing or queued in `idleProbes` answers in a row AND nothing was heard for `silentMs`, or when its parse server
 * reports unhealthy: a service that is busy with something else, or a question that failed, is never "no response".
 */
export function livenessFrom(probe, memory = {}, { now = Date.now(), silentMs = LOCAL.silentMs, idleProbes = LOCAL.idleProbes } = {}) {
  const last = memory.lastSignalAt ?? now, streak = memory.idleStreak ?? 0;
  const base = { at: probe.at ?? now, parseRunning: probe.parseRunning ?? null, queued: probe.queued ?? null, healthy: probe.healthy ?? null };
  const heard = state => ({ ...base, state, lastSignalAt: now, idleStreak: 0, silentForMs: 0 });
  const kept = (state, idleStreak = streak) => ({ ...base, state, lastSignalAt: last, idleStreak, silentForMs: Math.max(0, now - last) });
  if (probe.server === 'stopped') return kept('stopped');
  if (probe.server !== 'running') return kept('unknown');
  if (probe.starting) return heard('starting');
  if (probe.healthy === false) return kept('silent');
  if (probe.mine === 'pending') return heard('queued');
  if (probe.mine === 'parsing') return heard('parsing');
  const busy = probe.parseRunning > 0, waiting = probe.queued > 0;
  if (probe.mine === 'unknown' && busy) return heard('parsing');
  if (probe.mine === 'unknown' && waiting) return heard('queued');
  if (busy || waiting) return heard('quiet');
  const idle = streak + 1;
  return kept(idle >= idleProbes && now - last > silentMs ? 'silent' : 'quiet', idle);
}

/**
 * Watch one running window: ask the service about it at `intervalMs` (the first time after `firstMs`), one question at a time (the next is armed only when the answer is in),
 * and call `onState(state)` with { state, at, lastSignalAt, silentForMs, parseRunning, queued, healthy } (times as ISO strings, `at` null before the first answer). `touch()`
 * says the command itself printed something. `stop()` ends it and aborts a question in flight. Disabled (`enabled: false`, nothing asked, nothing reported) without a command
 * line or with an interval of 0. A failing `probe` is 'unknown'.
 */
export function watchWindow({ cli, tier, startPage, endPage, signal, onState, intervalMs = LOCAL.livenessMs, firstMs = LOCAL.livenessFirstMs, silentMs, idleProbes, timeoutMs, probe = probeService, now = Date.now } = {}) {
  if (!cli || !(intervalMs > 0)) return { enabled: false, stop() {}, touch() {} };
  const iso = time => new Date(time).toISOString();
  const controller = new AbortController();
  let memory = { lastSignalAt: now(), idleStreak: 0 }, stopped = false, asking = false, timer;
  const tell = state => { try { onState?.(state); } catch { /* a listener's problem, never the watcher's */ } };
  const arm = ms => { if (!stopped) { timer = setTimeout(ask, ms); timer.unref?.(); } };
  async function ask() {
    if (stopped || asking) return;
    asking = true;
    try {
      const answer = await probe({ cli, tier, startPage, endPage, signal: controller.signal, ...(timeoutMs ? { timeoutMs } : {}) });
      if (stopped) return;
      const next = livenessFrom(answer, memory, { now: now(), ...(silentMs ? { silentMs } : {}), ...(idleProbes ? { idleProbes } : {}) });
      memory = { lastSignalAt: next.lastSignalAt, idleStreak: next.idleStreak };
      tell({ state: next.state, at: iso(next.at), lastSignalAt: iso(next.lastSignalAt), silentForMs: next.silentForMs, parseRunning: next.parseRunning, queued: next.queued, healthy: next.healthy });
    } catch {
      if (!stopped) tell({ state: 'unknown', at: iso(now()), lastSignalAt: iso(memory.lastSignalAt), silentForMs: Math.max(0, now() - memory.lastSignalAt), parseRunning: null, queued: null, healthy: null });
    } finally { asking = false; arm(intervalMs); }
  }
  const watch = {
    enabled: true,
    stop() { if (stopped) return; stopped = true; clearTimeout(timer); controller.abort(new Error('stopped')); },
    touch() { memory = { lastSignalAt: now(), idleStreak: 0 }; },
  };
  signal?.addEventListener('abort', () => watch.stop(), { once: true });
  tell({ state: 'quiet', at: null, lastSignalAt: iso(memory.lastSignalAt), silentForMs: 0, parseRunning: null, queued: null, healthy: null });
  arm(Math.min(firstMs, intervalMs));
  return watch;
}

/* ---------- reading the Markdown ---------- */

const MARKER = /^<!--\s*page\s+(\d+)\s+of\s+(\d+)\s*-->[ \t]*$/gm;
const IMAGE = /^!\[[^\]]*\]\([^)]*\)$/;
const BULLET = /^\s*(?:[•·▪‣◦]|[-*+])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const range = (a, b) => (a === b ? `${a}` : `${a}–${b}`);

function blocksOf(body, pageIdx) {
  const items = [];
  const lines = body.split('\n');
  let paragraph = [], list = [], table = [];
  const flush = () => {
    if (paragraph.length) items.push({ type: 'text', text: paragraph.join('\n'), page_idx: pageIdx });
    if (list.length) items.push({ type: 'list', list_items: list, page_idx: pageIdx });
    if (table.length) items.push({ type: 'text', text: table.join('\n'), page_idx: pageIdx });
    paragraph = []; list = []; table = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flush(); continue; }
    if (IMAGE.test(line.trim())) { flush(); items.push({ type: 'text', text: '[Figure]', page_idx: pageIdx }); continue; }
    const heading = HEADING.exec(line);
    if (heading) { flush(); items.push({ type: 'text', text: heading[2].trim(), text_level: Math.max(1, heading[1].length - 1), page_idx: pageIdx }); continue; }
    const bullet = BULLET.exec(line);
    if (bullet) { if (paragraph.length || table.length) flush(); list.push(bullet[1].trim()); continue; }
    if (line.trimStart().startsWith('|')) { if (paragraph.length || list.length) flush(); table.push(line); continue; }
    if (list.length || table.length) flush();
    paragraph.push(line);
  }
  flush();
  return items;
}

/**
 * The Markdown of one window as content_list items (v1) whose `page_idx` counts from the window's first page, the same shape
 * a cloud piece has, so lib/mineru-merge.js puts them in the book. Checks what the CLI returned: as many page markers as
 * the window has pages, each inside the window, and the TOTAL in each marker equal to the PDF's page count. Throws
 * LocalMineruError (marker-count, marker-range, total-mismatch). Resolves { content, markers, warnings }.
 */
export function parseLocalMarkdown(markdown, { startPage, endPage, totalPages }) {
  const text = String(markdown ?? '').replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const found = [...text.matchAll(MARKER)].map(match => ({ page: Number(match[1]), total: Number(match[2]), index: match.index, end: match.index + match[0].length }));
  const expected = endPage - startPage + 1;
  if (found.length !== expected)
    throw new LocalMineruError('marker-count', `本地解析返回了 ${found.length} 页，这一段（第 ${range(startPage, endPage)} 页）应有 ${expected} 页。请重试这一段。`, { retryable: true });
  for (const marker of found)
    if (marker.page < startPage || marker.page > endPage)
      throw new LocalMineruError('marker-range', `本地解析返回的页码（第 ${marker.page} 页）不在这一段（第 ${range(startPage, endPage)} 页）里，没法放到正确的页上。请重试这一段。`, { retryable: true });
  if (new Set(found.map(marker => marker.page)).size !== found.length)
    throw new LocalMineruError('marker-range', `本地解析返回的页码有重复（这一段是第 ${range(startPage, endPage)} 页）。请重试这一段。`, { retryable: true });
  if (Number.isInteger(totalPages) && totalPages > 0) {
    const wrong = found.find(marker => marker.total !== totalPages);
    if (wrong) throw new LocalMineruError('total-mismatch', `本地解析读到的总页数（${wrong.total}）和这个 PDF 的页数（${totalPages}）不一致，没法确认页码对得上。请重试这一段。`, { retryable: true });
  }
  const content = [];
  found.forEach((marker, position) => {
    const body = text.slice(marker.end, found[position + 1]?.index ?? text.length);
    content.push(...blocksOf(body, marker.page - startPage));
  });
  return { content, markers: found.length, warnings: [] };
}

/* ---------- parsing a window ---------- */

const NOT_RUNNING = /服务未在运行|服务未运行|服务没有运行|not running|connection (?:to the local server )?(?:was )?(?:lost|refused|reset)|无法连接|ECONNREFUSED/i;
const ENGINE_BUSY = /\bengine_(?:unavailable|busy)\b|parse-server is not ready|local parse[- ]server.{0,24}(?:busy|not ready|starting|warming)|another parse is running|server is busy|解析引擎正忙/i;
const MISSING_MODELS = /requires model files|models? (?:\S+ )?(?:are |is )?(?:missing|not ready|not found)|mineru-kit models download|模型.{0,12}(?:不完整|不存在|没有下载|未下载)/i;

/**
 * Turn a non-zero `mineru parse --json` exit into a plain `LocalMineruError` (with `detail: { exitCode, lines }` for the diagnostics log,
 * never raw JSON on the compact card). Recognises `server-stopped`, `engine-busy` (warming up or occupied by another parse), and `needs-models`.
 */
export function explainParseFailure(result) {
  const raw = `${result?.stderr || ''}\n${result?.stdout || ''}`.trim();
  const lines = raw.split(/\r?\n/).map(line => line.trimEnd()).filter(Boolean).slice(-12);
  const detail = { ...(Number.isInteger(result?.code) ? { exitCode: result.code } : {}), ...(lines.length ? { lines } : {}) };
  const parsed = jsonOf(result?.stdout) ?? jsonOf(result?.stderr) ?? jsonOf(raw);
  const errObj = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (typeof parsed.error === 'object' && parsed.error ? parsed.error : parsed) : null;
  const jsonCode = typeof errObj?.code === 'string' ? errObj.code : '';
  const jsonMessage = typeof errObj?.message === 'string' ? errObj.message.trim() : typeof parsed?.error === 'string' ? parsed.error.trim() : '';
  const combined = `${jsonCode} ${jsonMessage} ${raw}`;
  const attach = error => (Object.keys(detail).length ? Object.assign(error, { detail }) : error);
  if (NOT_RUNNING.test(combined)) return attach(new LocalMineruError('server-stopped', LOCAL_MESSAGES.serverStopped, { retryable: true }));
  if (ENGINE_BUSY.test(combined)) return attach(new LocalMineruError('engine-busy', LOCAL_MESSAGES.engineBusy, { retryable: true }));
  if (MISSING_MODELS.test(combined)) return attach(new LocalMineruError('needs-models', LOCAL_MESSAGES.setupNeedsModels, { retryable: false }));
  const reason = clip(jsonMessage || raw);
  return attach(new LocalMineruError('failed', `本地解析没有成功：${reason || '没有返回原因'}`, { retryable: true }));
}

/**
 * Parse pages startPage..endPage of `pdf` locally and read the result. `--pages` is always given (the CLI's own default is only
 * the first 10 pages). Resolves { content, markers, warnings }; throws LocalMineruError (server-stopped, engine-busy, timeout, failed,
 * empty-output, marker-count, marker-range, total-mismatch) or the abort reason (the process tree is killed first).
 */
export async function parseWindow({ cli, pdf, tier, startPage, endPage, totalPages, outFile, signal, timeoutMs, waitSec: asked, onOutput }) {
  const pages = endPage - startPage + 1;
  const waitSec = asked ?? waitSeconds({ pages });
  const args = ['parse', pdf, '--tier', tier, '--pages', `${startPage}-${endPage}`, '--wait', String(waitSec), '--json', '-o', outFile, '--force'];
  const result = await runCli(cli, args, { signal, timeoutMs: timeoutMs ?? (waitSec + 60) * 1000, ...(onOutput ? { onLine: () => onOutput() } : {}) });
  if (result.code !== 0) throw explainParseFailure(result);
  let markdown;
  try { markdown = await readFile(outFile, 'utf8'); }
  catch { throw new LocalMineruError('empty-output', LOCAL_MESSAGES.emptyOutput, { retryable: true }); }
  finally { await rm(outFile, { force: true }).catch(() => {}); }
  return parseLocalMarkdown(markdown, { startPage, endPage, totalPages });
}
