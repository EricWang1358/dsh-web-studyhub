import React from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import HandOff from '../hand-off/HandOff.jsx';
import { hasChatHost } from '../hand-off/use-hand-off.js';
import { useStudy } from '../study-context.jsx';
import { questionSourceOpener } from './QuestionSourcePage.jsx';

function cardCitation(run, source) {
  const list = [...(run?.solution?.citations || []), ...(run?.card?.citations || [])];
  if (!list.length || !source) return null;
  const hit = list.find((c) => c && (c.sourceId === source.id || (source.document?.sourceId && c.documentSourceId === source.document.sourceId))) || list[0];
  if (!hit) return null;
  const quote = typeof hit.quote === 'string' && hit.quote.trim() ? hit.quote : (hit.selection?.quote || '');
  const peekPage = Number.isInteger(hit.selection?.page) ? hit.selection.page : (Number.isInteger(hit.page) ? hit.page : undefined);
  if (!quote && !Number.isInteger(peekPage)) return null;
  return { ...(quote ? { quote } : {}), ...(Number.isInteger(peekPage) ? { peekPage } : {}) };
}

/**
 * Quiet in-flow advisory block below TermChips (#1193): appears when term-filling reaches
 * deeper prerequisites or runs a second time on the same question. Never uses a filled primary button
 * or blocks any grading/navigation control.
 */
export default function ChapterHint({
  run,
  sources,
  decks,
  openModal,
  cardPlace,
  terms = [],
  deeper = [],
  onDismiss,
  onDismissForever,
}) {
  const chapterTitle = String(cardPlace?.chapter?.title ?? '').trim();
  const documentTitle = String(cardPlace?.document?.title ?? run?.cardSource?.title ?? '').trim();
  const deckTitle = String((Array.isArray(decks) ? decks.find((deck) => deck.id === run?.deckId)?.title : '') || run?.deckTitle || '').trim();

  const openSource = React.useMemo(
    () => questionSourceOpener(run, sources, (modal) => {
      const cite = cardCitation(run, modal.source);
      openModal?.(cite ? { ...modal, ...cite } : modal);
    }),
    [run, sources, openModal],
  );

  const handOffInput = React.useMemo(() => ({
    deckTitle,
    documentTitle,
    chapterTitle,
    deckId: run?.deckId || '',
    card: run?.card || {},
    terms,
    deeper,
  }), [deckTitle, documentTitle, chapterTitle, run?.deckId, run?.card, terms, deeper]);

  const { host } = useStudy();
  const canChat = hasChatHost(host);
  return (
    <aside className="chapter-hint" data-chapter-hint="" role="region" aria-label={ui('这一章先别做题提示')}>
      <div className="chapter-hint__head">
        <p className="chapter-hint__body">
          {chapterTitle
            ? (canChat
              ? uiFormat('这一块的基础还没搭起来，再往下补词效率不高。「{0}」先别急着做题，先读一遍，或者让主会话讲一讲。', [chapterTitle])
              : uiFormat('这一块的基础还没搭起来，再往下补词效率不高。「{0}」先别急着做题，先读一遍，或者复制提示词让 AI 讲一讲。', [chapterTitle]))
            : (canChat
              ? ui('这一块的基础还没搭起来，再往下补词效率不高。这一部分先别急着做题，先读一遍，或者让主会话讲一讲。')
              : ui('这一块的基础还没搭起来，再往下补词效率不高。这一部分先别急着做题，先读一遍，或者复制提示词让 AI 讲一讲。'))}
        </p>
        <Button
          variant="quiet"
          size="sm"
          icon="close"
          className="sh-btn--icon chapter-hint__close"
          aria-label={ui('关闭提示')}
          onClick={onDismiss}
        />
      </div>
      <div className="chapter-hint__actions">
        {openSource && (
          <Button variant="quiet" size="sm" iconEnd="arrow-right" className="chapter-hint__source" onClick={openSource}>
            {ui('在旁边读原文')}
          </Button>
        )}
        <HandOff id="question.basics" shape="quiet" label="发给主会话讲" copyLabel="复制讲解提示词" input={handOffInput} />
      </div>
      <div className="chapter-hint__foot">
        <Button variant="quiet" size="sm" className="chapter-hint__mute" onClick={onDismissForever}>
          {ui('这类不再提示')}
        </Button>
      </div>
    </aside>
  );
}
