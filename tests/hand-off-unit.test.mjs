/* 「发给主会话」, the shared unit (ui/hand-off/, the hand-off plan sections 1.1-1.2 and 5 S2a; direction B 「盖章回执」), without a browser:
   - the delivery behind askInChat (deliverToChat): into an empty composer, never over the learner's own text (copied instead), copied without a chat, the
     full-text card when the clipboard refuses (a slip only when it was closed without copying); one receipt per outcome (seal, title, line, at most one
     action, its own time), a write said first; a prompt without the language sentence gets it once; the receipts as the region draws them; the card;
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
  export { deliverToChat, useHandOff, handOffTip, withLanguageTail, handOffReceipt, HAND_OFF_RECEIPTS, HAND_OFF_RULE } from './ui/hand-off/use-hand-off.js';
  export { SEALS } from './ui/hand-off/Receipt.jsx';
  export { default as HandOffSheet } from './ui/hand-off/HandOffSheet.jsx';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { messageParts } from './ui/agent-prompts/message.js';
  export { ToastRegion, shouldAutoDismiss } from './ui/components/Feedback.jsx';
  export { HandOff, HandOffButton, HandOffForm } from './ui/hand-off/HandOff.jsx';
  export { fillComposer, composerHasContent, attachToComposer, canAttachToComposer } from './ui/host/composer-draft.js';
  export { languageTail } from './ui/agent-prompts/say.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { InlineMessage, Banner } from './ui/components/Feedback.jsx';
  export { noticeToToast } from './ui/ActionFeedback.jsx';
  export { ICON_NAMES } from './ui/components/Icon.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
m.setUiLanguage('zh');
const h = React.createElement;
const TAIL = '请用中文回复；已有的题目和引文保持原文，不要翻译。';
const actx = { id: 'session-scope' };

/** A fake app: what askInChat's host does, a clipboard that takes or refuses, and the notices said. */
function fakes({ host = null, refuse = false, openSheet = () => {} } = {}) {
  const notices = [], copied = [];
  const clipboard = { writeText: async (text) => { if (refuse) throw new Error('denied'); copied.push(text); } };
  return { notices, copied, deliver: (prompt, said, images) => m.deliverToChat({ host, prompt, said, images, notify: (value) => notices.push(value), openSheet, clipboard }) };
}

test('filled: the host took it into an empty box; the receipt 填 says to check and press send, with 去主会话 where the host can show the chat (#488); the language sentence is added once', async () => {
  const seen = [];
  const { notices, copied, deliver } = fakes({ host: { askInChat: (text) => { seen.push(text); return 'filled'; }, showChat: () => {} } });
  assert.equal(await deliver('请改这一节。'), 'filled');
  assert.deepEqual(seen, [`请改这一节。\n${TAIL}`]);
  assert.deepEqual(copied, []);
  const [filled] = notices;
  assert.deepEqual({ ...filled, action: filled.action.label }, { receipt: 'filled', title: '已填进主会话的输入框', text: '看一眼，再由你按发送', timeout: 8000, action: '去主会话' });
  const noChat = fakes({ host: { askInChat: () => 'filled' } });
  await noChat.deliver('p');
  assert.equal(noChat.notices[0].action, undefined, 'no button where this host cannot show the chat');
  // An older host answers true; a prompt that already carries the sentence is not given a second one.
  const again = fakes({ host: { askInChat: () => true } });
  assert.equal(await again.deliver(`x\n${TAIL}`), 'filled');
  assert.equal(m.withLanguageTail(`x\n${TAIL}`), `x\n${TAIL}`);
});

