import React from "react";
import { ui, uiFormat, uiMessage } from "../i18n.js";
import ModelSetupGate from "../ModelSetupGate.jsx";
import { Button, Chip, SegmentedControl } from "../components/index.js";
import { HELP_CHOICES } from "../agent-prompts/card.js";
import { FixPhraseChips, FixPhraseSave, appendFixPhrase } from "./FixPhrases.jsx";
import { CourseRuleAdd } from "../course-rules/CourseRuleAdd.jsx";
import { useStudyServices } from "../study-context.jsx";
import VoiceButton from "../voice/VoiceButton.jsx";
import { focusInputEnd, useVoiceInput } from "../voice/useVoiceInput.js";

const EMPTY_ASSIST_SEED = { mode: "", text: "", choices: [], relation: "prerequisite", nonce: 0 };

/** Local state & callbacks for the practice assist drawer and in-place explanation ask composer, scoped to the active entryKey. */
export function useAssistPanelState(entryKey, activeEntryKeyRef) {
  const [assistState, setAssistState] = React.useState({ key: "", ...EMPTY_ASSIST_SEED });
  const assistMode = assistState.key === entryKey ? assistState.mode : "";
  const assistSeed = assistState.key === entryKey ? assistState : EMPTY_ASSIST_SEED;
  const assistTextSetterRef = React.useRef(null);
  const setAssistPanel = React.useCallback((mode, { text = "", choices = [], relation = "prerequisite" } = {}) => {
    const key = activeEntryKeyRef.current;
    setAssistState((prev) => ({ key, mode, text, choices, relation, nonce: prev.nonce + 1 }));
  }, [activeEntryKeyRef]);
  const closeAssist = React.useCallback(() => {
    const key = activeEntryKeyRef.current;
    setAssistState((prev) => ({ ...prev, key, mode: "" }));
  }, [activeEntryKeyRef]);
  const setAssistMode = React.useCallback((next) => {
    const key = activeEntryKeyRef.current;
    setAssistState((prev) => {
      const curMode = prev.key === key ? prev.mode : "";
      const resolved = (typeof next === "function" ? next(curMode) : next) || "";
      if (prev.key === key && curMode === resolved) return prev;
      return { key, mode: resolved, text: "", choices: [], relation: "prerequisite", nonce: prev.nonce + 1 };
    });
  }, [activeEntryKeyRef]);
  const setAssistTextForVoice = React.useCallback((updater) => {
    if (assistTextSetterRef.current) {
      assistTextSetterRef.current(updater);
      return;
    }
    const key = activeEntryKeyRef.current;
    setAssistState((prev) => {
      const curText = prev.key === key ? prev.text : "";
      const nextText = typeof updater === "function" ? updater(curText) : updater;
      return { ...prev, key, text: nextText, nonce: prev.nonce + 1 };
    });
  }, [activeEntryKeyRef]);
  const [inlineAskState, setInlineAskState] = React.useState({ key: "", open: false });
  const inlineAskOpen = inlineAskState.key === entryKey && inlineAskState.open;
  return {
    assistMode, assistSeed, assistTextSetterRef, setAssistPanel, closeAssist, setAssistMode,
    setAssistTextForVoice, setInlineAskState, inlineAskOpen,
  };
}

