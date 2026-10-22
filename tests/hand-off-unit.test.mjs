/* 「发给主会话」, the shared unit (ui/hand-off/, the hand-off plan sections 1.1-1.2 and 5 S2a), without a browser:
   - the delivery behind askInChat (deliverToChat): into an empty composer, never over the learner's draft (copied instead), copied without a chat, shown in a
     notice that stays when the clipboard refuses; one wording per outcome, a write said first; a prompt without the language sentence gets it once;
   - the host side (ui/host/composer-draft.js) against a conversation wrapped in a Proxy whose submit throws: empty -> setDraft only, text / a chip /
     an attachment -> nothing written, unreadable -> taken as empty, no conversation or a throwing host -> not filled;
   - useHandOff: send (an async input, a failing input, an unknown id), action and item; <HandOff>: one label, its rule in a layered Tooltip, never primary,
     the icon shape named by its label; the Feedback messages' secondary and tip. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { deliverToChat, useHandOff, handOffTip, withLanguageTail, HAND_OFF_NOTICES, HAND_OFF_RULE } from './ui/hand-off/use-hand-off.js';
  export { HandOff, HandOffButton, HandOffForm } from './ui/hand-off/HandOff.jsx';
  export { fillComposer, composerHasContent } from './ui/host/composer-draft.js';
  export { languageTail } from './ui/agent-prompts/say.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { InlineMessage, Banner } from './ui/components/Feedback.jsx';
  export { noticeToToast } from './ui/ActionFeedback.jsx';
  export { ICON_NAMES } from './ui/components/Icon.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
m.setUiLanguage('zh');
const h = React.createElement;
const TAIL = '请用中文回复；已有的题目和引文保持原文，不要翻译。';

/** A fake app: what askInChat's host does, a clipboard that takes or refuses, and the notices said. */
function fakes({ host = null, refuse = false } = {}) {
  const notices = [], copied = [];
  const clipboard = { writeText: async (text) => { if (refuse) throw new Error('denied'); copied.push(text); } };
  return { notices, copied, deliver: (prompt, said) => m.deliverToChat({ host, prompt, said, notify: (value) => notices.push(value), clipboard }) };
}

test('filled: the host took it into an empty box; the notice says to check and press send; the language sentence is added once', async () => {
  const seen = [];
  const { notices, copied, deliver } = fakes({ host: { askInChat: (text) => { seen.push(text); return 'filled'; } } });
  assert.equal(await deliver('请改这一节。'), 'filled');
  assert.deepEqual(seen, [`请改这一节。\n${TAIL}`]);
  assert.deepEqual(copied, []);
  assert.deepEqual(notices, ['已填进主会话的输入框，确认后按发送。']);
  // An older host answers true; a prompt that already carries the sentence is not given a second one.
  const again = fakes({ host: { askInChat: () => true } });
  assert.equal(await again.deliver(`x\n${TAIL}`), 'filled');
  assert.equal(m.withLanguageTail(`x\n${TAIL}`), `x\n${TAIL}`);
});

test('kept: the learner\'s words stay; the prompt is copied and the notice says why; a write before it is said first', async () => {
  const { notices, copied, deliver } = fakes({ host: { askInChat: () => 'kept' } });
  assert.equal(await deliver('p', '已保存。'), 'kept');
  assert.deepEqual(copied, [`p\n${TAIL}`]);
  assert.deepEqual(notices, ['已保存。输入框里已有文字，没有覆盖：提示词已复制，粘贴到合适的位置再发送。']);
});

test('copied: no chat (no host, a host without askInChat, a host that says false or throws)', async () => {
  for (const host of [null, {}, { askInChat: () => false }, { askInChat: () => { throw new Error('gone'); } }, { askInChat: async () => { throw new Error('gone'); } }]) {
    const { notices, copied, deliver } = fakes({ host });
    assert.equal(await deliver('p'), 'copied');
    assert.equal(copied.length, 1);
    assert.deepEqual(notices, ['没有主会话：提示词已复制，粘贴到对话里再发送。']);
  }
});

test('shown: a refused clipboard puts the whole prompt in a notice that stays, under its title; the notice is drawn untranslated', async () => {
  const { notices, deliver } = fakes({ refuse: true });
  assert.equal(await deliver('第一行\n第二行'), 'shown');
  assert.deepEqual(notices, [{ title: '复制这段提示词，粘贴到对话里', text: `第一行\n第二行\n${TAIL}`, copy: true, persistent: true }]);
  const kept = fakes({ host: { askInChat: () => 'kept' }, refuse: true });
  assert.equal(await kept.deliver('p'), 'shown');
  assert.equal(kept.notices[0].title, '输入框里已有文字，没有覆盖。复制这段提示词，粘贴到对话里');
  const toast = m.noticeToToast(notices[0]);
  assert.equal(toast.title, '复制这段提示词，粘贴到对话里');
  assert.equal(toast.message, `第一行\n第二行\n${TAIL}`);
  assert.equal(toast.persistent, true);
  // A clipboard that is missing altogether (an old webview) is a refusal too.
  const none = [];
  assert.equal(await m.deliverToChat({ host: null, prompt: 'p', notify: (value) => none.push(value), clipboard: undefined }), 'shown');
});

