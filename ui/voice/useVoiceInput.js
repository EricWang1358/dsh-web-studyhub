import { useCallback, useEffect, useRef, useState } from 'react';
import { errorMessage, getUiLanguage } from '../i18n.js';
import { entryFor, refreshQuery } from '../host-query-store.js';
import { createVoiceRecorder } from './mic.js';
import { VOICE_MAX_SECONDS } from './wav.js';

/* One voice input (#1031): press to talk, press again to send, the text comes back through `onText`. Before the first recording of a page it asks
   whether a transcription tier is there (audio.preflight: a cloud provider, a paid one when 只用付费密钥 is the default in 设置 › 音频转写, as the
   recording will be sent, or the installed local engine), once per page and again after a setup failure; without one the
   button opens the setup guide instead of the microphone. A library whose host has no audio context hides the button (`unavailable`). `scope` names
   where the text belongs (the question on screen): text that comes back after it changed is dropped and the learner is told (ui/voice/mic.js). */

let readiness = null;
let watchedSettingsEntry = null;
let internalSettingsFetch = 0;

function ensureSettingsWatch() {
  const entry = entryFor('audio.settings.get', {});
  if (watchedSettingsEntry === entry) return;
  watchedSettingsEntry = entry;
  entry.subscribe(() => {
    if (internalSettingsFetch > 0) return;
    readiness = null;
  });
}

/** Is voice transcription set up? Asked once per page; `again` after the learner saved a key. The check uses the same 只用付费密钥 as the clip
    (audio.clip.transcribe falls back to the settings' paidOnlyByDefault), so "ready" never means a free key the clip will not use. */
export function voiceReadiness(call, again = false) {
  ensureSettingsWatch();
  if (again || !readiness) {
    readiness = (async () => {
      internalSettingsFetch += 1;
      let settings = null;
      try {
        settings = await refreshQuery(call, 'audio.settings.get', {}).catch(() => null);
      } finally {
        internalSettingsFetch -= 1;
      }
      return call('audio.preflight', settings?.paidOnlyByDefault === true ? { paidOnly: true } : {});
    })().then(
      (status) => ({ ready: !!(status?.transcription || status?.liveLocal?.ready), reason: status?.reason || 'no-provider' }),
      () => ({ ready: false, unavailable: true }));
  }
  return readiness;
}
/** Forget the answer, so the next recording asks again (after a setup failure: the settings changed since). */
export function forgetVoiceReadiness() { readiness = null; }

/** Focus a ref'd text input/textarea without scrolling and place its caret at the end (after a voice transcript fills it). */
export function focusInputEnd(ref) {
  const apply = () => {
    const el = ref?.current;
    if (!el || el.isConnected === false) return;
    el.focus?.({ preventScroll: true });
    const end = el.value?.length ?? 0;
    el.setSelectionRange?.(end, end);
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
  else apply();
}

const IDLE = { phase: 'idle', left: VOICE_MAX_SECONDS, error: '', code: '' };
const WORKLET_ERROR = /failed to load worklet|audioworklet|worklet['’]?s module|unable to load.*worklet|study-pcm|audiocontext.*not allowed/i;
const WORKLET_ERROR_ZH = '浏览器没能启动录音组件，请刷新页面或换用最新版 Chrome / Edge 后再试。';
const voiceErrorText = (error) => {
  const raw = typeof error === 'string' ? error : String(error?.message || error || '');
  return WORKLET_ERROR.test(raw) ? errorMessage(WORKLET_ERROR_ZH) : errorMessage(error);
};

export function useVoiceInput({ call, onText, scope = '' }) {
  const [state, setState] = useState(IDLE);
  const [starting, setStarting] = useState(false);
  const [level, setLevel] = useState(0);
  const [setup, setSetup] = useState(null);
  const [unavailable, setUnavailable] = useState(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const recorder = useRef(null), mounted = useRef(true), startingRef = useRef(false);
  useEffect(() => {
    mounted.current = true;
    voiceReadiness(call).then((status) => { if (mounted.current) setUnavailable(!!status.unavailable); });
    return () => { mounted.current = false; startingRef.current = false; recorder.current?.cancel(); };
  }, [call]);
  // Another question while recording: the microphone stops now, not when the learner presses again (ui/voice/mic.js moved()).
  useEffect(() => { void recorder.current?.moved(); }, [scope]);
  const deliver = useCallback(async (finished) => {
    try {
      const text = await finished;
      if (mounted.current && text) onTextRef.current?.(text);
    } catch (error) {
      if (!mounted.current) return;
      if (error?.name === 'AbortError') return; // the learner cancelled
      if (error?.code === 'AUDIO_SETUP') { forgetVoiceReadiness(); setSetup({ reason: error.reason || 'no-provider' }); setLevel(0); setState(IDLE); }
      else setState((current) => ({ ...current, error: voiceErrorText(error), code: error?.code || '' }));
    }
  }, []);
  const start = useCallback(async () => {
    if (startingRef.current || (recorder.current && recorder.current.phase !== 'idle')) return;
    const startScope = scopeRef.current;
    startingRef.current = true;
    setStarting(true);
    try {
      let status = await voiceReadiness(call);
      if (!status.ready && !status.unavailable) status = await voiceReadiness(call, true);
      if (!mounted.current || !startingRef.current || scopeRef.current !== startScope) return;
      if (status.unavailable) { setUnavailable(true); return; }
      if (!status.ready) { setSetup({ reason: status.reason }); return; }
      setSetup(null);
      recorder.current = createVoiceRecorder({ call, language: getUiLanguage(), scope: () => scopeRef.current,
        onState: ({ phase, left, error }) => {
          if (!mounted.current) return;
          if (phase !== 'recording') setLevel(0);
          setState((current) => ({ phase, left, error: error === undefined ? current.error : error ? voiceErrorText(error) : '', code: error ? current.code : '' }));
        },
        onLevel: (next) => { if (mounted.current) setLevel(next); },
        onLimit: deliver });
      try { await recorder.current.start(); } catch { /* the error is in the state already */ }
      if (!mounted.current || !startingRef.current || scopeRef.current !== startScope) { void recorder.current?.cancel(); return; }
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  }, [call, deliver]);
  const finish = useCallback(() => (recorder.current?.phase === 'recording' ? deliver(recorder.current.finish()) : undefined), [deliver]);
  const cancel = useCallback(() => { startingRef.current = false; setStarting(false); setLevel(0); recorder.current?.cancel(); setState(IDLE); }, []);
  /** The key and the button: start when idle, send when recording, nothing while sending or starting. */
  const toggle = useCallback(() => (state.phase === 'recording' ? finish() : state.phase === 'idle' && !startingRef.current ? start() : undefined), [state.phase, finish, start]);
  const recheck = useCallback(async () => {
    const status = await voiceReadiness(call, true);
    if (mounted.current && status.ready) setSetup(null);
  }, [call]);
  return { ...state, starting, level, setup, unavailable, start, finish, cancel, toggle, recheck, closeSetup: () => setSetup(null), clearError: () => setState(IDLE) };
}
