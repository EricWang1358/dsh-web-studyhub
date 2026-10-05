import { ui, uiFormat } from "./i18n.js";
import React from "react";
import { Button, Hint } from "./components/index.js";
import { selfCitedCardCount } from "../lib/source-provenance.js";

export default function CitationDisclosure({ card, sources = [], onOpenSource }) {
  const [open, setOpen] = React.useState(false);
  const selections = card?.selections || [];
  const selectionKey = s => JSON.stringify([s?.documentId, s?.revision, s?.sourceId, s?.start, s?.end, s?.quote]);
  const citations = (card?.citations || []).map(citation => ({ ...citation,
    selection: citation.selection || selections.find(selection => selection.sourceId === citation.sourceId && selection.quote === citation.quote) }));
  for (const selection of selections) {
    if (!citations.some(citation => citation.selection && selectionKey(citation.selection) === selectionKey(selection))) citations.push({ sourceId: selection.sourceId, quote: selection.quote, selection });
  }
  if (!citations.length) return null;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const selfCited = selfCitedCardCount([card], sources) > 0;
  return (
    <details className="citation-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{ui("引用与来源核对")}{" "}<span>{uiFormat("· {0} 条", [citations.length])}</span></summary>
      {open && <>
        <div className="citations">
          {citations.map((citation, index) => {
            const source = sourceById.get(citation.sourceId);
            return <Button key={index} variant="quiet" wrap block align="start" icon="external"
              onClick={() => onOpenSource(source && citation.selection ? { ...source, selection: citation.selection } : source, citation.quote)}>
              <span>{source?.title || ui("资料")}
                <blockquote>{citation.quote}</blockquote></span>
            </Button>;
          })}
        </div>
        {selfCited && <Hint tone="warning" role="note">{ui("这些引用来自导入的题目自身，不能独立核实答案。请对照原始资料判断。")}</Hint>}
      </>}
    </details>
  );
}