/** Assist form view owning its own typing/chip state so keystrokes never re-render QuestionRun. */
export function AssistFormPanelView({
  mode, seed, run, model, modelSettings, feedback,
  fixPhrases, courseRules, voiceAskButton,
  reviewBodyRef, textSetterRef, copy, submitAssistAct, renderThinkingField, onClose, onOpenSocratic,
}) {
  const [assistText, setAssistText] = React.useState(seed.text || "");
  const [thinkingNote, setThinkingNote] = React.useState("");
  const [helpChoices, setHelpChoices] = React.useState(seed.choices || []);
  const [deriveRelation, setDeriveRelation] = React.useState(seed.relation || "prerequisite");
  const inputRef = React.useRef(null);
  const lastNonceRef = React.useRef(seed.nonce);
  React.useEffect(() => {
    if (lastNonceRef.current === seed.nonce) return;
    lastNonceRef.current = seed.nonce;
    setAssistText(seed.text || "");
    setThinkingNote("");
    setHelpChoices(seed.choices || []);
    setDeriveRelation(seed.relation || "prerequisite");
  }, [seed]);
  React.useEffect(() => {
    if (!textSetterRef) return undefined;
    const setFromVoice = (updater) => {
      setAssistText(updater);
      focusInputEnd(inputRef);
    };
    textSetterRef.current = setFromVoice;
    return () => { if (textSetterRef.current === setFromVoice) textSetterRef.current = null; };
  }, [textSetterRef]);

  if (!mode) return null;
  if (!model.ready) {
    return (
      <div className="assist-form assist-gate">
        <ModelSetupGate variant="inline" feature={mode === "derive" ? "generate" : "welcome"} model={model} onOpenSettings={modelSettings} />
        <div className="action-feedback-slot assist-form__feedback">{feedback}</div>
        <div className="assist-actions">
          <Button size="sm" className="assist-actions__btn" onClick={onClose}>{ui("取消")}</Button>
        </div>
      </div>
    );
  }
  const trimmedNote = mode === "ask" ? thinkingNote.trim().slice(0, 200) : "";
  const canSubmitAssist = !!assistText.trim() || (mode === "ask" && (helpChoices.length > 0 || !!trimmedNote));
  const submitAssist = async () => {
    const trimmed = assistText.trim();
    if (!trimmed && !(mode === "ask" && (helpChoices.length || trimmedNote))) return;
    const originChoices = mode === "ask" ? [...helpChoices] : [];
    const originExtra = mode === "derive" ? { relation: deriveRelation } : (mode === "ask" && trimmedNote ? { thinkingNote: trimmedNote } : undefined);
    const done = await submitAssistAct(mode, trimmed, originChoices, originExtra);
    if (!done) return;
    setAssistText("");
    setThinkingNote("");
    setHelpChoices([]);
    onClose();
  };
  return (
    <form
      className="assist-form"
      onSubmit={async (event) => {
        event.preventDefault();
        await submitAssist();
      }}
    >
      {mode === "ask" && onOpenSocratic && run.mode !== "exam" && (
        <div className="assist-drawer-mode">
          <SegmentedControl
            size="sm"
            label={ui("助学方式")}
            value="ask"
            onChange={(next) => { if (next === "socratic") onOpenSocratic(); }}
            options={[
              { value: "ask", label: ui("AI 帮我理解") },
              { value: "socratic", label: ui("苏格拉底带学") },
            ]}
          />
        </div>
      )}
      {mode === "ask" && <>
        <strong>{ui("想从哪里弄懂？可多选")}</strong>
        <div className="assist-quick-choices" role="group" aria-label={ui("帮助方式")}>
          {HELP_CHOICES.filter((choice) => choice.id !== "mistake" || run.feedback).map((choice) =>
            <Chip key={choice.id} selected={helpChoices.includes(choice.id)}
              onClick={() => setHelpChoices((items) => items.includes(choice.id)
                ? items.filter((item) => item !== choice.id) : [...items, choice.id])}>
              {ui(choice.label)}
            </Chip>)}
        </div>
      </>}
      {mode === "derive" && <SegmentedControl size="sm" className="assist-quick-choices" label={ui("出成什么题")} value={deriveRelation} onChange={setDeriveRelation}
        options={[{ value: "prerequisite", label: ui("这道题的前置题") }, { value: "standalone", label: ui("一道独立的新题") }]} />}
      {mode === "improve" && <>
        <strong>{ui("不知道怎么说？点一个，或者让助教自己检查")}</strong>
        <FixPhraseChips phrases={fixPhrases.phrases}
          onPick={(picked) => setAssistText((current) => appendFixPhrase(current, picked))}
          onRemove={fixPhrases.remove} />
      </>}
      {renderThinkingField(mode, thinkingNote, setThinkingNote, (
        <label className="assist-form__field">
          {mode === "ask" ? ui("补充你自己的疑问（可选）") : mode === "derive" ? ui("根据哪个知识点出题？写下来，后台助教会出成一道题，放进同一题组") : copy.improveLabel()}
          <textarea ref={inputRef} className="assist-form__input" autoFocus rows={2} value={assistText} maxLength={1000}
            placeholder={mode === "ask" ? ui("例如：不懂为什么重试会放大负载") : mode === "derive" ? ui("例如：什么是聚合根；为什么重试要幂等") : ui("例如：选项 B 和 C 说的是一回事；解析没说清为什么 A 错")}
            onChange={(event) => setAssistText(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                if (!canSubmitAssist) return;
                event.preventDefault();
                submitAssist();
              } else if (event.key === "Escape" && !assistText.trim()) {
                event.preventDefault();
                event.stopPropagation();
                const selector = mode === "ask" ? '[data-tour="review-help"]'
                  : mode === "improve" ? '[data-tour="review-improve"]'
                  : ".question-card";
                onClose();
                const body = reviewBodyRef.current;
                const target = body?.querySelector?.(selector) || body?.querySelector?.(".question-card");
                target?.focus?.({ preventScroll: true });
              }
            }} />
        </label>
      ))}
      {mode === "improve" && <FixPhraseSave phrases={fixPhrases.phrases} text={assistText} onSave={fixPhrases.add} />}
      {mode === "improve" && <CourseRuleAdd courseRules={courseRules} text={assistText} />}
      <div className="action-feedback-slot assist-form__feedback">{feedback}</div>
      <div className="assist-actions">
        <Button type="submit" variant="primary" size="sm" className="assist-actions__btn"
          disabled={!canSubmitAssist}>{ui("提交到后台")}</Button>
        {assistText.trim() && (
          <Button variant="quiet" size="sm" className="assist-actions__btn" onClick={() => setAssistText("")}>
            {ui("清空")}
          </Button>
        )}
        <Button size="sm" className="assist-actions__btn" onClick={onClose}>{ui("取消")}</Button>
        {mode === "ask" && voiceAskButton}
      </div>
      {mode === "ask" && <p className="muted small">{copy.askNote()}</p>}
    </form>
  );
}