test('English: the notices and the language sentence are English', async () => {
  m.setUiLanguage('en');
  try {
    const { notices, copied, deliver } = fakes({ host: { askInChat: () => 'kept' } });
    await deliver('p');
    assert.equal(copied[0], `p\n${m.languageTail('en')}`);
    assert.match(notices[0], /^The input box already has your text, so it was left as it is: the prompt is copied/);
    assert.equal(m.handOffTip('写进这个知识点，或发给主会话'), 'Write into this point, or send it to the main chat Only fills the main chat’s input box and you press send; without a main chat it is copied to the clipboard.');
  } finally { m.setUiLanguage('zh'); }
});

/* The host side: a session input as DSH has it (SessionInputShell: projection.detectText, state.getSnapshot(), setDraft, submit), wrapped so a submit throws. */
function conversationWith({ text = '', draft = text, attachments = [], projection = true, state = true } = {}) {
  const log = [];
  const shell = { setDraft: (value) => log.push(['setDraft', value]), submit: () => log.push(['submit']), actions: { submit: () => log.push(['actions.submit']) } };
  if (projection) shell.projection = { detectText: text };
  if (state) shell.state = { getSnapshot: () => ({ draft, attachmentIds: attachments }) };
  const guard = (target, path) => new Proxy(target, { get(object, key) {
    if (key === 'submit') throw new Error(`${path}.submit must never be called`);
    const value = object[key];
    return value && typeof value === 'object' ? guard(value, `${path}.${String(key)}`) : value;
  } });
  const conversation = { input: { for: (actx) => { log.push(['for', actx.id]); return guard(shell, 'input'); } } };
  return { conversation, log };
}
const actx = { id: 'session-scope' };

test('the composer: empty -> setDraft only (never submit); words, a chip or an attachment -> nothing written', () => {
  const empty = conversationWith();
  assert.equal(m.fillComposer(empty.conversation, actx, 'prompt'), 'filled');
  assert.deepEqual(empty.log, [['for', 'session-scope'], ['setDraft', 'prompt']]);
  const blank = conversationWith({ text: '  \n ' });
  assert.equal(m.fillComposer(blank.conversation, actx, 'prompt'), 'filled', 'whitespace is empty');
  for (const [what, options] of [['typed words', { text: '我自己写的' }], ['a file chip (one placeholder character)', { text: '\uFFFC', draft: '@notes.md' }],
    ['an attachment', { attachments: ['att-1'] }], ['a draft only the snapshot shows', { projection: false, draft: 'typed' }]]) {
    const { conversation, log } = conversationWith(options);
    assert.equal(m.fillComposer(conversation, actx, 'prompt'), 'kept', what);
    assert.deepEqual(log, [['for', 'session-scope']], `${what}: nothing written`);
  }
});

test('the composer: unreadable is taken as empty; no conversation, no scope or a throwing host is not filled', () => {
  const unreadable = conversationWith({ projection: false, state: false });
  assert.equal(m.fillComposer(unreadable.conversation, actx, 'p'), 'filled');
  assert.equal(m.composerHasContent({ get projection() { throw new Error('renamed'); }, state: { getSnapshot: () => { throw new Error('renamed'); } } }), false);
  assert.equal(m.fillComposer(null, actx, 'p'), false);
  assert.equal(m.fillComposer(conversationWith().conversation, null, 'p'), false);
  assert.equal(m.fillComposer({ input: { for: () => { throw new Error('conversation.input.for requires a retained Session scope'); } } }, actx, 'p'), false);
  assert.equal(m.fillComposer({ input: { for: () => ({ projection: { detectText: '' }, setDraft: () => { throw new Error('disposed'); } }) } }, actx, 'p'), false);
});

/** The hook's api, read once while rendering inside a fake app (its functions keep working afterwards). */
function handOffApi(services) {
  let api;
  const Probe = () => { api = m.useHandOff(); return null; };
  renderToStaticMarkup(h(m.StudyServicesContext.Provider, { value: services }, h(Probe)));
  return api;
}

