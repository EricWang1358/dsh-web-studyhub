import { useCallback, useMemo } from 'react';
import { errorMessage, getUiLanguage, ui, uiFormat } from '../i18n.js';
import { useStudy } from '../study-context.jsx';
import { handOffText, isHandOff } from '../agent-prompts/index.js';
import { hasLanguageTail, languageTail } from '../agent-prompts/say.js';

/* 「发给主会话」, the one shared unit (the hand-off plan, section 1): every page that hands work to the main chat goes through here, with an id of the
   registry (ui/agent-prompts/index.js). It only ever fills the chat's input box (the learner presses send), never over what the learner already typed,
   and says what happened with a receipt in the app's one notice slot (direction B 「盖章回执」: a seal, a title, one line, at most one action); a refused
   clipboard opens the full-text card (ui/hand-off/HandOffSheet.jsx) instead. A page writes no toast or inline line of its own about it.
   ui/hand-off/HandOff.jsx draws the button. */

/** The label of every button and menu item that hands over (one fact, one wording). */
export const HAND_OFF_LABEL = '发给主会话';
/** The fixed rule of its Tooltip (second sentence; a place may put its own `what` first). */
export const HAND_OFF_RULE = '只填进主会话的输入框，由你按发送；没有主会话时复制到剪贴板。';

/** The short form of the rule, for a menu item's one-line hint (the whole rule does not fit beside a label on a phone). */
export const HAND_OFF_MENU_HINT = '只填进输入框，不自动发送';

/**
 * The receipt of each outcome: its title (the seal's character is in it: 填 留 复 手), the one line under it, its one action and how long it stays (ms; 0:
 * until it is closed). 'filled' has no action (the host already switched to the chat); 'kept' offers 去主会话 only where the host can show the chat;
 * 'shown' is the slip left when the full-text card was closed without copying. The learner's own typed text is never called 草稿 (that word is a draft deck).
 */
export const HAND_OFF_RECEIPTS = Object.freeze({
  filled: { title: '已填进主会话的输入框', line: '看一眼，再由你按发送', timeout: 5000 },
  kept: { title: '输入框里你写的字都留着', line: '这段已复制，粘贴到合适的位置', timeout: 8000, action: '去主会话' },
  copied: { title: '已复制到剪贴板', line: '没找到主会话，粘贴到任意对话', timeout: 6000, action: '看看内容' },
  shown: { title: '需要手动复制', line: '浏览器没让复制，点「打开全文」', timeout: 0, action: '打开全文' },
});
/** The input of a hand-off could not be read: the app's error toast, no seal. */
export const HAND_OFF_FAILED = '没能发给主会话：{0}';

/* Sentences one after another: one that does not end a sentence yet gets the language's full stop (a place's `what` may be a bare phrase), then a space
   after one that ends in a Latin character (English), none after a Chinese one. A closing quote or bracket after the end mark still counts as ended. */
