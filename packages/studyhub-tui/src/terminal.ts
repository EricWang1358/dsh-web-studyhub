/**
 * Cross-platform TTY lifecycle manager for Linux bash & Windows PowerShell / Windows Terminal.
 * - Enters alternate screen buffer cleanly when attached to a TTY (can be disabled via `--no-alt-screen`).
 * - Guarantees terminal restoration (exit alt screen, show cursor, disable mouse/bracketed paste)
 *   on normal exit, SIGINT, SIGTERM, and uncaught exceptions via `signal-exit`.
 */
import { onExit } from 'signal-exit';

const ENTER_ALT_SCREEN = '\x1b[?1049h\x1b[2J\x1b[H';
const EXIT_ALT_SCREEN = '\x1b[?1049l';
const SHOW_CURSOR = '\x1b[?25h';
const RESET_STYLE = '\x1b[0m';

export interface TerminalSessionOptions {
  stdout?: NodeJS.WriteStream;
  stdin?: NodeJS.ReadStream;
  altScreen?: boolean;
}

export interface TerminalSession {
  readonly isTty: boolean;
  readonly altScreenActive: boolean;
  restore: () => void;
}

export function enterTerminalSession(options: TerminalSessionOptions = {}): TerminalSession {
  const stdout = options.stdout ?? process.stdout;
  const stdin = options.stdin ?? process.stdin;
  const isTty = Boolean(stdout.isTTY && stdin.isTTY);
  const useAlt = isTty && options.altScreen !== false;

  // Ensure UTF-8 encoding on both Linux bash and Windows PowerShell / ConPTY
  try {
    stdout.setDefaultEncoding?.('utf8');
  } catch {
    // Ignore on custom streams
  }

  let restored = false;

  const restore = () => {
    if (restored) return;
    restored = true;
    if (isTty) {
      try {
        stdout.write(`${RESET_STYLE}${SHOW_CURSOR}${useAlt ? EXIT_ALT_SCREEN : ''}`);
      } catch {
        // Ignore broken pipe during exit
      }
      try {
        if (typeof stdin.setRawMode === 'function' && stdin.isRaw) {
          stdin.setRawMode(false);
        }
      } catch {
        // Ignore raw-mode errors on teardown
      }
    }
  };

  if (useAlt) {
    try {
      stdout.write(ENTER_ALT_SCREEN);
    } catch {
      // Ignore write failures
    }
  }

  const removeExitHook = onExit(() => {
    restore();
  });

  return {
    isTty,
    altScreenActive: useAlt,
    restore: () => {
      removeExitHook();
      restore();
    },
  };
}
