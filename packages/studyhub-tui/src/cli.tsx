/**
 * StudyHub TUI CLI entrypoint.
 * Handles `--help` / `--version` fast-path before importing Ink/React/Host for instant cold CLI response.
 * Supports both Linux bash and Windows PowerShell / Windows Terminal.
 */
import { parseCliArgs, cliHelpText } from './cli-args.js';

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

  const [{ createElement }, { render }, { enterTerminalSession }, { createTuiHost }, { StudyHubTuiApp }] =
    await Promise.all([
      import('react'),
      import('ink'),
      import('./terminal.js'),
      import('./host/index.js'),
      import('./App.js'),
    ]);

  const terminal = enterTerminalSession({ altScreen: parsed.altScreen });

  let host: Awaited<ReturnType<typeof createTuiHost>> | null = null;
  let instance: ReturnType<typeof render> | null = null;
  let cleaningUp = false;

  const cleanup = async () => {
    if (cleaningUp) return;
    cleaningUp = true;
    try {
      instance?.unmount();
    } catch {
      // Ignore unmount errors
    }
    terminal.restore();
    if (host) {
      await host.dispose().catch(() => {});
    }
  };

  const onSignal = () => {
    void cleanup().finally(() => process.exit(0));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    host = await createTuiHost({
      libraryRoot: parsed.libraryRoot,
      language: parsed.language,
      skipAutoProbe: parsed.skipAutoProbe,
    });

    instance = render(
      createElement(StudyHubTuiApp, {
        host,
        initialPage: parsed.initialPage,
        initialTheme: parsed.theme,
        initialLanguage: parsed.language,
        autoLaunchpad: parsed.autoLaunchpad,
        onExit: () => {
          instance?.unmount();
        },
      }),
      {
        exitOnCtrlC: true,
        patchConsole: true,
      },
    );

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
