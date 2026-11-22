import type { PageId, ThemeId, UiLanguage } from './types/contracts.js';
import { PAGE_REGISTRY } from './types/contracts.js';

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  doctor: boolean;
  json: boolean;
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

function resolveAsciiState(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  explicitAscii?: boolean,
): { asciiMode: boolean; asciiReason: string } {
  if (explicitAscii === true) return { asciiMode: true, asciiReason: '--ascii' };
  if (explicitAscii === false) return { asciiMode: false, asciiReason: '--unicode' };

  const flag = String(env.STUDYHUB_TUI_ASCII ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') {
    return { asciiMode: true, asciiReason: 'STUDYHUB_TUI_ASCII' };
  }
  if (flag === '0' || flag === 'false' || flag === 'no') {
    return { asciiMode: false, asciiReason: 'STUDYHUB_TUI_ASCII=0' };
  }

  const term = String(env.TERM ?? '').trim().toLowerCase();
  if (term === 'dumb') return { asciiMode: true, asciiReason: 'TERM=dumb' };

  if (platform === 'win32') {
    if (env.WT_SESSION) return { asciiMode: false, asciiReason: 'WT_SESSION' };
    if (env.TERM_PROGRAM) return { asciiMode: false, asciiReason: 'TERM_PROGRAM' };
    if (String(env.ConEmuANSI ?? '').trim().toUpperCase() === 'ON') {
      return { asciiMode: false, asciiReason: 'ConEmuANSI' };
    }
    if (env.ANSICON) return { asciiMode: false, asciiReason: 'ANSICON' };
    if (env.MSYSTEM) return { asciiMode: false, asciiReason: 'MSYSTEM' };
    if (term.includes('xterm') || term.includes('vt100')) {
      return { asciiMode: false, asciiReason: 'TERM' };
    }
    return { asciiMode: true, asciiReason: 'win32-conhost' };
  }

  return { asciiMode: false, asciiReason: 'utf8-default' };
}

export function shouldAutoAscii(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return resolveAsciiState(env, platform).asciiMode;
}

export function shouldEnableMouse(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.STUDYHUB_TUI_MOUSE ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes' || flag === 'on') return true;
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false;
  return false;
}

