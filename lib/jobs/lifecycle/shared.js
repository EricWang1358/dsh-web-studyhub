export { ACTIONS } from '../contract.js';

export const TERMINAL = Object.freeze(['complete', 'failed', 'cancelled', 'interrupted']);
export const terminal = status => TERMINAL.includes(status);
export const errorOf = (code, message = code) => Object.assign(new Error(message), { code });
export const checkpointPause = Symbol('checkpoint pause');
export const iso = () => new Date().toISOString();
export const denied = code => ({ available: false, reason: { code } });
