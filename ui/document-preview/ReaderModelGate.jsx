import React, { createContext, useContext } from 'react';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { ModelSettingsContext } from '../ModelErrorNote.jsx';
import { StudyServicesContext } from '../study-context.jsx';

/* The reader's way to the model settings, and its one gate. Everything in the reader that needs a model (questions about a passage, top-up questions,
   translation, a paragraph's translation, the AI outline) shows the same gate with the same button; the words are ModelSetupGate's.
   DocumentViewer provides `{ model, openModelSettings, openSettings }`; without a provider (the 资料 page's outline dialog, previews) the app's own
   handlers are used, and with none of them there is no button that goes nowhere. */
export const ReaderModelContext = createContext(null);

/** What the reader can open: the readiness of the model, the model settings and a Settings section. */
export function useReaderServices() {
  const reader = useContext(ReaderModelContext), app = useContext(ModelSettingsContext), study = useContext(StudyServicesContext);
  return {
    model: reader?.model || null,
    openModelSettings: reader?.openModelSettings ?? app ?? undefined,
    openSettings: reader?.openSettings ?? (typeof study?.openSettings === 'function' ? study.openSettings : undefined),
  };
}

/**
 * The gate of a feature that needs a model, in the compact form. The caller shows it only when it knows the feature cannot run, so it is drawn as not ready
 * whatever the readiness says (a model that is set up but not offering this operation is still "not there" to this feature).
 * feature: 'passage' | 'outline' | 'translate' (ModelSetupGate).
 */
export default function ReaderModelGate({ feature = 'passage', variant = 'inline', className }) {
  const { model, openModelSettings } = useReaderServices();
  return <ModelSetupGate variant={variant} feature={feature} model={{ ...(model || {}), ready: false }} onOpenSettings={openModelSettings} className={className} />;
}
