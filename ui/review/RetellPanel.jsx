import React, { useState } from "react";
import { errorMessage, ui, uiFormat, uiLocale } from "../i18n.js";
import { Button, Icon, InlineMessage, Tooltip } from "../components/index.js";
import ModelSetupGate from "../ModelSetupGate.jsx";
import ModelErrorNote from "../ModelErrorNote.jsx";
import { describeModelError } from "../generation-status.js";
import { useStudy } from "../study-context.jsx";
import { browserSession, readText, removeKey, writeText } from "../storage.js";
import { useInjectCss } from "../shared.js";
import VoiceButton from "../voice/VoiceButton.jsx";
import { focusInputEnd, useVoiceInput } from "../voice/useVoiceInput.js";
import css from "./learning-loop.css";

/* 用自己的话讲一遍 (#1016): the learner explains a question (teach.retell) or a 复习全书 point (book.retell) in their own words, and the AI says what was right,
   what was left out and what was wrong, with a way to the source. One model call per press, booked in 模型用量 like every instant request. It is AI feedback,
   not a grade. The library keeps only an aggregate (how often, how often clear, the last gap): the text stays in this tab (sessionStorage) until a check
   succeeds, so a failure or a reload loses nothing, and it is never sent anywhere to be kept. */

const DRAFT = "studyhub:retell:";
const MAX = 4000;
const PARTS = [["right", "讲对了的"], ["missed", "漏掉的"], ["wrong", "讲错的"]];

/** 讲清楚过 ✓ of a point or question: the aggregate (`retold`: { tries, passes, gap, at }) once an explanation was clear. */
export function RetoldMark({ retold }) {
  useInjectCss(css, "study-learning-loop");
  if (!(retold?.passes > 0)) return null;
  return (
    <Tooltip content={uiFormat("用自己的话讲过 {0} 次，其中 {1} 次 AI 认为讲清楚了。", [retold.tries, retold.passes])}>
      <span className="retold-mark" data-retold=""><Icon className="sh-icon--inline" name="check" />{ui("讲清楚过")}</span>
    </Tooltip>
  );
}

/**
 * op: 'teach.retell' | 'book.retell'; args: what names the question or the point; draftKey: where this target's unsent text lives;
 * model: modelReadiness(); onModelSettings; onSource(cite): opens the source (cite: the verdict's citation index, or null), absent = no link;
 * onDone(answer): after a check (the answer carries `record`, the new aggregate).
 */
