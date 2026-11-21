import React from "react";
import { Button, Chip } from "../components/index.js";
import { ui, uiFormat } from "../i18n.js";
import { useStudyBusy } from "../study-context.jsx";
import { normalizeTerm, partitionMarkedTerms } from "./term-marks.js";

/**
 * Strip of marked unknown words under a question (`#1192`).
 * Renders the tagged words via shared `Chip` components and a secondary button
 * whose click action is injected via `onFill(terms)` for extensibility (`#1202`).
 * When some marked terms are already filling in background (`inFlightTerms`), newly marked
 * `pendingTerms` stay actionable so the learner can start a parallel fill job for only them.
 */
export default function TermChips({
  terms = [],
  inFlightTerms = [],
  candidates = [],
  onRemove,
  onMarkCandidate,
  onFill,
  onTermList,
  hasCourse = false,
  busy = false,
  running = false,
  submitting = false,
}) {
  const studyBusy = useStudyBusy();
  const locked = Boolean(busy || studyBusy);
  const hasTerms = Array.isArray(terms) && terms.length > 0;
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
  if (!hasTerms && !hasCandidates) return null;

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
