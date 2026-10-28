import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DISCOVERY_SCRIPT, ENTRY, discoveredFolders, findZcode, folderOf, usualFolders } from '../packages/studyhub-zcode/install/find-zcode.mjs';
import { cleanGiven, install, nodeOk } from '../packages/studyhub-zcode/install/install.mjs';

/* install.bat finds ZCode wherever it is installed, under any folder name. The owner's is at E:\Program Files\ZCode; the
   reference installer looked only under %LOCALAPPDATA% and C:'s Program Files, and read paths back through cmd.exe in
   the console code page, which breaks a Chinese folder name. Now the batch file only checks Node and hands over to
   install.mjs; paths never pass through cmd. */
const windows = process.platform === 'win32';
const packageDir = fileURLToPath(new URL('../packages/studyhub-zcode/', import.meta.url));
const bat = await readFile(join(packageDir, 'install', 'install.bat'), 'utf8');
const entryOn = (folder) => win32.join(folder, ENTRY);

test('install.bat is ASCII, has no C:-only lookup, reads no path back and leaves everything to install.mjs', () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(bat), 'cmd.exe mis-reads anything but ASCII');
  assert.doesNotMatch(bat, /\b[Cc]:\\/, 'no hard-coded C: path');
  assert.doesNotMatch(bat, /%ZCODE%|ZCODE=/i, 'no ZCode path in a batch variable');
  const forLoops = bat.match(/for \/f[^\n]*/gi) || [];
  assert.deepEqual(forLoops.map((line) => /\('node -v'\)/.test(line)), [true], 'the only output cmd reads is node -v');
  assert.match(bat, /node "%~dp0studyhub\\install\\install\.mjs" %\*/);
  assert.match(bat, /if %%a GTR 22 set "NODE_OK=1"/);
  assert.match(bat, /if %%a EQU 22 if %%b GEQ 19 set "NODE_OK=1"/, 'Node 22.19 or newer, as the package\'s engines');
});

test('Node 22.19 or newer; a folder argument survives cmd\'s quoting', () => {
  assert.deepEqual(['22.18.9', '22.19.0', '23.0.0', '21.99.0', '24.1.0'].map((version) => nodeOk(version)), [false, true, true, false, true]);
  assert.equal(cleanGiven('E:\\Program Files\\ZCode"'), 'E:\\Program Files\\ZCode', 'install.bat "E:\\…\\ZCode\\" arrives with a stray quote');
  assert.equal(cleanGiven('"E:\\学习工具 & 50%\\"'), 'E:\\学习工具 & 50%');
  assert.equal(cleanGiven('E:\\'), 'E:\\');
  assert.equal(cleanGiven(undefined), '');
});

test('ZCode on E: is found from the usual folders of every drive', () => {
  const owner = 'E:\\Program Files\\ZCode';
  const exists = (path) => ['C:\\', 'E:\\', entryOn(owner)].includes(path);
  assert.ok(usualFolders({}, exists).includes(owner));
  assert.equal(findZcode({ env: {}, exists, discover: () => '' }), entryOn(owner));
});

test('the running process and the registry are read as UTF-8 JSON in base64: a Chinese folder arrives intact', () => {
  const folder = 'F:\\学习工具 & 50%\\ZCode';
  const exists = (path) => path === entryOn(folder);
  const json = JSON.stringify({ process: [], registry: [`"${folder}\\ZCode.exe",0`, `${folder}\\Uninstall ZCode.exe /currentuser`] });
  // The bytes PowerShell prints: base64 of the UTF-8 JSON, then CRLF.
  const printed = Buffer.from(`${Buffer.from(json, 'utf8').toString('base64')}\r\n`, 'latin1');
  assert.equal(findZcode({ env: {}, exists, run: () => printed }), entryOn(folder));
  assert.deepEqual(discoveredFolders(JSON.stringify({ process: `${folder}\\ZCode.exe`, registry: folder })), [folder, folder], 'PowerShell 5.1 may print one item without its array');
  // What `reg query` printed in code page 936 is never taken for a path.
  const gbk = Buffer.from([...Buffer.from('F:\\', 'latin1'), 0xd1, 0xa7, 0xcf, 0xb0, ...Buffer.from('\\ZCode', 'latin1')]);
  assert.equal(findZcode({ env: {}, exists, run: () => gbk }), null);
  assert.equal(folderOf('E:\\\uFFFD\uFFFD\\ZCode'), null);
  assert.match(DISCOVERY_SCRIPT, /GetValue\(\$n\)/, 'the default value is read by GetValue(\'\'), not by its localised name');
});

