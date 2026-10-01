import { deferredView } from './deferred-view.jsx';

// A view owns its loading boundary, so unrelated study surfaces stay visible.
// LiveClass remains mounted across page navigation to preserve recording.
export const BlogNotes = deferredView(() => import("./BlogNotes.jsx"));
export const Skeleton = deferredView(() => import("./Skeleton.jsx"));
export const Workflows = deferredView(() => import("./Workflows.jsx"));
export const Graph = deferredView(() => import("./Graph.jsx"));
export const AudioDashboard = deferredView(() => import("./AudioDashboard.jsx"));
export const DocumentViewer = deferredView(() => import("./document-preview/DocumentViewer.jsx"));
export const LiveClass = deferredView(() => import("./LiveClass.jsx"));
