import { ui } from "./i18n.js";
import React from "react";
import { selfCitedCardCount } from "../lib/source-provenance.js";

export default function CitationDisclosure({ card, sources = [], onOpenSource }) {
  const [open, setOpen] = React.useState(false);
  const citations = card?.citations || [];
  if (!citations.length) return null;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const selfCited = selfCitedCardCount([card], sources) > 0;
  return (
    <details className="citation-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{ui("引用与来源核对 ")}<span>· {citations.length}{ui(" 条")}</span></summary>
      {open && <>
        <div className="citations">
          {citations.map((citation, index) => {
            const source = sourceById.get(citation.sourceId);
            return <button type="button" key={index}
              onClick={() => onOpenSource(source, citation.quote)}>
              ↗ {source?.title || ui("资料")}
              <blockquote>{citation.quote}</blockquote>
            </button>;
          })}
        </div>
        {selfCited && <p className="warning" role="note">{ui("这些引用来自导入的题目自身，不能独立核实答案。请对照原始资料判断。")}</p>}
      </>}
    </details>
  );
}
