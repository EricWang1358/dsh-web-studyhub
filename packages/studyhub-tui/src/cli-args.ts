import type { PageId, StudySnapshot, ThemeId, UiLanguage } from './types/contracts.js';
import { PAGE_REGISTRY } from './types/contracts.js';
import { probeTerminalCompatMatrix, type TerminalCompatMatrix } from './render/terminal-compat.js';

export interface ParsedCliArgs {
  help: boolean;
  version: boolean;
  doctor: boolean;
  stats: boolean;
  due: boolean;
  board: boolean;
  exportBackup: boolean;
  exportPath?: string;
  searchQuery?: string;
  searchLimit?: number;
  course?: string;
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
  mouseAltClickOnly?: boolean;
  error?: string;
}

export interface ColorCapability {
  enabled: boolean;
  level: 0 | 1 | 2 | 3;
  reason: string;
}

const VALID_THEMES = new Set<ThemeId>(['dsh-dark', 'warm-paper', 'nord', 'high-contrast', 'warm-amber', 'soft-sage']);
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

/**
 * Alt-compatible mouse click mode (#1311).
 * Defaults to `true` (only Alt+click triggers TUI actions; plain clicks preserve terminal selection).
 * Set `STUDYHUB_TUI_MOUSE_ALT=0` (or `--mouse-alt=0`) to allow plain clicks as well.
 */
