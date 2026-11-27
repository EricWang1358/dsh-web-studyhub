import { ui, uiFormat, errorMessage, getUiLanguage } from "../i18n.js";
import React from "react";
import Markdown from "../Markdown.jsx";
import ChoiceFeedback from "../ChoiceFeedback.jsx";
import Cloze from "../Cloze.jsx";
import CitationDisclosure from "../CitationDisclosure.jsx";
import ExplanationFollowup from "../ExplanationFollowup.jsx";
import { Badge, Button, ChunkedRows, Tooltip } from "../components/index.js";
import { fixedOptionLabel, optionMark } from "../option-label.js";
import OptionMark from "../OptionMark.jsx";
import AnswerState from "./AnswerState.jsx";
import { fixedOptionsOf, hasOptions, isGraded } from "../../lib/card-kinds.js";
import { invalidate, useHostQuery } from "../host-query.js";
import { useStudy } from "../study-context.jsx";
import { AppContext } from "../app/app-context.js";
import { useCopyFeedback } from "../use-copy-feedback.js";
import CorrectionCard from "./CorrectionCard.jsx";
import { companionSlideButtonLabel, openCompanionTarget, resolveCompanionTarget } from "../companions/companion-ref.js";
import { useRescueExperiments } from "../companions/use-rescue-experiments.js";
import { modelReadiness } from "../generation-status.js";
import { rescueGate, rescueNote } from "../wrongbook-model.js";
import { lookBackBlindRecall } from "../../lib/practice-settings.js";
import { isActionableTriage, LOOKBACK_ERROR_REASONS, maskedClozeTextOf, maskedPromptOf, persistRowReason, reasonGroups, reasonLabelOf, resolveRowTriage, rowReasonKey, seedReasonsFromRows, toggleRowReason } from "./lookback-recall.js";

/* 本轮题目 on the result page (#1009): one row per question of the round, read once when the page opens with review.lookBack {runId}
   (lib/contexts/study/round-look-back.js; a read the main chat is refused, so a chat's tool results of the round stay small), and a press on a row opens a
   read-only look-back under it: the question, the answer given, the right answer, the explanation and the Q&A. Opening a row asks the host for nothing, so
   it opens at once and can change no schedule and no clock. An unanswered question shows only itself: its answer waits until it is practised; a question being
   graded (#1031) also shows only itself, with 批改中, until its grade lands. At first only the wrong, unanswered and being-graded rows are listed (all of them
   when there are none), long lists draw in chunks (ChunkedRows). A mock exam has no look-back (its report).
   待看订正 (#1031) comes first when there are any: the misses whose AI grade landed after the learner had moved on, each with its correction and
   我看懂了 · 加入重练 (`onAck(row)`), which sends the round back to that question's retry. */

const STATUS = {
  right: { tone: "success", graded: "答对", self: "达标" },
  wrong: { tone: "error", graded: "答错", self: "未达标" },
  self: { tone: "neutral", graded: "自报", self: "自报" },
  grading: { tone: "neutral", graded: "批改中", self: "批改中" },
  unanswered: { tone: "neutral", graded: "未答", self: "未答" },
};
const ROW_CHUNK = 20;

const pageWords = (row) => row.page == null ? "" : row.unit === "slide" ? uiFormat("第 {0} 张", [row.page])
  : row.unit === "part" ? uiFormat("第 {0} 节", [row.page]) : uiFormat("第 {0} 页", [row.page]);
