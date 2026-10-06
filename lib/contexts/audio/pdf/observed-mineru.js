import { parseWindow as parseLocalWindow } from '../../../mineru-local.js';

const REQUEST = Object.freeze({ boundary: 'external-request' });

/** The MinerU client with the requests that change something observed as Calls of a Job: the create and the upload declare their side effect (a repeated create makes
 * another batch), the download and the check of a saved batch do not. The polls of a running piece are not Calls: a conversion polls every few seconds for up to hours,
 * and a thousand identical read-only Calls would only bury the few that matter. The job's own retry layer (lib/mineru-job.js) is still the only one; each try is its own Call. */
export const observeClient = (client, observe) => ({ ...client,
  requestUploads: (files, options) => observe('create', signal => client.requestUploads(files, { ...options, signal }), { ...REQUEST, sideEffect: true }),
  upload: (url, bytes, options) => observe('upload', signal => client.upload(url, bytes, { ...options, signal }), { ...REQUEST, sideEffect: true }),
  download: (url, options) => observe('download', signal => client.download(url, { ...options, signal }), { ...REQUEST, sideEffect: false }),
  status: (batchId, options) => (options?.purpose === 'verify'
    ? observe('verify', signal => client.status(batchId, { ...options, signal }), { ...REQUEST, sideEffect: false }) : client.status(batchId, options)) });

/** The local route with each window run as one observed `local-process` Call (a Marker or MinerU run over a range of pages); repeating one only rewrites its own result file. */
export const observeLocal = (local, observe) => ({ ...local,
  parseWindow: options => observe('window', signal => (local.parseWindow || parseLocalWindow)({ ...options, signal }), { sideEffect: false }) });
