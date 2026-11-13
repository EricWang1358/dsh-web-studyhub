import { ui, uiFormat } from "../i18n.js";
import React from "react";
import { Button, InlineMessage, Spinner, focusQuietly } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { reviewEntryKey, voiceScopeKey } from "../async.js";
import { plainAssistFailure } from "../generation-status.js";
import VoiceButton from "../voice/VoiceButton.jsx";
import { useVoiceInput } from "../voice/useVoiceInput.js";
import { clozeBlankIds, splitSpokenBlanks } from "../voice/cloze-split.js";
import { suggestedGrade } from "../voice/suggest-grade.js";
import CorrectionCard from "./CorrectionCard.jsx";
import CorrectionsPending from "./CorrectionsPending.jsx";

/* Voice answering on the practice page (#1031). Voice is an input method: the text goes into the inputs typing uses and is submitted by the paths
   typing uses. A cloze's blanks are filled from 「第一空 …」 (ui/voice/cloze-split.js; a transcript that does not match fills none and shows above the
   blanks); an open question's text goes into its answer box; a flashcard's is shown beside the revealed answer with a suggested grade (local word
   overlap) to confirm with the 0–5 buttons, and is AI-graded only when its course asked for it (课程设置 › 练习). With the autopilot on, a spoken answer
   is submitted once it is in the box — a cloze through review.answer, an open question through the background grade — and the round moves on; the
   grade lands on the question later (run.grading). Its correction, 改分 and 我看懂了 · 加入重练 are CorrectionCard. QuestionRun keeps one line per place. */

const kindOf = (run, isCloze) => (isCloze ? "cloze" : run.mode === "flashcard" || run.card?.kind === "flashcard" ? "flash" : run.card?.kind === "open" ? "open" : "");

/**
 * The voice of one question. Returns the pieces QuestionRun places: `answer` (the button and what it says, per kind), `askButton` (in the 帮我弄懂 box),
 * `keys` (V and Shift+V for the session's key handler), `suggested` (the preselected grade of a spoken flashcard), `correction` and `pending` (the header).
 */
export function useVoiceAnswer({ session, data, model, rubricCard, setAssistMode, setAssistText }) {
  const { call } = useStudy();
  const { run, entry, actions, autopilot, isCloze } = session;
  const kind = kindOf(run, isCloze);
  const key = reviewEntryKey(run);
  const [spoken, setSpoken] = React.useState({ key: "", text: "", mismatch: false });
  const [pending, setPending] = React.useState(null);
  const said = spoken.key === key ? spoken : { text: "", mismatch: false };
  const deck = data?.decks?.find((item) => item.id === run.deckId);
  const aiFlash = kind === "flash" && model.ready && !!(data?.courses || []).find((course) => course.name === (deck?.course ?? deck?.folder))?.practice?.aiGradeFlashcards;
  const aiOpen = kind === "open" && (rubricCard || model.ready);
  // `scope`: a transcript that comes back after the learner moved to another question is dropped, never put into (or graded on) that one; moving on while
  // recording stops the microphone. The question's identity, not reviewEntryKey: a queue edit or a resync leaves the same question on screen.
  const scope = voiceScopeKey(run);
  const answer = useVoiceInput({ call, scope, onText: (text) => {
    if (run.feedback) return;
    if (kind === "cloze") {
      const split = splitSpokenBlanks(text, clozeBlankIds(run.card));
      setSpoken({ key, text, mismatch: !!split.mismatch });
      if (split.mismatch) return;
      for (const [id, value] of Object.entries(split.values)) actions.setClozeValue(id, value);
      if (autopilot) setPending({ key, kind: "cloze", values: split.values });
    } else if (kind === "open") {
      const next = entry.response.trim() ? `${entry.response.trimEnd()}\n${text}` : text;
      actions.setResponse(next);
      setSpoken({ key, text, mismatch: false });
      if (autopilot && aiOpen) setPending({ key, kind: "grade", text: next });
    } else if (kind === "flash") {
      actions.setResponse(text);
      setSpoken({ key, text, mismatch: false });
      if (!aiFlash && !run.revealed) actions.flipCard();
    }
  } });
  const ask = useVoiceInput({ call, scope, onText: (text) => setAssistText((current) => (current.trim() ? `${current.trimEnd()} ${text}` : text)) });
  // Submitted only after the text is in the box on screen (a render later): nothing is graded that the learner could not see.
  React.useEffect(() => {
    if (!pending || pending.key !== key) return;
    setPending(null);
    if (pending.kind === "cloze") actions.reviewAct("review.answer", { answers: pending.values });
    else actions.assistCard("grade", pending.text, [], undefined, { quiet: true });
  }, [pending]); // eslint-disable-line react-hooks/exhaustive-deps
  const suggested = kind === "flash" && run.revealed && !run.feedback && said.text ? suggestedGrade(said.text, run.solution?.answer ?? run.card?.answer) : null;
  const root = React.useRef(null);
  // The suggested grade is preselected: its button takes the focus, so Enter or Space confirms it and any other grade is one press away.
  React.useEffect(() => {
    if (suggested === null) return;
    // Quietly: the program chose this button, so its 「快捷键 N」 card stays shut (it covered the neighbouring labels on a phone).
    focusQuietly(root.current?.closest(".question-card")?.querySelectorAll(".grade-scale .grade")[suggested]);
  }, [suggested, key]);
  const voiceable = !!kind && !run.feedback && run.mode !== "exam";
  const keys = {
    voice: () => (voiceable ? answer.toggle() : undefined),
    "voice-ask": () => { setAssistMode("ask"); if (model.ready) ask.toggle(); },
  };
  const gradeTask = (data?.assist || []).filter((task) => task.cardId === run.card?.id && task.mode === "grade").at(-1);
  const canAdjust = !!run.feedback?.rubric && !run.feedback.taskCheck && run.mode !== "exam" && !run.retry && !run.complete;
  return {
    keys, suggested,
    answer: voiceable || said.text ? <VoiceAnswer voice={answer} kind={kind} said={said} run={run} entry={entry} actions={actions} root={root}
      aiOpen={aiOpen && !rubricCard} aiFlash={aiFlash} gradeTask={gradeTask} model={model} /> : null,
    askButton: run.mode !== "exam" ? <VoiceButton voice={ask} label="语音提问" shortcut="Shift+V" /> : null,
    correction: run.feedback ? <CorrectionCard feedback={run.feedback} withRubric={!rubricCard && !!run.feedback.rubric}
      onAdjust={canAdjust ? (grade) => actions.reviewAct("review.grade.adjust", { entryIndex: run.index, grade }) : undefined} /> : null,
    pending: run.correctionsPending > 0 && run.mode !== "exam" ? <CorrectionsPending run={run} onAck={(row) => actions.reviewAct("review.correction.ack", { entryIndex: row.entryIndex, cardId: row.cardId })} /> : null,
  };
}

