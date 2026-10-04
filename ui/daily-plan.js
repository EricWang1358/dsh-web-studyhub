import { useCallback, useEffect, useRef, useState } from 'react';
import { localDate } from '../lib/board-model.js';

/** A queued source/flow reference must wait until its library has loaded. */
export function useStudyReferenceHandoff(take, root, onOpen) {
  const open = useRef(onOpen);
  open.current = onOpen;
  useEffect(() => { if (root) return take?.(reference => open.current?.(reference)); }, [take, root]);
}

/** One controller for home, board and the current learning context. Reads never ask AI. */
export function useDailyPlan({ call, root, visible, progressKey, onLaunch, onChanged, navigation }) {
  const latest = useRef({ call, root, onLaunch, onChanged, navigation });
  latest.current = { call, root, onLaunch, onChanged, navigation };
  const [date, setDate] = useState(localDate);
  const [snapshot, setSnapshot] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(null);
  const sequence = useRef(0), pending = useRef(null);
  const reading = useRef(null);
  const scope = `${root || ''}:${date}`;
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const refresh = useCallback(async ({ invalidate = false } = {}) => {
    if (!root) return;
    if (pending.current?.scope === scope) {
      if (invalidate) pending.current.refresh = true;
      return;
    }
    if (reading.current?.scope === scope) {
      if (invalidate) reading.current.invalidated = true;
      return reading.current.promise;
    }
    const flight = { scope };
    reading.current = flight;
    flight.promise = (async () => {
      try {
        do {
          flight.invalidated = false;
          const request = ++sequence.current;
          try {
            const value = await latest.current.call('daily.plan.get', { date });
            if (currentScope.current === scope && sequence.current === request && !flight.invalidated) {
              setSnapshot(previous => previous?.scope === scope && JSON.stringify(previous.value) === JSON.stringify(value) ? previous : { scope, value });
              setError('');
            }
          } catch (failure) {
            if (currentScope.current === scope && sequence.current === request && !flight.invalidated) setError(failure.message);
          }
        } while (flight.invalidated && reading.current === flight && currentScope.current === scope);
      } finally {
        if (reading.current === flight) reading.current = null;
      }
    })();
    return flight.promise;
  }, [root, date, scope]);
  useEffect(() => {
    setError('');
    if (!visible || !root) return;
    void refresh();
    const check = () => {
      if (document.hidden) return;
      const today = localDate();
      if (today !== date) setDate(today); else void refresh();
    };
    const timer = setInterval(check, 15000);
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [visible, root, date, refresh]);
  useEffect(() => { if (visible && progressKey) void refresh({ invalidate: true }); }, [visible, progressKey, refresh]);
  const perform = async (action, args = {}) => {
    if (!root || pending.current?.scope === scope || localDate() !== date) { setDate(localDate()); return false; }
    const token = { scope };
    pending.current = token;
    reading.current = null;
    const request = ++sequence.current;
    const originNavigation = latest.current.navigation?.();
    setBusy({ scope, action }); setError('');
    try {
      const value = await latest.current.call(`daily.plan.${action}`, { date, ...args });
      if (currentScope.current !== scope || sequence.current !== request) return false;
      if (action === 'start') {
        if (value.task) setSnapshot(previous => previous?.scope === scope ? { scope, value: { ...previous.value,
          tasks: previous.value.tasks.map(task => task.id === value.task.id ? value.task : task) } } : previous);
        if (originNavigation === latest.current.navigation?.()) await latest.current.onLaunch?.(value);
      }
      else setSnapshot({ scope, value });
      await latest.current.onChanged?.();
      return true;
    } catch (failure) {
      if (currentScope.current === scope && sequence.current === request) setError(failure.message);
      return false;
    } finally {
      if (pending.current === token) {
        pending.current = null;
        if (currentScope.current === scope) {
          setBusy(null);
          if (token.refresh) void refresh({ invalidate: true });
        }
      }
    }
  };
  return { state: snapshot?.scope === scope ? snapshot.value : null, date, busy: busy?.scope === scope ? busy.action : '', error, refresh,
    suggest: (args) => perform('suggest', args), accept: (proposalId) => perform('accept', { proposalId }),
    saveProfile: (profile) => perform('profile', profile), start: (taskId) => perform('start', { taskId }),
    complete: (taskId, minutes) => perform('complete', { taskId, ...(minutes === undefined ? {} : { minutes }) }) };
}
