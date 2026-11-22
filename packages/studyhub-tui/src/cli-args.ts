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
  error?: string;
}

const VALID_THEMES = new Set<ThemeId>(['dsh-dark', 'warm-paper', 'nord', 'high-contrast']);
const VALID_PAGES = new Set<PageId>(PAGE_REGISTRY.map((p) => p.id));

export function shouldAutoAscii(env: Record<string, string | undefined> = process.env): boolean {
  const flag = String(env.STUDYHUB_TUI_ASCII ?? '').trim().toLowerCase();
  if (flag === '1' || flag === 'true' || flag === 'yes') return true;
  if (flag === '0' || flag === 'false' || flag === 'no') return false;
  const term = String(env.TERM ?? '').trim().toLowerCase();
  return term === 'dumb';
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
    '  -v, --version         Print version and exit',
    '  -h, --help            Show this help message',
    '',
    'Models:',
    '  Primary:   Local agy CLI (auto-detected on first run)',
    '  Secondary: OpenAI-compatible APIs (DeepSeek, OpenAI, SiliconFlow, Zhipu, OpenRouter, Custom)',
    '             Supports DEEPSEEK_API_KEY / OPENAI_API_KEY environment variables.',
    '',
    'Shortcuts inside TUI:',
    '  1-9, 0, n, b, t, a, , Switch pages        Ctrl+K / /  Command palette',
    '  c                     Switch course       ?           Context help',
    '  [                     Toggle sidebar      Ctrl+R      Refresh snapshot',
  ].join('\n');
}
