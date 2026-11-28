import { deferredView } from './deferred-view.jsx';

/* The PDF converter (ui/PdfConversion.jsx) and the conversion job/history cards on 资料 (ui/PdfConvertJob.jsx, together with ConvertEdit,
   PdfExternalConvertGuide and mineru.css) stay out of the workspace's first-load static closure (#562) and arrive on demand in their own chunk.
   Until a chunk arrives nothing is drawn: there is no placeholder height shift when a library has no active conversions. */
export const PdfConversion = deferredView(() => import('./PdfConversion.jsx'), { loading: () => null });
export const PdfConvertSection = deferredView(() => import('./PdfConvertJob.jsx').then(mod => ({ default: mod.PdfConvertSection })), { loading: () => null });
