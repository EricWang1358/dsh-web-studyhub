/**
 * Single-source Global & Modifier Shortcut Router (#1354 P1 / D1).
 *
 * Pure TypeScript (zero React, Ink, or Node I/O imports) centralizing:
 *  1. `AppShell` global single-key & page-navigation routing (`resolveGlobalKeyRoute`).
 *  2. `AppShell` system Ctrl-chord routing (`resolveSystemKeyRoute`).
 *  3. Centralized `Alt+*` (`key.meta`) containment (`resolveAltChordRoute`):
 *     allows `<TextInput>`'s editing chords (`Alt+Enter`, `Alt+←/→`, `Alt+Backspace/Delete`)
 *     to pass through while intercepting and consuming unhandled `Alt+s`, `Alt+x`, `Alt+q`, etc.
 *     so they can NEVER leak into single-letter view or modal handlers.
 *  4. Reusable `isPlainKey(input, key)` modifier predicate for `useKeyScope` handlers.
 */
import type { Key } from 'ink';
import { PAGE_REGISTRY, type PageId } from '../types/contracts.js';
import { RESERVED_GLOBAL_KEY_SET } from '../components/focus.js';

/** Page cycle order for `[` / `]`. */
export const GLOBAL_NAV_ORDER: readonly PageId[] = Object.freeze(
  PAGE_REGISTRY.filter((p) => p.group !== null).map((p) => p.id),
);

/** Single-character page jump map derived from `PAGE_REGISTRY`. */
export const GLOBAL_PAGE_SHORTCUTS: ReadonlyMap<string, PageId> = new Map<string, PageId>(
  PAGE_REGISTRY.map((p) => [p.shortcut, p.id]),
);

export type GlobalSingleKeyAction =
  | 'palette-open'
  | 'help-open'
  | 'course-picker-open'
  | 'inbox-open'
  | 'quit-request'
  | 'toggle-sidebar'
  | 'page-prev'
  | 'page-next';

/** Canonical single-character non-page global shortcuts owned by `AppShell:global`. */
export const GLOBAL_SINGLE_KEY_ROUTES: Readonly<Record<string, GlobalSingleKeyAction>> = Object.freeze({
  '/': 'palette-open',
  '?': 'help-open',
  c: 'course-picker-open',
  I: 'inbox-open',
  q: 'quit-request',
  '\\': 'toggle-sidebar',
  '[': 'page-prev',
  ']': 'page-next',
});

/** Launchpad home reserves `s` (sample), `i` (import), and `m` (model settings). */
const LAUNCHPAD_RESERVED_KEYS: ReadonlySet<string> = new Set(['s', 'i', 'm']);

export type GlobalRouteResolution =
  | { action: 'fold-passive-assistant' }
  | { action: 'go-back' }
  | { action: GlobalSingleKeyAction }
  | { action: 'navigate-review' }
  | { action: 'navigate-page'; page: PageId };

export interface GlobalKeyRouteContext {
  overlayOpen: boolean;
  inputCaptured: boolean;
  showLaunchpad: boolean;
  page: PageId;
  passiveAssistantOpen: boolean;
  isKeyClaimed: (key: string) => boolean;
}

export type SystemKeyAction =
  | 'quit-force'
  | 'quit-request'
  | 'palette-close'
  | 'palette-open'
  | 'assistant-open-passive'
  | 'assistant-focus'
  | 'assistant-close'
  | 'assistant-open-focus'
  | 'notification-history-open'
  | 'refresh';

export interface SystemKeyRouteResolution {
  action: SystemKeyAction;
  /** True when `AppShell:system` should consume the keystroke; false to allow views to also react (e.g. `Ctrl+R`). */
  consume: boolean;
}

export interface SystemKeyRouteContext {
  blockedByScope: boolean;
  tooSmall: boolean;
  quitConfirmOpen: boolean;
  commandPaletteOpen: boolean;
  assistantOpen: boolean;
  assistantFocused: boolean;
  assistantFullscreen: boolean;
}

export type AltChordResolution =
  | { kind: 'pass' }
  | { kind: 'consume-unhandled-alt'; chord: string };

/** True iff the keystroke is a plain non-Ctrl, non-Meta printable key. */
export function isPlainKey(input: string, key: Key): boolean {
  return Boolean(input) && !key.ctrl && !key.meta;
}

/** True iff the keystroke is an `Alt+*` editing chord legitimately owned by `<TextInput>`. */
export function isTextInputAltEditingKey(key: Key): boolean {
  return Boolean(
    key.meta && (key.return || key.leftArrow || key.rightArrow || key.backspace || key.delete),
  );
}

/**
 * Centralized `Alt+*` (`key.meta`) router/containment guard:
 * - Passes through non-Meta keys and `<TextInput>` editing chords (`Alt+Enter`, `Alt+←/→`, `Alt+Backspace/Delete`).
 * - Consumes unhandled `Alt+<key>` chords (`Alt+s`, `Alt+x`, `Alt+q`, `Alt+1`, etc.) so they never
 *   leak into single-letter view/modal/global handlers anywhere in the app.
 */
