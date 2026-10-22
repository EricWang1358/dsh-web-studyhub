import { useCallback, useMemo } from 'react';
import { errorMessage, getUiLanguage, ui, uiFormat } from '../i18n.js';
import { useStudy } from '../study-context.jsx';
import { handOffText, isHandOff } from '../agent-prompts/index.js';
import { hasLanguageTail, languageTail } from '../agent-prompts/say.js';

/* 「发给主会话」, the one shared unit (the hand-off plan, section 1): every page that hands work to the main chat goes through here, with an id of the
   registry (ui/agent-prompts/index.js). It only ever fills the chat's input box (the learner presses send), never over what the learner already typed,
   and says what happened in the app's one notice slot; a page writes no toast or inline line of its own about it. ui/hand-off/HandOff.jsx draws it. */

/** The label of every button and menu item that hands over (one fact, one wording). */
export const HAND_OFF_LABEL = '发给主会话';
/** The fixed rule of its Tooltip (second sentence; a place may put its own `what` first). */
export const HAND_OFF_RULE = '只填进主会话的输入框，由你按发送；没有主会话时复制到剪贴板。';

/** The short form of the rule, for a menu item's one-line hint (the whole rule does not fit beside a label on a phone). */
export const HAND_OFF_MENU_HINT = '只填进输入框，不自动发送';

/** What the notice says, one sentence per outcome; 'shown' is the title of the notice that holds the whole prompt. */
export const HAND_OFF_NOTICES = Object.freeze({
  filled: '已填进主会话的输入框，确认后按发送。',
  kept: '输入框里已有文字，没有覆盖：提示词已复制，粘贴到合适的位置再发送。',
  copied: '没有主会话：提示词已复制，粘贴到对话里再发送。',
  keptShown: '输入框里已有文字，没有覆盖。',
  shown: '复制这段提示词，粘贴到对话里',
  failed: '没能发给主会话：{0}',
});

/* Sentences one after another: one that does not end a sentence yet gets the language's full stop (a place's `what` may be a bare phrase), then a space
   after one that ends in a Latin character (English), none after a Chinese one. A closing quote or bracket after the end mark still counts as ended. */
const ENDED = /[.!?。！？…:：;；][\s"'”’」』)）]*$/;
const endSentence = text => (ENDED.test(text) ? text : `${text}${/^zh/i.test(getUiLanguage()) ? '。' : '.'}`);
const joinSentences = parts => parts.filter(Boolean).reduce((text, part) => {
  if (!text) return part;
  const ended = endSentence(text);
  return `${ended}${/[!-~]$/.test(ended) ? ' ' : ''}${part}`;
}, '');

/** The Tooltip text: this place's `what` (optional, a catalogue key) and the fixed rule. */
export const handOffTip = (what = '') => joinSentences([what ? ui(what) : '', ui(HAND_OFF_RULE)]);

/** A prompt that does not say which language to answer in yet gets the one language sentence (a registered hand-off already ends with it). */
export const withLanguageTail = text => (hasLanguageTail(text) ? text : `${String(text).trimEnd()}\n${languageTail(getUiLanguage())}`);

/**
 * The delivery behind askInChat (ui/app/use-app-core.js): host.askInChat(text) fills the composer ('filled' or true), keeps the learner's draft ('kept')
 * or has no chat (anything else). Not filled: the prompt goes onto the clipboard; a refused clipboard shows the whole prompt in a notice that stays.
 * `said`: what a write before the hand-off did (「已保存。」), said first. Resolves to 'filled' | 'kept' | 'copied' | 'shown'.
 */
export async function deliverToChat({ host, prompt, said = '', notify = () => {}, clipboard = globalThis.navigator?.clipboard }) {
  const text = withLanguageTail(String(prompt ?? '')), lead = said ? ui(said) : '';
  let outcome = false;
  try { outcome = await host?.askInChat?.(text); } catch { outcome = false; }
  if (outcome === true || outcome === 'filled') { notify(joinSentences([lead, ui(HAND_OFF_NOTICES.filled)])); return 'filled'; }
  const kept = outcome === 'kept';
  try {
    await clipboard.writeText(text);
    notify(joinSentences([lead, ui(kept ? HAND_OFF_NOTICES.kept : HAND_OFF_NOTICES.copied)]));
    return kept ? 'kept' : 'copied';
  } catch {
    notify({ title: joinSentences([lead, kept ? ui(HAND_OFF_NOTICES.keptShown) : '', ui(HAND_OFF_NOTICES.shown)]), text, copy: true, persistent: true });
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
      notify({ text: uiFormat(HAND_OFF_NOTICES.failed, [errorMessage(failure)]), tone: 'error' });
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
