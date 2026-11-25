import React, { useRef, useState } from 'react';
import { ui } from '../i18n.js';
import { Button, TextArea, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useStudy } from '../study-context.jsx';
import { COPY_PROMPT_LABEL, HAND_OFF_LABEL, handOffTip, hasChatHost, useHandOff } from './use-hand-off.js';
import css from './hand-off.css';

/* 「发给主会话」 as drawn (the hand-off plan, section 1.2; ui/hand-off/use-hand-off.js does the work). One label everywhere, its rule on hover and focus
   in a layered Tooltip (never a title attribute), and never the page's primary button: the two places whose main action IS the hand-off keep their own
   primary Button and only call send(). The main chat is DSH's, not StudyHub's, so every shape leads with the `external` mark, the one look of a link to a DSH chat
   (AgentLink; ui/DESIGN.md, #1073 round 10). Shapes: 'link' (default, inside a line or an error row), 'quiet' (a line of its own), 'icon' (no words, its accessible
   name the label: the chat glyph, the one exception to the mark, because a lone ↗ reads "opens a link" and a topic row's end must say "ask the main chat" at a glance;
   round 11, ICON_ONLY_HAND_OFFS in tests/helpers/go-on.mjs lists where it is used), 'secondary' (the one action of a form or dialog that holds nothing else). */

const VARIANT = { link: 'link', quiet: 'quiet', icon: 'quiet', secondary: 'secondary' };

/**
 * The button alone, for a place that builds its own message (the book's 问 AI form): onClick, busy (the same label at the same width, quieter: no spinner
 * is added, so the line it stands in never moves), disabled; what: this place's first Tooltip
 * sentence; label: the place's own words where a write comes first (保存并发给主会话). Extra props (data-*) go on the button.
 */
export function HandOffButton({ shape = 'link', size = 'sm', what = '', copyWhat = '', label = HAND_OFF_LABEL, copyLabel = '', busy = false, disabled = false, onClick, anchorClassName = 'sh-handoff__tip', ...rest }) {
  useInjectCss(css, 'study-hand-off');
  const { host } = useStudy();
  const canChat = hasChatHost(host);
  const effectiveLabel = !canChat
    ? (copyLabel || (label === HAND_OFF_LABEL || String(label).includes('主会话') ? COPY_PROMPT_LABEL : label))
    : label;
  const effectiveWhat = !canChat && copyWhat ? copyWhat : what;
  const variant = VARIANT[shape] || 'link', text = ui(effectiveLabel);
  const chatButton = shape === 'icon'
    ? <Button variant={variant} size={size} icon="chat" className="sh-btn--icon sh-handoff__btn" data-tour="hand-off" aria-label={text} aria-busy={busy || undefined} disabled={disabled || busy} onClick={onClick} {...rest} />
    : <Button variant={variant} size={size} icon="external" className="sh-handoff__btn" data-tour="hand-off" aria-busy={busy || undefined} disabled={disabled || busy} onClick={onClick} {...rest}>{text}</Button>;
  const waiting = { 'aria-busy': busy || undefined, disabled: disabled || busy };
  const button = canChat ? chatButton : <CopyPromptButton iconOnly={shape === 'icon'} variant={variant} size={size} text={text} onClick={onClick} rest={{ ...waiting, ...rest }} />;
  return <Tooltip layer content={handOffTip(effectiveWhat, canChat)} anchorClassName={anchorClassName}>{button}</Tooltip>;
}

/* A host with no main chat (the desktop edition) has no window to hand anything to: the same control copies the prompt and the learner stays,
   so it draws the copy glyph, never the mark of a window outside or the chat glyph. */
function CopyPromptButton({ iconOnly, variant, size, text, onClick, rest }) {
  return (
    <Button variant={variant} size={size} icon="copy" className={iconOnly ? 'sh-btn--icon sh-handoff__btn' : 'sh-handoff__btn'} data-tour="hand-off"
      aria-label={iconOnly ? text : undefined} onClick={onClick} {...rest}>{iconOnly ? null : text}</Button>
  );
}

/**
 * <HandOff id input what lead shape said onSent />: the whole unit. id: a registry id (ui/agent-prompts/index.js); input: the entry's input, or an
 * async function that reads it; lead: a short sentence before the button (「想先和主会话聊聊怎么学：」); said: what a write before it did; onSent(outcome).
 */
export function HandOff({ id, input, what = '', copyWhat = '', lead = '', copyLead = '', label = HAND_OFF_LABEL, copyLabel = '', shape = 'link', said = '', onSent, disabled = false, className, ...rest }) {
  useInjectCss(css, 'study-hand-off');
  const { host } = useStudy();
  const canChat = hasChatHost(host);
  const { send } = useHandOff();
  const [sending, setSending] = useState(false), flight = useRef(false);
  const go = async () => {
    if (flight.current) return;
    flight.current = true;
    setSending(true);
    // (`onSent?.(await send(...))` would not call send at all without an onSent: the optional call skips its arguments)
    try { const outcome = await send(id, input, { said }); onSent?.(outcome); } finally { flight.current = false; setSending(false); }
  };
  const button = <HandOffButton shape={shape} label={label} copyLabel={copyLabel} what={what} copyWhat={copyWhat} busy={sending} disabled={disabled} onClick={go} data-hand-off={id} {...rest} />;
  const effectiveLead = !canChat && copyLead ? copyLead : lead;
  if (!effectiveLead) return className ? <span className={className}>{button}</span> : button;
  return (
    <span className={['sh-handoff', shape === 'quiet' && 'sh-handoff--quiet', className].filter(Boolean).join(' ')}>
      <span className="sh-handoff__lead">{ui(effectiveLead)}</span>{button}
    </span>
  );
}

/**
 * <HandOffForm id input prepare chips placeholder label what said submitLabel needsText disabled rows onSent>: only for the migrated places that already had
 * a box of their own (knowledge skeleton extension, learning flows). New places have no box: the chat's input box is the box. chips: catalogue keys, a tap
 * fills the box; input(text, prepared): the entry's input made from what was typed (the entry's builder puts it in a request fence) and what prepare returned;
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