const ENDED = /[.!?。！？…:：;；][\s"'”’」』)）]*$/;
const endSentence = text => (ENDED.test(text) ? text : `${text}${/^zh/i.test(getUiLanguage()) ? '。' : '.'}`);
export const joinSentences = parts => parts.filter(Boolean).reduce((text, part) => {
  if (!text) return part;
  const ended = endSentence(text);
  return `${ended}${/[!-~]$/.test(ended) ? ' ' : ''}${part}`;
}, '');

/** The Tooltip text: this place's `what` (optional, a catalogue key) and the fixed rule. */
export const handOffTip = (what = '') => joinSentences([what ? ui(what) : '', ui(HAND_OFF_RULE)]);

/** A prompt that does not say which language to answer in yet gets the one language sentence (a registered hand-off already ends with it). */
export const withLanguageTail = text => (hasLanguageTail(text) ? text : `${String(text).trimEnd()}\n${languageTail(getUiLanguage())}`);

/**
 * The receipt notice of `outcome`: { receipt, title, text (`lead`, what a write before it did, goes before the line), timeout, action? }. action: { label, run }.
 */
export function handOffReceipt(outcome, { lead = '', action = null } = {}) {
  const receipt = HAND_OFF_RECEIPTS[outcome];
  return { receipt: outcome, title: ui(receipt.title), text: joinSentences([lead, ui(receipt.line)]), ...(receipt.timeout ? { timeout: receipt.timeout } : { persistent: true }),
    ...(action ? { action } : {}) };
}

/**
 * The delivery behind askInChat (ui/app/use-app-core.js): host.askInChat(text) fills the composer ('filled' or true), keeps the learner's own text ('kept')
 * or has no chat (anything else). Not filled: the prompt goes onto the clipboard. A refused clipboard opens the full-text card (`openSheet({ text, mode:
 * 'shown', lead, onClosed(copied) })`), and only a card closed without copying leaves the 「需要手动复制」 slip, whose action opens the card again; without a
 * card (no app around it) the slip carries the whole text. `said`: what a write before the hand-off did (「已保存。」), said first.
 * Resolves to 'filled' | 'kept' | 'copied' | 'shown'.
 */
export async function deliverToChat({ host, prompt, said = '', notify = () => {}, openSheet = null, clipboard = globalThis.navigator?.clipboard }) {
  const text = withLanguageTail(String(prompt ?? '')), lead = said ? ui(said) : '';
  let outcome = false;
  try { outcome = await host?.askInChat?.(text); } catch { outcome = false; }
  if (outcome === true || outcome === 'filled') { notify(handOffReceipt('filled', { lead })); return 'filled'; }
  const kept = outcome === 'kept';
  const look = mode => () => { notify(''); openSheet?.({ text, mode, lead }); };
  try {
    await clipboard.writeText(text);
    // 去主会话 only where the host can show the chat (the top-level page covers it); 看看内容 opens the card with what was copied
    const action = kept ? (typeof host?.showChat === 'function' ? { label: ui(HAND_OFF_RECEIPTS.kept.action), run: () => host.showChat() } : null)
      : openSheet ? { label: ui(HAND_OFF_RECEIPTS.copied.action), run: look('copied') } : null;
    notify(handOffReceipt(kept ? 'kept' : 'copied', { lead, action }));
    return kept ? 'kept' : 'copied';
  } catch {
    if (!openSheet) { notify({ ...handOffReceipt('shown', { lead }), text: `${joinSentences([lead, ui(HAND_OFF_RECEIPTS.shown.line)])}\n\n${text}`, copy: true }); return 'shown'; }
    // the learner's own text in the box was kept: the card and its slip say so too, before why it was not copied
    const said = joinSentences([lead, kept ? ui(HAND_OFF_RECEIPTS.kept.title) : '']);
    const reopen = { label: ui(HAND_OFF_RECEIPTS.shown.action), run: () => open() };
    const open = () => { notify(''); openSheet({ text, mode: 'shown', lead: said, onClosed: copied => { if (!copied) notify(handOffReceipt('shown', { lead: said, action: reopen })); } }); };
    open();
    return 'shown';
  }
}

/**
 * useHandOff() -> { send, action, item }.
 *   send(id, input, { said }) -> Promise<'filled'|'kept'|'copied'|'shown'|'failed'>: `input` may be an async function (read what the message needs first);
 *     a write before the hand-off stays at the call site (await act(..., { rethrow: true }), then send with `said`). 'failed': the input could not be read.
 *   action(id, input, { what, said }) -> { label, onClick, tip }: for a Feedback action/secondary, a CompactJobCard link, a FileDrop rejectAction.
 *   item(id, input) -> { id, label, hint (the short rule), run }: a Menu item; Menu runs it when chosen (it does not reach onSelect; no dialog of its own).
 * An id the registry does not have throws at once.
 */
export function useHandOff() {
  const { askInChat, notify } = useStudy();
  const send = useCallback(async (id, input = {}, { said = '' } = {}) => {
    if (!isHandOff(id)) throw new Error(`Unknown hand-off: ${id}`);
    let text;
    try {
      const value = typeof input === 'function' ? await input() : input;
      text = handOffText(id, value ?? {}, getUiLanguage());
    } catch (failure) {
      notify({ text: uiFormat(HAND_OFF_FAILED, [errorMessage(failure)]), tone: 'error' });
      return 'failed';
    }
    return (await askInChat(text, { said })) || 'failed';
  }, [askInChat, notify]);
  const action = useCallback((id, input, { what = '', said = '' } = {}) => {
    if (!isHandOff(id)) throw new Error(`Unknown hand-off: ${id}`);
    return { label: ui(HAND_OFF_LABEL), onClick: () => send(id, input, { said }), tip: handOffTip(what) };
  }, [send]);
  const item = useCallback((id, input) => {
    if (!isHandOff(id)) throw new Error(`Unknown hand-off: ${id}`);
    return { id: `hand-off:${id}`, label: ui(HAND_OFF_LABEL), hint: ui(HAND_OFF_MENU_HINT), run: () => send(id, input) };
  }, [send]);
  return useMemo(() => ({ send, action, item }), [send, action, item]);
}
