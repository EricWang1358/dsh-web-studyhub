import React, { useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, TextArea, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { HAND_OFF_LABEL, handOffTip, useHandOff } from './use-hand-off.js';
import css from './hand-off.css';

/* 「发给主会话」 as drawn (the hand-off plan, section 1.2; ui/hand-off/use-hand-off.js does the work). One label everywhere, its rule on hover and focus
   in a layered Tooltip (never a title attribute), and never the page's primary button: the two places whose main action IS the hand-off keep their own
   primary Button and only call send(). Shapes: 'link' (default, inside a line or an error row), 'quiet' (a line of its own), 'icon' (the ChatCircleText
   glyph, its accessible name the label), 'secondary' (the one action of a form or dialog that holds nothing else). */

const VARIANT = { link: 'link', quiet: 'quiet', icon: 'quiet', secondary: 'secondary' };

/**
 * The button alone, for a place that builds its own message (the book's 问 AI form): onClick, busy, disabled; what: this place's first Tooltip
 * sentence; label: only 「发给主会话…」 where it opens a form first. Extra props (data-*) go on the button.
 */
export function HandOffButton({ shape = 'link', size = 'sm', what = '', label = HAND_OFF_LABEL, busy = false, disabled = false, onClick, anchorClassName = 'sh-handoff__tip', ...rest }) {
  useInjectCss(css, 'study-hand-off');
  const variant = VARIANT[shape] || 'link', text = ui(label);
  const button = shape === 'icon'
    ? <Button variant={variant} size={size} icon="chat" className="sh-btn--icon" aria-label={text} busy={busy} disabled={disabled} onClick={onClick} {...rest} />
    : <Button variant={variant} size={size} busy={busy} disabled={disabled} onClick={onClick} {...rest}>{text}</Button>;
  return <Tooltip layer content={handOffTip(what)} anchorClassName={anchorClassName}>{button}</Tooltip>;
}

/**
 * <HandOff id input what lead shape said onSent />: the whole unit. id: a registry id (ui/agent-prompts/index.js); input: the entry's input, or an
 * async function that reads it; lead: a short sentence before the button (「想先和主会话聊聊怎么学：」); said: what a write before it did; onSent(outcome).
 */
export function HandOff({ id, input, what = '', lead = '', shape = 'link', said = '', onSent, disabled = false, className, ...rest }) {
  useInjectCss(css, 'study-hand-off');
  const { send } = useHandOff();
  const [sending, setSending] = useState(false), flight = useRef(false);
  const go = async () => {
    if (flight.current) return;
    flight.current = true;
    setSending(true);
    // (`onSent?.(await send(...))` would not call send at all without an onSent: the optional call skips its arguments)
    try { const outcome = await send(id, input, { said }); onSent?.(outcome); } finally { flight.current = false; setSending(false); }
  };
  const button = <HandOffButton shape={shape} what={what} busy={sending} disabled={disabled} onClick={go} data-hand-off={id} {...rest} />;
  if (!lead) return className ? <span className={className}>{button}</span> : button;
  return (
    <span className={['sh-handoff', shape === 'quiet' && 'sh-handoff--quiet', className].filter(Boolean).join(' ')}>
      <span className="sh-handoff__lead">{ui(lead)}</span>{button}
    </span>
  );
}

/**
 * <HandOffForm id input prepare chips placeholder label what said submitLabel needsText disabled rows onSent>: only for the migrated places that already had
 * a box of their own (knowledge skeleton extension, learning flows). New places have no box: the chat's input box is the box. chips: catalogue keys, a tap
 * fills the box; input(text, prepared): the entry's input made from what was typed (the entry's builder puts it in a fenceRequest fence) and what prepare returned;
 * prepare(text): the write before the hand-off (a flow saved, notes saved), resolving to what input needs, or `false` to stop (the place said why itself);
 * submitLabel: 「保存并发给主会话」 when a write comes first; needsText: the button waits for a word; disabled: the place's own reasons; rows: the box's height;
 * children: a control above the box (the extension's intent). The box empties once it was handed over.
 */
export function HandOffForm({ id, input, prepare, chips = [], placeholder = '', label = '', what = '', said = '', submitLabel = HAND_OFF_LABEL, needsText = false, disabled = false, rows = 3,
  onSent, maxLength = 600, className, children }) {
  useInjectCss(css, 'study-hand-off');
  const { send } = useHandOff();
  const [text, setText] = useState(''), [sending, setSending] = useState(false), flight = useRef(false);
  const waiting = disabled || (needsText && !text.trim());
  const go = async () => {
    if (flight.current || waiting) return;
    flight.current = true;
    setSending(true);
    try {
      const typed = text.trim(), prepared = prepare ? await prepare(typed) : undefined;
      if (prepared === false) return;
      const outcome = await send(id, () => input(typed, prepared), { said });
      if (outcome !== 'failed') setText('');
      onSent?.(outcome);
    } finally { flight.current = false; setSending(false); }
  };
  return (
    <form className={['sh-handoff-form', className].filter(Boolean).join(' ')} data-hand-off-form={id} onSubmit={event => { event.preventDefault(); go(); }}>
      {chips.length > 0 && <div className="sh-handoff-form__chips" role="group" aria-label={ui('常用的问法')}>
        {chips.map(chip => <Button key={chip} size="sm" variant="quiet" type="button" onClick={() => setText(ui(chip))}>{ui(chip)}</Button>)}
      </div>}
      {children}
      <TextArea className="sh-handoff-form__box" rows={rows} maxLength={maxLength} value={text} disabled={disabled} onChange={event => setText(event.target.value)}
        aria-label={label ? ui(label) : ui(HAND_OFF_LABEL)} placeholder={placeholder ? ui(placeholder) : undefined}
        onKeyDown={event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); go(); } }} />
      <div className="sh-handoff-form__send">
        <HandOffButton shape="secondary" what={what} label={submitLabel} busy={sending} disabled={waiting} type="submit" data-hand-off={id} />
      </div>
    </form>
  );
}

export default HandOff;
