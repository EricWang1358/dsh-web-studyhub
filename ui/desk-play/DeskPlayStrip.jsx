import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { kinds, useInjectCss } from '../shared.js';
import Markdown from '../Markdown.jsx';
import { Badge, Button, IconButton } from '../components/index.js';
import { useStudyServices } from '../study-context.jsx';
import OrigamiMark from './OrigamiMark.jsx';
import {
  computeTodayOrigami,
  eligibleDecksForSlip,
  extractSlipCard,
  pickDeckId,
  pickRandomCard,
} from './lucky-card.js';
import {
  readDeskPlayPrefs,
  writeDeskPlayPrefs,
} from './desk-play-storage.js';
import css from './desk-play.css';

/**
 * Compact, hideable Desk Play strip tucked cleanly beneath `.desk` on the home page.
 * Holds two quiet companions that never compete with TodayCard's single primary CTA:
 *  1. 5-stage geometric Origami Progress Mark reflecting today's rhythm
 *  2. Desk Serendipity Slip («随手抽一签») lazily fetching a real card on click via `deck.get`
 */
export default function DeskPlayStrip({ data, onPracticeDeck, initialSlip = null, initialRevealed = false }) {
  useInjectCss(css, 'study-desk-play');
  const { call } = useStudyServices();
  const deckCacheRef = useRef(new Map());
  const drawSeqRef = useRef(0);

  const [hidden, setHidden] = useState(() => readDeskPlayPrefs().hidden);
  const [slip, setSlip] = useState(initialSlip);
  const [revealed, setRevealed] = useState(initialRevealed);
  const [drawing, setDrawing] = useState(false);
  const [drawError, setDrawError] = useState('');

  const origami = useMemo(() => computeTodayOrigami(data), [data]);
  const eligibleDecks = useMemo(() => eligibleDecksForSlip(data?.decks), [data?.decks]);
  const rootKey = data?.root || '';
  const revisionKey = data?.revision ?? '';
  const rootRef = useRef(rootKey);
  rootRef.current = rootKey;

  // Invalidate deck cache when the library switches or its revision advances (background edits, merges, slain cards).
  useEffect(() => {
    deckCacheRef.current.clear();
  }, [rootKey, revisionKey]);

  // Drop the current slip immediately if its deck was archived, deleted, merged, or moved out of active decks.
  useEffect(() => {
    if (!slip) return;
    if (!eligibleDecks.some((deck) => deck.id === slip.deckId)) {
      setSlip(null);
      setRevealed(false);
      setDrawError('');
    }
  }, [slip, eligibleDecks]);

  // Reset slip and pending error when library root changes (belt-and-suspenders alongside key={data.root}).
  const prevRootRef = useRef(rootKey);
  useEffect(() => {
    if (prevRootRef.current === rootKey) return;
    prevRootRef.current = rootKey;
    drawSeqRef.current += 1;
    setSlip(null);
    setRevealed(false);
    setDrawError('');
    setDrawing(false);
  }, [rootKey]);

  const toggleHidden = (nextHidden) => {
    setHidden(nextHidden);
    writeDeskPlayPrefs({ hidden: nextHidden });
  };

  const drawSlip = async () => {
    if (!eligibleDecks.length || drawing) return;
    const seq = ++drawSeqRef.current;
    const originRoot = rootKey;
    setDrawing(true);
    setDrawError('');
    try {
      const tried = [];
      let chosenSlip = null;
      const attempts = Math.min(3, eligibleDecks.length);
      for (let i = 0; i < attempts; i += 1) {
        const exclude = i === 0 && slip && eligibleDecks.length > 1 ? [slip.deckId] : tried;
        const deckId = pickDeckId(eligibleDecks, exclude);
        if (!deckId) break;
        tried.push(deckId);
        const cacheKey = `${rootKey}:${revisionKey}:${deckId}`;
        let fullDeck = deckCacheRef.current.get(cacheKey);
        if (!fullDeck) {
          fullDeck = await call('deck.get', { id: deckId });
          if (seq !== drawSeqRef.current || rootRef.current !== originRoot) return;
          if (fullDeck && Array.isArray(fullDeck.cards)) {
            deckCacheRef.current.set(cacheKey, fullDeck);
          }
        }
        const card = pickRandomCard(fullDeck?.cards, slip?.cardId || null);
        if (card) {
          chosenSlip = extractSlipCard(card, fullDeck);
          if (chosenSlip) break;
        }
      }
      if (seq !== drawSeqRef.current || rootRef.current !== originRoot) return;
      if (chosenSlip) {
        setSlip(chosenSlip);
        setRevealed(false);
      } else {
        setDrawError(ui('这组里暂时没有可抽的卡，换一组再试。'));
      }
    } catch (failure) {
      if (seq !== drawSeqRef.current || rootRef.current !== originRoot || failure?.stale) return;
      setDrawError(ui('没能读取这张卡，稍后再试。'));
    } finally {
      if (seq === drawSeqRef.current && rootRef.current === originRoot) setDrawing(false);
    }
  };

  if (hidden) {
    return (
      <div className="desk-play-collapsed">
        <Button variant="quiet" size="sm" icon="sparkle" onClick={() => toggleHidden(false)}>
          {ui('展开案头小笺')}
        </Button>
      </div>
    );
  }

  return (
    <section className="desk-play" aria-label={ui('案头小笺')}>
      <div className="desk-play__bar">
        <div className="desk-play__origami">
          <OrigamiMark
            stage={origami.stage}
            done={origami.done}
            goal={origami.goal}
            label={origami.label}
            caption={origami.caption}
          />
          <div className="desk-play__origami-copy">
            <span className="desk-play__eyebrow">{ui('今日折纸')}</span>
            <strong className="desk-play__stage">{ui(origami.label)}</strong>
            <span className="desk-play__ratio">{uiFormat('{0} / {1} 题', [origami.done, origami.goal])}</span>
          </div>
        </div>

        <div className="desk-play__slip-trigger">
          {eligibleDecks.length > 0 ? (
            <>
              <div className="desk-play__slip-copy">
                <strong className="desk-play__title">{ui('随手抽一签')}</strong>
                <span className="desk-play__subtitle">{ui('从题库里抽一题，十秒默想热身')}</span>
              </div>
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                busy={drawing}
                busyLabel={ui('抽签中…')}
                onClick={drawSlip}
              >
                {slip ? ui('再抽一签') : ui('抽一签')}
              </Button>
            </>
          ) : (
            <div className="desk-play__slip-copy">
              <strong className="desk-play__title">{ui('随手抽一签')}</strong>
              <span className="desk-play__subtitle">{ui('发布第一组题后，可以在这里随手抽一张卡热身')}</span>
            </div>
          )}
        </div>

        <div className="desk-play__tools">
          <IconButton
            size="sm"
            icon="chevron-down"
            label={ui('收起案头小笺')}
            onClick={() => toggleHidden(true)}
          />
        </div>
      </div>

      {drawError && (
        <p className="desk-play__error" role="status">{drawError}</p>
      )}

      {slip && (
        <article className="desk-play-slip sh-paper-card sh-paper-card--snug" aria-live="polite">
          <div className="desk-play-slip__head">
            <div className="desk-play-slip__meta">
              <Badge size="sm">{kinds[slip.kind] || ui('闪卡')}</Badge>
              <span className="desk-play-slip__deck">{slip.deckTitle}</span>
              {slip.topic && <span className="desk-play-slip__topic">{slip.topic}</span>}
            </div>
            <IconButton
              size="sm"
              icon="close"
              label={ui('收起签纸')}
              onClick={() => { setSlip(null); setRevealed(false); }}
            />
          </div>

          <div className="desk-play-slip__prompt">
            <Markdown text={slip.prompt} links={false} className="md-compact" />
          </div>

          {slip.options?.length > 0 && (
            <ul className="desk-play-slip__options" aria-label={ui('题目选项')}>
              {slip.options.map((opt) => (
                <li
                  key={opt.id}
                  className="desk-play-slip__option"
                  data-correct={revealed && opt.correct ? 'true' : undefined}
                >
                  <span className="desk-play-slip__option-key">{opt.label}</span>
                  <div className="desk-play-slip__option-text">
                    <Markdown text={opt.text} links={false} className="md-compact" />
                  </div>
                </li>
              ))}
            </ul>
          )}

          {revealed && (
            <div className="desk-play-slip__answer">
              <span className="desk-play-slip__answer-label">{ui('参考答案')}</span>
              <div className="desk-play-slip__answer-body">
                {slip.answer
                  ? <Markdown text={slip.answer} links={false} className="md-compact" />
                  : <p>{ui('这道题暂无简短答案，直接练这一组看完整解析。')}</p>}
              </div>
              {slip.explanation && (
                <div className="desk-play-slip__explanation">
                  <Markdown text={slip.explanation} links={false} className="md-compact" />
                </div>
              )}
            </div>
          )}

          <div className="desk-play-slip__actions">
            <Button
              variant="secondary"
              size="sm"
              aria-expanded={revealed}
              onClick={() => setRevealed((prev) => !prev)}
            >
              {revealed ? ui('收起答案') : ui('翻看答案')}
            </Button>
            <Button
              variant="quiet"
              size="sm"
              icon="refresh"
              busy={drawing}
              busyLabel={ui('抽签中…')}
              onClick={drawSlip}
            >
              {ui('再抽一签')}
            </Button>
            {onPracticeDeck && (
              <Button
                variant="link"
                size="sm"
                iconEnd="arrow-right"
                onClick={() => onPracticeDeck(slip.deckId)}
              >
                {ui('练这一组')}
              </Button>
            )}
          </div>
        </article>
      )}
    </section>
  );
}
