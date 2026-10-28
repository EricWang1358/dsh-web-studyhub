import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import { ENTRY, findZcode, folderOf, parseReg, registryFolders, usualFolders } from '../packages/studyhub-zcode/install/find-zcode.mjs';

/* install.bat must find ZCode wherever it is installed. The owner's is at E:\Program Files\ZCode; the reference installer
   looked only under %LOCALAPPDATA% and C:'s Program Files. The batch file itself looks nowhere: it asks find-zcode.mjs. */
const bat = await readFile(new URL('../packages/studyhub-zcode/install/install.bat', import.meta.url), 'utf8');
const entryOn = (folder) => win32.join(folder, ENTRY);

test('install.bat is ASCII, has no C:-only lookup and asks find-zcode.mjs where ZCode is', () => {
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(bat), 'cmd.exe mis-reads anything but ASCII');
  assert.doesNotMatch(bat, /\b[Cc]:\\/, 'no hard-coded C: path');
  assert.doesNotMatch(bat, /%(ProgramFiles|LOCALAPPDATA|ProgramFiles\(x86\))%\\ZCode/i, 'no fixed install folder');
  assert.match(bat, /node "%~dp0studyhub\\install\\find-zcode\.mjs" "%~1"/);
  assert.match(bat, /NODE_MAJOR% LSS 22/, 'Node 22 or newer');
  assert.match(bat, /plugins marketplace add "%~dp0\."/);
  assert.match(bat, /plugins install studyhub@studyhub-bundle/);
  assert.match(bat, /plugins uninstall studyhub --force/, 'the uninstall commands are printed');
  assert.match(bat, /plugins marketplace remove studyhub-bundle/);
});

test('ZCode on E: is found from the usual folders of every drive', () => {
  const owner = 'E:\\Program Files\\ZCode';
  const exists = (path) => ['C:\\', 'E:\\', entryOn(owner)].includes(path);
  assert.ok(usualFolders({}, exists).includes(owner));
  assert.equal(findZcode({ env: {}, exists, run: () => '' }), entryOn(owner));
});

test('a folder given to install.bat (or ZCODE_HOME) wins, and a resources\\glm folder works too', () => {
  const folder = 'G:\\Apps\\ZCode';
  const exists = (path) => path === entryOn(folder);
  assert.equal(findZcode({ given: folder, env: {}, exists, run: () => '' }), entryOn(folder));
  assert.equal(findZcode({ given: `"${folder}\\ZCode.exe"`, env: {}, exists, run: () => '' }), entryOn(folder));
  assert.equal(findZcode({ env: { ZCODE_HOME: folder }, exists, run: () => '' }), entryOn(folder));
  assert.equal(findZcode({ given: win32.join(folder, 'resources', 'glm'), env: {}, exists, run: () => '' }), entryOn(folder));
  assert.equal(findZcode({ env: {}, exists: () => false, run: () => '' }), null);
});

test('the running ZCode process and the registry name its folder', () => {
  const folder = 'F:\\Tools\\ZCode';
  const exists = (path) => path === entryOn(folder);
  const fromProcess = (command) => (command === 'powershell' ? `${folder}\\ZCode.exe\r\n` : '');
  assert.equal(findZcode({ env: {}, exists, run: fromProcess }), entryOn(folder));
  const uninstall = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ZCode-1234',
    '    DisplayName    REG_SZ    ZCode 0.18.2',
    '    InstallLocation    REG_SZ    F:\\Tools\\ZCode',
    '    DisplayIcon    REG_SZ    "F:\\Tools\\ZCode\\ZCode.exe",0',
    '', 'End of search: 3 match(es) found.'].join('\r\n');
  const fromRegistry = (command, args) => (command === 'reg' && args.includes('/f') && args[1].startsWith('HKCU') ? uninstall : '');
  assert.equal(findZcode({ env: {}, exists, run: fromRegistry }), entryOn(folder));
  const appPath = ['HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\ZCode.exe', '    (默认)    REG_SZ    F:\\Tools\\ZCode\\ZCode.exe'].join('\r\n');
  assert.deepEqual(registryFolders((args) => (args[1].includes('App Paths') && args[1].startsWith('HKLM') ? appPath : '')), [folder]);
});

test('registry values are read as folders', () => {
  assert.equal(folderOf('"E:\\Program Files\\ZCode\\Uninstall ZCode.exe" /currentuser'), 'E:\\Program Files\\ZCode');
  assert.equal(folderOf('E:\\Program Files\\ZCode\\ZCode.exe,0'), 'E:\\Program Files\\ZCode');
  assert.equal(folderOf('E:\\Program Files\\ZCode'), 'E:\\Program Files\\ZCode');
  assert.equal(folderOf('relative\\ZCode'), null);
  assert.deepEqual(parseReg('HKEY_X\\Y\r\n    Name    REG_EXPAND_SZ    D:\\a b\r\n'), [{ key: 'HKEY_X\\Y', name: 'Name', value: 'D:\\a b' }]);
});
