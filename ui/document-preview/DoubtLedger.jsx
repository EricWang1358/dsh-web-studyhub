import React, { useContext, useEffect, useState } from 'react';
import Markdown from '../Markdown.jsx';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { StudyServicesContext } from '../study-context.jsx';
import { stripTermMarkers } from '../term-marker.js';
import SaveAnswerAsCard from './links/SaveAnswerAsCard.jsx';
import css from './doubt-ledger.css';

/**
 * Opt-in ledger rendered inside `DocumentLearning` when no passage is selected (`settings.practice.readerDoubtLedger`).
 * Shows unsaved session answers + kept passage annotations with a zero-token recall veil and 1-click flashcard save.
 */
export default function DoubtLedger({ doubts = [], deckId = '', decks = [], saveReady = false, saveCall = null, onSaved, onOpenCard, onSelectDoubt, isCurrent = () => true }) {
  useInjectCss(css, 'study-doubt-ledger');
  const services = useContext(StudyServicesContext);
  const effectiveCall = typeof saveCall === 'function' ? saveCall : (typeof services?.call === 'function' ? services.call : null);
  const canSaveCard = typeof effectiveCall === 'function';
  const [veilOn, setVeilOn] = useState(false);
  const [revealed, setRevealed] = useState(() => new Set());
  const doubtIdsKey = doubts.map((item) => item.id).join('\0');
  useEffect(() => {
    setRevealed(new Set());
  }, [doubtIdsKey]);
  if (!doubts.length) return null;

  const toggleVeil = () => {
    setVeilOn((on) => !on);
    setRevealed(new Set());
  };
  const toggleReveal = (id) => setRevealed((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div className="study-doubt-ledger" data-doubt-ledger="">
      <div className="study-doubt-ledger__head">
        <h4 className="study-doubt-ledger__title">{uiFormat('本文疑问 ({0})', [doubts.length])}</h4>
        <Button size="sm" variant="secondary" wrap aria-pressed={veilOn} onClick={toggleVeil}>
          {veilOn ? ui('退出遮罩自测') : ui('遮住答案自测')}
        </Button>
      </div>
      <ul className="study-doubt-ledger__list">
        {doubts.map((item) => {
          const masked = veilOn && !revealed.has(item.id);
          const cleanAnswer = stripTermMarkers(item.answer);
          return (
            <li key={item.id} className="study-doubt-ledger__item" data-doubt-masked={masked ? '' : undefined}>
              <div className="study-doubt-ledger__meta">
                <Badge size="sm" tone={item.kept ? 'neutral' : 'info'}>
                  {item.kept ? ui('已存为批注') : ui('本次提问')}
                </Badge>
                {item.selection?.quote && typeof onSelectDoubt === 'function' && (
                  <Button variant="quiet" size="sm" onClick={() => onSelectDoubt(item.selection, item)}>
                    {ui('定位原段落')}
                  </Button>
                )}
              </div>
              {item.quote && <p className="study-doubt-ledger__quote">{item.quote}</p>}
              {item.question && <p className="study-doubt-ledger__q">{item.trail ? <span className="study-doubt-ledger__trail">{item.trail} › </span> : null}{item.question}</p>}
              {masked ? (
                <div className="study-doubt-ledger__veil">
                  <span>{ui('先自己回想刚才的回答，再揭晓对照。')}</span>
                  <Button size="sm" variant="secondary" onClick={() => toggleReveal(item.id)}>
                    {ui('揭晓回答')}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="study-doubt-ledger__answer">
                    <Markdown text={cleanAnswer} />
                  </div>
                  <div className="study-doubt-ledger__actions">
                    {veilOn && (
                      <Button size="sm" variant="quiet" onClick={() => toggleReveal(item.id)}>
                        {ui('重新遮住')}
                      </Button>
                    )}
                    {canSaveCard && item.selection?.quote && (
                      <SaveAnswerAsCard
                        key={`${item.id}:${cleanAnswer}`}
                        call={effectiveCall}
                        compact
                        selection={item.selection}
                        question={item.question}
                        answer={cleanAnswer}
                        deckId={deckId}
                        decks={decks}
                        ready={saveReady}
                        onSaved={onSaved}
                        onOpenCard={onOpenCard}
                        isCurrent={isCurrent}
                      />
                    )}
                  </div>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