test('pictures of a page (#488): after the text they go into the box, the receipt says so; a refused or missing picture is said too; without a chat they are not touched', async () => {
  const order = [], pic = [{ name: 'page-3.jpg' }];
  const host = { askInChat: () => { order.push('text'); return 'filled'; }, attachToChat: files => { order.push(files); return true; }, showChat: () => {} };
  const ok = fakes({ host });
  assert.equal(await ok.deliver('p', '', pic), 'filled');
  assert.deepEqual(order, ['text', pic], 'text first: a picture in the box would make the box count as the learner\'s own');
  assert.equal(ok.notices[0].text, '这一页的图也附上了。看一眼，再由你按发送');
  const refused = fakes({ host: { ...host, attachToChat: () => false } });
  await refused.deliver('p', '', pic);
  assert.equal(refused.notices[0].text, '没能附上这一页的图，需要的话自己截图贴上。看一眼，再由你按发送');
  const none = fakes({ host });
  await none.deliver('p', '', []);
  assert.match(none.notices[0].text, /^没能附上这一页的图/, 'a page that could not be drawn says so as well');
  const kept = fakes({ host: { ...host, askInChat: () => 'kept' } });
  assert.equal(await kept.deliver('p', '', pic), 'kept');
  assert.match(kept.notices[0].text, /^这一页的图也附上了。这段已复制/, 'a picture never replaces what the learner typed, so it still goes in');
  const seen = [];
  const noChat = fakes({ host: { askInChat: () => false, attachToChat: files => { seen.push(files); return true; } } });
  assert.equal(await noChat.deliver('p', '', pic), 'copied');
  assert.deepEqual(seen, []);
  assert.doesNotMatch(noChat.notices[0].text, /这一页的图/);
  const plain = fakes({ host: { ...host, attachToChat: files => { seen.push(files); return true; } } });
  await plain.deliver('p');
  assert.deepEqual(seen, [], 'every other hand-off has no picture and says nothing about one');
  assert.equal(plain.notices[0].text, '看一眼，再由你按发送');
});

test('the composer takes a picture through the two faces of the real host: a draft is registered, its id joins the box; a host without them, or a busy box, says false and leaves nothing behind', () => {
  const files = [{ name: 'page-3.jpg', type: 'image/jpeg' }], log = [];
  const conversation = (add = true) => ({
    createDrafts: (session, given) => { log.push(['drafts', session, given]); return [{ id: 'd1' }]; },
    releaseDraftAttachments: drafts => log.push(['released', drafts]),
    input: { for: () => ({ addAttachments: ids => { log.push(['add', ids]); return add; } }) },
  });
  assert.equal(m.canAttachToComposer(conversation()), true);
  assert.equal(m.attachToComposer(conversation(), actx, 's1', files), true);
  assert.deepEqual(log.splice(0), [['drafts', 's1', files], ['add', ['d1']]]);
  assert.equal(m.attachToComposer(conversation(false), actx, 's1', files), false);
  assert.deepEqual(log.splice(0).at(-1), ['released', [{ id: 'd1' }]], 'a busy box refuses: the draft is let go');
  assert.equal(m.canAttachToComposer({ input: { for: () => ({}) } }), false, 'DSH without createDrafts: the old screenshot way');
  assert.equal(m.attachToComposer({ input: { for: () => ({}) } }, actx, 's1', files), false);
  assert.equal(m.attachToComposer({ createDrafts: () => [], input: { for: () => ({}) } }, actx, 's1', files), false, 'no addAttachments');
  assert.equal(m.attachToComposer(null, actx, 's1', files), false);
  assert.equal(m.attachToComposer(conversation(), actx, 's1', []), false);
  assert.equal(m.attachToComposer({ createDrafts: () => { throw new Error('gone'); }, input: { for: () => ({ addAttachments: () => true }) } }, actx, 's1', files), false);
});

test('kept: the learner\'s own text stays; the prompt is copied; 去主会话 only where the host can show the chat; a write before it is said before the line', async () => {
  let shown = 0;
  const { notices, copied, deliver } = fakes({ host: { askInChat: () => 'kept', showChat: () => { shown += 1; } } });
  assert.equal(await deliver('p', '已保存。'), 'kept');
  assert.deepEqual(copied, [`p\n${TAIL}`]);
  const [receipt] = notices;
  assert.deepEqual({ ...receipt, action: receipt.action.label }, { receipt: 'kept', title: '输入框里你写的字都留着', text: '已保存。这段已复制，粘贴到合适的位置', timeout: 8000, action: '去主会话' });
  receipt.action.run();
  assert.equal(shown, 1, '去主会话 shows the chat');
  const bare = fakes({ host: { askInChat: () => 'kept' } });
  await bare.deliver('p');
  assert.equal(bare.notices[0].action, undefined, 'a host that cannot show the chat gets no button that would do nothing');
  for (const notice of [receipt, bare.notices[0]]) assert.doesNotMatch(`${notice.title}${notice.text}`, /草稿/, 'the learner\'s typed text is never called 草稿 (a draft deck)');
});

