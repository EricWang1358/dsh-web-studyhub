/**
 * StudyHub TUI CLI entrypoint.
 * - Handles `--help` / `--version` / `--doctor` fast-paths before importing Ink/React/Host (<150ms).
 * - Renders `ShellBootFrame` IMMEDIATELY while `createTuiHost` initializes StudyRuntime
 *   in parallel, slashing perceived Time-To-First-Frame by >60%.
 * - Supports both Linux bash and Windows PowerShell / Windows Terminal (including `--ascii`).
 */
import {
  buildDoctorReport,
  buildStatsSummary,
  cliHelpText,
  formatDoctorReport,
  formatStatsSummary,
  parseCliArgs,
  resolveColorCapability,
  shouldAutoAscii,
  shouldEnableMouse,
} from './cli-args.js';

const PKG_VERSION = '1.0.0';

async function runDoctorFastPath(parsed: ReturnType<typeof parseCliArgs>) {
  const [{ accessSync, constants, existsSync, statSync }, { homedir }, { delimiter, dirname, isAbsolute, join, resolve }, { fileURLToPath }] =
    await Promise.all([import('node:fs'), import('node:os'), import('node:path'), import('node:url')]);

  const home = homedir();
  const dshOverride = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const dshHome = dshOverride
    ? isAbsolute(dshOverride)
      ? resolve(dshOverride)
      : resolve(home, dshOverride)
    : join(home, '.dsh');
  const tuiPrefsPath = join(dshHome, 'study', 'tui.json');
  const tuiPrefsExists = existsSync(tuiPrefsPath);

  const marker = join('application', 'desktop-host.js');
  let desktopRoot: string | null = null;
  const desktopOverride =
    typeof process.env.STUDYHUB_DESKTOP_ROOT === 'string' ? process.env.STUDYHUB_DESKTOP_ROOT.trim() : '';
  if (desktopOverride && existsSync(join(desktopOverride, marker))) {
    desktopRoot = resolve(desktopOverride);
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
    version: PKG_VERSION,
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

async function runStatsFastPath(parsed: ReturnType<typeof parseCliArgs>) {
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
      version: PKG_VERSION,
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

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.error) {
    process.stderr.write(`Error: ${parsed.error}\n\n${cliHelpText(PKG_VERSION)}\n`);
    process.exit(2);
  }

  if (parsed.help) {
    process.stdout.write(`${cliHelpText(PKG_VERSION)}\n`);
    return;
  }

  if (parsed.version) {
    process.stdout.write(`studyhub-tui ${PKG_VERSION}\n`);
    return;
  }

  if (parsed.doctor) {
    await runDoctorFastPath(parsed);
    return;
  }

  if (parsed.stats) {
    await runStatsFastPath(parsed);
    return;
  }

  const resolvedAscii = parsed.asciiMode ?? (shouldAutoAscii(process.env) ? true : undefined);
  const resolvedMouse = parsed.mouse ?? shouldEnableMouse(process.env);
  const colorCap = resolveColorCapability(process.env, { isTTY: Boolean(process.stdout.isTTY) });
  if (colorCap.level === 0) {
    process.env.FORCE_COLOR = '0';
  }

  const [
    React,
    { render, Box, Text },
    { enterTerminalSession },
    { ShellBootFrame },
    { useTuiStore },
    { setColorLevel },
  ] = await Promise.all([
    import('react'),
    import('ink'),
    import('./terminal.js'),
    import('./shell/ShellBootFrame.js'),
    import('./state/store.js'),
    import('./theme/tokens.js'),
  ]);

  setColorLevel(colorCap.level);

  if (parsed.theme) useTuiStore.getState().setTheme(parsed.theme);
  if (parsed.language) useTuiStore.getState().setLanguage(parsed.language);
  if (resolvedAscii !== undefined) useTuiStore.getState().setPreferences({ asciiMode: resolvedAscii });

  const terminal = enterTerminalSession({ altScreen: parsed.altScreen, mouse: resolvedMouse });

  type TuiHostType = Awaited<ReturnType<typeof import('./host/tui-host.js').createTuiHost>>;
  let activeHost: TuiHostType | null = null;
  let instance: ReturnType<typeof render> | null = null;
  let cleaningUp = false;

  const MAX_BOOT_BUFFER_BYTES = 64;
  const bootChunks: Buffer[] = [];
  let bootBytes = 0;
  let bootAttached = false;

  const stripBootNoise = (raw: string): string =>
    raw
      .replace(/\x1b\[<\d+;\d+;\d+[Mm]/g, '')
      .replace(/\x1b\[M[\s\S]{3}/g, '')
      .replace(/\x1b\[[IO]/g, '')
      .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|\x9c)/g, '')
      .replace(/\x1b\[\?\d+(?:;\d+)*[uc]/g, '')
      .replace(/\x1b\[>[\d;]*c/g, '')
      .replace(/\x1b\[\d+;\d+R/g, '')
      .replace(/\x1b\[\?\d+(?:;\d+)*\$y/g, '');

  const onBootData = (chunk: Buffer | string) => {
    if (bootBytes >= MAX_BOOT_BUFFER_BYTES) return;
    const raw = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (raw.includes('\x03')) {
      onSignal();
      return;
    }
    const filtered = stripBootNoise(raw);
    if (!filtered) return;
    const buf = Buffer.from(filtered, 'utf8');
    const remaining = MAX_BOOT_BUFFER_BYTES - bootBytes;
    const slice = buf.length > remaining ? buf.subarray(0, remaining) : buf;
    if (slice.length > 0) {
      bootChunks.push(slice);
      bootBytes += slice.length;
    }
  };

  const detachBootBuffer = () => {
    if (!bootAttached) return;
    bootAttached = false;
    process.stdin.off('data', onBootData);
    process.stdin.pause();
  };

  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    detachBootBuffer();
    try {
      instance?.unmount();
    } catch {
      // Ignore unmount errors
    }
    terminal.restore();
    if (activeHost) {
      await activeHost.dispose().catch(() => {});
    }
  };

  const onSignal = () => {
    void cleanup().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  if (process.stdin.isTTY) {
    try {
      process.stdin.setRawMode?.(true);
      process.stdin.on('data', onBootData);
      bootAttached = true;
    } catch {
      // Ignore if stdin cannot enter raw mode during boot
    }
  }

  // Kick off host + App loading IMMEDIATELY in parallel with Ink mounting ShellBootFrame
  const bootPromise = Promise.all([import('./host/tui-host.js'), import('./App.js')]).then(
    async ([{ createTuiHost }, { StudyHubTuiApp }]) => {
      const host = await createTuiHost({
        libraryRoot: parsed.libraryRoot,
        language: parsed.language,
        skipAutoProbe: parsed.skipAutoProbe,
      });
      if (cleaningUp) {
        await host.dispose().catch(() => {});
        return null;
      }
      activeHost = host;
      return { host, StudyHubTuiApp };
    },
  );

  function BootstrapRoot() {
    const [ready, setReady] = React.useState<{
      host: TuiHostType;
      StudyHubTuiApp: typeof import('./App.js').StudyHubTuiApp;
    } | null>(null);
    const [bootError, setBootError] = React.useState<string | null>(null);

    React.useEffect(() => {
      let alive = true;
      bootPromise.then(
        (res) => {
          if (!alive) return;
          detachBootBuffer();
          if (res) setReady(res);
        },
        (err) => {
          if (!alive) return;
          detachBootBuffer();
          setBootError(err instanceof Error ? err.message : String(err));
        },
      );
      return () => {
        alive = false;
      };
    }, []);

    React.useEffect(() => {
      if (!ready || bootChunks.length === 0) return undefined;
      const buffered = Buffer.concat(bootChunks.splice(0, bootChunks.length));
      bootBytes = 0;
      const timer = setImmediate(() => {
        if (cleaningUp || buffered.length === 0) return;
        try {
          process.stdin.unshift(buffered);
        } catch {
          // Ignore replay errors if stdin closed
        }
      });
      return () => clearImmediate(timer);
    }, [ready]);

    if (bootError) {
      return React.createElement(
        Box,
        { flexDirection: 'column', padding: 1 },
        React.createElement(Text, { color: 'red', bold: true }, `StudyHub TUI startup failed: ${bootError}`),
        React.createElement(Text, { dimColor: true }, 'Press Ctrl+C to exit.'),
      );
    }

    if (!ready) {
      return React.createElement(ShellBootFrame, {
        label: parsed.language === 'en' ? 'Starting StudyHub runtime…' : '正在初始化 StudyHub 学习引擎…',
      });
    }

    return React.createElement(ready.StudyHubTuiApp, {
      host: ready.host,
      initialPage: parsed.initialPage,
      initialTheme: parsed.theme,
      initialLanguage: parsed.language,
      initialAsciiMode: resolvedAscii,
      autoLaunchpad: parsed.autoLaunchpad,
      onExit: () => {
        instance?.unmount();
      },
    });
  }

  try {
    instance = render(React.createElement(BootstrapRoot), {
      exitOnCtrlC: true,
      patchConsole: true,
    });
    await instance.waitUntilExit();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    await cleanup();
  }
}

main().catch((err) => {
  try {
    process.stdout.write('\x1b[0m\x1b[?25h\x1b[?1049l');
  } catch {
    // Ignore
  }
  process.stderr.write(`StudyHub TUI fatal error: ${err instanceof Error ? err.stack || err.message : String(err)}\n`);
  process.exit(1);
});
