import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { kinds, useInjectCss } from '../shared.js';
import { Badge, Button, IconButton } from '../components/index.js';
import { useStudyServices } from '../study-context.jsx';
import OrigamiMark from './OrigamiMark.jsx';
import LazyInkScratchpadDialog from './LazyInkScratchpadDialog.jsx';
import {
  computeTodayOrigami,
  eligibleDecksForSlip,
  extractSlipCard,
  pickDeckId,
  pickRandomCard,
} from './lucky-card.js';
import {
  readDeskPlayPrefs,
  readScratchpadSession,
  writeDeskPlayPrefs,
} from './desk-play-storage.js';
import css from './desk-play.css';

/**
 * Compact, hideable Desk Play strip tucked cleanly beneath `.desk` on the home page.
 * Holds three quiet companions that never compete with TodayCard's single primary CTA:
 *  1. 5-stage geometric Origami Progress Mark reflecting today's rhythm
 *  2. Desk Serendipity Slip («随手抽一签») lazily fetching a real card on click via `deck.get`
 *  3. 1-click launcher for the Calligraphic Ink Scratchpad modal
 */
export default function DeskPlayStrip({ data, onPracticeDeck }) {
  useInjectCss(css, 'study-desk-play');
  const { call } = useStudyServices();
  const deckCacheRef = useRef(new Map());

  const [hidden, setHidden] = useState(() => readDeskPlayPrefs().hidden);
  const [scratchpadOpen, setScratchpadOpen] = useState(false);
  const [savedStrokes, setSavedStrokes] = useState(() => readScratchpadSession().strokes.length);
  const [slip, setSlip] = useState(null);
  const [revealed, setRevealed] = useState(false);
  const [drawing, setDrawing] = useState(false);
  const [drawError, setDrawError] = useState('');

  const origami = useMemo(() => computeTodayOrigami(data), [data]);
  const eligibleDecks = useMemo(() => eligibleDecksForSlip(data?.decks), [data?.decks]);
  const rootKey = data?.root || '';

  const toggleHidden = (nextHidden) => {
    setHidden(nextHidden);
    writeDeskPlayPrefs({ hidden: nextHidden });
  };

  // Studio shortcut Alt+Shift+D toggles the calligraphic scratchpad on the Home Desk,
  // even when the Desk Play strip is collapsed, while yielding to editable fields and open modals.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat) return;
      if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey) return;
      if (event.code !== 'KeyD' && String(event.key || '').toLowerCase() !== 'd') return;
      const target = event.target;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable || target.closest?.('input,textarea,select,[contenteditable]'))) return;
      if (scratchpadOpen) {
        event.preventDefault();
        setScratchpadOpen(false);
        return;
      }
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      setScratchpadOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [scratchpadOpen]);

  const drawSlip = async () => {
    if (!eligibleDecks.length || drawing) return;
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
        const cacheKey = `${rootKey}:${deckId}`;
        let fullDeck = deckCacheRef.current.get(cacheKey);
        if (!fullDeck) {
          fullDeck = await call('deck.get', { id: deckId });
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
      if (chosenSlip) {
        setSlip(chosenSlip);
        setRevealed(false);
      } else {
        setDrawError(ui('这组里暂时没有可抽的卡，换一组再试。'));
      }
    } catch {
      setDrawError(ui('没能读取这张卡，稍后再试。'));
    } finally {
      setDrawing(false);
    }
  };

  const scratchpadDialog = scratchpadOpen && (
    <LazyInkScratchpadDialog
      onClose={() => setScratchpadOpen(false)}
      onStrokesChange={setSavedStrokes}
    />
  );

  if (hidden) {
    return (
      <div className="desk-play-collapsed">
        <Button variant="quiet" size="sm" icon="sparkle" onClick={() => toggleHidden(false)}>
          {ui('展开案头小笺')}
        </Button>
        {scratchpadDialog}
      </div>
    );
  }

  return (
    <section className="desk-play" aria-label={ui('案头小笺与草稿纸')}>
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
          <Button
            variant="secondary"
            size="sm"
            icon="note"
            aria-keyshortcuts="Alt+Shift+D"
            onClick={() => setScratchpadOpen(true)}
          >
            {savedStrokes > 0 ? uiFormat('毛笔草稿纸 · {0}', [savedStrokes]) : ui('毛笔草稿纸')}
          </Button>
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

          <p className="desk-play-slip__prompt">{slip.prompt}</p>

          {revealed && (
            <div className="desk-play-slip__answer">
              <span className="desk-play-slip__answer-label">{ui('参考答案')}</span>
              <p className="desk-play-slip__answer-body">{slip.answer || ui('这道题暂无简短答案，直接练这一组看完整解析。')}</p>
              {slip.explanation && (
                <p className="desk-play-slip__explanation">{slip.explanation}</p>
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

      {scratchpadDialog}
    </section>
  );
}