test('useHandOff().send: the registry builds the message (an async input is awaited), askInChat delivers it with `said`; a failing input says so', async () => {
  const asked = [], notices = [];
  const api = handOffApi({ askInChat: async (text, options) => { asked.push([text, options]); return 'kept'; }, notify: (value) => notices.push(value) });
  assert.equal(await api.send('deck.ask', async () => ({ deckTitle: 'Physics' }), { said: '已保存。' }), 'kept');
  assert.match(asked[0][0], /题组「`Physics`」/);
  assert.ok(asked[0][0].endsWith(`${TAIL}\n我想：`));
  assert.deepEqual(asked[0][1], { said: '已保存。' });
  assert.equal(await api.send('deck.ask', async () => { throw new Error('book.coverage refused'); }), 'failed');
  assert.deepEqual(notices, [{ text: '没能发给主会话：book.coverage refused', tone: 'error' }]);
  assert.equal(asked.length, 1, 'nothing delivered when the input failed');
  await assert.rejects(() => api.send('no.such', {}), /Unknown hand-off: no\.such/);
  assert.throws(() => api.action('no.such', {}), /Unknown hand-off/);
});

test('useHandOff().action and .item: one label, the rule as tip and its short form as hint, sending on click or select', async () => {
  const asked = [];
  const api = handOffApi({ askInChat: async (text) => { asked.push(text); return 'filled'; }, notify: () => {} });
  const action = api.action('topic.explain', { topic: 'Entropy', deckTitle: 'Physics', mastery: 40 }, { what: '讲这个主题，再出一两道小题检查我。' });
  assert.equal(action.label, '发给主会话');
  assert.equal(action.tip, '讲这个主题，再出一两道小题检查我。只填进主会话的输入框，由你按发送；没有主会话时复制到剪贴板。');
  assert.equal(await action.onClick(), 'filled');
  const item = api.item('deck.ask', { deckTitle: 'Physics' });
  assert.deepEqual({ id: item.id, label: item.label, hint: item.hint }, { id: 'hand-off:deck.ask', label: '发给主会话', hint: '只填进输入框，不自动发送' });
  assert.equal(await item.run(), 'filled');
  assert.equal(asked.length, 2);
});

const services = { askInChat: async () => 'filled', notify: () => {} };
const draw = (element) => renderToStaticMarkup(h(m.StudyServicesContext.Provider, { value: services }, element));

test('<HandOff>: the label, its rule in a layered Tooltip, a lead; never primary; the icon shape is named by its label and has no title', () => {
  const link = draw(h(m.HandOff, { id: 'deck.ask', input: { deckTitle: 'Physics' }, lead: '想先和主会话聊聊怎么学：' }));
  assert.match(link, /class="sh-handoff__lead">想先和主会话聊聊怎么学：</);
  assert.match(link, /data-hand-off="deck\.ask"[^>]*>发给主会话</);
  assert.match(link, /sh-btn--link/);
  assert.match(link, /只填进主会话的输入框，由你按发送；没有主会话时复制到剪贴板。/);
  for (const shape of ['link', 'quiet', 'icon', 'secondary']) {
    const html = draw(h(m.HandOff, { id: 'deck.ask', input: {}, shape }));
    assert.doesNotMatch(html, /sh-btn--primary/, `${shape}: never primary`);
    assert.doesNotMatch(html, /\stitle="/, `${shape}: no title attribute`);
  }
  const icon = draw(h(m.HandOff, { id: 'topic.explain', input: {}, shape: 'icon' }));
  assert.match(icon, /aria-label="发给主会话"/);
  assert.match(icon, /sh-btn--icon/);
  assert.ok(m.ICON_NAMES.includes('chat'), 'the chat glyph is in the icon set');
  const form = draw(h(m.HandOffForm, { id: 'skeleton.extend', input: (text) => ({ text }), chips: ['讲细点'], placeholder: '想让主会话怎么扩展？' }));
  assert.match(form, /data-hand-off-form="skeleton\.extend"/);
  assert.match(form, /<textarea[^>]*placeholder="想让主会话怎么扩展？"/);
  assert.match(form, /type="submit"[^>]*>发给主会话</);
});

test('Feedback: InlineMessage has Banner\'s secondary; action and secondary may carry a tip (a layered Tooltip, no title)', () => {
  const inline = renderToStaticMarkup(h(m.InlineMessage, { tone: 'error', action: { label: '重试', onClick() {} }, secondary: { label: '发给主会话', onClick() {}, tip: '只填进主会话的输入框' } }, '没导入'));
  assert.match(inline, />重试</);
  assert.match(inline, /sh-inline__secondary[^>]*>发给主会话</);
  assert.match(inline, /class="sh-popover-anchor sh-feedback__tip"/);
  assert.doesNotMatch(inline, /\stitle="/);
  const banner = renderToStaticMarkup(h(m.Banner, { title: 't', action: { label: 'a', onClick() {}, tip: 'why a' }, secondary: { label: 'b', onClick() {} } }));
  assert.match(banner, /sh-feedback__tip/);
  assert.equal((banner.match(/sh-feedback__tip/g) || []).length, 1, 'only the action with a tip is wrapped');
});
