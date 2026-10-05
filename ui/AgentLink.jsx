import React, { useEffect, useRef, useState } from 'react';
import { ui } from './i18n.js';
import { Button, ErrorState } from './components/index.js';

/** Try to open an assistant: '' when DSH opened it, otherwise the reason to show. */
export async function attemptOpen(openAgent, id, options) {
  try {
    await openAgent(id, options);
    return '';
  } catch (error) {
    return error?.message || ui('没能打开后台助手。');
  }
}

/**
 * The button that opens a background assistant. It says what happened: it waits while DSH opens
 * the assistant, ignores a second click meanwhile (so a double click cannot open it twice), and
 * shows the reason when it cannot be opened. Without a host that can open assistants, or
 * without an id to open, it draws nothing.
 */
export default function AgentLink({ childId, parentId, openAgent, label, ariaLabel, className, variant = 'link' }) {
  const [state, setState] = useState({ opening: false, error: '' });
  const busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // The host says whether this child can be opened at all (its function carries `canOpen`); no link that would only fail when pressed.
  if (!childId || !openAgent || openAgent.canOpen?.(childId, { parentId }) === false) return null;
  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ opening: true, error: '' });
    const error = await attemptOpen(openAgent, childId, { parentId });
    busy.current = false;
    if (alive.current) setState({ opening: false, error });
  };
  return <>
    <Button variant={variant} size="sm" className={className} aria-label={ariaLabel} busy={state.opening} busyLabel={ui('正在打开…')} onClick={open}>
      {label}</Button>
    {state.error && <ErrorState compact className="agent-link__problem" error={state.error} />}
  </>;
}
