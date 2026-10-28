/* The installer behind install.bat. Ported from BAXUIE's StudyHub for ZCode 0.4.8 (MIT).

   install.bat only checks that Node 22.19 or newer is there and runs this file with its own arguments. Everything that
   touches a path happens here, in Node: cmd.exe never reads a path back (it would read it in the console code page and
   break a Chinese folder name) and never parses one (an & or % in a folder name stays text). ZCode's own command line is
   run as `<this node> <zcode.cjs> plugins …` with each argument passed as one argument, no shell.

   Steps: find ZCode (find-zcode.mjs), register this package's folder as the local marketplace "studyhub-bundle" (again,
   if it already points elsewhere), install studyhub@studyhub-bundle, print the uninstall commands. Exit 0 or 1. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findZcode } from './find-zcode.mjs';

export const MARKETPLACE = 'studyhub-bundle';
export const MIN_NODE = Object.freeze([22, 19]);

/** Node is new enough (the package's engines: >=22.19). */
export function nodeOk(version = process.versions.node) {
  const [major, minor] = String(version).split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/** A folder as it arrives from cmd: `install.bat "E:\ZCode\"` reaches Node as `E:\ZCode"` (the \" is read as a quote). */
export function cleanGiven(value) {
  let text = String(value ?? '').trim().replace(/^"+|"+$/g, '').trim();
  while (/[\\/]$/.test(text) && !/^[A-Za-z]:[\\/]$/.test(text)) text = text.slice(0, -1);
  return text;
}

/** The command line a learner can paste, quoted for cmd. */
const quoted = (value) => `"${value}"`;

/**
 * Run the install. `bundle` is the package folder (the one with marketplace.json); `spawn` and `find` are injected in
 * tests. Answers the exit code.
 */
export function install({ argv = process.argv.slice(2), bundle = resolve(fileURLToPath(new URL('../..', import.meta.url))),
  find = findZcode, spawn = spawnSync, node = process.execPath, log = console.log, version = process.versions.node } = {}) {
  if (!nodeOk(version)) {
    log(`[X] Node.js ${version} is too old. Install Node.js 22.19 or newer from https://nodejs.org and run install.bat again.`);
    return 1;
  }
  const given = cleanGiven(argv[0]);
  const zcode = find({ given: given || undefined });
  if (!zcode) {
    log('[X] ZCode was not found. Start ZCode once and run install.bat again, or give the folder ZCode is installed in:');
    log('    install.bat "E:\\Program Files\\ZCode"');
    return 1;
  }
  log(`[1/3] Found ZCode: ${zcode}`);
  const zcodeCli = (...args) => spawn(node, [zcode, 'plugins', ...args], { stdio: 'inherit', windowsHide: false }).status === 0;
  log('[2/3] Registering this folder as a local marketplace and installing StudyHub ...');
  if (!zcodeCli('marketplace', 'add', bundle)) {
    log('    The marketplace may already point at another folder; registering this one again ...');
    zcodeCli('marketplace', 'remove', MARKETPLACE);
    if (!zcodeCli('marketplace', 'add', bundle)) { log('[X] Registering the marketplace failed.'); return 1; }
  }
  if (!zcodeCli('install', `studyhub@${MARKETPLACE}`)) { log('[X] Installing StudyHub failed.'); return 1; }
  log('[3/3] Done. Quit ZCode completely, including its tray icon, and open it again.');
  log('      Then type /studyhub in a new chat. Model setup and privacy: see the guide next to install.bat.');
  log('      Background tasks belong to the chat that started them: closing that chat or quitting ZCode ends them;');
  log('      finished parts are kept.');
  log('');
  log('To uninstall later, run these two lines in a command prompt:');
  log(`  node ${quoted(zcode)} plugins uninstall studyhub --force`);
  log(`  node ${quoted(zcode)} plugins marketplace remove ${MARKETPLACE}`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = install();
