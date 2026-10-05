import { useEffect, useState } from 'react';

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
