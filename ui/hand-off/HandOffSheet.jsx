import React, { useMemo, useRef, useState } from 'react';
import { getUiLanguage, ui, uiFormat } from '../i18n.js';
import { Button, Dialog } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { messageParts } from '../agent-prompts/message.js';
import { HAND_OFF_RECEIPTS, joinSentences } from './use-hand-off.js';
import { Seal } from './Receipt.jsx';
import css from './hand-off.css';

/* The full-text card of 「发给主会话」 (direction B; opened by ui/hand-off/use-hand-off.js deliverToChat): 'shown' when the clipboard was refused (it opens at
   once, no slip beside it), 'copied' from the receipt's 看看内容. The app's own <Dialog size="sm"> (on a phone it is the full-width card). Head: the seal,
   the title, the reason. Body: the message once, in a calm box that can be selected: the learner's own sentence (its names drawn as names), their typed
   words as a quote, the notes for the assistant folded under the message's own head (「StudyHub 附注（给助手）· N 行」), the line they type after. A copy of
   the whole box (select-all, or a selection from the sentence's start into the notes) puts the message exactly as it is on the clipboard (backticks and
   fences, the drawing is only for the eye); a text that is not laid out as a message is shown as it is. Foot: one copy action (the card's one filled
   button when the learner has to act) that turns into 「已复制」 at the same width and leaves the card open, and the select-all fallback (it opens the
   fold first; the selection is the ochre highlighter, not the system blue). */

// a name span of nameData (ui/agent-prompts/say.js): a run of backticks, the name on one line (padded with a space when it starts or ends with one), the same run
const NAME_SPAN = /(?<!`)(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g;

/** The learner's sentence with its name spans drawn as names (the backticks are for the assistant). */
function Sentence({ text }) {
  const pieces = [];
  let at = 0;
  for (const match of String(text).matchAll(NAME_SPAN)) {
    if (match.index > at) pieces.push(text.slice(at, match.index));
    pieces.push(<span key={match.index} className="sh-handoff-sheet__name">{match[2].replace(/^ (.*) $/, '$1')}</span>);
    at = match.index + match[0].length;
  }
  pieces.push(text.slice(at));
  return <p className="sh-handoff-sheet__ask">{pieces}</p>;
}

const isMac = () => /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || globalThis.navigator?.userAgent || '');
const isTouch = () => { try { return !!globalThis.matchMedia?.('(pointer: coarse)').matches; } catch { return false; } };

/** sheet: { text, mode: 'shown' | 'copied', lead (what a write before it did), onClosed(copied) }; onClose(): the app forgets the card. */
export default function HandOffSheet({ sheet, onClose }) {
  useInjectCss(css, 'study-hand-off');
  const language = getUiLanguage();
  const parts = useMemo(() => messageParts(sheet.text, language), [sheet.text, language]);
  const [copied, setCopied] = useState(false), [selected, setSelected] = useState(false), [open, setOpen] = useState(false);
  const copyRef = useRef(null), boxRef = useRef(null), copiedRef = useRef(false);
  const shown = sheet.mode === 'shown', receipt = HAND_OFF_RECEIPTS[shown ? 'shown' : 'copied'];
  const touch = useMemo(isTouch, []), keys = isMac() ? '⌘C' : 'Ctrl+C';
  const laidOut = parts.notes.length > 0;
  const close = () => { onClose?.(); sheet.onClosed?.(copiedRef.current); };
  // A copy that takes the message (from the sentence's first character into the notes: what select-all makes) gets the text exactly as it is; a smaller
  // piece is copied as the learner selected it.
  const tookCopy = event => {
    copiedRef.current = true;
    setCopied(true);
    const box = boxRef.current, range = globalThis.getSelection?.()?.rangeCount ? globalThis.getSelection().getRangeAt(0) : null;
    const first = box && document.createTreeWalker(box, NodeFilter.SHOW_TEXT).nextNode(), fold = box?.querySelector('.sh-handoff-sheet__fold');
    if (!laidOut || !range || !first || !fold || !event?.clipboardData) return;
    if (range.isPointInRange(first, 0) && range.comparePoint(fold, 0) === 0) {
      event.clipboardData.setData('text/plain', sheet.text);
      event.preventDefault();
    }
  };
  // Select the whole message (the fold opened first, so the notes are in the selection; the fold's own label is not selectable).
  const selectAll = () => {
    setOpen(true);
    setSelected(true);
    requestAnimationFrame(() => {
      const box = boxRef.current, selection = globalThis.getSelection?.();
      if (!box || !selection) return;
      const range = document.createRange();
      range.selectNodeContents(box);
      selection.removeAllRanges();
      selection.addRange(range);
    });
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(sheet.text); tookCopy(); } catch { selectAll(); }
  };
  const label = shown ? ui('复制全文') : ui('再复制一次');
  const fallback = selected ? (touch ? ui('已全选，长按复制') : uiFormat('已全选，按 {0} 复制', [keys]))
    : touch ? ui('点这里全选，再长按复制') : uiFormat('复制不了？全选后按 {0}', [keys]);
  const footer = (
    <div className="sh-handoff-sheet__foot">
      <Button variant="link" size="sm" className="sh-handoff-sheet__select" onClick={selectAll}>{fallback}</Button>
      <Button ref={copyRef} variant={shown ? 'primary' : 'secondary'} icon={copied ? 'check' : 'copy'} className="sh-handoff-sheet__copy" data-copied={copied || undefined} onClick={copy}>
        <span className="sh-handoff-sheet__labels"><span aria-hidden={copied || undefined}>{label}</span><span aria-hidden={!copied || undefined}>{ui('已复制')}</span></span>
      </Button>
    </div>
  );
  return (
    <Dialog size="sm" className="sh-handoff-sheet" initialFocus={copyRef} onClose={close} footer={footer} bodyLabel={ui(receipt.title)}
      title={<span className="sh-handoff-sheet__title"><Seal outcome={shown ? 'shown' : 'copied'} size="lg" /><span>{ui(receipt.title)}</span></span>}
      description={shown ? joinSentences([sheet.lead, ui(receipt.line)]) : ui(receipt.line)}>
      <div ref={boxRef} className="sh-handoff-sheet__box" data-hand-off-text="" onCopy={tookCopy}>
        {laidOut ? <Sentence text={parts.ask} /> : <div className="sh-handoff-sheet__plain">{sheet.text}</div>}
        {laidOut && parts.request && <blockquote className="sh-handoff-sheet__request"><span className="sh-handoff-sheet__label">{ui('我的要求')}</span>{parts.request}</blockquote>}
        {laidOut && <details className="sh-handoff-sheet__fold" open={open} onToggle={event => setOpen(event.currentTarget.open)}>
          <summary>{uiFormat('StudyHub 附注（给助手）· {0} 行', [parts.notes.length])}</summary>
          <div className="sh-handoff-sheet__notes">{parts.notes.join('\n')}</div>
        </details>}
        {parts.tail && <div className="sh-handoff-sheet__tail">{parts.tail}</div>}
      </div>
    </Dialog>
  );
}
