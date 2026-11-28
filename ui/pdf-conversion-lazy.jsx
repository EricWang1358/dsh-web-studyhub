import React, { Suspense, lazy } from 'react';
import { deferredView } from './deferred-view.jsx';
import { hasContext } from './capabilities.js';
import { isConvertJob } from './mineru-flow.js';
import { useStudy } from './study-context.jsx';

/* The PDF converter (ui/PdfConversion.jsx) and the conversion job/history cards on 资料 (ui/PdfConvertJob.jsx, together with ConvertEdit,
   PdfExternalConvertGuide and mineru.css) stay out of the workspace's first-load static closure (#562) and arrive on demand in their own chunk.
   Until a chunk arrives nothing is drawn: there is no placeholder height shift when a library has no active conversions. */
export const PdfConversion = deferredView(() => import('./PdfConversion.jsx'), { loading: () => null });

const LazyPdfConvertSection = lazy(() => import('./PdfConvertJob.jsx').then(mod => ({ default: mod.PdfConvertSection }), () => ({ default: () => null })));

/** Function-component lazy wrapper (never a class constructor, so shallow tree walkers and SSR stay safe) that skips fetching the PDF job/history chunk
    when neither an active conversion job nor the audio context is present. */
export function PdfConvertSection(props) {
  const { call } = useStudy();
  const hasConvertJob = (props.data?.jobs || []).some(isConvertJob);
  const canHaveHistory = hasContext(props.data, 'audio') && typeof call === 'function';
  if (!hasConvertJob && !canHaveHistory) return null;
  return <Suspense fallback={null}><LazyPdfConvertSection {...props} /></Suspense>;
}
