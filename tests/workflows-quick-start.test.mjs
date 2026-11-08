/* S5 (#779): Workflows page is a read-only archive of historical sessions with a calm retirement banner,
   no quick-start input or creation controls, and full English translation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`export { default as Workflows } from './ui/Workflows.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
const { Workflows, setUiLanguage } = m;
const baseListing = {
  retired: true,
  components: [],
  templates: [],
  sessions: [],
  topics: [],
  skeletons: [],
  groups: { groups: [] },
  limit: 5,
};
const sampleSessions = [
  { id: 'ws-1', topic: 'Memento', title: 'AI 带学', stepTitle: '讲解', status: 'completed', updatedAt: '2026-10-01T08:00:00.000Z' },
  { id: 'ws-2', topic: 'Raft Quorum', title: '费曼四步', stepTitle: '复述', status: 'active', updatedAt: '2026-10-02T09:00:00.000Z' },
];
const render = (listing, language = 'zh', data = {}) => {
  setUiLanguage(language);
  try {
    return renderToStaticMarkup(React.createElement(Workflows, { data: { root: 'r', modelReady: true, ...data }, initialListing: listing }));
  } finally {
    setUiLanguage('zh');
  }
};
const text = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

test('the archive page shows the calm retirement banner and has no quick-start input or creation buttons', () => {
  const html = render(baseListing);
  assert.match(text(html), /历史学习流记录/);
  assert.match(text(html), /学习流已退役，历史记录只读保留/);
  assert.match(text(html), /学法/);
  assert.doesNotMatch(html, /wf-quick-go/);
  assert.doesNotMatch(html, /aria-label="(?:想学什么|What do you want to learn\?)"/);
});

test('without historical sessions it renders a calm empty state; with sessions it sorts newest first with 查看记录 only', () => {
  assert.match(text(render(baseListing)), /当前学习库没有历史学习流记录/);
  const html = render({ ...baseListing, sessions: sampleSessions });
  assert.ok(html.indexOf('Raft Quorum') < html.indexOf('Memento'), 'newest session comes first');
  assert.match(text(html), /查看记录/);
  assert.doesNotMatch(text(html), /删除|新建|编辑流程|开始学习流/);
});

test('English: the read-only archive and retirement banner are translated with no residual Chinese UI strings', () => {
  const html = text(render({ ...baseListing, sessions: sampleSessions }, 'en'));
  assert.doesNotMatch(html.replace(/AI 带学|讲解|费曼四步|复述/g, ''), /[㐀-鿿]/);
  assert.match(html, /retired/i);
  assert.match(html, /read-only/i);
});
