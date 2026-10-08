import { useEffect, useRef, useState } from 'react';
import { modelKey } from '../lib/job-model.js';
import { useLiveEffect } from './use-async.js';

/**
 * The reasoning levels of ONE model as the host reports them (the host action `model.efforts`): for the 即时控制 of a question run, whose stages offer the
 * levels of the model in force, its own choice or the generation model (lib/job-model.js). null until known and when the host cannot describe models, [] for a model without levels.
 * Asked again only when the model changes; `route` null asks nothing.
 */
export function useRouteEfforts(call, route) {
  const key = modelKey(route), ask = useRef(call);
  ask.current = call;
  const [state, setState] = useState({ key: '', options: null });
  useLiveEffect((isLive) => {
    if (!key || typeof ask.current !== 'function') return;
    const [provider, model] = JSON.parse(key);
    Promise.resolve(ask.current('model.efforts', { provider, model })).then(
      value => { if (isLive()) setState({ key, options: Array.isArray(value?.options) ? value.options : null }); }, () => {});
  }, [key]);
  return state.key === key ? state.options : null;
}

/**
 * The reasoning levels of the model the study model route points at, as the host reports them (binding.get's `effort.options`,
 * lowest first): `options` is null until they are known, [] when the model offers none. The audio settings and the usage console
 * both build their reasoning selects from it, so the choices are the model's own, not a fixed low / medium / high.
 */
export function useModelEfforts(call, { enabled = true } = {}) {
  const [state, setState] = useState({ options: null, model: '' });
  useEffect(() => {
    if (!enabled || typeof call !== 'function') return undefined;
    let live = true;
    Promise.resolve(call('binding.get')).then(
      binding => { if (live) setState({ options: Array.isArray(binding?.effort?.options) ? binding.effort.options : [], model: binding?.route?.model || '' }); },
      () => {});
    return () => { live = false; };
  }, [call, enabled]);
  return state;
}
