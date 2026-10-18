import { statfs as fsStatfs } from 'node:fs/promises';
import path from 'node:path';
import { runLocalCommand } from './local-command.js';

/* The fixed drives of this computer and the default folder for a large local tool (the one-click MinerU install). The owner's rule: never the
   system drive when there is another fixed drive with room; the system drive only when it is the only one with room. Read-only: nothing is
   created here. Windows asks PowerShell for DriveInfo (fixed and ready drives only: a locked BitLocker drive, a USB stick or a DVD is left out; an
   external USB hard disk does report 'Fixed', so each drive's bus marks it `removable` and it comes after the system drive as a default);
   when PowerShell cannot answer, every letter D:..Z: is asked with statfs (which cannot tell a USB stick from a disk). Other systems have no
   drives to choose: the tool goes into the StudyHub data folder. */

export const DRIVES = Object.freeze({ timeoutMs: 8000, cacheMs: 60_000 });

// The fourth field is 'USB' for a drive on an external disk: Windows reports an external USB hard disk as 'Fixed' too, and it breaks the tool once it is
// unplugged. The letters come from Win32_DiskDrive (a USB interface, or external/removable media) through its partitions (about 0.3 s; the Storage
// module's Get-Disk takes seconds). Empty when WMI cannot answer: the drive then counts as internal.
const SCRIPT = "$x = @(); try { $x = @(Get-CimInstance Win32_DiskDrive -Filter \"InterfaceType='USB' OR MediaType LIKE 'External%' OR MediaType LIKE 'Removable%'\" -ErrorAction Stop "
  + "| % { Get-CimAssociatedInstance $_ -ResultClassName Win32_DiskPartition } | % { Get-CimAssociatedInstance $_ -ResultClassName Win32_LogicalDisk } | % { $_.DeviceID }) } catch {}; "
  + "[System.IO.DriveInfo]::GetDrives() | ? { $_.IsReady -and $_.DriveType -eq 'Fixed' } "
  + "| % { '{0}|{1}|{2}|{3}' -f $_.Name,$_.AvailableFreeSpace,$_.TotalSize,$(if ($x -contains $_.Name.Substring(0,2)) { 'USB' } else { '' }) }";
const REMOVABLE_BUS = /^(USB|SD|MMC|1394)$/i;
const MB = 1_048_576;
const letterOf = root => String(root || '').slice(0, 2).toUpperCase();
export const systemDriveOf = (env = process.env) => letterOf(env.SystemDrive || 'C:');

const powershell = (signal) => runLocalCommand({ file: 'powershell.exe', prefix: [], env: {} }, ['-NoProfile', '-NonInteractive', '-Command', SCRIPT], { signal, timeoutMs: DRIVES.timeoutMs });

/** The lines of the PowerShell answer as drives: `C:\|123|456|NVMe` (bytes free, bytes in all, the bus; `removable` for a USB or SD disk). */
export function parseDriveLines(text, systemDrive = systemDriveOf()) {
  const drives = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^([A-Za-z]:\\?)\|(\d+)\|(\d+)(?:\|([A-Za-z0-9 ]*))?\s*$/.exec(line.trim());
    if (!match) continue;
    const letter = letterOf(match[1]);
    drives.push({ root: `${letter}\\`, freeMb: Math.floor(Number(match[2]) / MB), totalMb: Math.floor(Number(match[3]) / MB), system: letter === systemDrive,
      removable: REMOVABLE_BUS.test((match[4] || '').trim()) });
  }
  return drives;
}

/**
 * The fixed drives, largest free space first: [{ root: 'D:\\', freeMb, totalMb, system }]. `run(signal)` stands in for PowerShell and `statfs`
 * for the fallback (tests); not Windows: []. Never throws.
 */
export async function listFixedDrives({ platform = process.platform, run = powershell, statfs = fsStatfs, systemDrive = systemDriveOf(), signal } = {}) {
  if (platform !== 'win32') return [];
  let drives = [];
  try {
    const result = await run(signal);
    if (result?.code === 0) drives = parseDriveLines(result.stdout, systemDrive);
  } catch { /* PowerShell is missing or blocked: ask each letter instead */ }
  if (!drives.length) {
    const letters = [systemDrive, ...'DEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(letter => `${letter}:`)].filter((letter, index, all) => all.indexOf(letter) === index);
    for (const letter of letters) {
      try {
        const info = await statfs(`${letter}\\`);
        const block = Number(info.bsize);
        drives.push({ root: `${letter}\\`, freeMb: Math.floor((Number(info.bavail) * block) / MB), totalMb: Math.floor((Number(info.blocks) * block) / MB), system: letter === systemDrive });
      } catch { /* no such drive */ }
    }
  }
  return drives.sort((a, b) => b.freeMb - a.freeMb);
}

let cached = null;
/** listFixedDrives, remembered for DRIVES.cacheMs in this process (a plan is asked for again on every change of the card). */
export async function fixedDrives(options = {}) {
  if (options.run || options.statfs || options.platform) return listFixedDrives(options);
  const now = Date.now();
  if (cached && now - cached.at < DRIVES.cacheMs) return cached.drives;
  const drives = await listFixedDrives(options);
  cached = { at: now, drives };
  return drives;
}
export const forgetDrives = () => { cached = null; };

/**
 * Where a tool goes when the learner did not choose: `<drive>\<leaf...>` on the non-system fixed drive with the most free space when it has
 * `neededMb`; else the system drive when it has room; else the drive with the most free space (the plan then says there is not enough).
 * Without drives (not Windows, nothing readable): `dataFolder`. Resolves { folder, reason, drive } where reason is 'largest-data-drive',
 * 'other-drives-full' (other fixed drives exist, none has room), 'other-drives-removable' (the only other drive with room is an external USB/SD disk),
 * 'only-system-drive' or 'data-folder'.
 */
export function defaultDataFolder({ leaf = ['StudyHub', 'MinerU'], neededMb = 0, drives = [], dataFolder }) {
  if (!drives.length) return { folder: dataFolder, reason: 'data-folder', drive: null };
  const sorted = [...drives].sort((a, b) => b.freeMb - a.freeMb);
  const others = sorted.filter(drive => !drive.system), system = sorted.find(drive => drive.system);
  // An external (USB/SD) disk comes after the system drive: the tool would stop working whenever it is unplugged.
  const roomy = others.find(drive => !drive.removable && drive.freeMb >= neededMb);
  const external = others.find(drive => drive.removable && drive.freeMb >= neededMb);
  const drive = roomy || (system && system.freeMb >= neededMb ? system : external || sorted[0]);
  const reason = !drive.system ? 'largest-data-drive' : external ? 'other-drives-removable' : others.length ? 'other-drives-full' : 'only-system-drive';
  return { folder: path.win32.join(drive.root, ...leaf), reason, drive };
}

/** The drive a Windows path is on ('D:'), or '' for another path. */
export const driveOfPath = folder => (/^[A-Za-z]:/.test(String(folder || '')) ? letterOf(folder) : '');
