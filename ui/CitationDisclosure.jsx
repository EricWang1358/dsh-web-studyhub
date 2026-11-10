import { ui, uiFormat } from "./i18n.js";
import React from "react";
import { Badge, Button, Hint } from "./components/index.js";
import { aiDraftedCitedCardCount, isAiDraftedSource, isJsonCardSource, selfCitedCardCount } from "../lib/source-provenance.js";

export default function CitationDisclosure({ card, sources = [], onOpenSource, defaultOpen = false }) {
  const [open, setOpen] = React.useState(Boolean(defaultOpen));
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
  const aiDraftedCited = aiDraftedCitedCardCount([card], sources) > 0;
  return (
    <details className="citation-disclosure" open={open || undefined} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>{ui("引用与来源核对")}{" "}<span>{uiFormat("· {0} 条", [citations.length])}</span>
        {selfCited && <>{" "}<Badge size="sm" tone="warning">{ui("题目自引")}</Badge></>}
        {aiDraftedCited && <>{" "}<Badge size="sm" tone="warning">{ui("AI 撰写 · 未核对")}</Badge></>}
      </summary>
      {open && <>
        <div className="citations">
          {citations.map((citation, index) => {
            const source = sourceById.get(citation.sourceId);
            const targetSource = source && citation.selection ? { ...source, selection: citation.selection } : source;
            const aiDrafted = isAiDraftedSource(source);
            const pdfPage = !isJsonCardSource(source) && Number.isInteger(source?.document?.page) && source.document.page >= 1
              && (source.format || source.document?.format || "pdf") === "pdf" ? source.document.page : 0;
            return <div key={index} className="citations__row">
              <Button className="citations__button" variant="quiet" wrap block align="start" icon="external"
                onClick={() => onOpenSource(targetSource, citation.quote)}>
                <span>{source?.title || ui("资料")}{aiDrafted && <>{" "}<Badge size="sm" tone="warning" className="citations__provenance">{ui("AI 撰写 · 未核对")}</Badge></>}
                  <blockquote>{citation.quote}</blockquote></span>
              </Button>
              {pdfPage > 0 && <Button className="citations__peek" variant="quiet" size="sm"
                onClick={() => onOpenSource(targetSource, citation.quote, pdfPage)}>{ui("看原页")}</Button>}
            </div>;
          })}
        </div>
        {selfCited && <Hint tone="warning" role="note">{ui("这些引用来自导入的题目自身，不能独立核实答案。请对照原始资料判断。")}</Hint>}
        {aiDraftedCited && <Hint tone="warning" role="note">{ui("这些引用含「AI 撰写 · 未核对」讲义，请结合权威资料核实。")}</Hint>}
      </>}
    </details>
  );
}
