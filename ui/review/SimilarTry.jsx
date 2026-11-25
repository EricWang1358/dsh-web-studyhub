import React, { useContext, useEffect, useRef, useState } from "react";
import { ui, uiFormat } from "../i18n.js";
import { Badge, Button, InlineMessage, Spinner, Tooltip } from "../components/index.js";
import ModelSetupGate from "../ModelSetupGate.jsx";
import { useStudy, useStudyBusy } from "../study-context.jsx";
import { AppContext } from "../app/app-context.js";
import { reviewEntryKey } from "../async.js";
import { useInjectCss } from "../shared.js";
import css from "./learning-loop.css";

/* 试一道同类题 (#1015): after a wrong answer, one press finds a similar question that already exists (the wrong book's finder, review.similar, no model) and
   practises it as a detour of its own (the prerequisites' way: a one-question round with returnTo, whose result page offers 回到原题 as its main button), so
   the round here is not touched: nothing is added to 待答 and 到此为止 still ends this round only. With nothing found it offers 生成一道变式: the background
   assistant's 出题 (derive, standalone) behind the model gate, one model call, the new question in the same deck; once written, one press practises it the
   same way. Shown under the explanation (ui/review/LearningActions.jsx) and on the finished 逐步理解 panel. */

/** Whether the question on screen was answered wrong (a choice, a grade under 3). */
export const answeredWrong = (run) => !!run?.feedback && (run.feedback.correct === false || run.feedback.grade < 3);

/** The variant 生成一道变式 asked for this question of this round: the latest standalone 出题 of the task list made from this round for this card (deck and
 *  card), without a Q&A behind it (把问答出成独立题 always has one). Read from the tasks, so it is still there after a reload. */
export const variantTask = (tasks, run) => (tasks || []).filter((task) => task.mode === "derive" && task.relation === "standalone" && !task.followupId
  && task.runId === run.id && task.deckId === run.deckId && task.cardId === run.card?.id).at(-1) ?? null;

/**
 * Inline list of similar questions (#1319): highlights the original question (`data-similar-origin="true"`)
 * with a direct 「回到原题」 action, supports multi-hop selection, and handles Esc to step back.
 */
