import { createContext } from 'react';

/* `describe(error)`: the diagnostic text of the page the learner is on (ui/diagnostics.js). The page boundary (ui/app/page-boundary.jsx) provides it, and
   CrashFallback offers 复制诊断信息 from it, so a boundary of a part inside the page (deferredView, a settings pane) shows the button without being told. */
export const DiagnosticContext = createContext(null);
