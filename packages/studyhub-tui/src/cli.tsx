/**
 * StudyHub TUI CLI entrypoint.
 * - Handles `--help` / `--version` fast-path before importing Ink/React/Host (<60ms).
 * - Renders `ShellBootFrame` IMMEDIATELY while `createTuiHost` initializes StudyRuntime
 *   in parallel, slashing perceived Time-To-First-Frame by >60%.
 * - Supports both Linux bash and Windows PowerShell / Windows Terminal (including `--ascii`).
 */
import { parseCliArgs, cliHelpText, shouldAutoAscii, shouldEnableMouse, resolveColorCapability } from './cli-args.js';

const PKG_VERSION = '1.0.0';

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
