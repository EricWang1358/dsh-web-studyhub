import React, { useEffect, useRef, useState } from 'react';
import { ui } from './i18n.js';

/** Try to open an assistant: '' when DSH opened it, otherwise the reason to show. */
export async function attemptOpen(openAgent, id) {
  try {
    await openAgent(id);
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
export default function AgentLink({ childId, openAgent, label, ariaLabel, className }) {
  const [state, setState] = useState({ opening: false, error: '' });
  const busy = useRef(false), alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  if (!childId || !openAgent) return null;
  const open = async () => {
    if (busy.current) return;
    busy.current = true;
    setState({ opening: true, error: '' });
    const error = await attemptOpen(openAgent, childId);
    busy.current = false;
    if (alive.current) setState({ opening: false, error });
  };
  return <>
    <button type="button" className={className} aria-label={ariaLabel} aria-busy={state.opening || undefined} disabled={state.opening} onClick={open}>
      {state.opening ? ui('正在打开…') : label}</button>
    {state.error && <small className="agent-link__error" role="alert">{state.error}</small>}
  </>;
}
