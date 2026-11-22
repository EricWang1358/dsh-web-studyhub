import type { PageId, ThemeId, UiLanguage } from './types/contracts.js';
import { PAGE_REGISTRY } from './types/contracts.js';

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  libraryRoot?: string;
  theme?: ThemeId;
  language?: UiLanguage;
  initialPage?: PageId;
  altScreen: boolean;
  autoLaunchpad: boolean;
  skipAutoProbe: boolean;
  asciiMode?: boolean;
  mouse?: boolean;
  error?: string;
}

export interface ColorCapability {
  enabled: boolean;
  level: 0 | 1 | 2 | 3;
  reason: string;
}

const VALID_THEMES = new Set<ThemeId>(['dsh-dark', 'warm-paper', 'nord', 'high-contrast']);
const VALID_PAGES = new Set<PageId>(PAGE_REGISTRY.map((p) => p.id));
const TRUECOLOR_TERM_PROGRAMS = new Set([
  'wezterm',
  'iterm.app',
  'vscode',
  'hyper',
  'alacritty',
  'kitty',
]);

/**
 * Resolve terminal color support from environment variables and TTY state.
 * Honors `NO_COLOR`, `FORCE_COLOR`, `TERM=dumb`, non-TTY streams, Windows Terminal (`WT_SESSION`),
 * `COLORTERM`, `TERM_PROGRAM`, and 256-color `TERM` values.
 */
export function resolveColorCapability(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { isTTY?: boolean; platform?: NodeJS.Platform },
): ColorCapability {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') {
    return { enabled: false, level: 0, reason: 'NO_COLOR' };
  }

  const forceRaw = env.FORCE_COLOR;
  if (forceRaw !== undefined && forceRaw !== '') {
    const force = forceRaw.trim().toLowerCase();
    if (force === '0' || force === 'false') {
      return { enabled: false, level: 0, reason: `FORCE_COLOR=${forceRaw}` };
    }
    if (force === '1') {
      return { enabled: true, level: 1, reason: 'FORCE_COLOR=1' };
    }
    if (force === '2') {
      return { enabled: true, level: 2, reason: 'FORCE_COLOR=2' };
    }
    if (force === '3' || force === 'true') {
      return { enabled: true, level: 3, reason: `FORCE_COLOR=${forceRaw}` };
    }
  }

  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term === 'dumb') {
    return { enabled: false, level: 0, reason: 'TERM=dumb' };
  }

  const isTTY = opts?.isTTY ?? Boolean(process.stdout?.isTTY);
  if (!isTTY) {
    return { enabled: false, level: 0, reason: 'non-tty' };
  }

  const colorterm = String(env.COLORTERM ?? '').trim().toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') {
    return { enabled: true, level: 3, reason: `COLORTERM=${colorterm}` };
  }

  if (env.WT_SESSION) {
    return { enabled: true, level: 3, reason: 'WT_SESSION' };
  }

  const termProgram = String(env.TERM_PROGRAM ?? '').trim().toLowerCase();
  if (TRUECOLOR_TERM_PROGRAMS.has(termProgram)) {
    return { enabled: true, level: 3, reason: `TERM_PROGRAM=${env.TERM_PROGRAM}` };
  }

  if (term.includes('256color')) {
    return { enabled: true, level: 2, reason: 'TERM=256color' };
  }

  return { enabled: true, level: 1, reason: opts?.platform === 'win32' ? 'win32-tty' : 'tty-basic' };
}

export function shouldAutoAscii(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const flag = String(env.STUDYHUB_TUI_ASCII ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'no') return false;

  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term === 'dumb') return true;

  if (platform === 'win32') {
    if (env.WT_SESSION) return false;
    if (env.TERM_PROGRAM) return false;
    if (String(env.ConEmuANSI ?? '').trim().toUpperCase() === 'ON') return false;
    if (env.ANSICON) return false;
    if (env.MSYSTEM) return false;
    if (term.includes('xterm') || term.includes('vt100')) return false;
    return true;
  }

  return false;
}