/** The prompt of a row: in its card when it was answered, alone when it was not. */
const promptOf = (row) => String(row.card?.prompt ?? row.prompt ?? "");
const plainLine = (text) => String(text || "").replace(/\{\{[^{}]+\}\}/g, "＿＿").replace(/[#*_`>$\\]/g, "").replace(/\s+/g, " ").trim();

/** How a row's answer is measured: chosen or filled in (答对 / 答错), or graded by the learner (达标 / 未达标). */
const selfGraded = (row, mode) => mode === "flashcard" || !isGraded(row.kind);

function rowYourAnswerMarkdown(row, mode) {
  const { card, feedback = {} } = row;
  if (card && mode !== "flashcard" && hasOptions(card.kind) && card.options?.length) {
    const pickedIds = new Set(feedback.selected || []);
    const fixed = !!fixedOptionsOf(card.kind);
    return card.options
      .map((opt, idx) => (pickedIds.has(opt.id) ? (fixed ? fixedOptionLabel(card, opt) : `${optionMark(card, opt, idx)}. ${opt.text}`) : null))
      .filter(Boolean)
      .join("；");
  }
  if (card && mode !== "flashcard" && card.kind === "cloze" && feedback.answers && typeof feedback.answers === "object") {
    return Object.values(feedback.answers).map((value) => String(value ?? "").trim()).filter(Boolean).join("；");
  }
  return [
    Number.isInteger(feedback.grade) && !feedback.selfReported ? `${feedback.grade}` : "",
    feedback.note ? String(feedback.note).trim() : "",
  ].filter(Boolean).join(" — ");
}

function rowCorrectAnswerMarkdown(row, mode) {
  const { card, solution } = row;
  if (!solution) return "";
  if (card && mode !== "flashcard" && hasOptions(card.kind) && card.options?.length) {
    const fixed = !!fixedOptionsOf(card.kind);
    return card.options
      .filter((opt) => solution.options?.find((item) => item.id === opt.id)?.correct)
      .map((opt, idx) => (fixed ? fixedOptionLabel(card, opt) : `${optionMark(card, opt, idx)}. ${opt.text}`))
      .join("；");
  }
  if (card && mode !== "flashcard" && card.kind === "cloze" && solution.cloze?.answers?.length) {
    return solution.cloze.answers.map((answer) => answer.value).filter(Boolean).join("；");
  }
  return String(solution.answer || "").trim();
}

/** Format look-back rows with solutions as clean Markdown for copying notes out of a round. */
export function formatLookBackMarkdown(rows = [], translate = ui, options = {}) {
  const sections = [];
  const reasonsByKey = options?.reasonsByKey;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row) continue;
    const mode = row.mode || "";
    const words = STATUS[row.status] || STATUS.wrong;
    const statusText = translate(selfGraded(row, mode) ? words.self : words.graded);
    const titlePrefix = row.number != null ? `${row.number}. ` : "";
    const lines = [`### ${titlePrefix}[${statusText}] ${plainLine(promptOf(row)) || translate("题干尚未填写")}`];
    if (row.solution) {
      const yours = rowYourAnswerMarkdown(row, mode);
      const correct = rowCorrectAnswerMarkdown(row, mode);
      if (yours) lines.push(`**${translate("你的答案")}**：${yours}`);
      if (correct) lines.push(`**${translate("正确答案")}**：${correct}`);
      if (row.solution.explanation) lines.push(`**${translate("解析")}**：${String(row.solution.explanation).trim()}`);
      if (row.solution.misconception) lines.push(`**${translate("易错点")}**：${String(row.solution.misconception).trim()}`);
      if (row.solution.rubric) lines.push(`**${translate("评分依据")}**：${String(row.solution.rubric).trim()}`);
    }
    const reasonLabel = row.status === "wrong" && reasonsByKey ? reasonLabelOf(reasonsByKey[rowReasonKey(row)]) : "";
    if (reasonLabel) lines.push(`**${translate("错因归类")}**：${translate(reasonLabel)}`);
    sections.push(lines.join("\n\n"));
  }
  return sections.join("\n\n---\n\n");
}