export default function RetellPanel({ op, args, draftKey, model, onModelSettings, onSource, onDone, onClose }) {
  useInjectCss(css, "study-learning-loop");
  const { call } = useStudy();
  const storeKey = DRAFT + draftKey;
  const [text, setText] = useState(() => readText(storeKey, "", browserSession()));
  const [lastSubmittedText, setLastSubmittedText] = useState("");
  const [checking, setChecking] = useState(false);
  const [answer, setAnswer] = useState(null);
  const [failure, setFailure] = useState("");
  const inputRef = React.useRef(null);
  const textRef = React.useRef(text);
  textRef.current = text;
  const mountedRef = React.useRef(true);
  const activeKeyRef = React.useRef(storeKey);
  activeKeyRef.current = storeKey;
  const prevStoreKeyRef = React.useRef(storeKey);
  const reqIdRef = React.useRef(0);
  React.useEffect(() => () => { mountedRef.current = false; }, []);
  React.useEffect(() => {
    if (prevStoreKeyRef.current === storeKey) return;
    prevStoreKeyRef.current = storeKey;
    reqIdRef.current += 1;
    const nextDraft = readText(storeKey, "", browserSession());
    textRef.current = nextDraft;
    setText(nextDraft);
    setLastSubmittedText("");
    setChecking(false);
    setAnswer(null);
    setFailure("");
  }, [storeKey]);
  const unread = ui("这次没有拿到 AI 的反馈，写的内容还在，可以再试一次。");
  const edit = (value) => { textRef.current = value; setText(value); if (value) writeText(storeKey, value, browserSession()); else removeKey(storeKey, browserSession()); };
  const voice = useVoiceInput({
    call,
    scope: storeKey,
    onText: (spoken) => {
      const current = textRef.current;
      edit(current.trim() ? `${current.trimEnd()} ${spoken}` : spoken);
      focusInputEnd(inputRef);
    },
  });

  async function submit(event) {
    event?.preventDefault();
    const submitted = textRef.current.trim();
    if (!submitted || checking) return;
    const originKey = storeKey;
    const reqId = ++reqIdRef.current;
    setChecking(true);
    setFailure("");
    try {
      const result = await call(op, { ...args, text: submitted, language: uiLocale().startsWith("en") ? "en" : "zh" });
      if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
      setLastSubmittedText(submitted);
      setAnswer(result);
      // Only clear the draft if the learner did not edit it while checking was in flight.
      if (textRef.current.trim() === submitted) {
        removeKey(originKey, browserSession());
        textRef.current = "";
        setText("");
      }
      onDone?.(result);
    } catch (error) {
      if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
      setFailure(errorMessage(error) || unread);
    } finally {
      if (mountedRef.current && activeKeyRef.current === originKey && reqIdRef.current === reqId) setChecking(false);
    }
  }

  if (!model?.ready) return <div className="retell-panel"><ModelSetupGate variant="inline" feature="welcome" model={model} onOpenSettings={onModelSettings} /></div>;
  const known = failure && describeModelError(failure).kind !== "unknown";
  const drafting = !answer || Boolean(text.trim());
  return (
    <section className="retell-panel" aria-label={ui("用自己的话讲一遍")} data-retell-drafting={drafting ? "" : undefined}>
      <form onSubmit={submit}>
        <label className="retell-panel__field">
          <span>{ui("不看讲解，用自己的话把这个知识点讲一遍：是什么、为什么、什么时候用。")}</span>
          <textarea ref={inputRef} className="retell-panel__input" rows={4} maxLength={MAX} value={text} autoFocus onChange={(event) => edit(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent?.isComposing || event.isComposing || event.keyCode === 229) return;
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter" && !event.shiftKey && !event.altKey) {
                if (text.trim() && !checking) {
                  event.preventDefault();
                  submit();
                }
                return;
              }
              if (event.key === "Escape" && !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && !text.trim()) {
                event.preventDefault();
                event.stopPropagation();
                const cardEl = event.currentTarget.closest?.(".question-card") || event.currentTarget.closest?.(".review-body")?.querySelector?.(".question-card");
                const panel = event.currentTarget.closest?.(".retell-panel");
                const prev = panel?.previousElementSibling;
                const trigger = prev?.querySelector?.('[data-usage="review.retell"], .book-point__retell') || prev?.querySelector?.("button");
                onClose?.();
                requestAnimationFrame(() => {
                  if (trigger?.isConnected) trigger.focus({ preventScroll: true });
                  else if (cardEl?.focus) cardEl.focus({ preventScroll: true });
                  else inputRef.current?.blur?.();
                });
              }
            }}
            placeholder={ui("它讲的是……；之所以这样，是因为……；在……的时候用。")} />
        </label>
        <p className="retell-panel__note">{ui("AI 反馈用于帮你查漏，不是评分。每次检查约 1 次模型调用；只记下讲清楚的次数，不保存你写的内容。")}</p>
        <div className="retell-panel__actions">
          <VoiceButton voice={voice} />
          <Button type="submit" variant="primary" size="sm" busy={checking} disabled={!text.trim()}>{ui("让 AI 看看")}</Button>
        </div>
      </form>
      {failure && (known
        ? <div className="retell-panel__failure"><ModelErrorNote error={failure} context="assist" onSettings={onModelSettings} />
          <Button size="sm" onClick={submit}>{ui("再试一次")}</Button></div>
        // Any other failure (an unreadable reply, a refusal) is said in the learner's language; the raw reason stays as the detail.
        : <InlineMessage tone="error" title={unread} action={{ label: ui("再试一次"), onClick: submit }}>
          {failure !== unread && <span className="retell-panel__detail">{failure}</span>}</InlineMessage>)}
      {answer && !checking && (
        <div className="retell-result" role="status">
          <p className="retell-result__head">{answer.passed ? ui("讲清楚了。") : ui("还差一点，看看下面漏掉或讲错的地方，再讲一遍。")}</p>
          {PARTS.map(([part, label]) => (
            <div key={part} className="retell-result__part" data-part={part}>
              <h4>{ui(label)}</h4>
              {answer[part]?.length ? <ul>{answer[part].map((item, index) => <li key={index}>{item}</li>)}</ul> : <p className="retell-result__none">{ui("没有")}</p>}
            </div>
          ))}
          {answer.missed?.length > 0 && !text.trim() && lastSubmittedText && (
            <Button size="sm" variant="secondary" className="retell-result__restore" onClick={() => {
              edit(lastSubmittedText);
              requestAnimationFrame(() => inputRef.current?.focus());
            }}>{ui("对照漏点再补一句")}</Button>
          )}
          {onSource && <Button variant="link" size="sm" iconEnd="arrow-right" className="retell-result__source" onClick={() => onSource(answer.cite ?? null)}>{ui("去原文看这段")}</Button>}
        </div>
      )}
    </section>
  );
}