export function shouldEnableMouse(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.STUDYHUB_TUI_MOUSE ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return true;
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false;
  return false;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const result: ParsedCliArgs = {
    help: false,
    version: false,
    altScreen: true,
    autoLaunchpad: true,
    skipAutoProbe: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '-h' || token === '--help') {
      result.help = true;
      continue;
    }
    if (token === '-v' || token === '--version') {
      result.version = true;
      continue;
    }
    if (token === '--no-alt-screen') {
      result.altScreen = false;
      continue;
    }
    if (token === '--no-launchpad') {
      result.autoLaunchpad = false;
      continue;
    }
    if (token === '--skip-probe') {
      result.skipAutoProbe = true;
      continue;
    }
    if (token === '--ascii') {
      result.asciiMode = true;
      continue;
    }
    if (token === '--unicode') {
      result.asciiMode = false;
      continue;
    }
    if (token === '--mouse') {
      result.mouse = true;
      continue;
    }
    if (token === '--no-mouse') {
      result.mouse = false;
      continue;
    }

    const eqIdx = token.indexOf('=');
    const flag = eqIdx > 0 ? token.slice(0, eqIdx) : token;
    const takeValue = (): string | undefined => {
      if (eqIdx > 0) return token.slice(eqIdx + 1);
      if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        i += 1;
        return argv[i];
      }
      return undefined;
    };

    if (flag === '--root' || flag === '-r') {
      const val = takeValue();
      if (!val) {
        result.error = 'Missing value for --root';
        return result;
      }
      result.libraryRoot = val;
      continue;
    }

    if (flag === '--theme') {
      const val = takeValue();
      if (!val || !VALID_THEMES.has(val as ThemeId)) {
        result.error = `Invalid --theme "${val ?? ''}". Valid: dsh-dark, warm-paper, nord, high-contrast`;
        return result;
      }
      result.theme = val as ThemeId;
      continue;
    }

    if (flag === '--lang') {
      const val = takeValue();
      if (val !== 'zh' && val !== 'en') {
        result.error = `Invalid --lang "${val ?? ''}". Valid: zh, en`;
        return result;
      }
      result.language = val;
      continue;
    }

    if (flag === '--page' || flag === '-p') {
      const val = takeValue();
      if (!val || !VALID_PAGES.has(val as PageId)) {
        result.error = `Invalid --page "${val ?? ''}". Valid: ${[...VALID_PAGES].join(', ')}`;
        return result;
      }
      result.initialPage = val as PageId;
      continue;
    }

    if (token.startsWith('-')) {
      result.error = `Unknown option: ${token}`;
      return result;
    }

    // Positional path acts as library root if not set yet
    if (!result.libraryRoot) {
      result.libraryRoot = token;
    }
  }

  return result;
}

export function cliHelpText(version = '1.0.0'): string {
  return [
    `StudyHub TUI v${version} — Interactive Terminal Client for StudyHub`,
    '',
    'Usage:',
    '  studyhub-tui [options] [library-path]',
    '',
    'Options:',
    '  -r, --root <path>     Open a specific StudyHub library directory (.dsh-study or folder)',
    '  -p, --page <id>       Start directly on a page (library, review, sources, generate, ...)',
    '      --theme <id>      Theme: dsh-dark | warm-paper | nord | high-contrast',
    '      --lang <zh|en>    UI language: zh (default) | en',
    '      --no-alt-screen   Render inline without switching to the alternate screen buffer',
    '      --no-launchpad    Skip the first-run Launchpad even on an empty library',
    '      --skip-probe      Skip background CLI model discovery on startup',
    '      --ascii           Use ASCII-safe borders/bars (for legacy Windows PowerShell 5.1)',
    '      --mouse           Enable SGR mouse wheel scrolling (or STUDYHUB_TUI_MOUSE=1; --no-mouse disables)',
    '  -v, --version         Print version and exit',
    '  -h, --help            Show this help message',
    '',
    'Models:',
    '  Primary:   Local agy CLI (auto-detected on first run)',
    '  Secondary: OpenAI-compatible APIs (DeepSeek, OpenAI, SiliconFlow, Zhipu, OpenRouter, Custom)',
    '             Supports DEEPSEEK_API_KEY / OPENAI_API_KEY environment variables.',
    '',
    'Shortcuts inside TUI:',
    '  1-9, 0, n, b, t, a, , Switch pages        Ctrl+K / /  Command palette & search',
    '  [  ]                  Prev / next page    \\           Toggle sidebar',
    '  c                     Switch course       I           Notification inbox',
    '  ?                     Context help        Ctrl+R      Refresh snapshot',
  ].join('\n');
}
