import React, { useEffect, useState } from "react";
import { ui, uiLocale } from "../i18n.js";
import { Chip } from "../components/index.js";
import ModelSetupGate from "../ModelSetupGate.jsx";
import { reviewEntryKey } from "../async.js";
import TeachingStatus from "./TeachingStatus.jsx";
import SimilarTry from "./SimilarTry.jsx";
import RetellPanel from "./RetellPanel.jsx";

/* The ways to learn from an answered question, in one row under its explanation and Q&A (ui/review/QuestionRun.jsx): 逐步理解 and 计算题引导练习 (guided
   teaching, teach.start), 用自己的话讲一遍 (#1016, its panel opens under the row) and, after a wrong answer, 试一道同类题 (#1015; on the finished 逐步理解
   panel instead, where it is the next step). Each needs the model except 试一道同类题's finder: without one the model gate shows in place of a call. */

/** session: useReviewSession(); data: the snapshot; model: modelReadiness(data); onModelSettings; openModal: the app's modal opener (sources). */
export default function LearningActions({ session, data, model, onModelSettings, openModal }) {
  const { run, entry, teachingBusy, teachingError, actions } = session;
  const teaching = entry.teaching;
  const key = reviewEntryKey(run);
  const [gate, setGate] = useState(false);
  const [retell, setRetell] = useState(false);
  useEffect(() => { setGate(false); setRetell(false); }, [key]);
  useEffect(() => { if (model.ready) setGate(false); }, [model.ready]);
  if (!run.feedback || run.mode === "exam") return null;
  const language = uiLocale().startsWith("en") ? "en" : "zh";
  const teach = (mode) => { if (!model.ready) setGate(true); else if (!teachingBusy) actions.teachingAct("teach.start", { mode, language }); };
  const citations = run.solution?.citations || [];
  // 去原文看这段: the citation the AI pointed at (else the first), through the explanation's own way to a source.
  const openCite = (index) => {
    const cite = citations[index ?? 0] || citations[0], source = data?.sources?.find((item) => item.id === cite?.sourceId);
    if (source) openModal({ type: "source", source, quote: cite.quote, back: true });
  };
  return (
    <>
      <div className="assist-actions" aria-label={ui("引导学习方式")}>
        <Chip selected={teaching?.mode === "understanding"} onClick={() => teach("understanding")}>{ui("逐步理解")}</Chip>
        <Chip selected={teaching?.mode === "calculation"} onClick={() => teach("calculation")}>{ui("计算题引导练习")}</Chip>
        <Chip selected={retell} data-usage="review.retell" onClick={() => setRetell((open) => !open)}>{ui("用自己的话讲一遍")}</Chip>
        <TeachingStatus busy={teachingBusy} failure={teachingError} onCancel={actions.cancelTeaching} onRetry={actions.retryTeaching} />
        {!teaching?.complete && <SimilarTry session={session} data={data} model={model} onModelSettings={onModelSettings} />}
      </div>
      {gate && !model.ready && <ModelSetupGate variant="inline" feature="welcome" model={model} onOpenSettings={onModelSettings} />}
      {retell && <RetellPanel key={key} op="teach.retell" args={{ deckId: run.deckId, cardId: run.card.id }} draftKey={`card:${run.deckId}:${run.card.id}`}
        model={model} onModelSettings={onModelSettings} onSource={citations.length ? openCite : undefined} />}
    </>
  );
}
