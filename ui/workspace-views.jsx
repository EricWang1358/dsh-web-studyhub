import { deferredView } from './deferred-view.jsx';

// A view owns its loading boundary, so unrelated study surfaces stay visible.
// LiveClass remains mounted across page navigation to preserve recording.
// The daily path (library, sources, generate, draft, review, wrong book) stays in the workspace's first load; the pages opened
// now and then (statistics, mock exam, exam prep, outline, review book, board) arrive with their own chunk when first opened (#562).
// The board's subscription (ui/board/use-board.js) stays with the shell, which shows its badge on every page.
export const BlogNotes = deferredView(() => import("./BlogNotes.jsx"));
export const Skeleton = deferredView(() => import("./Skeleton.jsx"));
export const Workflows = deferredView(() => import("./Workflows.jsx"));
export const Graph = deferredView(() => import("./Graph.jsx"));
export const TaskConsole = deferredView(() => import("./tasks/TaskConsole.jsx"));
export const AudioDashboard = deferredView(() => import("./AudioDashboard.jsx"));
export const DocumentViewer = deferredView(() => import("./document-preview/DocumentViewer.jsx"));
export const LiveClass = deferredView(() => import("./LiveClass.jsx"));
export const GuidedStudy = deferredView(() => import("./guided-study/GuidedStudyWorkbench.jsx"));
export const Dashboard = deferredView(() => import("./Dashboard.jsx"));
export const Exam = deferredView(() => import("./Exam.jsx"));
export const ExamPrep = deferredView(() => import("./exam-prep/ExamPrep.jsx"));
export const CourseOutline = deferredView(() => import("./outline/CourseOutline.jsx"));
export const BookPage = deferredView(() => import("./book/BookPage.jsx"));
export const Board = deferredView(() => import("./Board.jsx"));
