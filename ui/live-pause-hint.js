import { useEffect, useRef, useState } from 'react';

/* The one quiet line on the live page for a fast speaker (断句停顿, lib/audio-settings.js LIVE_PAUSE): text only becomes a sentence when a pause is
   heard, so a speaker who never pauses leaves everything in the grey in-progress line, with nothing to polish or tick for questions. After more than a
   minute of one growing line (at least 150 characters) and no new sentence, the page says where the setting is. pauseHint is pure: the watch it returns
   is the only state, and the same input gives the same answer. */

/** The field's deep-link anchor in 音频设置 (a data-tour id of the audio category, ui/settings-groups.js). */
export const LIVE_PAUSE_ANCHOR = 'settings-live-pause';
export const PAUSE_HINT_MS = 60_000;
export const PAUSE_HINT_CHARS = 150;

export const initialPauseWatch = () => ({ id: '', count: 0, since: null });

/**
 * @param watch  what the last call returned ({ id, count, since }): since is when the current stretch of text without a new sentence began
 * @param snap   { id: the class, active: still running, count: sentences so far, interim: the in-progress line }
 * @param now    milliseconds
 * @returns      { watch, show }
 */
export function pauseHint(watch, { id = '', active = false, count = 0, interim = '' }, now) {
  const text = String(interim || '');
  // Another class, one that is no longer running, or a new sentence: the count starts again.
  if (!active || id !== watch.id || count !== watch.count) return { watch: { id, count, since: active && text ? now : null }, show: false };
  if (!text) return { watch: { ...watch, since: null }, show: false };
  const since = watch.since ?? now;
  return { watch: since === watch.since ? watch : { ...watch, since }, show: text.length >= PAUSE_HINT_CHARS && now - since > PAUSE_HINT_MS };
}

const running = session => !!session && !['ended', 'error'].includes(session.status);

/** Whether the live page shows the line for this session; it looks again every few seconds while a class runs, so a speaker who goes quiet needs no new poll. */
export function usePauseHint(session) {
  const [, setTick] = useState(0);
  const watch = useRef(initialPauseWatch());
  const on = running(session);
  useEffect(() => {
    if (!on) return undefined;
    const timer = setInterval(() => setTick(value => value + 1), 5000);
    return () => clearInterval(timer);
  }, [on]);
  const result = pauseHint(watch.current, { id: session?.id || '', active: on, count: session?.total ?? session?.segments?.length ?? 0, interim: session?.interim || '' }, Date.now());
  watch.current = result.watch;
  return result.show;
}
