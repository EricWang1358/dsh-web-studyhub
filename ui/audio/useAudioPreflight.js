import { useEffect, useRef, useState } from 'react';
import { checkFiles, withoutFiles } from './preflight.js';

/**
 * The pre-flight of the audio form: whether a transcription provider is configured (`readiness`, null until known) and each
 * chosen recording's check (`checks`, key -> probe). The recordings are checked as soon as they are in the list, so a problem
 * shows before the learner presses start; nothing is sent to a provider. `files` are the form's entries ({ key, kind, … }).
 * `recheck(list)` asks again right before an import starts and resolves { checks, status } (null parts when the host did not say).
 */
export function useAudioPreflight({ call, files, paidOnly, initialReadiness = null, initialChecks }) {
  const [readiness, setReadiness] = useState(initialReadiness), [checks, setChecks] = useState(initialChecks || {});
  const round = useRef(0);
  /** Ask the host what is configured. */
  const refreshReadiness = async () => {
    if (!call) return null;
    try {
      const result = await call('audio.preflight', {});
      if (!result || typeof result !== 'object') return null;
      const status = withoutFiles(result);
      setReadiness(status);
      return status;
    } catch { return null; }
  };
  useEffect(() => {
    if (!initialReadiness) void refreshReadiness();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call]);
  const audioFiles = files.filter(file => file.kind !== 'subtitle');
  const signature = audioFiles.map(file => file.key).join('|');
  useEffect(() => {
    if (!call || !audioFiles.length || initialChecks) return undefined;
    const mine = ++round.current;
    setChecks(current => Object.fromEntries(audioFiles.map(file => [file.key, current[file.key] || { checking: true }])));
    const timer = setTimeout(() => {
      void checkFiles(call, audioFiles, { paidOnly }).then(({ checks: next }) => {
        if (mine === round.current && next) setChecks(next);
      }, () => { if (mine === round.current) setChecks({}); });
    }, 150);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, signature, paidOnly]);
  async function recheck(list) {
    const answer = await checkFiles(call, list, { paidOnly });
    if (answer.checks) { setChecks(answer.checks); setReadiness(answer.status); }
    return answer;
  }
  return { readiness, checks, setChecks, refreshReadiness, recheck, audioFiles };
}
