/**
 * Single source of truth for StudyHub TUI global shortcuts (#1354 P2-a).
 *
 * Both the bottom `KeyHintBar` default/tail hints (`components/focus.ts`) and
 * `HelpOverlay`'s global shortcuts section (`shell/HelpOverlay.tsx`) derive
 * from `GLOBAL_KEYMAP_ENTRIES`, eliminating shortcut drift between footer and help.
 */
import type { KeyHint, UiLanguage } from '../types/contracts.js';

export interface GlobalKeymapEntry {
  id: string;
  /** Key display in HelpOverlay (Unicode terminals). */
  helpKey: string;
  /** Optional ASCII-safe key display in HelpOverlay. */
  helpKeyAscii?: string;
  /** Concise key token for the bottom KeyHintBar (defaults to `helpKey`). */
  footerKey?: string;
  footerZh?: string;
  footerEn?: string;
  helpZh: string;
  helpEn: string;
  /** Included in default shell footer when no page-specific hints are set. */
  inDefaultFooter?: boolean;
  /** Included in the right tail of the shell footer (`Ctrl+K`, `?`). */
  inFooterTail?: boolean;
}

export const GLOBAL_KEYMAP_ENTRIES: readonly GlobalKeymapEntry[] = Object.freeze([
  {
    id: 'command-palette',
    helpKey: 'Ctrl+K  /',
    footerKey: 'Ctrl+K',
    footerZh: '命令',
    footerEn: 'Cmd',
    helpZh: '命令面板 / 全文搜题与原文',
    helpEn: 'Command palette & search',
    inFooterTail: true,
  },
  {
    id: 'assistant-dock',
    helpKey: 'Ctrl+Space',
    helpZh: '停靠 AI 助手 / 带学 (Ctrl+G聚焦 c/C/y复制 F全屏)',
    helpEn: 'Dock AI Assistant (Ctrl+G focus, c/C/y copy, F full)',
  },
  {
    id: 'help',
    helpKey: '?',
    footerKey: '?',
    footerZh: '帮助',
    footerEn: 'Help',
    helpZh: '帮助',
    helpEn: 'Help',
    inFooterTail: true,
  },
  {
    id: 'course-picker',
    helpKey: 'c',
    footerKey: 'c',
    footerZh: '课程',
    footerEn: 'Course',
    helpZh: '切换课程',
    helpEn: 'Switch course',
    inDefaultFooter: true,
  },
  {
    id: 'inbox',
    helpKey: 'I',
    helpZh: '收件箱与通知',
    helpEn: 'Notification inbox',
  },
  {
    id: 'page-jump',
    helpKey: '1-9 0',
    footerKey: '1-9',
    footerZh: '页面',
    footerEn: 'Pages',
    helpZh: '跳转页面',
    helpEn: 'Jump to page',
    inDefaultFooter: true,
  },
  {
    id: 'page-cycle',
    helpKey: '[  ]',
    footerKey: '[ ]',
    footerZh: '切换',
    footerEn: 'Cycle',
    helpZh: '上/下一页面',
    helpEn: 'Prev / next page',
    inDefaultFooter: true,
  },
  {
    id: 'back',
    helpKey: '⌫',
    helpKeyAscii: 'Bksp',
    helpZh: '返回',
    helpEn: 'Back',
  },
  {
    id: 'sidebar',
    helpKey: '\\',
    helpZh: '折叠侧栏',
    helpEn: 'Toggle sidebar',
  },
  {
    id: 'refresh',
    helpKey: 'Ctrl+R',
    helpZh: '刷新',
    helpEn: 'Refresh',
  },
  {
    id: 'quit',
    helpKey: 'q',
    footerKey: 'q',
    footerZh: '退出',
    footerEn: 'Quit',
    helpZh: '退出',
    helpEn: 'Quit',
    inDefaultFooter: true,
  },
  {
    id: 'move',
    helpKey: 'j/k ↑↓',
    helpKeyAscii: 'j/k',
    helpZh: '列表 / 行移动',
    helpEn: 'Move up / down',
  },
  {
    id: 'half-page',
    helpKey: 'Ctrl+D/U',
    helpZh: '半页下/上翻',
    helpEn: 'Half-page scroll',
  },
  {
    id: 'full-page',
    helpKey: 'Ctrl+F/B',
    helpZh: '整页下/上翻',
    helpEn: 'Full-page scroll',
  },
  {
    id: 'top-bottom',
    helpKey: 'g/G',
    helpZh: '首尾跳转 (Home/End)',
    helpEn: 'Top / bottom (Home/End)',
  },
  {
    id: 'close',
    helpKey: 'Esc',
    footerKey: 'Esc',
    footerZh: '关闭',
    footerEn: 'Close',
    helpZh: '关闭 / 取消',
    helpEn: 'Close / cancel',
  },
  {
    id: 'submit',
    helpKey: 'Ctrl+S',
    helpZh: '提交 (Ctrl+J/Shift+Enter换行)',
    helpEn: 'Submit (Ctrl+J/Shift+Enter nl)',
  },
  {
    id: 'mouse',
    helpKey: 'Alt+点击',
    helpKeyAscii: 'Alt+Click',
    helpZh: 'Alt+点击 = 鼠标操作；普通点击保留终端选择 (--mouse-alt=0 放开普通点击)',
    helpEn: 'Alt+click = mouse action; plain click keeps terminal selection (--mouse-alt=0 allows plain)',
  },
]);