function LookBackAnswer({ row, mode }) {
  const { card, solution } = row, feedback = row.feedback || {};
  if (mode !== "flashcard" && hasOptions(card.kind) && card.options?.length) {
    const verdict = !!fixedOptionsOf(card.kind);
    const multiple = Boolean(card.multiple || card.kind === "multi");
    return (
      <>
        <ChoiceFeedback card={card} options={card.options} feedback={feedback} solution={solution} multiple={multiple} />
        <div className="options look-back__options">
          {card.options.map((option, index) => {
            const key = solution.options?.find((item) => item.id === option.id);
            const picked = feedback.selected?.includes(option.id);
            return (
              <div key={option.id} className={"option " + (key?.correct ? "correct" : picked ? "incorrect" : "dim")}>
                <span className="option-letter" aria-hidden={verdict || undefined}><OptionMark card={card} option={option} index={index} /></span>
                <div>
                  {verdict ? <span className="option-verdict">{fixedOptionLabel(card, option)}</span> : <Markdown text={option.text} links={false} className="md-compact" />}
                  <AnswerState correct={key?.correct} picked={picked} multiple={multiple} />
                  {key?.explanation && <Markdown text={key.explanation} links={false} className="md-compact option-explanation" />}
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  }
  if (mode !== "flashcard" && card.kind === "cloze") return <Cloze card={card} values={feedback.answers || {}} onChange={() => {}} disabled details={feedback.details || null} solution={solution} />;
  return (
    <div className="look-back__reference">
      {Number.isInteger(feedback.grade) && !feedback.selfReported && <p className="muted small">{uiFormat("你的自评：{0} 分", [feedback.grade])}</p>}
      {feedback.note && <p className="muted small">{uiFormat("你写的：{0}", [feedback.note])}</p>}
      {solution.answer && <><h4>{ui("参考答案")}</h4><Markdown text={solution.answer} /></>}
    </div>
  );
}

/** Neutral options preview shown while blind-recall veil is active (hides correctness & explanations). */
function VeiledOptions({ card }) {
  const verdict = !!fixedOptionsOf(card.kind);
  return (
    <ul className="look-back__veil-options">
      {card.options.map((option, index) => (
        <li key={option.id} className="look-back__veil-option">
          <span className="look-back__veil-mark" aria-hidden={verdict || undefined}><OptionMark card={card} option={option} index={index} /></span>
          <div>{verdict ? fixedOptionLabel(card, option) : <Markdown text={option.text} links={false} className="md-compact" />}</div>
        </li>
      ))}
    </ul>
  );
}

/** The read-only look-back of one row. */
function LookBack({ row, mode, sources, onOpenSource, veiled = false, onReveal, showReasons = false, reasonId = "", onPickReason, onAsk = null, canAskInPlace = false }) {
  if (!row.solution || row.status === "grading") {
    return (
      <div className="look-back__body">
        <Markdown text={promptOf(row)} />
        <p className="muted small">{row.status === "grading" ? ui("正在批改，分数出来后这里会显示答案和讲解。") : ui("这道题这一轮没有作答，答案留到下次练到时再看。")}</p>
      </div>
    );
  }
  if (veiled) {
    const promptText = maskedPromptOf(row);
    const clozeText = maskedClozeTextOf(row);
    return (
      <div className="look-back__body">
        {promptText && <Markdown text={promptText} />}
        {clozeText && <Markdown text={clozeText} />}
        {mode !== "flashcard" && hasOptions(row.card?.kind) && row.card?.options?.length > 0 && <VeiledOptions card={row.card} />}
        <div className="look-back__veil">
          <span className="muted small">{ui("先在心里回想一遍答案与卡点，再揭晓核对。")}</span>
          <Button size="sm" variant="secondary" onClick={onReveal}>{ui("揭晓答案与解析")}</Button>
        </div>
      </div>
    );
  }
  const isChoice = mode !== "flashcard" && (hasOptions(row.card.kind) || row.card.kind === "cloze");
  return (
    <div className="look-back__body">
      {/* A cloze draws its own sentence with the blanks; anything else shows the question first. */}
      {!(mode !== "flashcard" && row.card.kind === "cloze") && <Markdown text={promptOf(row)} />}
      <LookBackAnswer row={row} mode={mode} />
      {(row.solution.explanation || row.solution.misconception) && (
        <div className="explanation look-back__explanation">
          {row.solution.explanation && <><h4>{ui("理解这道题")}</h4><Markdown text={row.solution.explanation} /></>}
          {row.solution.misconception && <><h4>{ui("容易混淆的地方")}</h4><Markdown text={row.solution.misconception} /></>}
          {!isChoice && row.solution.rubric && <><h4>{row.card.kind === "task" ? ui("验收标准") : ui("评分依据")}</h4><Markdown text={row.solution.rubric} /></>}
        </div>
      )}
      {showReasons && row.status === "wrong" && (
        <div className="look-back__reasons" role="group" aria-label={ui("错因归类")}>
          <span className="muted small">{ui("错因归类")}</span>
          {LOOKBACK_ERROR_REASONS.map((item) => (
            <Button key={item.id} size="sm" variant="quiet" shape="pill" aria-pressed={reasonId === item.id} onClick={() => onPickReason?.(item.id)}>
              {ui(item.label)}
            </Button>
          ))}
        </div>
      )}
      {onOpenSource && <CitationDisclosure card={row.solution} sources={sources} onOpenSource={onOpenSource} />}
      <ExplanationFollowup
        run={{ deckId: row.deckId, card: { id: row.cardId }, solution: row.solution }}
        readOnly={onAsk ? true : !canAskInPlace}
        onAskMore={onAsk ? () => onAsk(row) : null}
      />
      {onAsk && !(row.solution?.followups?.length > 0) && (
        <div className="look-back__ask">
          <Button size="sm" variant="quiet" onClick={() => onAsk(row)}>{ui("追问")}</Button>
        </div>
      )}
    </div>
  );
}

/**
 * props: run (the finished run), sources (optional material list for citations and source jumps),
 * onOpenWrongBook(refs) (optional: the wrong book on these questions, where its rescue is; absent when the page is not available).
 */
export default function RoundLookBack({ run, sources = [], onOpenWrongBook, onOpenBook, onPracticePrereq, onFixQuestion, onAck, onPracticeWrong, onAsk = null, onFollowup = null, segment = null, onSegmentChange, collapsible = false, practiceSettings = null }) {
  const study = useStudy();
  const app = React.useContext(AppContext);
  const appData = app?.data;
  const courses = appData?.courses;
  const settingRecall = lookBackBlindRecall(practiceSettings ?? appData?.settings?.practice);
  const askHandler = onAsk || onFollowup || null;
  const canAskInPlace = !askHandler && typeof study?.call === "function";
  const hasModelField = appData?.model !== undefined || appData?.modelReady !== undefined;
  const generationModelReady = hasModelField ? modelReadiness(appData).ready : true;
  const [compilingConfusable, setCompilingConfusable] = React.useState(null);
  const onRescueCompleted = React.useCallback(() => {
    Promise.resolve(app?.core?.refresh?.()).catch(() => {});
  }, [app?.core]);
  const { jobs: rescueJobs, start: startRescueJob } = useRescueExperiments({ call: study?.call, onCompleted: onRescueCompleted });
  const openSource = study?.openModal ? (source, quote, peekPage) => {
    if (source) study.openModal({ type: "source", source, quote, peekPage, back: true });
  } : null;
  // One read per opening of the result page, shared by any other reader of the same round (ui/host-query.js); nothing for an exam.
  const query = useHostQuery("review.lookBack", { runId: run.id }, { enabled: run.mode !== "exam" });
  // A grade that lands while this page is open (#1031: the run's poll brings the new count) is read again, so its row and 待看订正 show at once.
  const landed = `${run.correctionsPending || 0}:${(run.navigation || []).filter((item) => item.grading).length}`;
  const seen = React.useRef(landed);
  React.useEffect(() => { if (seen.current !== landed) { seen.current = landed; invalidate("review.lookBack", { runId: run.id }); } }, [landed, run.id]);
  const rows = (run.mode !== "exam" && query.data?.rows) || [];
  const needsLook = rows.filter((row) => row.status === "wrong" || row.status === "unanswered" || row.status === "grading");
  const corrections = rows.filter((row) => row.correctionPending);
  const hesitantRows = rows.filter((row) => row.hesitant);
  // Until the learner chooses: the corrections waiting to be read, else the wrong, unanswered and being-graded ones, or all of them when there are none.
  const [chosen, setAll] = React.useState(null);
  const [hesitantOnly, setHesitantOnly] = React.useState(false);
  const view = chosen ?? (corrections.length ? "pending" : needsLook.length ? "some" : "all"), all = view === "all";
  const [open, setOpen] = React.useState(() => new Set());
  const [veilActive, setVeilActive] = React.useState(settingRecall);
  const [recallTried, setRecallTried] = React.useState(settingRecall);
  const [revealedRows, setRevealedRows] = React.useState(() => new Set());
  const [reasonsByKey, setReasonsByKey] = React.useState(() => seedReasonsFromRows(rows));
  const recallEnabled = settingRecall || recallTried;
  const rowsRef = React.useRef(rows);
  rowsRef.current = rows;
  const rowReasonsSignature = rows.map((row) => `${rowReasonKey(row)}=${row?.errorReason || ""}`).join("|");
  const veilResetKey = `${run.id}\0${settingRecall ? 1 : 0}`;
  const lastVeilResetKeyRef = React.useRef(veilResetKey);
  React.useEffect(() => {
    if (lastVeilResetKeyRef.current === veilResetKey) return;
    lastVeilResetKeyRef.current = veilResetKey;
    setVeilActive(settingRecall);
    setRecallTried(settingRecall);
    setRevealedRows(new Set());
  }, [veilResetKey, settingRecall]);
  const reasonsSyncKey = `${run.id}\0${rowReasonsSignature}`;
  const lastReasonsSyncKeyRef = React.useRef(reasonsSyncKey);
  React.useEffect(() => {
    if (lastReasonsSyncKeyRef.current === reasonsSyncKey) return;
    lastReasonsSyncKeyRef.current = reasonsSyncKey;
    setReasonsByKey(seedReasonsFromRows(rowsRef.current));
  }, [reasonsSyncKey]);
  const toggleBlindRecall = () => {
    setVeilActive((prev) => {
      const next = !prev;
      if (next) {
        setRecallTried(true);
        setRevealedRows(new Set());
      }
      return next;
    });
  };
  React.useEffect(() => { if (segment) setHesitantOnly(false); }, [segment]);
  const shown = hesitantOnly
    ? hesitantRows
    : segment
      ? rows.filter((row) => row.status === segment)
      : (view === "pending" ? corrections : all ? rows : needsLook);
  const withSolution = shown.filter((row) => row.solution);
  const expandedWithSolution = withSolution.filter((row) => open.has(row.number));
  const copyTargets = (expandedWithSolution.length ? expandedWithSolution : withSolution).map((row) => (row.mode ? row : { ...row, mode: run.mode }));
  const { copied, copy } = useCopyFeedback(() => formatLookBackMarkdown(copyTargets, ui, recallEnabled ? { reasonsByKey } : undefined));
  if (!rows.length) return null;
  const count = (status) => rows.filter((row) => row.status === status).length;
  const wrong = count("wrong"), unanswered = count("unanswered"), grading = count("grading");
  const wrongRefs = rows.filter((row) => row.status === "wrong").map((row) => ({ deckId: row.deckId, cardId: row.cardId }));
  const allShownOpen = shown.length >= 2 && shown.every((row) => open.has(row.number));
  const pickView = (nextView) => {
    setAll(nextView);
    setHesitantOnly(false);
    onSegmentChange?.(null);
  };
  const toggle = (number) => setOpen((previous) => {
    const next = new Set(previous);
    if (next.has(number)) next.delete(number); else next.add(number);
    return next;
  });
  const toggleAllShown = () => setOpen((previous) => {
    const next = new Set(previous);
    if (allShownOpen) for (const row of shown) next.delete(row.number);
    else for (const row of shown) next.add(row.number);
    return next;
  });
  const sourceForRow = (row) => (
    study?.openModal && Array.isArray(sources) && (row?.sourceId || row?.documentSourceId)
      ? (sources.find((item) => item.id === row.sourceId) || sources.find((item) => item.id === row.documentSourceId) || null)
      : null
  );
  const onKeyDown = (event) => {
    if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
    const target = event.target;
    if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;
    const line = target?.closest?.(".look-back__line");
    if (line && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      const lines = [...event.currentTarget.querySelectorAll(".look-back__line")];
      const index = lines.indexOf(line);
      if (index < 0 || !lines.length) return;
      event.preventDefault();
      const nextIndex = event.key === "ArrowDown" ? Math.min(lines.length - 1, index + 1)
        : event.key === "ArrowUp" ? Math.max(0, index - 1)
        : event.key === "Home" ? 0
        : lines.length - 1;
      lines[nextIndex]?.focus?.();
      return;
    }
    if (event.key === "o" || event.key === "O") {
      const rowEl = target?.closest?.(".look-back__row");
      const num = rowEl?.dataset?.number ? Number(rowEl.dataset.number) : null;
      const focusedRow = num !== null ? shown.find((item) => item.number === num) : null;
      const targetRow = focusedRow || shown.find((item) => open.has(item.number) && sourceForRow(item)) || null;
      const place = sourceForRow(targetRow);
      if (place && study?.openModal) {
        event.preventDefault();
        study.openModal({ type: "source", source: place, back: true });
      }
    }
  };
  const openConfusable = async (triage, row, key) => {
    const pair = triage?.confusable;
    const targetCourse = triage?.course || "";
    const hid = triage?.hid || pair?.hids?.find(Boolean) || row?.hid || "";
    if (pair?.rows?.length && study?.call && study?.openModal) {
      setCompilingConfusable(key);
      try {
        const res = await study.call("companion.compile", {
          confusables: [pair],
          course: targetCourse || undefined,
          ...(hid ? { hid } : {}),
          language: getUiLanguage(),
          mountMode: "companion-only",
        });
        if (res?.companion?.id) {
          openCompanionTarget(study.openModal, {
            companionId: res.companion.id,
            course: res.companion.course || targetCourse || "",
            companionTitle: res.companion.title || "",
            returnLabel: ui("返回本轮结果"),
            from: "review",
          });
          return;
        }
      } catch (failure) {
        if (!onOpenBook) { study?.notify?.({ tone: "error", text: errorMessage(failure) }); return; }
      } finally {
        setCompilingConfusable(null);
      }
    }
    onOpenBook?.({ course: targetCourse, hid, view: "lookup" });
  };
  const rescueTriageRow = async (triage, row) => {
    if (generationModelReady && study?.call) {
      await startRescueJob(row.cardId, {
        course: triage?.course || "",
        deckId: row.deckId,
        cardIds: [row.cardId],
        ...(triage?.hid || row.hid ? { hid: triage?.hid || row.hid } : {}),
        ...(triage?.reason ? { errorReason: triage.reason } : {}),
      });
      return;
    }
    const gate = rescueGate("experiment", { modelReady: false, canChat: false });
    study?.notify?.({ tone: "warning", text: gate.text });
  };
  const fixTriageRow = async (row) => {
    if (onFixQuestion) { await onFixQuestion(row); return; }
    if (!study?.call) return;
    try {
      const res = await study.call("coach.feedback", { deckId: row.deckId, cardId: row.cardId, vote: "down", tags: ["general-quality"] });
      const note = rescueNote("fix", res);
      study?.notify?.({ tone: note.tone, text: note.text });
    } catch (failure) {
      study?.notify?.({ tone: "error", text: errorMessage(failure) });
    }
  };
  const taggedReasons = recallEnabled && onPracticeWrong ? reasonGroups(rows, reasonsByKey) : [];
  const render = (row) => {
    const words = STATUS[row.status] || STATUS.unanswered;
    const expanded = open.has(row.number), regionId = `look-back-${run.id}-${row.number}`;
    const rKey = rowReasonKey(row);
    const isVeiled = recallEnabled && veilActive && row.status === "wrong" && !!row.solution && !revealedRows.has(row.number);
    const revealRow = () => setRevealedRows((previous) => {
      const next = new Set(previous);
      next.add(row.number);
      return next;
    });
    const place = sourceForRow(row);
    const companionTarget = expanded && row.solution && !isVeiled && study?.openModal
      ? resolveCompanionTarget({ card: row.card, solution: row.solution, courses, sources })
      : null;
    const activeTriage = expanded && !isVeiled && row.status === "wrong"
      ? resolveRowTriage(row, reasonsByKey[rKey] || "")
      : null;
    const showTriage = isActionableTriage(activeTriage);
    const rescueState = showTriage && activeTriage.route === "rescue_companion" ? (rescueJobs[row.cardId] || null) : null;
    const rescueRunning = rescueState?.status === "starting" || rescueState?.status === "running";
    const readyRescue = rescueState?.status === "ready" && rescueState?.companionId
      ? { companionId: rescueState.companionId, course: rescueState.course || activeTriage?.course || "", slide: 1, anchor: "#1", companionTitle: rescueState.title || "", lessonMode: "rescue" }
      : (companionTarget?.lessonMode === "rescue" ? companionTarget : null);
    const prereqPractice = onPracticePrereq || onPracticeWrong;
    const prereqRefs = activeTriage?.prereqRefs?.length ? activeTriage.prereqRefs : (activeTriage?.prereq ? [activeTriage.prereq] : []);
    const triageButton = !showTriage ? null
      : activeTriage.route === "confusable_contrast" ? (
        <Button variant="quiet" size="sm" iconEnd="arrow-right" data-triage-route="confusable_contrast"
          busy={compilingConfusable === rKey} lock={study?.busy} disabled={!study?.call && !onOpenBook}
          onClick={() => openConfusable(activeTriage, row, rKey)}>
          {activeTriage.confusable?.id ? uiFormat("对比辨析 {0}", [activeTriage.confusable.id]) : ui("对比辨析易混概念")}
        </Button>
      ) : activeTriage.route === "rescue_companion" ? (
        readyRescue && study?.openModal ? (
          <Button variant="quiet" size="sm" iconEnd="arrow-right" data-triage-route="rescue_companion"
            onClick={() => openCompanionTarget(study.openModal, readyRescue, { returnLabel: ui("返回本轮结果"), from: "review" })}>
            {ui("打开 4 页交互实验")}
          </Button>
        ) : (
          <Button variant="quiet" size="sm" icon="sparkle" data-triage-route="rescue_companion"
            busy={rescueRunning} lock={study?.busy}
            onClick={() => rescueTriageRow(activeTriage, row)}>
            {ui("做一个 4 页交互实验")}
          </Button>
        )
      ) : activeTriage.route === "book_retell" ? (
        <Button variant="quiet" size="sm" iconEnd="arrow-right" data-triage-route="book_retell"
          lock={study?.busy} disabled={!onOpenBook}
          onClick={() => onOpenBook?.({ course: activeTriage.course || "", hid: activeTriage.hid || row.hid || "" })}>
          {ui("去全书讲一遍")}
        </Button>
      ) : activeTriage.route === "prereq_branch" ? (
        <Button variant="quiet" size="sm" iconEnd="arrow-right" data-triage-route="prereq_branch"
          lock={study?.busy} disabled={!prereqRefs.length || !prereqPractice}
          onClick={() => (onPracticePrereq ? onPracticePrereq(prereqRefs, row) : onPracticeWrong?.(prereqRefs))}>
          {ui("先练前置题")}
        </Button>
      ) : activeTriage.route === "fix_question" ? (
        <Button variant="quiet" size="sm" data-triage-route="fix_question"
          lock={study?.busy}
          onClick={() => fixTriageRow(row)}>
          {ui("这题有问题，交给后台修")}
        </Button>
      ) : null;
    const showPlainCompanion = companionTarget && !(showTriage && activeTriage.route === "rescue_companion" && companionTarget.lessonMode === "rescue");
    return (
      <li key={row.number} className="look-back__row" data-status={row.status} data-number={row.number}>
        <Button variant="quiet" className="look-back__line" align="start" aria-expanded={expanded} aria-controls={expanded ? regionId : undefined} onClick={() => toggle(row.number)}>
          <span className="look-back__number">{row.number}</span>
          <Badge size="sm" tone={words.tone}>{ui(selfGraded(row, run.mode) ? words.self : words.graded)}</Badge>
          {row.hinted && <Badge size="sm">{ui("用了提示")}</Badge>}
          {row.correctionPending && <Badge size="sm" tone="warning">{ui("待看订正")}</Badge>}
          {recallEnabled && row.status === "wrong" && reasonsByKey[rKey] && (
            <Badge size="sm">{ui(reasonLabelOf(reasonsByKey[rKey]))}</Badge>
          )}
          {row.hesitant && (
            <Tooltip layer content={uiFormat("用时约 {0} 秒", [Math.round((row.elapsedMs || 0) / 1000)])}>
              <Badge size="sm">{ui("想了较久")}</Badge>
            </Tooltip>
          )}
          <span className="look-back__prompt">{plainLine(promptOf(row)) || ui("题干尚未填写")}</span>
          {row.page != null && <span className="look-back__page muted small">{pageWords(row)}</span>}
        </Button>
        {expanded && (
          <div id={regionId} className="look-back__panel" role="region" aria-label={uiFormat("第 {0} 题回看", [row.number])}>
            <LookBack row={row} mode={run.mode} sources={sources} onOpenSource={openSource}
              veiled={isVeiled} onReveal={revealRow} showReasons={recallEnabled}
              reasonId={reasonsByKey[rKey] || ""}
              onPickReason={(reasonId) => {
                const nextReason = reasonsByKey[rKey] === reasonId ? null : reasonId;
                setReasonsByKey((prev) => toggleRowReason(prev, rKey, reasonId));
                void persistRowReason(study?.call, row, run.id, nextReason).then((res) => {
                  if (res?.updated) invalidate("review.lookBack", { runId: run.id });
                });
              }}
              onAsk={askHandler} canAskInPlace={canAskInPlace} />
            {!isVeiled && row.feedback && <CorrectionCard feedback={row.feedback} withRubric={!!row.feedback.rubric && row.card?.kind !== "task"}
              onAck={row.correctionPending && onAck ? () => Promise.resolve(onAck(row)).then(() => invalidate("review.lookBack")) : undefined} />}
            {!isVeiled && (triageButton || showPlainCompanion || place || (row.status === "wrong" && onOpenWrongBook)) && (
              <div className="look-back__actions">
                {triageButton}
                {showPlainCompanion && (
                  <Button variant="quiet" size="sm" iconEnd="arrow-right" onClick={() => openCompanionTarget(study.openModal, companionTarget)}>
                    {companionSlideButtonLabel(companionTarget)}
                  </Button>
                )}
                {place && (
                  <Button iconEnd="arrow-right" variant="link" size="sm" onClick={() => study.openModal({ type: "source", source: place, back: true })}>
                    {row.sourceTitle && row.page != null
                      ? uiFormat("打开出处「{0}」{1}", [row.sourceTitle, pageWords(row)])
                      : row.sourceTitle
                        ? uiFormat("打开出处「{0}」", [row.sourceTitle])
                        : row.page != null
                          ? uiFormat("打开出处 · {0}", [pageWords(row)])
                          : ui("打开出处")}
                  </Button>
                )}
                {row.status === "wrong" && onOpenWrongBook && (
                  <Button iconEnd="arrow-right" variant="link" size="sm" onClick={() => onOpenWrongBook([{ deckId: row.deckId, cardId: row.cardId }])}>{ui("去错题本练这道题")}</Button>
                )}
              </div>
            )}
          </div>
        )}
      </li>
    );
  };
  const compactFolded = collapsible && wrong === 0 && unanswered === 0 && grading === 0 && corrections.length === 0 && !segment;
  const content = (
    <>
      <div className="round-look-back__head">
        {!compactFolded && (
          <div className="round-look-back__lead">
            <h3>{ui("本轮题目")}</h3>
            <span className="muted small">{[wrong > 0 && uiFormat("错 {0}", [wrong]), unanswered > 0 && uiFormat("未答 {0}", [unanswered]), grading > 0 && uiFormat("批改中 {0}", [grading])].filter(Boolean).join(" · ") || ui("全部过关")}</span>
            {corrections.length > 0 && (view !== "pending" || !!segment || hesitantOnly) && <Button variant="link" size="sm" onClick={() => pickView("pending")}>{uiFormat("待看订正 {0}", [corrections.length])}</Button>}
            {needsLook.length > 0 && needsLook.length < rows.length && (
              <Button variant="link" size="sm" onClick={() => pickView(!segment && !hesitantOnly && view === "some" ? "all" : "some")}>
                {!segment && !hesitantOnly && view === "some" ? uiFormat("显示全部 {0} 题", [rows.length]) : grading ? ui("只看错题、未答和批改中") : ui("只看错题和未答")}
              </Button>
            )}
            {(view === "pending" || !!segment || hesitantOnly) && !(needsLook.length > 0 && needsLook.length < rows.length) && (
              <Button variant="link" size="sm" onClick={() => pickView("all")}>{uiFormat("显示全部 {0} 题", [rows.length])}</Button>
            )}
            {segment && needsLook.length > 0 && needsLook.length < rows.length && (
              <Button variant="link" size="sm" onClick={() => pickView("all")}>{uiFormat("显示全部 {0} 题", [rows.length])}</Button>
            )}
          </div>
        )}
        {/* The header keeps one action beside the list (#1688): 重练错题. The ways to look at the list and to take it away are a quieter row under it. */}
        {onPracticeWrong && wrong >= 1 && (
          <div className="round-look-back__tools">
            <Button iconEnd="arrow-right" size="sm" lock={study?.busy} onClick={() => onPracticeWrong(wrongRefs)}>
              {wrong === 1 ? ui("重练这道错题") : uiFormat("重练这 {0} 道错题", [wrong])}
            </Button>
          </div>
        )}
      </div>
      {/* The quieter row: how the list works in a few words, then two display toggles drawn as toggles (a pill that shows when it is on), then the actions. */}
      <div className="round-look-back__more">
        <span className="muted small round-look-back__hint">{ui("点一道题回看答案和讲解，不改成绩。")}</span>
        {(hesitantRows.length > 0 || shown.length >= 2 || wrong >= 1 || taggedReasons.length > 0 || withSolution.length > 0) && <>
          {wrong >= 1 && (
            <Button className="round-look-back__tool" variant="quiet" size="sm" shape="pill" aria-pressed={veilActive} onClick={toggleBlindRecall}>
              {ui("先遮答案自测")}
            </Button>
          )}
          {hesitantRows.length > 0 && (
            <Button className="round-look-back__tool" variant="quiet" size="sm" shape="pill" aria-pressed={hesitantOnly} onClick={() => { setHesitantOnly((prev) => !prev); onSegmentChange?.(null); }}>
              {uiFormat("只看想了较久 ({0})", [hesitantRows.length])}
            </Button>
          )}
          {shown.length >= 2 && (
            <Button className="round-look-back__tool" variant="quiet" size="sm" onClick={toggleAllShown}>
              {allShownOpen ? ui("全部收起") : ui("全部展开")}
            </Button>
          )}
          {taggedReasons.map((group) => (
            <Button key={group.id} className="round-look-back__tool" iconEnd="arrow-right" size="sm" variant="quiet" lock={study?.busy} onClick={() => onPracticeWrong(group.refs)}>
              {uiFormat("重练「{0}」({1})", [ui(group.label), group.refs.length])}
            </Button>
          ))}
          {withSolution.length > 0 && (
            <Button className="round-look-back__tool" variant="quiet" size="sm" onClick={copy}>
              {copied ? ui("已复制") : ui("复制复盘摘录")}
            </Button>
          )}
        </>}
      </div>
      <ol className="look-back__rows">
        <ChunkedRows items={shown} render={render} chunk={ROW_CHUNK} resetKey={`${view}:${segment || ""}:${hesitantOnly}`} as="li" />
      </ol>
    </>
  );
  if (compactFolded) {
    return (
      <details className="round-look-back round-look-back--compact sh-paper-card" aria-label={ui("本轮题目")} onKeyDown={onKeyDown}>
        <summary className="round-look-back__summary">
          <span className="round-look-back__title">{ui("本轮题目")}</span>
          <span className="muted small">{uiFormat("全部过关 · 共 {0} 题", [rows.length])}</span>
        </summary>
        <div className="round-look-back__content">
          {content}
        </div>
      </details>
    );
  }
  return (
    <section className="round-look-back sh-paper-card" aria-label={ui("本轮题目")} onKeyDown={onKeyDown}>
      {content}
    </section>
  );
}
