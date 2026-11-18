import React from "react";
import { Button, Chip } from "../components/index.js";
import { ui, uiFormat } from "../i18n.js";

/**
 * Strip of marked unknown words under a question (`#1192`).
 * Renders the tagged words via shared `Chip` components and a secondary button
 * whose click action is injected via `onFill(terms)` for extensibility (`#1202`).
 */
export default function TermChips({
  terms = [],
  candidates = [],
  onRemove,
  onMarkCandidate,
  onFill,
  onTermList,
  hasCourse = false,
  busy = false,
  running = false,
}) {
  const hasTerms = Array.isArray(terms) && terms.length > 0;
  const hasCandidates = Array.isArray(candidates) && candidates.length > 0;
  if (!hasTerms && !hasCandidates) return null;

  return (
    <div className="term-strip" role="region" aria-label={hasTerms ? ui("标出的生词") : ui("可能的生词")}>
      <span className="term-strip__label">{ui("生词")}</span>
      <div className="term-strip__list">
        {hasTerms && terms.map((term) => (
          <Chip
            key={`mark:${term}`}
            onRemove={busy || running ? undefined : () => onRemove?.(term)}
            removeLabel={uiFormat("移除生词「{0}」", [term])}
          >
            {term}
          </Chip>
        ))}
        {hasCandidates && candidates.map((term) => (
          <Chip
            key={`cand:${term}`}
            className="term-strip__candidate"
            onClick={busy || running ? undefined : () => onMarkCandidate?.(term)}
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
            busy={running}
            lock={busy}
            onClick={() => onFill?.(terms)}
          >
            {uiFormat("补齐这 {0} 个词", [terms.length])}
          </Button>
        )}
      </div>
    </div>
  );
}