export function parseCliArgs(argv: readonly string[]): ParsedCliArgs {
  const result = {
    help: false,
    version: false,
    altScreen: true,
    autoLaunchpad: true,
    skipAutoProbe: false,
  } as ParsedCliArgs;
  // Keep default false values non-enumerable until explicitly passed so existing empty-argv equality checks stay intact.
  Object.defineProperties(result, {
    doctor: { value: false, writable: true, enumerable: false, configurable: true },
    json: { value: false, writable: true, enumerable: false, configurable: true },
  });

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
    if (token === '--doctor') {
      Object.defineProperty(result, 'doctor', { value: true, writable: true, enumerable: true, configurable: true });
      continue;
    }
    if (token === '--json') {
      Object.defineProperty(result, 'json', { value: true, writable: true, enumerable: true, configurable: true });
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
    '      --doctor          Print cross-platform terminal, path & provider diagnostics and exit',
    '      --doctor --json   Print diagnostics in JSON format and exit (never prints API keys)',
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

export interface DoctorReportOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  isTty?: boolean;
  stdoutCols?: number | null;
  stdoutRows?: number | null;
  version?: string;
  args?: Partial<ParsedCliArgs>;
  dshHome?: string;
  tuiPrefsPath?: string;
  tuiPrefsExists?: boolean;
  desktopRoot?: string | null;
  agyPath?: string | null;
}

export interface DoctorReport {
  version: string;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  terminal: {
    isTty: boolean;
    cols: number | null;
    rows: number | null;
    term: string | null;
    colorTerm: string | null;
    termProgram: string | null;
    wtSession: boolean;
    colorLevel: 0 | 1 | 2 | 3;
    colorLabel: string;
    asciiMode: boolean;
    asciiReason: string;
    mouseEnabled: boolean;
  };
  paths: {
    dshHome: string;
    tuiPrefsPath: string;
    tuiPrefsExists: boolean;
    desktopRoot: string | null;
  };
  providers: {
    agyInPath: boolean;
    agyPath: string | null;
    envKeysPresent: string[];
  };
}

const KNOWN_PROVIDER_ENV_KEYS = [
  'DEEPSEEK_API_KEY',
  'OPENAI_API_KEY',
  'SILICONFLOW_API_KEY',
  'ZHIPU_API_KEY',
  'ZHIPUAI_API_KEY',
  'GLM_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'MOONSHOT_API_KEY',
  'KIMI_API_KEY',
] as const;

const COLOR_LABELS: Record<0 | 1 | 2 | 3, string> = {
  0: 'none',
  1: '16-color',
  2: '256-color',
  3: 'truecolor',
};

const envStringOrNull = (env: NodeJS.ProcessEnv, key: string): string | null => {
  const val = typeof env[key] === 'string' ? env[key].trim() : '';
  return val || null;
};

/**
 * Build a pure, secret-free diagnostic snapshot for `--doctor` and `--doctor --json`.
 * Never reads or embeds API key values; only records which recognized env var names are set.
 */
export function buildDoctorReport(opts: DoctorReportOptions = {}): DoctorReport {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const isTty = opts.isTty ?? Boolean(process.stdout?.isTTY);
  const cols =
    opts.stdoutCols !== undefined
      ? opts.stdoutCols
      : opts.isTty === false
        ? null
        : typeof process.stdout?.columns === 'number'
          ? process.stdout.columns
          : null;
  const rows =
    opts.stdoutRows !== undefined
      ? opts.stdoutRows
      : opts.isTty === false
        ? null
        : typeof process.stdout?.rows === 'number'
          ? process.stdout.rows
          : null;

  const colorCap = resolveColorCapability(env, { isTTY: isTty, platform });
  const { asciiMode, asciiReason } = resolveAsciiState(env, platform, opts.args?.asciiMode);
  const mouseEnabled = opts.args?.mouse ?? shouldEnableMouse(env);

  const agyPath = opts.agyPath && opts.agyPath.trim() ? opts.agyPath.trim() : null;
  const envKeysPresent: string[] = [];
  for (const key of KNOWN_PROVIDER_ENV_KEYS) {
    if (typeof env[key] === 'string' && env[key].trim().length > 0) {
      envKeysPresent.push(key);
    }
  }

  return {
    version: opts.version ?? '1.0.0',
    nodeVersion: opts.nodeVersion ?? process.version,
    platform,
    arch: opts.arch ?? process.arch,
    terminal: {
      isTty,
      cols,
      rows,
      term: envStringOrNull(env, 'TERM'),
      colorTerm: envStringOrNull(env, 'COLORTERM'),
      termProgram: envStringOrNull(env, 'TERM_PROGRAM'),
      wtSession: Boolean(envStringOrNull(env, 'WT_SESSION')),
      colorLevel: colorCap.level,
      colorLabel: COLOR_LABELS[colorCap.level],
      asciiMode,
      asciiReason,
      mouseEnabled,
    },
    paths: {
      dshHome: opts.dshHome ?? '',
      tuiPrefsPath: opts.tuiPrefsPath ?? '',
      tuiPrefsExists: Boolean(opts.tuiPrefsExists),
      desktopRoot: opts.desktopRoot ?? null,
    },
    providers: {
      agyInPath: Boolean(agyPath),
      agyPath,
      envKeysPresent,
    },
  };
}

/**
 * Format a `DoctorReport` for terminal output. Guaranteed 100% pure ASCII when `asciiMode` is true.
 */
export function formatDoctorReport(report: DoctorReport, asciiMode = report.terminal.asciiMode): string {
  const rule = asciiMode ? '----------------------------------------' : '────────────────────────────────────────';
  const okMark = asciiMode ? '[ok]' : '✓';
  const missMark = asciiMode ? '[--]' : '✗';
  const bullet = asciiMode ? '-' : '•';
  const t = report.terminal;
  const p = report.paths;
  const pr = report.providers;
  const sizeStr = t.cols !== null && t.rows !== null ? `${t.cols}x${t.rows}` : 'unknown';

  return [
    `StudyHub TUI Doctor (v${report.version})`,
    rule,
    `Runtime`,
    `  ${bullet} Node: ${report.nodeVersion}`,
    `  ${bullet} Platform: ${report.platform} (${report.arch})`,
    `Terminal`,
    `  ${bullet} TTY: ${t.isTty ? 'yes' : 'no'} | Size: ${sizeStr}`,
    `  ${bullet} Color: level ${t.colorLevel} (${t.colorLabel})`,
    `  ${bullet} Charset: ${t.asciiMode ? 'ASCII' : 'Unicode'} (${t.asciiReason})`,
    `  ${bullet} Mouse (SGR 1006): ${t.mouseEnabled ? 'enabled' : 'disabled'}`,
    `  ${bullet} Env: TERM=${t.term ?? '(unset)'} COLORTERM=${t.colorTerm ?? '(unset)'} TERM_PROGRAM=${t.termProgram ?? '(unset)'} WT_SESSION=${t.wtSession ? 'yes' : 'no'}`,
    `Paths`,
    `  ${bullet} DSH_HOME: ${p.dshHome || '(unset)'}`,
    `  ${bullet} tui.json: ${p.tuiPrefsExists ? okMark : missMark} ${p.tuiPrefsPath || '(unset)'} (${p.tuiPrefsExists ? 'found' : 'missing'})`,
    `  ${bullet} Desktop root: ${p.desktopRoot ? `${okMark} ${p.desktopRoot}` : `${missMark} not found`}`,
    `Providers`,
    `  ${bullet} agy CLI: ${pr.agyInPath ? `${okMark} ${pr.agyPath}` : `${missMark} not found in PATH`}`,
    `  ${bullet} API env keys: ${pr.envKeysPresent.length > 0 ? pr.envKeysPresent.join(', ') : 'none'}`,
  ].join('\n');
}