export function resolveAltChordRoute(input: string, key: Key): AltChordResolution {
  if (!key.meta) return { kind: 'pass' };
  if (isTextInputAltEditingKey(key)) return { kind: 'pass' };
  const label = input ? `Alt+${input}` : 'Alt';
  return { kind: 'consume-unhandled-alt', chord: label };
}

/** Resolve a system-layer shortcut (`Ctrl+C`, `Ctrl+K`, `Ctrl+Space`, `Ctrl+G`, `Ctrl+O`, `Ctrl+R`). */
export function resolveSystemKeyRoute(
  input: string,
  key: Key,
  ctx: SystemKeyRouteContext,
): SystemKeyRouteResolution | null {
  if (key.meta) return null;

  if (key.ctrl && input === 'c') {
    return { action: ctx.quitConfirmOpen ? 'quit-force' : 'quit-request', consume: true };
  }
  if (key.ctrl && input === 'k') {
    if (ctx.commandPaletteOpen) return { action: 'palette-close', consume: true };
    if (!ctx.blockedByScope) return { action: 'palette-open', consume: true };
    return null;
  }
  const isCtrlSpace = input === '\u0000' || (key.ctrl && (input === ' ' || input === '@'));
  if (isCtrlSpace) {
    if (!ctx.assistantOpen) {
      if (!ctx.blockedByScope) return { action: 'assistant-open-passive', consume: true };
      return null;
    }
    if (ctx.tooSmall) return null;
    if (!ctx.assistantFocused && !ctx.assistantFullscreen) {
      return { action: 'assistant-focus', consume: true };
    }
    return { action: 'assistant-close', consume: true };
  }
  if (key.ctrl && input === 'g') {
    if (ctx.assistantOpen && (ctx.assistantFocused || ctx.assistantFullscreen)) {
      return { action: 'assistant-close', consume: true };
    }
    if (!ctx.blockedByScope) return { action: 'assistant-open-focus', consume: true };
    return null;
  }
  if (key.ctrl && input === 'o') {
    if (!ctx.blockedByScope) return { action: 'notification-history-open', consume: true };
    return null;
  }
  if (key.ctrl && input === 'r') {
    return { action: 'refresh', consume: false };
  }
  return null;
}

/** Resolve a global-layer shortcut (`AppShell:global`) from the single centralized routing table. */
export function resolveGlobalKeyRoute(
  input: string,
  key: Key,
  ctx: GlobalKeyRouteContext,
): GlobalRouteResolution | null {
  if (ctx.overlayOpen || ctx.inputCaptured) return null;
  if (key.ctrl || key.meta) return null;

  if (key.escape) {
    return ctx.passiveAssistantOpen ? { action: 'fold-passive-assistant' } : null;
  }

  if (input && !RESERVED_GLOBAL_KEY_SET.has(input) && ctx.isKeyClaimed(input)) {
    return null;
  }

  if (key.backspace) {
    return ctx.isKeyClaimed('backspace') ? null : { action: 'go-back' };
  }

  if (input && Object.prototype.hasOwnProperty.call(GLOBAL_SINGLE_KEY_ROUTES, input)) {
    return { action: GLOBAL_SINGLE_KEY_ROUTES[input] };
  }

  if (ctx.showLaunchpad && LAUNCHPAD_RESERVED_KEYS.has(input)) {
    return null;
  }

  const target = GLOBAL_PAGE_SHORTCUTS.get(input);
  if (target) {
    return target === 'review' ? { action: 'navigate-review' } : { action: 'navigate-page', page: target };
  }

  return null;
}

/** Compute next/previous page in `GLOBAL_NAV_ORDER` for `[` / `]`. */
export function resolveCycledPage(current: PageId, dir: 1 | -1): PageId {
  const idx = GLOBAL_NAV_ORDER.indexOf(current);
  return GLOBAL_NAV_ORDER[(Math.max(0, idx) + dir + GLOBAL_NAV_ORDER.length) % GLOBAL_NAV_ORDER.length];
}

/**
 * The only shortcut decisions `AppShell` makes: it builds the routing context, asks this router,
 * and executes the returned action. It holds no shortcut table or chord check of its own, so a
 * stub router passed to `AppShell` (`keyRouter` prop) silences every global, system and Alt chord.
 */
export interface ShellKeyRouter {
  resolveSystem: typeof resolveSystemKeyRoute;
  resolveAltChord: typeof resolveAltChordRoute;
  resolveGlobal: typeof resolveGlobalKeyRoute;
}

export const SHELL_KEY_ROUTER: ShellKeyRouter = Object.freeze({
  resolveSystem: resolveSystemKeyRoute,
  resolveAltChord: resolveAltChordRoute,
  resolveGlobal: resolveGlobalKeyRoute,
});
