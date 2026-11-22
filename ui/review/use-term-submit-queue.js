import React from "react";
import { collectInFlightTerms, partitionMarkedTerms } from "./term-marks.js";

/**
 * Manages per-card assist task filtering and concurrent term-fill submission tracking
 * for QuestionRun (keeps optimistic in-flight terms until the next assistTasks snapshot).
 */
export function useTermSubmitQueue({ assistTasks, cardId, modelReady, setAssistMode, noteFillTerms, assistAct }) {
  const assistTasksRef = React.useRef(assistTasks);
  assistTasksRef.current = assistTasks;
  const submitTokenRef = React.useRef(0);
  const [pendingTermSubmits, setPendingTermSubmits] = React.useState([]);

  React.useEffect(() => {
    setPendingTermSubmits((prev) => {
      if (!prev.length) return prev;
      const next = prev.filter((item) => !item.settled || item.tasksAtSettle === assistTasks);
      return next.length === prev.length ? prev : next;
    });
  }, [assistTasks]);

  const cardTasks = React.useMemo(
    () => (assistTasks || []).filter((task) => task.cardId === cardId),
    [assistTasks, cardId],
  );
  const runningTasks = cardTasks.filter((task) => task.status === "running" && task.mode !== "grade");
  const runningTermsTasks = runningTasks.filter((task) => task.mode === "terms");
  const otherRunningTasks = runningTasks.filter((task) => task.mode !== "terms");
  const lastTask = cardTasks.filter((task) => task.mode !== "grade").at(-1);

  const optimisticTermsForCard = React.useMemo(
    () => pendingTermSubmits.filter((item) => item.cardId === cardId).flatMap((item) => item.terms),
    [pendingTermSubmits, cardId],
  );
  const inFlightTerms = React.useMemo(
    () => collectInFlightTerms(assistTasks, cardId, optimisticTermsForCard),
    [assistTasks, cardId, optimisticTermsForCard],
  );
  const runningTask = runningTasks[0] || (inFlightTerms.length > 0 ? { mode: "terms", terms: inFlightTerms } : null);

  const applyMarkedTerms = async (terms) => {
    const { pendingTerms } = partitionMarkedTerms(terms, inFlightTerms);
    if (!pendingTerms.length) return;
    if (!modelReady) {
      setAssistMode("ask");
      return;
    }
    noteFillTerms();
    const token = ++submitTokenRef.current;
    if (cardId) {
      setPendingTermSubmits((prev) => [...prev, { token, cardId, terms: pendingTerms, settled: false, tasksAtSettle: null }]);
    }
    let ok = false;
    try {
      ok = await assistAct("terms", "", [], { terms: pendingTerms });
    } finally {
      if (cardId) {
        if (!ok) {
          setPendingTermSubmits((prev) => prev.filter((item) => item.token !== token));
        } else {
          const snapshotTasks = assistTasksRef.current;
          setPendingTermSubmits((prev) => prev.map((item) => (
            item.token === token ? { ...item, settled: true, tasksAtSettle: snapshotTasks } : item
          )));
        }
      }
    }
  };

  return { cardTasks, runningTasks, runningTermsTasks, otherRunningTasks, lastTask, inFlightTerms, runningTask, applyMarkedTerms };
}