test('copied: no chat (no host, a host without askInChat, a host that says false or throws); 看看内容 opens the card with what was copied', async () => {
  for (const host of [null, {}, { askInChat: () => false }, { askInChat: () => { throw new Error('gone'); } }, { askInChat: async () => { throw new Error('gone'); } }]) {
    const sheets = [];
    const { notices, copied, deliver } = fakes({ host, openSheet: (sheet) => sheets.push(sheet) });
    assert.equal(await deliver('p'), 'copied');
    assert.equal(copied.length, 1);
    const [receipt] = notices;
    assert.deepEqual({ ...receipt, action: receipt.action.label }, { receipt: 'copied', title: '已复制到剪贴板', text: '没找到主会话，粘贴到任意对话', timeout: 6000, action: '看看内容' });
    receipt.action.run();
    assert.equal(notices.at(-1), '', 'the slip leaves before the card opens (no second copy of it inside the card)');
    assert.deepEqual(sheets.map(({ text, mode }) => ({ text, mode })), [{ text: `p\n${TAIL}`, mode: 'copied' }]);
  }
});

test('shown: a refused clipboard opens the full-text card at once, with no slip; closed without copying it leaves 「需要手动复制 · 打开全文」, which stays', async () => {
  const sheets = [];
  const { notices, deliver } = fakes({ refuse: true, openSheet: (sheet) => sheets.push(sheet) });
  assert.equal(await deliver('第一行\n第二行', '已保存。'), 'shown');
  assert.deepEqual(notices, [''], 'no slip while the card is open');
  assert.equal(sheets.length, 1);
  assert.deepEqual({ text: sheets[0].text, mode: sheets[0].mode, lead: sheets[0].lead }, { text: `第一行\n第二行\n${TAIL}`, mode: 'shown', lead: '已保存。' });
  sheets[0].onClosed(true);
  assert.deepEqual(notices, [''], 'copied in the card: nothing is left behind');
  sheets[0].onClosed(false);
  const slip = notices.at(-1);
  assert.deepEqual({ ...slip, action: slip.action.label }, { receipt: 'shown', title: '需要手动复制', text: '已保存。浏览器没让复制，点「打开全文」', persistent: true, action: '打开全文' });
  slip.action.run();
  assert.equal(sheets.length, 2, '打开全文 opens the card again');
  // the learner's text in the box was kept and the clipboard refused: the card says both
  const both = [];
  await fakes({ host: { askInChat: () => 'kept' }, refuse: true, openSheet: (sheet) => both.push(sheet) }).deliver('p');
  assert.equal(both[0].lead, '输入框里你写的字都留着');
  // Without the app around it (no card to open) the slip carries the whole text; a clipboard that is missing altogether (an old webview) is a refusal too.
  const none = [];
  assert.equal(await m.deliverToChat({ host: null, prompt: 'p', notify: (value) => none.push(value), clipboard: undefined }), 'shown');
  assert.equal(none[0].receipt, 'shown');
  assert.ok(none[0].text.endsWith(`p\n${TAIL}`) && none[0].copy, 'the text to copy by hand is in it');
});

test('English: the receipts and the language sentence are English', async () => {
  m.setUiLanguage('en');
  try {
    const { notices, copied, deliver } = fakes({ host: { askInChat: () => 'kept', showChat: () => {} } });
    await deliver('p');
    assert.equal(copied[0], `p\n${m.languageTail('en')}`);
    assert.equal(notices[0].title, 'Your typed text is kept');
    assert.equal(notices[0].text, 'Copied: paste it where it fits');
    assert.equal(notices[0].action.label, 'Go to the main chat');
    assert.equal(m.handOffTip('写进这个知识点，或发给主会话'), 'Write into this point, or send it to the main chat. Only fills the main chat’s input box and you press send; without a main chat it is copied to the clipboard.');
  } finally { m.setUiLanguage('zh'); }
});

