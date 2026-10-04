import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ui, uiMessage } from './i18n.js';
import { ToastRegion } from './components/Feedback.jsx';

// Keep the existing string/action-object protocol. Each submission gets its
// own lifetime, including a repeated confirmation with identical text.
// A notice may also carry { tone: 'info'|'success'|'warning' }.
export const reviewNoticeScope = (root, page, run) =>
  JSON.stringify([root, page, run?.id || '', run?.card?.id || '', !!run?.complete]);

/** The page part of a notice scope: library root + page name. */
export function pageOfScope(scope) {
  try {
    const parsed = JSON.parse(scope);
    if (Array.isArray(parsed)) return JSON.stringify(parsed.slice(0, 2));
  } catch {}
  return String(scope ?? '');
}

/** Pin an unbound notice to the page that renders it first. */
export const bindNotice = (entry, scope) => !entry || entry.page !== undefined ? entry : { ...entry, page: pageOfScope(scope) };

/** A notice with an explicit scope shows only there; any other stays on its page. */
export function noticeVisible(entry, scope) {
  if (!entry) return false;
  const explicit = entry.value && typeof entry.value === 'object' ? entry.value.scope : undefined;
  if (explicit !== undefined) return explicit === scope;
  return entry.page === undefined || entry.page === pageOfScope(scope);
}

let sequence = 0;
export function useNotice(scope) {
  const [entry, setEntry] = useState(null);
  const setNotice = useCallback(value => setEntry(value ? { id: ++sequence, value } : null), []);
  // Bind during render, so a notice set together with a page change belongs
  // to the new page rather than to the one being left.
  if (entry && entry.page === undefined) setEntry(bindNotice(entry, scope));
  useEffect(() => {
    if (entry && !noticeVisible(entry, scope)) setEntry(current => current === entry ? null : current);
  }, [entry, scope]);
  const visible = noticeVisible(entry, scope);
  const notice = useMemo(() => {
    if (!visible) return '';
    const value = typeof entry.value === 'string' ? { text: entry.value } : entry.value;
    return { ...value, key: entry.id };
  }, [visible, entry]);
  return [notice, setNotice];
}

const toObject = value => typeof value === 'string' ? { text: value } : value || {};
const actionOf = (value, busy) => value.action && { label: value.action.label, onClick: value.action.run ?? value.action.onClick, disabled: !!busy || value.action.disabled };

/** A notice as the toast the region draws. An undo offer (`undo`, with `timeout`) may leave by itself but is held while hovered or focused. */
export function noticeToToast(notice, busy) {
  const value = toObject(notice);
  return { id: 'notice', key: `notice:${value.key ?? value.text}`, tone: value.tone || 'info',
    message: uiMessage(value.text ?? ''), persistent: !!value.persistent, dismissLabel: ui('关闭提示'),
    ...(value.undo ? { undo: true } : {}), ...(value.timeout ? { timeout: value.timeout } : {}), action: actionOf(value, busy) };
}

export function errorToToast(error, busy) {
  const value = toObject(error);
  return { id: 'error', key: `error:${value.text}`, tone: 'error', message: uiMessage(value.text ?? ''), dismissLabel: ui('关闭错误'), action: actionOf(value, busy) };
}

/**
 * App-level feedback, now shown as toasts in the visible Study viewport (or in
 * the open dialog). Props are unchanged; `error` / `notice` may be a string or
 * { text, action: { label, run }, persistent, tone, undo, timeout }. placement: 'auto' |
 * 'page' | 'inline' (see ToastRegion). Rendered once, by App; pages reach it through useToast().
 */
export default function ActionFeedback({ error, notice, busy, onCloseError, onCloseNotice, placement = 'auto' }) {
  const toasts = [];
  if (notice) toasts.push(noticeToToast(notice, busy));
  if (error) toasts.push(errorToToast(error, busy));
  return <ToastRegion toasts={toasts} placement={placement}
    onDismiss={id => (id === 'error' ? onCloseError : onCloseNotice)?.()} />;
}