export function SimilarQuestionsList({
  originCard = null,
  items = [],
  activeCardId = "",
  onSelectItem,
  onRestoreOriginal,
  onClose,
}) {
  const busy = useStudyBusy();
  return (
    <div
      className="similar-list"
      data-similar-list=""
      role="region"
      aria-label={ui("同类题列表")}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          if (typeof onClose === "function") onClose();
          else onRestoreOriginal?.();
        }
      }}
    >
      <div className="similar-list__head">
        <strong className="similar-list__title">{ui("同类题列表")}</strong>
        <div className="similar-list__head-actions">
          {typeof onRestoreOriginal === "function" && (
            <Button size="sm" variant="secondary" icon="arrow-left" lock={busy} onClick={onRestoreOriginal}>
              {ui("回到原题")}
            </Button>
          )}
          {typeof onClose === "function" && (
            <Button size="sm" variant="quiet" onClick={onClose}>{ui("收起")}</Button>
          )}
        </div>
      </div>
      <ul className="similar-list__rows">
        {originCard && (
          <li className="similar-list__item is-origin" data-similar-origin="true">
            <div className="similar-list__meta">
              <Badge size="sm" tone="info">{ui("原题")}</Badge>
              <span className="similar-list__prompt">{originCard.prompt || originCard.topic || originCard.cardId}</span>
            </div>
            {typeof onRestoreOriginal === "function" && (
              <Button size="sm" variant="quiet" icon="arrow-left" lock={busy} onClick={onRestoreOriginal}>
                {ui("回到原题")}
              </Button>
            )}
          </li>
        )}
        {items.map((item) => {
          const isCurrent = Boolean(activeCardId && item.cardId === activeCardId);
          return (
            <li key={`${item.deckId}:${item.cardId}`} className={`similar-list__item${isCurrent ? " is-current" : ""}`} data-similar-item={item.cardId}>
              <div className="similar-list__meta">
                {item.topic && <Badge size="sm" tone="neutral">{item.topic}</Badge>}
                <span className="similar-list__prompt">{item.prompt || item.topic || item.cardId}</span>
              </div>
              {isCurrent ? (
                <Badge size="sm" tone="neutral">{ui("当前题")}</Badge>
              ) : (
                <Button size="sm" variant="quiet" lock={busy} onClick={() => onSelectItem?.(item)}>
                  {ui("做这道题")}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** session: useReviewSession(); data: the snapshot (assist tasks); model: modelReadiness(data); onModelSettings: the way to the model settings. */
export default function SimilarTry({ session, data, model, onModelSettings }) {
  useInjectCss(css, "study-learning-loop");
  const { call, busy } = useStudy();
  const app = useContext(AppContext);
  const learn = app?.learn;
  const { run, actions } = session;
  const key = reviewEntryKey(run);
  const [state, setState] = useState({ key: "", kind: "idle", message: "", items: [], listOpen: false });
  const activeKeyRef = useRef(key);
  activeKeyRef.current = key;
  const mountedRef = useRef(true);
  const reqIdRef = useRef(0);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const here = state.key === key ? state : { kind: "idle", message: "", items: [], listOpen: false };
  const inSimilarDetour = Boolean(run?.similarFor);
  if (run?.mode === "exam") return null;
  if (!inSimilarDetour && (!answeredWrong(run) || run?.returnTo)) return null;
  const origin = run.similarFor || { deckId: run.deckId, cardId: run.card.id };
  const originDeck = inSimilarDetour ? (data?.decks || []).find((deck) => deck.id === origin.deckId) : null;
  const originCardFromData = originDeck?.cards?.find((card) => card.id === origin.cardId) || null;
  const originCardInfo = learn?.practiceOrigin
    ? { deckId: learn.practiceOrigin.deckId, cardId: learn.practiceOrigin.cardId, prompt: learn.practiceOrigin.prompt, topic: learn.practiceOrigin.topic }
    : originCardFromData
      ? { deckId: origin.deckId, cardId: origin.cardId, prompt: originCardFromData.prompt || "", topic: originCardFromData.topic || "" }
      : { deckId: origin.deckId, cardId: origin.cardId, prompt: run.card?.prompt || "", topic: run.card?.topic || "" };
  const originPrompt = inSimilarDetour
    ? String(originCardInfo.prompt || "").replace(/\s+/g, " ").trim().slice(0, 60)
    : "";

  const detour = (cardId, deckId = run.deckId) => {
    learn?.pushPracticeContext?.({ originKind: "similar" });
    return actions.studyPrerequisites([{ deckId, cardId }], { similarFor: origin });
  };
  const canRestoreOriginal = Boolean(inSimilarDetour && (learn?.practiceOrigin || run.returnTo));
  const restoreOriginal = () => (learn?.practiceOrigin ? learn.returnToOriginalPractice() : actions.returnToOrigin?.());
  const variant = variantTask(data?.assist, run);
  // A variant that failed, or ended without a new question (the assistant found nothing to write), is not the end: 生成一道变式 is offered again.
  const variantReady = variant?.status === "done" && !!variant.resultCardId, variantRunning = variant?.status === "running";
  const variantMissed = !!variant && !variantReady && !variantRunning;

  async function find() {
    const originKey = key;
    const reqId = ++reqIdRef.current;
    setState({ key: originKey, kind: "finding", message: "", items: here.items || [], listOpen: false });
    try {
      const res = await call("review.similar", { runId: run.id, cardId: run.card.id });
      const item = res?.item ?? null;
      const items = Array.isArray(res?.items) ? res.items : (item ? [item] : []);
      if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
      if (item) { setState({ key: originKey, kind: "idle", message: "", items, listOpen: false }); await detour(item.cardId, item.deckId); }
      else setState({ key: originKey, kind: "none", message: "", items: [], listOpen: false });
    } catch (failure) {
      if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
      setState({ key: originKey, kind: "failed", message: failure?.message || ui("没能查找同类题，可以再试一次。"), items: [], listOpen: false });
    }
  }
  async function toggleSimilarList() {
    const originKey = key;
    if (here.listOpen) {
      setState((prev) => ({ ...prev, key: originKey, listOpen: false }));
      return;
    }
    const reqId = ++reqIdRef.current;
    setState({ key: originKey, kind: "finding", message: "", items: here.items || [], listOpen: false });
    try {
      const res = await call("review.similar", { runId: run.id, cardId: run.card.id, limit: 6 });
      const items = Array.isArray(res?.items) ? res.items : (res?.item ? [res.item] : []);
      if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
      if (items.length) setState({ key: originKey, kind: "idle", message: "", items, listOpen: true });
      else setState({ key: originKey, kind: "none", message: "", items: [], listOpen: false });
    } catch (failure) {
      if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
      setState({ key: originKey, kind: "failed", message: failure?.message || ui("没能查找同类题，可以再试一次。"), items: [], listOpen: false });
    }
  }
  async function generate() {
    const originKey = key;
    if (!model?.ready) { setState({ key: originKey, kind: "gate", message: "", items: [], listOpen: false }); return; }
    const reqId = ++reqIdRef.current;
    await actions.assistCard("derive", ui("出一道和这道题考同一知识点的变式题：换一个情境或数字，不要照抄原题。"), [], { relation: "standalone" });
    if (!mountedRef.current || activeKeyRef.current !== originKey || reqIdRef.current !== reqId) return;
    setState({ key: originKey, kind: "none", message: "", items: [], listOpen: false });
  }

  const tryButton = (
    <Tooltip layer content={ui("从题库里找一道考同一知识点、这一轮没出现过的题，不消耗模型。做完点「回到原题」回到这里。")}>
      <Button size="sm" variant="secondary" iconEnd="arrow-right" className="similar-try__go" data-usage="review.similar" lock={busy} busy={here.kind === "finding"} onClick={find}>
        {ui("试一道同类题")}</Button>
    </Tooltip>
  );
  return (
    <div className={inSimilarDetour ? "similar-try similar-try--detour" : "similar-try"} data-similar-detour={inSimilarDetour ? "" : undefined}>
      {!inSimilarDetour && (variantReady
        ? <Button size="sm" variant="primary" iconEnd="arrow-right" className="similar-try__go" lock={busy} data-usage="review.similar-variant-go"
          onClick={() => detour(variant.resultCardId, variant.deckId)}>{ui("做这道变式题")}</Button>
        : tryButton)}
      {canRestoreOriginal && (
        <Button size="sm" variant="secondary" icon="arrow-left" lock={busy} onClick={restoreOriginal}>
          {ui("回到原题")}
        </Button>
      )}
      {inSimilarDetour && originPrompt && <span className="similar-try__note">{uiFormat("原题：{0}", [originPrompt])}</span>}
      <Button size="sm" variant="quiet" data-usage="review.similar-list" lock={busy} busy={here.kind === "finding"} onClick={toggleSimilarList}>
        {ui("同类题列表")}
      </Button>
      {here.listOpen && (
        <SimilarQuestionsList
          originCard={originCardInfo}
          items={here.items}
          activeCardId={run.card?.id || ""}
          onSelectItem={(item) => detour(item.cardId, item.deckId)}
          onRestoreOriginal={canRestoreOriginal ? restoreOriginal : undefined}
          onClose={() => setState((prev) => ({ ...prev, key, listOpen: false }))}
        />
      )}
      {variantRunning && <span className="similar-try__note" role="status"><Spinner size="sm" />{ui("正在出一道变式题，写好后这里会出现「做这道变式题」。")}</span>}
      {here.kind === "none" && (!variant || variantMissed) && (
        <span className="similar-try__note" role="status">
          {variantMissed ? ui("上一次没有出成变式题。") : ui("题库里没有这一轮之外的同类题。")}{" "}
          <Tooltip layer content={ui("后台助教按这道题的知识点出一道新题，放进同一题组：约 1 次模型调用。")}>
            <Button variant="link" size="sm" icon="sparkle" data-usage="review.similar-variant" lock={busy} onClick={generate}>{ui("生成一道变式")}</Button>
          </Tooltip>
        </span>
      )}
      {here.kind === "gate" && !model?.ready && <ModelSetupGate variant="inline" feature="generate" model={model} onOpenSettings={onModelSettings} />}
      {here.kind === "failed" && <InlineMessage tone="error" className="similar-try__note" action={{ label: ui("再试一次"), onClick: find }}>{here.message}</InlineMessage>}
    </div>
  );
}
