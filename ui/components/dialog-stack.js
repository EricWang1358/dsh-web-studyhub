import { useSyncExternalStore } from 'react';

/* Open dialogs, oldest first. A modal <dialog> makes everything outside it
   inert, so feedback raised while one is open is shown inside the topmost one
   (see ToastRegion / DialogToasts). Entries are opaque objects owned by Dialog. */
const stack = [];
const listeners = new Set();
const emit = () => listeners.forEach(listener => listener());

export function pushDialog(entry) {
  stack.push(entry);
  emit();
  return () => {
    const index = stack.lastIndexOf(entry);
    if (index < 0) return;
    stack.splice(index, 1);
    emit();
  };
}

export const topDialog = () => stack.at(-1) ?? null;

export function subscribeDialogs(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const useTopDialog = () => useSyncExternalStore(subscribeDialogs, topDialog, () => null);

/* Toast channels: a ToastRegion that is covered by an open dialog publishes
   its toasts here and the topmost Dialog renders them in its toast slot. */
const channels = new Map();
const channelListeners = new Set();
let channelSnapshot = [];
const emitChannels = () => {
  channelSnapshot = [...channels].map(([id, entry]) => ({ id, ...entry }));
  channelListeners.forEach(listener => listener());
};

export function publishToasts(id, entry) {
  channels.set(id, entry);
  emitChannels();
}

export function retractToasts(id) {
  if (channels.delete(id)) emitChannels();
}

export const toastChannels = () => channelSnapshot;

export function subscribeToastChannels(listener) {
  channelListeners.add(listener);
  return () => channelListeners.delete(listener);
}

const NONE = [];
export const useToastChannels = () => useSyncExternalStore(subscribeToastChannels, toastChannels, () => NONE);

const OPEN_DIALOG_SELECTOR = 'dialog[open], [role="dialog"]';

/** True when document.activeElement sits inside an open dialog (excluding `ignoreRoot` itself). */
export function isFocusInDialog(ignoreRoot = null) {
  if (typeof document === 'undefined') return false;
  const active = document.activeElement;
  return Boolean(active && active !== document.body && active !== ignoreRoot && active.closest?.(OPEN_DIALOG_SELECTOR));
}

/** True when `root` contains an open dialog or focus is currently inside one. */
export function hasOpenDialog(root) {
  return Boolean(root?.querySelector?.(OPEN_DIALOG_SELECTOR)) || isFocusInDialog(root);
}