const INLINE_ASK_CHIPS = HELP_CHOICES.filter((c) => ["plain", "example", "steps", "mistake"].includes(c.id));

/** In-place follow-up composer at the bottom of the explanation so learners never need to scroll back up to ask why. */
export function InlineExplanationAskView({
  open, hasFollowups, hasFeedback, entryKey, activeEntryKeyRef, model, modelSettings, assistAct, onExpand, onClose,
}) {
  const { call } = useStudyServices();
  const [text, setText] = React.useState("");
  const [choices, setChoices] = React.useState([]);
  const [submitting, setSubmitting] = React.useState(false);
  const inputRef = React.useRef(null);
  const voice = useVoiceInput({
    call,
    scope: entryKey,
    onText: (spoken) => {
      setText((current) => (current.trim() ? `${current.trimEnd()} ${spoken}` : spoken));
      focusInputEnd(inputRef);
    },
  });
  const { cancel: cancelVoice } = voice;
  const prevOpenRef = React.useRef(open);
  React.useEffect(() => {
    if (prevOpenRef.current && !open) cancelVoice();
    prevOpenRef.current = open;
  }, [open, cancelVoice]);
  React.useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus?.({ preventScroll: true }));
  }, [open]);

  if (!open) {
    if (hasFollowups) return null;
    return (
      <div className="explanation-inline-ask">
        <Button variant="quiet" size="sm" onClick={onExpand}>{ui("还有疑问？就地追问")}</Button>
      </div>
    );
  }
  if (!model.ready) {
    return (
      <div className="explanation-inline-ask explanation-inline-ask--open">
        <ModelSetupGate variant="inline" feature="welcome" model={model} onOpenSettings={modelSettings} />
        <div className="assist-actions">
          <Button size="sm" variant="quiet" onClick={onClose}>{ui("取消")}</Button>
        </div>
      </div>
    );
  }
  const canSubmit = !submitting && (!!text.trim() || choices.length > 0);
  const submit = async () => {
    const trimmed = text.trim();
    if (submitting || (!trimmed && !choices.length)) return;
    const originKey = entryKey;
    const originChoices = [...choices];
    setSubmitting(true);
    try {
      const ok = await assistAct("ask", trimmed, originChoices);
      if (ok && activeEntryKeyRef.current === originKey) {
        setText("");
        setChoices([]);
        onClose();
      }
    } finally {
      if (activeEntryKeyRef.current === originKey) setSubmitting(false);
    }
  };
  return (
    <form className="explanation-inline-ask explanation-inline-ask--open" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <div className="assist-quick-choices" role="group" aria-label={ui("追问方向")}>
        {INLINE_ASK_CHIPS.filter((c) => c.id !== "mistake" || hasFeedback).map((c) => (
          <Chip key={c.id} selected={choices.includes(c.id)}
            onClick={() => setChoices((items) => items.includes(c.id) ? items.filter((item) => item !== c.id) : [...items, c.id])}>
            {ui(c.label)}
          </Chip>
        ))}
      </div>
      <label className="assist-form__field">
        {ui("写下你对解析的疑问（可选）")}
        <textarea ref={inputRef} className="assist-form__input" rows={2} maxLength={1000} value={text}
          placeholder={ui("例如：这一步的推导前提是什么？")}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent?.isComposing || event.keyCode === 229) return;
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              if (!canSubmit) return;
              event.preventDefault();
              void submit();
            } else if (event.key === "Escape" && !text.trim()) {
              event.preventDefault();
              event.stopPropagation();
              onClose();
            }
          }} />
      </label>
      <div className="assist-actions">
        <Button type="submit" variant="primary" size="sm" busy={submitting} disabled={!canSubmit}>{ui("提交追问")}</Button>
        <Button size="sm" variant="quiet" onClick={onClose}>{ui("取消")}</Button>
        <VoiceButton voice={voice} label="语音提问" />
      </div>
    </form>
  );
}

