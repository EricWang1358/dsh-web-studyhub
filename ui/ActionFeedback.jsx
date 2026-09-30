import React, { useCallback, useEffect, useState } from 'react';
import { ui } from './i18n.js';

// Keep the existing string/action-object protocol. Each submission gets its
// own lifetime, including a repeated confirmation with identical text.
export function useNotice() {
  const [entry, setEntry] = useState(null);
  const setNotice = useCallback(value => setEntry(value ? { value } : null), []);
  useEffect(() => {
    if (!entry || entry.value.action || entry.value.persistent) return;
    const timer = setTimeout(() => setEntry(current => current === entry ? null : current), 5000);
    return () => clearTimeout(timer);
  }, [entry]);
  return [entry?.value || '', setNotice];
}

export default function ActionFeedback({ error, notice, busy, onCloseError, onCloseNotice }) {
  if (!error && !notice) return null;
  return <div className="action-feedback">
    {error && <div role="alert" className="alert error">
      <span>{error}</span>
      <button type="button" aria-label={ui('关闭错误')} onClick={onCloseError}>×</button>
    </div>}
    {notice && <div role="status" className="alert notice">
      <span>{notice.text ?? notice}</span>
      {notice.action && <button type="button" className="alert-action" disabled={busy} onClick={notice.action.run}>
        {notice.action.label}
      </button>}
      <button type="button" aria-label={ui('关闭提示')} onClick={onCloseNotice}>×</button>
    </div>}
  </div>;
}
