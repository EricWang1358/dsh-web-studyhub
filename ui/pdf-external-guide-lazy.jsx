import { deferredView } from './deferred-view.jsx';

/* The manual-conversion guide (ui/PdfExternalConvertGuide.jsx) under a FAILED conversion's detail. PdfConvertJob.jsx is in the workspace's first load (the 资料 page's
   job cards), and a failure is rare, so the guide and its sheet arrive with their own chunk the first time one is shown. Nothing is drawn until then: a local chunk
   arrives at once. The PDF panel and Settings, already chunks of their own, import the guide directly. */
export const PdfExternalConvertGuide = deferredView(() => import('./PdfExternalConvertGuide.jsx'), { loading: () => null });