const DEFAULT_FOOTER_ORDER: readonly string[] = ['page-jump', 'course-picker', 'page-cycle', 'quit'];

/** Build default global footer hints from the single keymap table. */
export function buildDefaultFooterHints(lang: UiLanguage): KeyHint[] {
  const zh = lang === 'zh';
  const byId = new Map(GLOBAL_KEYMAP_ENTRIES.map((e) => [e.id, e]));
  const out: KeyHint[] = [];
  for (const id of DEFAULT_FOOTER_ORDER) {
    const e = byId.get(id);
    if (!e) continue;
    out.push({
      key: e.footerKey ?? e.helpKey,
      label: zh ? (e.footerZh ?? e.helpZh) : (e.footerEn ?? e.helpEn),
    });
  }
  return out;
}

/** Build persistent footer tail hints (`Ctrl+K`, `?`) from the single keymap table. */
export function buildFooterTailHints(lang: UiLanguage, compactAll: boolean): KeyHint[] {
  const zh = lang === 'zh';
  return GLOBAL_KEYMAP_ENTRIES.filter((e) => e.inFooterTail).map((e) => ({
    key: e.footerKey ?? e.helpKey,
    label:
      e.id === 'help' && compactAll
        ? zh
          ? '全部键'
          : 'All'
        : zh
          ? (e.footerZh ?? e.helpZh)
          : (e.footerEn ?? e.helpEn),
  }));
}

/** Build single Esc-close hint for captured overlays from the single keymap table. */
export function buildCloseFooterHint(lang: UiLanguage): KeyHint {
  const zh = lang === 'zh';
  const esc = GLOBAL_KEYMAP_ENTRIES.find((e) => e.id === 'close');
  return {
    key: esc?.footerKey ?? 'Esc',
    label: zh ? (esc?.footerZh ?? '关闭') : (esc?.footerEn ?? 'Close'),
  };
}

/** Build HelpOverlay's global shortcuts list from the single keymap table. */
export function buildGlobalHelpShortcuts(lang: UiLanguage, asciiMode = false): KeyHint[] {
  const zh = lang === 'zh';
  return GLOBAL_KEYMAP_ENTRIES.map((e) => {
    let key = asciiMode && e.helpKeyAscii ? e.helpKeyAscii : e.helpKey;
    if (e.id === 'mouse' && !asciiMode && !zh) key = 'Alt+Click';
    return {
      key,
      label: zh ? e.helpZh : e.helpEn,
    };
  });
}
