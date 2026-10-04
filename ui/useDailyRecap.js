import { useEffect, useRef, useState } from 'react';

export const recapGroupKey = group => JSON.stringify([group.day, group.courseId || group.course]);
export const recapTimeZone = saved => saved?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai';
const isRunning = status => status?.groups?.some(group => group.generation?.status === 'running');

/** Own status reads and mutations together, so an older read cannot erase a newer action. */
export function useDailyRecap({ root, runId, course, saved, call, act, busy, poll }) {
  const [status, setStatus] = useState(null), [error, setError] = useState('');
  const [working, setWorking] = useState(''), [tones, setTones] = useState({});
  const owner = useRef(null), callbacks = useRef({ call, act });
  callbacks.current = { call, act };
  const timeZone = recapTimeZone(saved);

  useEffect(() => {
    const token = { live: true, timer: null, read: 0, operation: null, status: null };
    owner.current = token;
    setStatus(null); setError(''); setWorking(''); setTones({});
    token.schedule = delay => {
      clearTimeout(token.timer);
      if (poll && token.live && isRunning(token.status)) token.timer = setTimeout(token.refresh, delay);
    };
    token.refresh = async () => {
      if (token.operation || !token.live) return;
      clearTimeout(token.timer);
      const read = ++token.read;
      try {
        const next = await callbacks.current.call('note.daily.status', { timeZone, ...(runId ? { runId } : {}),
          ...(course !== undefined && course !== '*' ? { course } : {}) });
        if (!token.live || token.read !== read) return;
        token.status = next; setStatus(next); setError('');
        token.schedule(3000);
      } catch (cause) {
        if (!token.live || token.read !== read) return;
        setError(cause.message || String(cause));
        token.schedule(5000);
      }
    };
    token.refresh();
    return () => { token.live = false; clearTimeout(token.timer); };
  }, [root, runId, course, timeZone, poll]);

  const toneFor = group => tones[recapGroupKey(group)] || group.tone || status?.tone || saved?.tone || 'friendly';
  async function perform(group, action, args, update) {
    const token = owner.current;
    if (busy || !token?.live || token.operation) return;
    const operation = {}; token.operation = operation; token.read++;
    clearTimeout(token.timer); setWorking(recapGroupKey(group)); setError('');
    const live = () => token.live && owner.current === token && token.operation === operation;
    try {
      let result;
      if (callbacks.current.act) await callbacks.current.act(action, args, next => { result = next; }, { rethrow: true });
      else result = await callbacks.current.call(action, args);
      if (!live() || !result) return;
      token.status = { ...token.status, groups: token.status.groups.map(item => recapGroupKey(item) === recapGroupKey(group) ? update(item, result) : item) };
      setStatus(token.status);
    } catch (cause) { if (live()) setError(cause.message || String(cause)); }
    finally {
      if (live()) {
        token.operation = null; setWorking('');
        if (action === 'note.daily.cancel' && poll) await token.refresh();
        else token.schedule(1500);
      }
    }
  }
  const generate = (group, force = false) => {
    if (!group.eligible) return;
    return perform(group, 'note.daily.generate', { course: group.courseId || group.course, day: group.day, timeZone: group.timeZone || timeZone,
      tone: toneFor(group), ...(force ? { force: true } : {}) }, (item, result) => ({ ...item, noteId: result.id,
      protected: result.status === 'protected', hasContent: result.status === 'done' || item.hasContent,
      generation: result.generation || { status: result.status }, stale: result.status === 'done' ? false : item.stale }));
  };
  const cancel = group => group.noteId && perform(group, 'note.daily.cancel', { id: group.noteId },
    (item, result) => ({ ...item, generation: result.generation || { status: 'cancelled' } }));
  return { status, error, working, toneFor, generate, cancel,
    refresh: () => owner.current?.refresh(), setTone: (group, tone) => setTones(previous => ({ ...previous, [recapGroupKey(group)]: tone })) };
}