/** What the voice adds under one question: the button, what was said, and for an open question or an opted-in flashcard the AI grade and its state. */
function VoiceAnswer({ voice, kind, said, run, entry, actions, root, aiOpen, aiFlash, gradeTask, model }) {
  const { busy } = useStudy();
  const grading = !!run.grading;
  const failed = !grading && !run.feedback && gradeTask?.status === "failed";
  const text = kind === "flash" ? said.text : entry.response;
  const offerGrade = !run.feedback && !grading && !!text.trim() && ((aiOpen && !run.revealed) || (aiFlash && !!said.text && !run.revealed));
  return (
    <div ref={root} className="voice-answer" data-tour="review-voice">
      {!run.feedback && !grading && !(kind === "flash" && run.revealed) && <VoiceButton voice={voice} shortcut="V" />}
      {said.mismatch && <InlineMessage tone="info">{uiFormat("没对上每一个空，没有替你填。你说的是：「{0}」。可以照着填，或者按「第一空 …，第二空 …」再说一次。", [said.text])}</InlineMessage>}
      {kind === "flash" && said.text && <p className="voice-said"><span className="voice-said__label">{ui("你说的")}</span>{said.text}</p>}
      {kind === "flash" && run.revealed && !run.feedback && said.text && <p className="muted small">{ui("已按你说的和参考答案的重合，预选了一个分数：按 Enter 确认，或点别的分。")}</p>}
      {offerGrade && <div className="voice-grade">
        <Button size="sm" variant={kind === "flash" ? "primary" : "secondary"} icon="sparkle" lock={busy} onClick={() => actions.assistCard("grade", text, [], undefined, { quiet: true })}>{ui("AI 批改")}</Button>
        {kind === "flash" && <Button size="sm" lock={busy} onClick={actions.flipCard}>{ui("翻面自评")}</Button>}
        <small className="muted">{ui("AI 按参考答案定 2–4 个评分维度逐项打分，并给出订正；也可以照常翻面自评。")}</small>
      </div>}
      {grading && <p className="assist-status" role="status"><Spinner size="sm" />{ui("正在批改…结果出来会显示在这道题下；可以先做别的题。")}</p>}
      {failed && (aiOpen || aiFlash) && <InlineMessage action={model.ready && text.trim() ? { label: ui("重新提交"), onClick: () => actions.assistCard("grade", text, [], undefined, { quiet: true }) } : undefined}>
        {uiFormat("批改没有完成：{0}", [plainAssistFailure(gradeTask.message) || ui("没有拿到具体原因")])}</InlineMessage>}
    </div>
  );
}
