import React, { memo, useEffect, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { useInjectCss } from '../shared.js';
import { Button, SegmentedControl } from '../components/index.js';
import { hasConfusableAspect, maskConfusableCell } from './confusable-drill.js';
import css from './book-confusables.css';

/* 易混概念 of the review book (#710 S3 + 5.0.0 Evolution 2 #1/#2): for each pair of term cards the book calls opposite or parallel (lib/course-book-confusables.js
   confusablesView), a comparison under the two names: what each is, when to use it, the key difference, the common mistake. A card's number is a link that goes to that
   card (`onCard(hid, code)`, else opens its point). On a narrow screen each row is a small block, each cell under its name. Generated, never edited here.
   When `drill` is enabled (`settings.book.confusableDrill`), learners can toggle 「对照自测」 to mask headers/names (default), `difference`, or `mistake` before revealing,
   and mark stuck items back to `book.crunch.mark` (without polluting FSRS). Each pair also offers the single permitted persistent secondary action 「转为辩证对比实验」
   (0-token `compileConfusablesToLesson` + `companion.compile`). */

const aspectLabel = aspect => ({ what: ui('是什么'), when: ui('什么时候用'), difference: ui('关键区别'), mistake: ui('常见误区') })[aspect] ?? aspect;
const maskedLabel = at => (at === 0 ? ui('概念 A') : at === 1 ? ui('概念 B') : uiFormat('概念 {0}', [at + 1]));

function CardLink({ code, hid, onGo, onCard }) {
  return <Button variant="link" size="sm" className="book-conf__code" data-term-link={code} onClick={() => (onCard && hid ? onCard(hid, code) : hid && onGo(hid))}>{code}</Button>;
}

/** confusables: lookup.confusables, [{ id, items: [K code, K code], names, rows: [{ aspect, cells }], hids }]; onGo(hid) opens the book at a point. */
export default memo(function BookConfusables({ confusables, drill = false, onGo, onCard, onCompileLab, onMarkStuck, stuckHids = null }) {
  useInjectCss(css, 'study-book-confusables');
  const [quizOn, setQuizOn] = useState(false);
  const [maskMode, setMaskMode] = useState('names');
  const [revealed, setRevealed] = useState(() => new Set());
  const [compilingId, setCompilingId] = useState(null);
  useEffect(() => {
    setQuizOn(false);
    setMaskMode('names');
    setRevealed(new Set());
  }, [confusables, drill]);
  const togglePair = id => setRevealed(current => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const toggleDrill = () => {
    setQuizOn(value => !value);
    setRevealed(new Set());
  };
  const changeMode = next => {
    setMaskMode(next);
    setRevealed(new Set());
  };
  const runCompileLab = async pair => {
    if (!onCompileLab || compilingId) return;
    setCompilingId(pair.id);
    try { await onCompileLab(pair); } finally { setCompilingId(null); }
  };
  const modeOptions = [
    { value: 'names', label: ui('遮概念名') },
    ...(hasConfusableAspect(confusables, 'difference') ? [{ value: 'difference', label: ui('遮关键区别') }] : []),
    ...(hasConfusableAspect(confusables, 'mistake') ? [{ value: 'mistake', label: ui('遮常见误区') }] : []),
  ];
  return (
    <div className="book-conf">
      <div className={drill && confusables.length > 0 ? 'book-conf__bar' : undefined}>
        <p className="book-conf__muted">{ui('术语卡里对立或并列的概念，一对一对比较；点编号去那张术语卡。')}</p>
        {drill && confusables.length > 0 && (
          <div className="book-conf__controls">
            {quizOn && modeOptions.length > 1 && (
              <SegmentedControl size="sm" label={ui('遮盖方式')} value={maskMode} options={modeOptions} onChange={changeMode} />
            )}
            <Button size="sm" variant="secondary" wrap className="book-conf__toggle" aria-pressed={quizOn} onClick={toggleDrill}>
              {quizOn ? ui('退出对照自测') : ui('对照自测')}
            </Button>
          </div>
        )}
      </div>
      {confusables.map(each => {
        const pairMasked = drill && quizOn && !revealed.has(each.id);
        const maskNames = pairMasked && maskMode === 'names';
        const maskAspect = pairMasked && maskMode !== 'names' ? maskMode : null;
        const shownNames = each.names.map((name, at) => (maskNames ? maskedLabel(at) : name));
        const anchorHid = each.hids?.find(Boolean) || '';
        const isStuck = Boolean(anchorHid && stuckHids?.has?.(anchorHid));
        return <article key={each.id} className="book-conf__pair" data-confusable={each.id}
          data-confusable-masked={pairMasked ? '' : undefined}
          data-confusable-mask-mode={pairMasked ? maskMode : undefined}>
          <h3 className="book-conf__head">
            <span className="book-conf__id">{each.id}</span>
            {maskNames ? <span className="book-conf__cue">{ui('先按下方线索分辨这两个概念')}</span>
              : each.names.map((name, at) => <React.Fragment key={each.items[at]}>
                {at > 0 && <span className="book-conf__vs" aria-hidden="true">·</span>}
                <span className="book-conf__name">{name}</span> <CardLink code={each.items[at]} hid={each.hids?.[at]} onGo={onGo} onCard={onCard} />
              </React.Fragment>)}
            <span className="book-conf__actions">
              {drill && quizOn && (
                <Button size="sm" variant="quiet" wrap className="book-conf__toggle" onClick={() => togglePair(each.id)}>
                  {pairMasked ? (maskNames ? ui('揭晓名称') : ui('揭晓内容')) : ui('重新遮住')}
                </Button>
              )}
              {drill && quizOn && anchorHid && onMarkStuck && (
                <Button size="sm" variant="quiet" wrap aria-pressed={isStuck} data-confusable-stuck={each.id} onClick={() => onMarkStuck(anchorHid, !isStuck)}>
                  {isStuck ? ui('已记卡住') : ui('卡住了')}
                </Button>
              )}
              {onCompileLab && !maskNames && (
                <Button size="sm" variant="secondary" iconEnd="arrow-right" wrap className="book-conf__lab" data-confusable-lab={each.id}
                  disabled={compilingId !== null} onClick={() => runCompileLab(each)}>
                  {compilingId === each.id ? ui('正在生成实验…') : ui('转为辩证对比实验')}
                </Button>
              )}
            </span>
          </h3>
          <table className="book-conf__table">
            <thead><tr><td aria-hidden="true" />{each.items.map((item, at) => <th key={item} scope="col">{shownNames[at]}</th>)}</tr></thead>
            <tbody>{each.rows.map(row => <tr key={row.aspect} className="book-conf__row" data-aspect={row.aspect}
              data-aspect-masked={maskAspect === row.aspect ? '' : undefined}>
              <th scope="row">{aspectLabel(row.aspect)}</th>
              {row.cells.map((cell, at) => <td key={at} data-head={shownNames[at]}>
                {pairMasked ? maskConfusableCell({ aspect: row.aspect, cell, names: each.names, mode: maskMode }) : cell}
              </td>)}
            </tr>)}</tbody>
          </table>
        </article>;
      })}
    </div>
  );
});