test('the receipt table: each outcome its title, its line, its one action and its time; each title carries its seal\'s character', () => {
  assert.deepEqual(Object.keys(m.HAND_OFF_RECEIPTS), ['filled', 'kept', 'copied', 'shown']);
  assert.deepEqual(Object.fromEntries(Object.entries(m.HAND_OFF_RECEIPTS).map(([outcome, receipt]) => [outcome, [receipt.timeout, receipt.action ?? null]])),
    { filled: [8000, '去主会话'], kept: [8000, '去主会话'], copied: [6000, '看看内容'], shown: [0, '打开全文'] });
  for (const [outcome, receipt] of Object.entries(m.HAND_OFF_RECEIPTS)) {
    assert.ok(receipt.title.includes(m.SEALS[outcome].character), `${outcome}: ${m.SEALS[outcome].character} in 「${receipt.title}」`);
    assert.ok(m.ICON_NAMES.includes(m.SEALS[outcome].glyph), `${outcome}: its English glyph is in the icon set`);
  }
});

test('the receipt as the region draws it: its own seal, title and line, a quiet action, a countdown line when it leaves by itself; one fixed key', () => {
  const draw = (notice) => { const toast = m.noticeToToast(notice); return [toast, renderToStaticMarkup(h(m.ToastRegion, { toasts: [toast], placement: 'page' }))]; };
  for (const outcome of ['filled', 'kept', 'copied', 'shown']) {
    const receipt = m.HAND_OFF_RECEIPTS[outcome];
    const [toast, html] = draw({ ...m.handOffReceipt(outcome, { action: receipt.action ? { label: receipt.action, run() {} } : null }), key: 7 });
    assert.equal(toast.key, 'notice:hand-off', `${outcome}: a newer receipt takes the slip that is up`);
    assert.equal(toast.stamp, 7);
    assert.match(html, new RegExp(`class="sh-toast sh-toast--info sh-toast--receipt" data-receipt="${outcome}"`));
    assert.match(html, new RegExp(`<span class="sh-seal sh-seal--md" data-o="${outcome}" aria-hidden="true"><span class="sh-seal__char">${m.SEALS[outcome].character}</span></span>`));
    assert.doesNotMatch(html, /sh-toast__icon/, `${outcome}: no tone icon`);
    assert.match(html, new RegExp(`<strong class="sh-toast__title">${receipt.title}</strong><span class="sh-toast__message">${receipt.line}</span>`));
    if (receipt.action) assert.match(html, new RegExp(`sh-btn--quiet[^"]*sh-toast__action[^>]*>${receipt.action}<`), `${outcome}: a quiet action`);
    else assert.doesNotMatch(html, /sh-toast__action/, `${outcome}: no action`);
    assert.equal(/sh-toast__timer/.test(html), outcome !== 'shown', `${outcome}: a countdown line only when it leaves by itself`);
    assert.equal(m.shouldAutoDismiss(toast), outcome !== 'shown', `${outcome}: ${outcome === 'shown' ? 'stays until closed' : 'leaves by itself, action or not'}`);
    // (the close button is the shared IconButton, named by its label)
    assert.doesNotMatch(html.replace(/<button[^>]*sh-toast__close[^>]*>/, ''), /\stitle="/);
  }
  // an ordinary info toast with an action still stays (only undo offers and receipts leave with one)
  assert.equal(m.shouldAutoDismiss({ tone: 'info', action: { label: 'x' } }), false);
  // English: the glyph in the seal's frame, not a letter
  m.setUiLanguage('en');
  try {
    const [, html] = draw(m.handOffReceipt('kept'));
    assert.match(html, /<span class="sh-seal sh-seal--md" data-o="kept" aria-hidden="true"><svg class="sh-icon sh-seal__glyph"/);
  } finally { m.setUiLanguage('zh'); }
});

test('the full-text card: the message once, in a box: the learner\'s sentence, their words, the notes folded under the prompt\'s own head; one copy action; shown asks with the filled button, copied with the quiet one', () => {
  const text = m.handOffText('workflow.design', { template: { id: 'wf1', title: 'Daily flow', version: 2 }, wish: '讲慢一点' }, 'zh');
  const card = (mode) => renderToStaticMarkup(h(m.StudyServicesContext.Provider, { value: services }, h(m.HandOffSheet, { sheet: { text, mode, lead: '' }, onClose() {} })));
  const shown = card('shown');
  assert.match(shown, /<span class="sh-seal sh-seal--lg" data-o="shown"/);
  assert.match(shown, /需要手动复制/);
  assert.match(shown, /浏览器没让复制/);
  assert.match(shown, /<p class="sh-handoff-sheet__ask">帮我调整学习流 <span class="sh-handoff-sheet__name">Daily flow<\/span>：<\/p>/);
  assert.match(shown, /<blockquote class="sh-handoff-sheet__request"><span class="sh-handoff-sheet__label">我的要求<\/span>讲慢一点<\/blockquote>/);
  const notes = m.messageParts(text, 'zh').notes.length;
  assert.match(shown, new RegExp(`<summary>StudyHub 附注（给助手）· ${notes} 行</summary>`), 'the fold says the head the message itself has');
  assert.match(shown, /<details class="sh-handoff-sheet__fold">/, 'folded until asked');
  // the message once: the drawn sentence and the quote are the top of the selectable box, not a summary above a raw copy of the same words
  assert.equal(shown.match(/帮我调整学习流/g).length, 1, 'the learner\'s sentence once');
  assert.equal(shown.match(/讲慢一点/g).length, 1, 'their words once');
  assert.doesNotMatch(shown, /```request|sh-handoff-sheet__top|sh-handoff-sheet__summary/, 'no raw fence on show');
  assert.match(shown, /<div class="sh-handoff-sheet__box" data-hand-off-text=""><p class="sh-handoff-sheet__ask">/);
  // a text that is not laid out as a message (no notes head) is shown as it is, once
  const plain = renderToStaticMarkup(h(m.StudyServicesContext.Provider, { value: services }, h(m.HandOffSheet, { sheet: { text: '一段\n旧格式的话', mode: 'shown', lead: '' }, onClose() {} })));
  assert.equal(plain.match(/旧格式的话/g).length, 1);
  assert.doesNotMatch(plain, /sh-handoff-sheet__fold/);
  assert.match(shown, /sh-btn--primary[^"]*sh-handoff-sheet__copy/);
  assert.match(shown, /复制不了？全选后按 (Ctrl\+C|⌘C)/);
  const copied = card('copied');
  assert.match(copied, /sh-btn--secondary[^"]*sh-handoff-sheet__copy/);
  assert.match(copied, /再复制一次/);
  assert.doesNotMatch(copied, /sh-btn--primary/);
  for (const html of [shown, copied]) assert.doesNotMatch(html.replace(/<button[^>]*sh-dialog__close[^>]*>/, ''), /\stitle="/);
});
test('the Tooltip: a place\'s `what` without a sentence end gets one before the fixed rule; one that has it is left alone', () => {
  m.setUiLanguage('zh');
  assert.equal(m.handOffTip('写进这个知识点，或发给主会话'), `写进这个知识点，或发给主会话。${m.HAND_OFF_RULE}`);
  assert.equal(m.handOffTip('写进这个知识点。'), `写进这个知识点。${m.HAND_OFF_RULE}`);
  assert.equal(m.handOffTip('要换个讲法？'), `要换个讲法？${m.HAND_OFF_RULE}`);
  assert.equal(m.handOffTip(), m.HAND_OFF_RULE);
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
  assert.match(asked[0][0], /^帮我看看题组 `Physics`：/);
  assert.ok(asked[0][0].endsWith(TAIL), 'a sentence that already asks needs no 我想： after it');
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
