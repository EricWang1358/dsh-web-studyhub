import { parseWindow as parseLocalWindow } from '../../../mineru-local.js';

/** The local route with each window run as one observed `local-process` Call (a Marker or MinerU run over a range of pages); repeating one only rewrites its own result file. */
export const observeLocal = (local, observe) => ({ ...local,
  parseWindow: options => observe('window', signal => (local.parseWindow || parseLocalWindow)({ ...options, signal }), { sideEffect: false }) });
