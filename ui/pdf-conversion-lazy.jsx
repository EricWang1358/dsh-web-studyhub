import { deferredView } from './deferred-view.jsx';

/* The local PDF converter (ui/PdfConversion.jsx and the install, job and history cards under it) is only needed once a file has been dropped or 「PDF 解析」 is
   opened, so it arrives with its own chunk then, not with the workspace's first load. Until it is there nothing is drawn: it is shown after a press, and a local chunk arrives at once. */
export const PdfConversion = deferredView(() => import('./PdfConversion.jsx'), { loading: () => null });