/** Calm post-answer cue when the learner has missed this card repeatedly (stubborn / leech). */
export function StubbornCue({ stubborn, onAsk, onImprove }) {
  return (
    <div className="stubborn-cue" role="status" data-leech={stubborn.isLeech ? "true" : undefined}>
      <span className="stubborn-cue__text">
        {stubborn.isLeech
          ? uiFormat("已累计答错 {0} 次 · 顽固题", [stubborn.missCount])
          : uiFormat("这道题已累计答错 {0} 次", [stubborn.missCount])}
      </span>
      <span className="stubborn-cue__actions">
        <Button variant="link" size="sm" onClick={onAsk}>{ui("拆解这道题")}</Button>
        <Button variant="link" size="sm" onClick={onImprove}>{ui("检查题目质量")}</Button>
      </span>
    </div>
  );
}

/** Failed / no-change background-assistant status banner under the question card. */
export function AssistTaskStatus({
  runningTask, lastTask, assistMode, dismissedTaskId, modelReady, modelSettings,
  assistAct, setAssistPanel, setDismissedTaskId, FailureView,
}) {
  const canEditLastTask = !!(lastTask && (lastTask.mode === "ask" || lastTask.mode === "improve" || (lastTask.mode === "derive" && !lastTask.followupId)));
  const editLastTask = () => {
    setAssistPanel(lastTask.mode, {
      text: lastTask.question || "",
      choices: lastTask.mode === "ask" ? lastTask.choices || [] : [],
      relation: lastTask.mode === "derive" ? lastTask.relation || "prerequisite" : "prerequisite",
    });
    setDismissedTaskId(lastTask.id);
  };
  if (!runningTask && lastTask?.status === "failed") {
    return (
      <FailureView task={lastTask} modelReady={modelReady} onSettings={modelSettings}
        onResubmit={() => assistAct(lastTask.mode, lastTask.question || "", lastTask.mode === "ask" ? lastTask.choices || [] : [],
          lastTask.mode === "derive" ? { relation: lastTask.relation, followupId: lastTask.followupId }
            : lastTask.mode === "terms" ? { terms: lastTask.terms || [] } : undefined)}
        onEdit={canEditLastTask ? editLastTask : null} />
    );
  }
  if (!runningTask && !assistMode && lastTask?.status === "done" && (lastTask.outcome === "no-change" || lastTask.outcome === "unlinked") && dismissedTaskId !== lastTask.id) {
    return (
      <div className="assist-status" role="status">
        <p>{uiMessage(lastTask.message)}</p>
        <div className="assist-actions">
          {canEditLastTask && <Button className="assist-actions__btn" size="sm" onClick={editLastTask}>{ui("改一改再提交")}</Button>}
          <Button className="assist-actions__btn" size="sm" variant="quiet" onClick={() => setDismissedTaskId(lastTask.id)}>{ui("知道了")}</Button>
        </div>
      </div>
    );
  }
  return null;
}
