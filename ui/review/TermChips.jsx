import React from "react";
import { Button, Chip } from "../components/index.js";
import { ui, uiFormat } from "../i18n.js";
import { useStudyBusy } from "../study-context.jsx";
import { useOptionalAppSelector } from "../app/app-context.js";
import { useInjectCss } from "../shared.js";
import { normalizeTerm, partitionMarkedTerms } from "./term-marks.js";
import termChipsCss from "./term-chips.css";

/**
 * Strip of marked unknown words under a question (`#1192`).
 * Renders the tagged words via shared `Chip` components and a secondary button
 * whose click action is injected via `onFill(terms)` for extensibility (`#1202`).
 * When `markingTerms` is active with 0 marked words yet, renders a calm 1-line mode bar
 * so click interception is always visible and 1-click exitable.
 * When some marked terms are already filling in background (`inFlightTerms`), newly marked
 * `pendingTerms` stay actionable so the learner can start a parallel fill job for only them.
 */
export default function TermChips({
  terms = [],
  inFlightTerms = [],
  candidates = [],
  markingTerms,
  onExit,
  onToggleMarkTerms,
  onRemove,
  onMarkCandidate,
  onFill,
  onTermList,
  hasCourse = false,
  busy = false,
  running = false,
  submitting = false,
}) {
  useInjectCss(termChipsCss, "study-term-chips");
  const studyBusy = useStudyBusy();
  const appMarkingTerms = useOptionalAppSelector((state) => state?.session?.markingTerms);
  const appExitMarkTerms = useOptionalAppSelector((state) => state?.session?.actions?.exitMarkTerms);
  const isMarking = typeof markingTerms === "boolean" ? markingTerms : Boolean(appMarkingTerms);
  const closeMarkMode = onExit || onToggleMarkTerms || appExitMarkTerms;
  const locked = Boolean(busy || studyBusy);
  const hasTerms = Array.isArray(terms) && terms.length > 0;
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
  if (!hasTerms && !hasCandidates) {
    if (!isMarking) return null;
    return (
      <div className="term-strip term-strip--mode" role="status" aria-live="polite" data-term-marking-bar="">
        <span className="term-strip__mode-hint">
          {ui("标生词模式：点击题目里的词来标记，按 Esc 或点「退出」恢复作答")}
        </span>
        {closeMarkMode && (
          <Button variant="quiet" size="sm" className="term-strip__exit" onClick={() => closeMarkMode()}>
            {ui("退出")}
          </Button>
        )}
      </div>
    );
  }

  const hasExplicitInFlight = Array.isArray(inFlightTerms) && inFlightTerms.length > 0;
  const { pendingTerms, inFlightKeys } = partitionMarkedTerms(terms, inFlightTerms);
  const fillTargets = hasExplicitInFlight ? pendingTerms : terms;
  const allTermsInFlight = hasTerms && (hasExplicitInFlight ? pendingTerms.length === 0 : running);
  const fillSpinning = submitting || allTermsInFlight;
  const fillCount = fillTargets.length > 0 ? fillTargets.length : terms.length;
  const candidateLocked = locked || (!hasExplicitInFlight && running);

  return (
    <div className="term-strip" role="region" aria-label={hasTerms ? ui("标出的生词") : ui("可能的生词")}>
      <span className="term-strip__label">{ui("生词")}</span>
      <div className="term-strip__list">
        {hasTerms && terms.map((term) => {
          const termInFlight = hasExplicitInFlight
            ? inFlightKeys.has(normalizeTerm(term).toLowerCase())
            : running;
          return (
            <Chip
              key={`mark:${term}`}
              className={termInFlight ? "term-strip__chip--filling" : undefined}
              data-filling={termInFlight ? "true" : undefined}
              onRemove={locked || submitting || termInFlight ? undefined : () => onRemove?.(term)}
              removeLabel={uiFormat("移除生词「{0}」", [term])}
            >
              {term}
            </Chip>
          );
        })}
        {hasCandidates && candidates.map((term) => (
          <Chip
            key={`cand:${term}`}
            className="term-strip__candidate"
            onClick={candidateLocked ? undefined : () => onMarkCandidate?.(term)}
          >
            {term}
          </Chip>
        ))}
      </div>
      <div className="term-strip__actions">
        {isMarking && closeMarkMode && (
          <Button variant="quiet" size="sm" className="term-strip__exit" onClick={() => closeMarkMode()}>
            {ui("退出")}
          </Button>
        )}
        {hasCourse && onTermList && (
          <Button
            variant="quiet"
            size="sm"
            className="term-strip__list-btn"
            data-tour="review-term-list"
            data-usage="review.term-list"
            onClick={onTermList}
          >
            {ui("生词表")}
          </Button>
        )}
        {hasTerms && (
          <Button
            variant="secondary"
            size="sm"
            className="term-strip__fill"
            busy={fillSpinning}
            lock={locked}
            disabled={fillTargets.length === 0 && !fillSpinning}
            onClick={() => fillTargets.length > 0 && onFill?.(fillTargets)}
          >
            {uiFormat("补齐这 {0} 个词", [fillCount])}
          </Button>
        )}
      </div>
    </div>
  );
}
