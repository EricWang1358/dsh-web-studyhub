/**
 * Single source of truth for TUI toast & notification history copy (#1354 D6).
 *
 * Shared by `NotificationHistoryModal`, `InboxModal` (`toasts` tab), and
 * `global-keymap.ts` so tone labels, empty states, clear feedback, timestamps,
 * clipboard payloads, and the `MAX_TOAST_HISTORY` cap never drift apart.
 */
import type { ToastItem, UiLanguage } from '../types/contracts.js';
import { MAX_TOAST_HISTORY } from '../state/store.js';

export type ToastTone = ToastItem['tone'];

export const TOAST_TONE_BADGES: Readonly<Record<ToastTone, string>> = Object.freeze({
  info: 'info',
  success: 'success',
  warning: 'warn',
  error: 'error',
});

/** Compact ASCII severity tag shown in list rows and clipboard headers. */
export function toastToneBadge(tone: ToastTone): string {
  return TOAST_TONE_BADGES[tone];
}

/** Learner-facing localized severity label shown in inbox badges and summaries. */
export function toastToneLabel(tone: ToastTone, lang: UiLanguage): string {
  const en = lang === 'en';
  switch (tone) {
    case 'error':
      return en ? 'Error' : '错误提示';
    case 'warning':
      return en ? 'Warn' : '警告提示';
    case 'success':
      return en ? 'Done' : '完成提示';
    default:
      return en ? 'Info' : '状态提示';
  }
}

/** Inbox entry kind used to color toast history items via `inboxItemTone`. */
export function toastToneInboxKind(tone: ToastTone): string {
  switch (tone) {
    case 'error':
      return 'toast-failed';
    case 'warning':
      return 'toast-warning';
    case 'success':
      return 'toast-result';
    default:
      return 'coach';
  }
}

/** Format a toast timestamp as `HH:MM:SS` (same day) or `MM-DD HH:MM` (earlier day). */
export function formatToastClock(createdAt: number, now: Date = new Date()): string {
  const date = new Date(createdAt);
  if (!Number.isFinite(date.getTime())) return '';
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return `${hh}:${mm}:${ss}`;
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  return `${mo}-${dd} ${hh}:${mm}`;
}

/** First normalized single line of a toast for compact list rows. */
export function toastFirstLine(text: string): string {
  const line = (text ?? '').split('\n')[0] ?? '';
  return line.replace(/\s+/g, ' ').trim();
}

/** Explicit newline count (minimum 1) matching what users call a multi-line notice. */
export function toastLogicalLineCount(text: string): number {
  return Math.max(1, (text ?? '').split('\n').length);
}

/** Full multi-line clipboard export format shared by notification history copy actions. */
export function formatToastClipboardPayload(
  item: Pick<ToastItem, 'createdAt' | 'tone' | 'source' | 'text'>,
  _lang?: UiLanguage,
  now?: Date,
): string {
  const clock = formatToastClock(item.createdAt, now);
  const badge = toastToneBadge(item.tone);
  const src = item.source ? ` [${item.source}]` : '';
  return `[${clock}] [${badge}]${src}\n${item.text}`;
}

export interface ToastHistoryCopy {
  title: string;
  tabLabel: string;
  footerHintLabel: string;
  emptyTitle: string;
  emptyHint: string;
  clearedStatus: string;
  noCopySelection: string;
  copyFailed: string;
  selectToRead: string;
  idleStatus: string;
  emptyMessageFallback: string;
  helpSummary: string;
}

/** Canonical bilingual copy bundle for both `NotificationHistoryModal` and `InboxModal` (`toasts` tab). */
export function toastHistoryCopy(lang: UiLanguage, maxHistory: number = MAX_TOAST_HISTORY): ToastHistoryCopy {
  const en = lang === 'en';
  return {
    title: en ? 'Notification History' : '通知历史',
    tabLabel: en ? 'History' : '近期提示',
    footerHintLabel: en ? 'History' : '近期提示',
    emptyTitle: en ? 'No notifications yet' : '暂无通知记录',
    emptyHint: en
      ? `Recent toasts are kept here (last ${maxHistory})`
      : `提示消息会自动留存在这里，最多保留最近 ${maxHistory} 条`,
    clearedStatus: en ? 'History cleared' : '已清空通知历史',
    noCopySelection: en ? 'No notification to copy' : '暂无可复制的通知',
    copyFailed: en ? 'Copy failed' : '复制失败',
    selectToRead: en ? 'Select a notification to read it' : '选一条通知查看全文',
    idleStatus: en
      ? 'Newest first; opening this panel never clears history'
      : '提示消息按时间倒序排列，打开面板不会清空历史',
    emptyMessageFallback: en ? '(empty)' : '(空消息)',
    helpSummary: en
      ? `Notification history (last ${maxHistory}, copy/clear)`
      : `通知历史（最近 ${maxHistory} 条，可复制/清空）`,
  };
}

/** Dynamic retained count subtitle (`最近 N 条` / `N recent`). */
export function formatToastHistorySubtitle(count: number, lang: UiLanguage): string {
  return lang === 'en' ? `${count} recent` : `最近 ${count} 条`;
}
