import React from "react";
import { Button, Chip } from "../components/index.js";
import { ui, uiFormat } from "../i18n.js";

/**
 * Strip of marked unknown words under a question (`#1192`).
 * Renders the tagged words via shared `Chip` components and a secondary button
 * whose click action is injected via `onFill(terms)` for extensibility (`#1202`).
 */
export default function TermChips({ terms, onRemove, onFill, busy = false, running = false }) {
  if (!Array.isArray(terms) || !terms.length) return null;

  return (
    <div className="term-strip" role="region" aria-label={ui("标出的生词")}>
      <span className="term-strip__label">{ui("生词")}</span>
      <div className="term-strip__list">
        {terms.map((term) => (
          <Chip
            key={term}
            onRemove={busy || running ? undefined : () => onRemove?.(term)}
            removeLabel={uiFormat("移除生词「{0}」", [term])}
          >
            {term}
          </Chip>
        ))}
      </div>
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
    </div>
  );
}