test('a folder given to install.bat (or ZCODE_HOME) wins, and a resources\\glm folder works too', () => {
  const folder = 'G:\\Apps\\ZCode';
  const exists = (path) => path === entryOn(folder);
  const none = () => '';
  assert.equal(findZcode({ given: folder, env: {}, exists, discover: none }), entryOn(folder));
  assert.equal(findZcode({ given: `"${folder}\\ZCode.exe"`, env: {}, exists, discover: none }), entryOn(folder));
  assert.equal(findZcode({ env: { ZCODE_HOME: folder }, exists, discover: none }), entryOn(folder));
  assert.equal(findZcode({ given: win32.join(folder, 'resources', 'glm'), env: {}, exists, discover: none }), entryOn(folder));
  assert.equal(findZcode({ env: {}, exists: () => false, discover: none }), null);
});

test('install.mjs passes every path as one argument, registers again when the marketplace exists, and prints the uninstall lines', () => {
  const calls = [], lines = [];
  let first = true;
  const spawn = (command, args) => { calls.push([command, ...args]); const failed = first && args[3] === 'add'; first = false; return { status: failed ? 1 : 0 }; };
  const zcode = 'E:\\学习工具 & 50%\\resources\\glm\\zcode.cjs', bundle = 'D:\\包 & 100%\\StudyHub-ZCode';
  const code = install({ argv: ['E:\\学习工具 & 50%"'], bundle, find: ({ given }) => { assert.equal(given, 'E:\\学习工具 & 50%'); return zcode; },
    spawn, node: 'node.exe', log: (line) => lines.push(line), version: '22.19.0' });
  assert.equal(code, 0);
  assert.deepEqual(calls, [['node.exe', zcode, 'plugins', 'marketplace', 'add', bundle], ['node.exe', zcode, 'plugins', 'marketplace', 'remove', 'studyhub-bundle'],
    ['node.exe', zcode, 'plugins', 'marketplace', 'add', bundle], ['node.exe', zcode, 'plugins', 'install', 'studyhub@studyhub-bundle']]);
  assert.ok(lines.includes(`  node "${zcode}" plugins uninstall studyhub --force`));
  assert.ok(lines.includes(`  node "${zcode}" plugins marketplace remove studyhub-bundle`));
  assert.equal(install({ argv: [], find: () => null, log: () => {}, version: '22.19.0' }), 1);
  assert.equal(install({ argv: [], log: () => {}, version: '22.18.0' }), 1, 'too old a Node stops before anything runs');
});

/* The real thing: cmd.exe runs install.bat from a package folder with a Chinese name, for a ZCode whose folder holds
   Chinese, & and %; a stand-in zcode.cjs records the arguments it got. */
test('install.bat installs from and into folders with Chinese, & and % in their names', { skip: !windows && 'Windows only', timeout: 60_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zcode-install-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundle = join(root, '学习包', 'StudyHub-ZCode'), zcodeDir = join(root, '学习工具 & 50%'), log = join(root, 'calls.jsonl');
  await mkdir(join(bundle, 'studyhub', 'install'), { recursive: true });
  await mkdir(join(bundle, 'studyhub', 'host'), { recursive: true });
  await writeFile(join(bundle, 'install.bat'), bat.replace(/\r?\n/g, '\r\n'));
  for (const file of ['install/install.mjs', 'install/find-zcode.mjs', 'host/workspace.mjs', 'host/messages.mjs', 'host/lib-root.mjs'])
    await copyFile(join(packageDir, file), join(bundle, 'studyhub', file));
  await mkdir(join(zcodeDir, 'resources', 'glm'), { recursive: true });
  await writeFile(join(zcodeDir, 'resources', 'glm', 'zcode.cjs'),
    `require('node:fs').appendFileSync(process.env.FAKE_ZCODE_LOG, JSON.stringify({ script: __filename, args: process.argv.slice(2) }) + '\\n');`);
  const env = { ...process.env, FAKE_ZCODE_LOG: log, STUDYHUB_NO_PAUSE: '1', PATH: `${dirname(process.execPath)};${process.env.SystemRoot}\\System32` };
  for (const given of [zcodeDir, `${zcodeDir}\\`]) {
    await rm(log, { force: true });
    // As a double-click or a typed command does: cmd /c with the batch file and the folder, each quoted.
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `""${join(bundle, 'install.bat')}" "${given}""`],
      { env, windowsVerbatimArguments: true, encoding: 'utf8', timeout: 50_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(calls.map((call) => call.args), [['plugins', 'marketplace', 'add', bundle], ['plugins', 'install', 'studyhub@studyhub-bundle']]);
    assert.ok(calls.every((call) => call.script === join(zcodeDir, 'resources', 'glm', 'zcode.cjs')), 'the ZCode path arrived intact');
  }
});
