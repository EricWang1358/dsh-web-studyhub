import { resolve } from 'node:path';
import {
  buildDoctorReport,
  buildStatsSummary,
  formatDoctorReport,
  formatStatsSummary,
  shouldAutoAscii,
  type ParsedCliArgs,
} from './cli-args.js';

export interface ExportReceipt {
  ok: true;
  path: string;
  bytes: number;
  decks: number;
  cards: number;
  libraryRoot: string;
  generatedAt: string;
}

/**
 * Run `--doctor` diagnostics without loading React, Ink, or StudyRuntime.
 */
export async function runDoctorFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const [{ accessSync, constants, existsSync, statSync }, { homedir }, { delimiter, dirname, isAbsolute, join, resolve: resolvePath }, { fileURLToPath }] =
    await Promise.all([import('node:fs'), import('node:os'), import('node:path'), import('node:url')]);

  const home = homedir();
  const dshOverride = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const dshHome = dshOverride
    ? isAbsolute(dshOverride)
      ? resolvePath(dshOverride)
      : resolvePath(home, dshOverride)
    : join(home, '.dsh');
  const tuiPrefsPath = join(dshHome, 'study', 'tui.json');
  const tuiPrefsExists = existsSync(tuiPrefsPath);

  const marker = join('application', 'desktop-host.js');
  let desktopRoot: string | null = null;
  const desktopOverride =
    typeof process.env.STUDYHUB_DESKTOP_ROOT === 'string' ? process.env.STUDYHUB_DESKTOP_ROOT.trim() : '';
  if (desktopOverride && existsSync(join(desktopOverride, marker))) {
    desktopRoot = resolvePath(desktopOverride);
  } else {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      for (const candidate of [join(dir, 'studyhub-desktop'), join(dir, 'packages', 'studyhub-desktop')]) {
        if (existsSync(join(candidate, marker))) {
          desktopRoot = candidate;
          break;
        }
      }
      if (desktopRoot) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  let agyPath: string | null = null;
  const rawPath = process.env.PATH ?? process.env.Path ?? '';
  if (rawPath) {
    const names = process.platform === 'win32' ? ['agy.cmd', 'agy.exe', 'agy.bat', 'agy'] : ['agy'];
    for (const entry of rawPath.split(delimiter)) {
      const dir = entry.trim().replace(/^"|"$/g, '');
      if (!dir) continue;
      for (const name of names) {
        const full = join(dir, name);
        try {
          if (!statSync(full).isFile()) continue;
          if (process.platform !== 'win32') accessSync(full, constants.X_OK);
          agyPath = full;
          break;
        } catch {
          // Not found or not executable
        }
      }
      if (agyPath) break;
    }
  }

  const report = buildDoctorReport({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    isTty: Boolean(process.stdout?.isTTY),
    stdoutCols: typeof process.stdout?.columns === 'number' ? process.stdout.columns : null,
    stdoutRows: typeof process.stdout?.rows === 'number' ? process.stdout.rows : null,
    version,
    args: parsed,
    dshHome,
    tuiPrefsPath,
    tuiPrefsExists,
    desktopRoot,
    agyPath,
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDoctorReport(report, report.terminal.asciiMode)}\n`);
  }
}

/**
 * Run `--stats` offline library summary without loading React or Ink.
 */
export async function runStatsFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const { createTuiHost } = await import('./host/tui-host.js');
  const host = await createTuiHost({
    libraryRoot: parsed.libraryRoot,
    skipAutoProbe: true,
    language: parsed.language,
  });
  try {
    const refresh = await host.refreshSnapshot();
    const libraryRoot =
      refresh.binding?.root || refresh.snapshot?.root || host.getLibraryRoot() || parsed.libraryRoot || '';
    const summary = buildStatsSummary({
      libraryRoot,
      snapshot: refresh.snapshot,
      version,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      const ascii = parsed.asciiMode ?? shouldAutoAscii(process.env);
      process.stdout.write(`${formatStatsSummary(summary, ascii)}\n`);
    }
  } finally {
    await host.dispose().catch(() => {});
  }
}

/**
 * Run `--export` 1-shot atomic JSON library backup without loading React, Ink, or any LLM provider.
 */
export async function runExportFastPath(args: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const [{ createTuiHost }, { atomicWriteJsonFile, defaultBackupFilePath }] = await Promise.all([
    import('./host/tui-host.js'),
    import('./host/atomic-write.js'),
  ]);

  const host = await createTuiHost({
    libraryRoot: args.libraryRoot,
    skipAutoProbe: true,
    language: args.language,
  });

  try {
    const res = await host.call<Record<string, unknown>>('export', {});
    if (!res.ok || !res.value) {
      throw new Error(res.error?.message || 'Failed to export library backup');
    }

    const libraryRoot = host.getLibraryRoot() || args.libraryRoot || '';
    const rawExportPath = args.exportPath?.trim();
    const targetPath = rawExportPath
      ? resolve(
          process.cwd(),
          rawExportPath.toLowerCase().endsWith('.json') ? rawExportPath : `${rawExportPath}.json`,
        )
      : defaultBackupFilePath(host.getLibraryRoot(), 'studyhub-backup', '.json');

    const { bytes } = await atomicWriteJsonFile(targetPath, res.value);

    const decksList = Array.isArray(res.value.decks) ? (res.value.decks as Array<{ cards?: unknown[] }>) : [];
    const decks = decksList.length;
    const cards = decksList.reduce(
      (sum, deck) => sum + (Array.isArray(deck?.cards) ? deck.cards.length : 0),
      0,
    );
    const generatedAt = new Date().toISOString();

    const receipt: ExportReceipt = {
      ok: true,
      path: targetPath,
      bytes,
      decks,
      cards,
      libraryRoot,
      generatedAt,
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      const ascii = args.asciiMode ?? shouldAutoAscii(process.env);
      const rule = ascii ? '----------------------------------------' : '────────────────────────────────────────';
      const bullet = ascii ? '-' : '•';
      const okMark = ascii ? '[ok]' : '✓';
      const lines = [
        `StudyHub TUI Export (v${version})`,
        rule,
        `Status: ${okMark} Exported library backup`,
        `  ${bullet} Path: ${receipt.path}`,
        `  ${bullet} Library: ${receipt.libraryRoot || '(unset)'}`,
        `  ${bullet} Size: ${receipt.bytes} bytes`,
        `  ${bullet} Contents: ${receipt.decks} decks, ${receipt.cards} cards`,
        `  ${bullet} Generated: ${receipt.generatedAt}`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } finally {
    await host.dispose().catch(() => {});
  }
}
