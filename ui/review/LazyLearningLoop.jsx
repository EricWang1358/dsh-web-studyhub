import React from "react";
import { deferredView } from "../deferred-view.jsx";

/* On-demand wrappers for the post-answer learning loop panels (#1015, #1016):
   keeps SimilarTry, RetellPanel and learning-loop.css out of the workspace static
   first load while preserving zero-latency mounting on demand. */

const DeferredSimilarTry = deferredView(() => import("./SimilarTry.jsx"), { loading: () => null });
export const LazyRetellPanel = deferredView(() => import("./RetellPanel.jsx"), { loading: () => null });

export function LazySimilarTry(props) {
  const run = props.session?.run;
  if (!run || run.mode === "exam") return null;
  const wrong = !!run.feedback && (run.feedback.correct === false || run.feedback.grade < 3);
  if (!run.similarFor && (!wrong || run.returnTo)) return null;
  return <DeferredSimilarTry {...props} />;
}
