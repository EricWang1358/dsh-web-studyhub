import React from "react";
import { ui, uiFormat } from "../i18n.js";
import { Button, Chip } from "../components/index.js";
import { useStudy } from "../study-context.jsx";
import { IMPROVE_SUGGESTIONS } from "../agent-prompts/card.js";
import { FIX_PHRASE_LIMITS, canAddFixPhrase } from "../../lib/fix-phrases.js";

/* 修题 box: the choices under its heading and the one link that keeps what was typed. The built-in choices (ui/agent-prompts/card.js) come first, then the
   learner's own phrases (settings.practice.fixPhrases, ui/review/use-fix-phrases.js), each a chip with a ✕ of its own. A click on a chip puts its whole text in the
   box (`onPick`); the chip shows a clipped line when the phrase is long. A write that is running (busy) takes the ✕ away and locks the link. */
const CHIP_CHARS = 24;
const clip = (text) => ([...text].length > CHIP_CHARS ? `${[...text].slice(0, CHIP_CHARS).join("")}…` : text);

export function FixPhraseChips({ phrases, onPick, onRemove }) {
  const { busy } = useStudy();
  const labelId = React.useId();
  return (
    <>
      <div className="assist-quick-choices" role="group" aria-label={ui("常见的问题")}>
        {IMPROVE_SUGGESTIONS.map(([label, body]) => <Chip key={label} onClick={() => onPick(ui(body))}>{ui(label)}</Chip>)}
      </div>
      {phrases.length > 0 && (
        <div className="assist-quick-choices" role="group" aria-labelledby={labelId} data-fix-phrases="">
          <span className="muted small" id={labelId}>{ui("我的常用语句")}</span>
          {phrases.map((phrase) =>
            <Chip key={phrase} onClick={() => onPick(phrase)} onRemove={busy ? undefined : () => onRemove(phrase)}
              removeLabel={uiFormat("删除常用语句「{0}」", [clip(phrase)])}>{clip(phrase)}</Chip>)}
        </div>
      )}
    </>
  );
}

const WHY = {
  saved: () => ui("已在我的常用语句里"),
  long: () => uiFormat("这段超过 {0} 字，存不进常用语句", [FIX_PHRASE_LIMITS.length]),
  full: () => uiFormat("常用语句最多 {0} 条，先删掉一条再存", [FIX_PHRASE_LIMITS.count]),
};

/** Under the box: 「存为我的常用语句」 for the typed text, or the reason it cannot be kept; nothing while the box is empty. Locked while a write runs. */
export function FixPhraseSave({ phrases, text, onSave }) {
  const { busy } = useStudy();
  const check = canAddFixPhrase(phrases, text);
  if (check.reason === "empty") return null;
  if (!check.ok) return <p className="muted small" role="status">{WHY[check.reason]()}</p>;
  return <Button variant="link" size="sm" align="start" data-usage="review.fix-phrase" lock={busy} onClick={() => onSave(text.trim())}>{ui("存为我的常用语句")}</Button>;
}
