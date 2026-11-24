import { useEffect, useSyncExternalStore } from 'react';
import type { KeyHint } from '../types/contracts.js';
import { useTuiStore } from '../state/store.js';

/**
 * Reserved global shortcuts that no primary view or sub-view may claim or shadow.
 * - `r`: Return to active review / resume practice
 * - `q`: Global quit (guarded by Quit ConfirmDialog when a session is active)
 * - `?`: Global Help overlay
 */
export const RESERVED_GLOBAL_KEYS: readonly string[] = Object.freeze(['r', 'q', '?']);
export const RESERVED_GLOBAL_KEY_SET: ReadonlySet<string> = new Set(RESERVED_GLOBAL_KEYS);

/**
 * Ref-counted global input capture.
 *
 * Any focused text field / modal calls `useInputCapture(true)`; while at least one
 * capture is held, `store.inputCaptured === true` and AppShell suppresses every
 * global single-key shortcut (digits, letters, `?`, `/`, `q` …).
 */
let captureCount = 0;

export function acquireInputCapture(): () => void {
  captureCount += 1;
  if (!useTuiStore.getState().inputCaptured) useTuiStore.getState().setInputCaptured(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    captureCount = Math.max(0, captureCount - 1);
    if (captureCount === 0 && useTuiStore.getState().inputCaptured) {
      useTuiStore.getState().setInputCaptured(false);
    }
  };
}

export function useInputCapture(active: boolean): void {
  useEffect(() => {
    if (!active) return undefined;
    return acquireInputCapture();
  }, [active]);
}

/**
 * Key claims: a view/component that legitimately uses a key AppShell treats as a
 * global shortcut (e.g. `n` = "new" in a list, digits in a SelectList) claims it
 * while active, and AppShell then leaves that key to the view.
 */
const claimed = new Map<string, number>();
let claimedSnapshot: ReadonlySet<string> = new Set<string>();
const claimListeners = new Set<() => void>();

function notifyClaimListeners(): void {
  claimedSnapshot = new Set<string>(claimed.keys());
  for (const listener of claimListeners) listener();
}

function subscribeClaimedKeys(listener: () => void): () => void {
  claimListeners.add(listener);
  return () => {
    claimListeners.delete(listener);
  };
}

export function getClaimedKeysSnapshot(): ReadonlySet<string> {
  return claimedSnapshot;
}

export function useClaimedKeys(): ReadonlySet<string> {
  return useSyncExternalStore(subscribeClaimedKeys, getClaimedKeysSnapshot, getClaimedKeysSnapshot);
}

export function claimKeys(keys: readonly string[]): () => void {
  let changed = false;
  for (const k of keys) {
    const prev = claimed.get(k) ?? 0;
    claimed.set(k, prev + 1);
    if (prev === 0) changed = true;
  }
  if (changed) notifyClaimListeners();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    let releaseChanged = false;
    for (const k of keys) {
      const n = (claimed.get(k) ?? 0) - 1;
      if (n <= 0) {
        if (claimed.delete(k)) releaseChanged = true;
      } else {
        claimed.set(k, n);
      }
    }
    if (releaseChanged) notifyClaimListeners();
  };
}

export function isKeyClaimed(key: string): boolean {
  return (claimed.get(key) ?? 0) > 0;
}

export function useClaimKeys(keys: readonly string[], active: boolean): void {
  const sig = keys.join('\u0000');
  useEffect(() => {
    if (!active || keys.length === 0) return undefined;
    return claimKeys(keys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sig]);
}

export const DIGIT_KEYS: readonly string[] = Object.freeze(['1', '2', '3', '4', '5', '6', '7', '8', '9']);

/**
 * Stack of active modal footer key hints (#1352 / #1354 D4).
 * When a modal is open, the shell's bottom KeyHintBar renders the top-most active
 * modal's own keys instead of falling back to global page-jump shortcuts.
 */
interface ModalHintEntry {
  id: number;
  hints: readonly KeyHint[];
}
let nextModalHintId = 1;
const modalHintStack: ModalHintEntry[] = [];
let modalHintsSnapshot: readonly KeyHint[] | null = null;
const modalHintListeners = new Set<() => void>();

function notifyModalHintListeners(): void {
  const top = modalHintStack.length > 0 ? modalHintStack[modalHintStack.length - 1].hints : null;
  modalHintsSnapshot = top;
  for (const listener of modalHintListeners) listener();
}

function subscribeModalHints(listener: () => void): () => void {
  modalHintListeners.add(listener);
  return () => {
    modalHintListeners.delete(listener);
  };
}

export function getModalHintsSnapshot(): readonly KeyHint[] | null {
  return modalHintsSnapshot;
}

export function useModalHints(): readonly KeyHint[] | null {
  return useSyncExternalStore(subscribeModalHints, getModalHintsSnapshot, getModalHintsSnapshot);
}

export function useModalFooterHints(hints: readonly KeyHint[] | undefined, active: boolean): void {
  const sig = hints && hints.length > 0 ? hints.map((h) => `${h.key}\u0001${h.label}`).join('\u0000') : '';
  useEffect(() => {
    if (!active || !hints || hints.length === 0) return undefined;
    const id = nextModalHintId++;
    modalHintStack.push({ id, hints });
    notifyModalHintListeners();
    return () => {
      const idx = modalHintStack.findIndex((e) => e.id === id);
      if (idx >= 0) {
        modalHintStack.splice(idx, 1);
        notifyModalHintListeners();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sig]);
}
