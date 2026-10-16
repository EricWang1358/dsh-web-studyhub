import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultDataFolder, driveOfPath, listFixedDrives, parseDriveLines } from '../lib/install-drives.js';

/* The default install folder of a large local tool: the owner's rule is "not the system drive" whenever another fixed drive has room. No real drive is read. */

const GB = 1024 ** 3;
const answer = lines => async () => ({ code: 0, stdout: lines.join('\r\n'), stderr: '' });

test('PowerShell lines become drives, largest free space first, the system drive marked', async () => {
  const drives = await listFixedDrives({ platform: 'win32', systemDrive: 'C:', run: answer([`C:\\|${20 * GB}|${256 * GB}`, `D:\\|${118 * GB}|${500 * GB}`, `E:\\|${40 * GB}|${1000 * GB}`, 'garbage']) });
  assert.deepEqual(drives.map(drive => [drive.root, drive.system]), [['D:\\', false], ['E:\\', false], ['C:\\', true]]);
  assert.equal(drives[0].freeMb, 118 * 1024);
  assert.equal(drives[0].totalMb, 500 * 1024);
});

test('the most free non-system drive is the default, as <drive>\\StudyHub\\MinerU', async () => {
  const drives = parseDriveLines([`C:\\|${300 * GB}|${500 * GB}`, `D:\\|${118 * GB}|${500 * GB}`, `E:\\|${40 * GB}|${1000 * GB}`].join('\n'), 'C:');
  const chosen = defaultDataFolder({ neededMb: 4000, drives, dataFolder: '/data' });
  assert.equal(chosen.folder, 'D:\\StudyHub\\MinerU', 'never C: while D: has room, even though C: has more');
  assert.equal(chosen.reason, 'largest-data-drive');
});

test('only the system drive: it is used and said so; other drives too full: the system drive, with its own reason', () => {
  const only = defaultDataFolder({ neededMb: 4000, drives: [{ root: 'C:\\', freeMb: 50_000, system: true }], dataFolder: '/data' });
  assert.deepEqual([only.folder, only.reason], ['C:\\StudyHub\\MinerU', 'only-system-drive']);
  const full = defaultDataFolder({ neededMb: 4000, drives: [{ root: 'C:\\', freeMb: 50_000, system: true }, { root: 'D:\\', freeMb: 900, system: false }], dataFolder: '/data' });
  assert.deepEqual([full.folder, full.reason], ['C:\\StudyHub\\MinerU', 'other-drives-full']);
  // Nothing has room: the drive with the most space, so the plan can say how much is missing there.
  const none = defaultDataFolder({ neededMb: 4000, drives: [{ root: 'C:\\', freeMb: 1000, system: true }, { root: 'D:\\', freeMb: 3000, system: false }], dataFolder: '/data' });
  assert.equal(none.folder, 'D:\\StudyHub\\MinerU');
});

test('locked, removable and optical drives are not listed by PowerShell, so they are never offered', async () => {
  // The script itself filters on IsReady and DriveType 'Fixed': only what it prints is a drive.
  const drives = await listFixedDrives({ platform: 'win32', systemDrive: 'C:', run: answer([`C:\\|${20 * GB}|${256 * GB}`]) });
  assert.deepEqual(drives.map(drive => drive.root), ['C:\\']);
});

test('a USB or SD disk (Windows calls an external hard disk "Fixed") is marked removable and is never the default while an internal drive has room', () => {
  const drives = parseDriveLines([`C:\\|${60 * GB}|${256 * GB}|NVMe`, `E:\\|${900 * GB}|${1000 * GB}|USB`, `F:\\|${50 * GB}|${64 * GB}|SD`, `D:\\|${20 * GB}|${200 * GB}|SATA`].join('\n'), 'C:');
  assert.deepEqual(drives.map(drive => [drive.root, !!drive.removable]), [['C:\\', false], ['E:\\', true], ['F:\\', true], ['D:\\', false]]);
  assert.equal(defaultDataFolder({ neededMb: 4000, drives, dataFolder: '/data' }).folder, 'D:\\StudyHub\\MinerU', 'the internal data drive, not the bigger USB disk');
  // Only C: and a USB disk: C: (it stays when the disk is unplugged), said as the other drives being unsuitable.
  const usbOnly = defaultDataFolder({ neededMb: 4000, drives: drives.filter(drive => drive.root !== 'D:\\'), dataFolder: '/data' });
  assert.deepEqual([usbOnly.folder, usbOnly.reason], ['C:\\StudyHub\\MinerU', 'other-drives-removable']);
  // C: full too: the external disk after all, rather than a folder that cannot fit.
  const cFull = defaultDataFolder({ neededMb: 4000, drives: [{ root: 'C:\\', freeMb: 1000, system: true }, { root: 'E:\\', freeMb: 900_000, system: false, removable: true }], dataFolder: '/data' });
  assert.equal(cFull.folder, 'E:\\StudyHub\\MinerU');
  // Without a bus type (older PowerShell, no Storage module) the line still reads as an internal drive.
  assert.equal(parseDriveLines(`D:\\|${GB}|${GB}|`, 'C:')[0].removable, false);
});

test('PowerShell failing falls back to statfs on each letter', async () => {
  const seen = [];
  const statfs = async root => {
    seen.push(root);
    if (root === 'C:\\') return { bsize: 4096, bavail: (10 * GB) / 4096, blocks: (100 * GB) / 4096 };
    if (root === 'F:\\') return { bsize: 4096, bavail: (70 * GB) / 4096, blocks: (200 * GB) / 4096 };
    throw Object.assign(new Error('no drive'), { code: 'ENOENT' });
  };
  const drives = await listFixedDrives({ platform: 'win32', systemDrive: 'C:', run: async () => { throw new Error('powershell blocked'); }, statfs });
  assert.deepEqual(drives.map(drive => [drive.root, drive.system, drive.freeMb]), [['F:\\', false, 70 * 1024], ['C:\\', true, 10 * 1024]]);
  assert.ok(seen.includes('Z:\\'));
  const failedExit = await listFixedDrives({ platform: 'win32', systemDrive: 'C:', run: async () => ({ code: 1, stdout: '', stderr: 'denied' }), statfs });
  assert.equal(failedExit.length, 2);
});

test('not Windows: no drives, the StudyHub data folder', async () => {
  assert.deepEqual(await listFixedDrives({ platform: 'linux' }), []);
  assert.deepEqual(defaultDataFolder({ neededMb: 4000, drives: [], dataFolder: '/home/me/.dsh/studyhub/mineru' }), { folder: '/home/me/.dsh/studyhub/mineru', reason: 'data-folder', drive: null });
  assert.equal(driveOfPath('d:\\x'), 'D:');
  assert.equal(driveOfPath('/home/x'), '');
});