export function shouldRequireAltClick(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = String(env.STUDYHUB_TUI_MOUSE_ALT ?? '').trim().toLowerCase();
  if (flag === '0' || flag === 'false' || flag === 'no' || flag === 'off') return false;
  return true;
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
    stats: { value: false, writable: true, enumerable: false, configurable: true },
    due: { value: false, writable: true, enumerable: false, configurable: true },
    board: { value: false, writable: true, enumerable: false, configurable: true },
    exportBackup: { value: false, writable: true, enumerable: false, configurable: true },
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
    if (token === '--stats') {
      Object.defineProperty(result, 'stats', { value: true, writable: true, enumerable: true, configurable: true });
      continue;
    }
    if (token === '--due') {
      Object.defineProperty(result, 'due', { value: true, writable: true, enumerable: true, configurable: true });
      continue;
    }
    if (token === '--board') {
      Object.defineProperty(result, 'board', { value: true, writable: true, enumerable: true, configurable: true });
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

    if (flag === '--mouse-alt') {
      const val = takeValue();
      const norm = String(val ?? '').trim().toLowerCase();
      if (norm === '0' || norm === 'false' || norm === 'no' || norm === 'off') {
        result.mouseAltClickOnly = false;
        continue;
      }
      if (norm === '1' || norm === 'true' || norm === 'yes' || norm === 'on') {
        result.mouseAltClickOnly = true;
        continue;
      }
      result.error = `Invalid --mouse-alt "${val ?? ''}". Expected 0 or 1`;
      return result;
    }

    if (flag === '--export') {
      Object.defineProperty(result, 'exportBackup', { value: true, writable: true, enumerable: true, configurable: true });
      const val = takeValue();
      if (val !== undefined) {
        const trimmed = val.trim();
        if (trimmed) {
          result.exportPath = trimmed;
        } else if (eqIdx > 0) {
          result.error = 'Missing value for --export';
          return result;
        }
      }
      continue;
    }

    if (flag === '--search') {
      const val = takeValue();
      const trimmed = val?.trim() ?? '';
      if (!trimmed) {
        result.error = 'Missing value for --search';
        return result;
      }
      result.searchQuery = trimmed;
      continue;
    }

    if (flag === '--limit') {
      const val = takeValue();
      const trimmed = val?.trim() ?? '';
      const n = trimmed && /^\d+$/.test(trimmed) ? Number(trimmed) : NaN;
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        result.error = `Invalid --limit "${val ?? ''}". Expected an integer between 1 and 100`;
        return result;
      }
      result.searchLimit = n;
      continue;
    }

    if (flag === '--course') {
      const val = takeValue();
      const trimmed = val?.trim() ?? '';
      if (!trimmed) {
        result.error = 'Missing value for --course';
        return result;
      }
      result.course = trimmed;
      continue;
    }

    if (flag === '--root' || flag === '--library' || flag === '-r') {
      const val = takeValue();
      if (!val) {
        result.error = `Missing value for ${flag === '--library' ? '--library' : '--root'}`;
        return result;
      }
      result.libraryRoot = val;
      continue;
    }

    if (flag === '--theme') {
      const val = takeValue();
      if (!val || !VALID_THEMES.has(val as ThemeId)) {
        result.error = `Invalid --theme "${val ?? ''}". Valid: dsh-dark, warm-paper, nord, high-contrast, warm-amber, soft-sage`;
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
    '  -r, --root <path>     Open a specific StudyHub library directory (.dsh-study or folder; alias: --library)',
    '  -p, --page <id>       Start directly on a page (library, review, sources, generate, ...)',
    '      --theme <id>      Theme: dsh-dark | warm-paper | nord | high-contrast | warm-amber | soft-sage',
    '      --lang <zh|en>    UI language: zh (default) | en',
    '      --no-alt-screen   Render inline without switching to the alternate screen buffer',
    '      --no-launchpad    Skip the first-run Launchpad even on an empty library',
    '      --skip-probe      Skip background CLI model discovery on startup',
    '      --ascii           Use ASCII-safe borders/bars (for legacy Windows PowerShell 5.1)',
    '      --mouse           Enable SGR mouse support (or STUDYHUB_TUI_MOUSE=1; Alt+click = UI action, plain click keeps terminal selection; --no-mouse disables)',
    '      --mouse-alt=0     Allow plain left-click without Alt (or STUDYHUB_TUI_MOUSE_ALT=0; default 1 = Alt+click only)',
    '      --doctor          Print cross-platform terminal, path & provider diagnostics and exit',
    '      --doctor --json   Print diagnostics in JSON format and exit (never prints API keys)',
    '      --stats           Print offline library summary (courses, decks, due & weak) and exit',
    '      --stats --json    Print offline library summary in JSON format and exit',
    '      --due             Print today\'s due review queue by deck (offline) and exit',
    '      --due --json      Print today\'s due review queue in JSON format and exit',
    '      --board           Print Kanban board tasks & Pomodoro summary (offline) and exit',
    '      --board --json    Print Kanban board summary in JSON format and exit',
    '      --course <name>   Filter --due / --board output to matching course(s)',
    '      --export [path]   Export full library JSON backup atomically and exit',
    '      --export --json   Export backup and print JSON receipt',
    '      --search <query>  Search cards & source passages offline and exit',
    '      --search <query> --json   Print search results in JSON format and exit',
    '      --limit <n>       Limit --search / --due results (1..100, default 10 / 20)',
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
    compat: {
      mux: TerminalCompatMatrix['mux'];
      osc52Copy: boolean;
      osc8Hyperlink: boolean;
      osc2Title: boolean;
      osc9Notify: boolean;
      focusReporting: boolean;
    };
    availableThemes: readonly ThemeId[];
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
  const compatMatrix = probeTerminalCompatMatrix({ env, isTTY: isTty, asciiMode });

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
      compat: {
        mux: compatMatrix.mux,
        osc52Copy: compatMatrix.osc52Copy,
        osc8Hyperlink: compatMatrix.osc8Hyperlink,
        osc2Title: compatMatrix.osc2Title,
        osc9Notify: compatMatrix.osc9Notify,
        focusReporting: compatMatrix.focusReporting,
      },
      availableThemes: ['dsh-dark', 'warm-paper', 'nord', 'high-contrast', 'warm-amber', 'soft-sage'],
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
    `  ${bullet} Capabilities: mux=${t.compat.mux} OSC52=${t.compat.osc52Copy ? 'on' : 'off'} OSC8=${t.compat.osc8Hyperlink ? 'on' : 'off'} OSC2=${t.compat.osc2Title ? 'on' : 'off'} OSC9=${t.compat.osc9Notify ? 'on' : 'off'} DEC1004=${t.compat.focusReporting ? 'on' : 'off'}`,
    `  ${bullet} Themes: ${t.availableThemes.join(', ')}`,
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

export interface StatsSummaryCourse {
  name: string;
  decks: number;
  cards: number;
  due: number;
}

export interface StatsSummary {
  version: string;
  libraryRoot: string;
  generatedAt: string;
  counts: {
    courses: number;
    activeDecks: number;
    archivedDecks: number;
    cards: number;
    due: number;
    weak: number;
    sources: number;
    notes: number;
    drafts: number;
  };
  courses: StatsSummaryCourse[];
}

export interface BuildStatsSummaryOptions {
  libraryRoot: string;
  snapshot: StudySnapshot | null | undefined;
  version?: string;
  generatedAt?: string;
}

function toFiniteCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export function toPureAscii(text: string): string {
  return text
    .replace(/[·•]/g, '-')
    .replace(/[—–]/g, '-')
    .replace(/…/g, '...')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[^\x00-\x7f]/g, '?');
}

/**
 * Build a deterministic, offline library summary snapshot for `--stats` and `--stats --json`.
 */
export function buildStatsSummary(opts: BuildStatsSummaryOptions): StatsSummary {
  const snap = opts.snapshot ?? {};
  const decks = Array.isArray(snap.decks) ? snap.decks : [];
  const progress = (snap.progress && typeof snap.progress === 'object' ? snap.progress : {}) as Record<
    string,
    { total?: number; due?: number; counts?: { weak?: number } } | undefined
  >;

  let activeDecks = 0;
  let archivedDecks = 0;
  let cards = 0;
  let deckDueSum = 0;
  let deckWeakSum = 0;

  const courseMap = new Map<string, StatsSummaryCourse>();
  const ensureCourse = (name: string): StatsSummaryCourse => {
    const existing = courseMap.get(name);
    if (existing) return existing;
    const created: StatsSummaryCourse = { name, decks: 0, cards: 0, due: 0 };
    courseMap.set(name, created);
    return created;
  };

  for (const rawCourse of Array.isArray(snap.courses) ? snap.courses : []) {
    const name = String(rawCourse?.name ?? rawCourse?.title ?? rawCourse?.id ?? '').trim();
    if (name) ensureCourse(name);
  }

  for (const d of decks) {
    if (!d || typeof d !== 'object') continue;
    if (d.archived) {
      archivedDecks += 1;
      continue;
    }
    const rec = d as Record<string, unknown>;
    if (rec.systemKind) continue;
    activeDecks += 1;
    const p = d.id ? progress[d.id] : undefined;
    const deckCards = toFiniteCount(d.cardCount ?? rec.count ?? p?.total);
    const deckDue = toFiniteCount(p?.due ?? rec.due ?? d.dueCount);
    const deckWeak = toFiniteCount(rec.wrong ?? d.wrongCount ?? p?.counts?.weak);
    cards += deckCards;
    deckDueSum += deckDue;
    deckWeakSum += deckWeak;

    const courseName = String(d.course ?? '').trim();
    if (courseName) {
      const entry = ensureCourse(courseName);
      entry.decks += 1;
      entry.cards += deckCards;
      entry.due += deckDue;
    }
  }

  for (const rawCourse of Array.isArray(snap.courses) ? snap.courses : []) {
    const name = String(rawCourse?.name ?? rawCourse?.title ?? rawCourse?.id ?? '').trim();
    if (!name) continue;
    const entry = courseMap.get(name);
    if (entry && entry.decks === 0 && entry.cards === 0) {
      const rec = rawCourse as Record<string, unknown>;
      entry.decks = toFiniteCount(rawCourse.deckCount ?? rec.decks);
      entry.cards = toFiniteCount(rawCourse.cardCount);
      entry.due = toFiniteCount(rawCourse.dueCount);
    }
  }

  const today = snap.today && typeof snap.today === 'object' ? (snap.today as Record<string, unknown>) : null;
  const due = deckDueSum > 0 ? deckDueSum : toFiniteCount(today?.due);
  const weak = deckWeakSum > 0 ? deckWeakSum : toFiniteCount(today?.weak);

  const courses = [...courseMap.values()]
    .sort((a, b) => b.due - a.due || b.cards - a.cards || b.decks - a.decks || a.name.localeCompare(b.name))
    .slice(0, 8);

  return {
    version: opts.version ?? '1.0.0',
    libraryRoot: opts.libraryRoot,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    counts: {
      courses: courseMap.size,
      activeDecks,
      archivedDecks,
      cards,
      due,
      weak,
      sources: Array.isArray(snap.sources) ? snap.sources.length : 0,
      notes: Array.isArray(snap.notes) ? snap.notes.length : 0,
      drafts: Array.isArray(snap.drafts) ? snap.drafts.length : 0,
    },
    courses,
  };
}

/**
 * Format a `StatsSummary` for terminal output. Guaranteed 100% pure ASCII when `asciiMode` is true.
 */
export function formatStatsSummary(summary: StatsSummary, asciiMode = false): string {
  const rule = asciiMode ? '----------------------------------------' : '────────────────────────────────────────';
  const bullet = asciiMode ? '-' : '•';
  const c = summary.counts;
  const clean = (s: string) => (asciiMode ? toPureAscii(s) : s);

  const lines = [
    `StudyHub TUI Stats (v${clean(summary.version)})`,
    rule,
    `Library: ${clean(summary.libraryRoot || '(unset)')}`,
    `Generated: ${clean(summary.generatedAt)}`,
    'Overview',
    `  ${bullet} Courses: ${c.courses} | Decks: ${c.activeDecks} active (${c.archivedDecks} archived)`,
    `  ${bullet} Cards: ${c.cards} total | Due: ${c.due} | Weak: ${c.weak}`,
    `  ${bullet} Materials: ${c.sources} sources | ${c.notes} notes | ${c.drafts} drafts`,
  ];

  if (summary.courses.length > 0) {
    lines.push(`Top Courses (${summary.courses.length})`);
    for (const course of summary.courses) {
      lines.push(`  ${bullet} ${clean(course.name)}: ${course.decks} decks, ${course.cards} cards, ${course.due} due`);
    }
  } else {
    lines.push('Top Courses (0)');
    lines.push(`  ${bullet} (none)`);
  }

  return lines.join('\n');
}
