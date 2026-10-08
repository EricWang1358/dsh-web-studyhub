import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* A page's course scope follows the current course until the learner picks one, then stays where they put it. Nothing used to say which; the scope picker now does
   (跟随当前课程 / 已固定), and a pinned page goes back to following with one click. */

const m = await loadUi(`
  export { default as PageScope, followState } from './ui/PageScope.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { setUiLanguage } from './ui/i18n.js';
`);
const han = /[㐀-鿿]/;
const text = markup => markup.replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const courses = [{ name: '数据结构' }, { name: '算法' }];
const setter = (pinned, follow = () => {}) => Object.assign(() => {}, { scope: { pinned, follow } });
const draw = ({ value = '数据结构', onChange = setter(false), current = '数据结构', language = 'zh', app = true } = {}) => {
  m.setUiLanguage(language);
  try {
    const picker = React.createElement(m.PageScope, { courses, value, onChange });
    return renderToStaticMarkup(app ? React.createElement(m.AppContext.Provider, { value: { data: { focus: { course: current, courses } } } }, picker) : picker);
  } finally { m.setUiLanguage('zh'); }
};

test('the rule: follows only while nothing was picked, and only when the page shows the current course', () => {
  assert.equal(m.followState({ pinned: false, value: '数据结构', current: '数据结构' }), 'following');
  assert.equal(m.followState({ pinned: true, value: '算法', current: '数据结构' }), 'pinned');
  assert.equal(m.followState({ pinned: true, value: '数据结构', current: '数据结构' }), 'pinned', 'picking the current course is still a pin');
  assert.equal(m.followState({ pinned: false, value: '*', current: '数据结构' }), null, 'a page whose default is not the current course (the exam page in interview mode) makes no claim');
  assert.equal(m.followState({ pinned: undefined, value: '数据结构', current: '数据结构' }), null, 'a page that does not say whether it is pinned makes no claim');
  assert.equal(m.followState({ pinned: false, value: '*', current: undefined }), null, 'no current course, nothing to follow');
  assert.equal(m.followState({ pinned: false, value: '', current: '' }), null, 'uncategorised is not a course to follow');
});

test('a page that follows says so, without a button', () => {
  const out = draw();
  assert.match(text(out), /跟随当前课程/);
  assert.doesNotMatch(out, /已固定/);
  assert.doesNotMatch(out, /<button[^>]*>(?:<[^>]+>)*改为跟随当前课程/);
});

test('a pinned page says so and goes back to following with one click', () => {
  let followed = 0;
  const out = draw({ value: '算法', onChange: setter(true, () => { followed++; }) });
  assert.match(text(out), /已固定/);
  assert.match(out, /<button[^>]*>(?:<[^>]+>)*改为跟随当前课程/);
  assert.equal(followed, 0);
});

test('without the app around it, or a setter that knows, there is no chip at all', () => {
  assert.doesNotMatch(draw({ app: false }), /跟随当前课程|已固定/);
  assert.doesNotMatch(draw({ onChange: () => {} }), /跟随当前课程|已固定/);
});

test('English: the chip and the button are English', () => {
  const following = draw({ language: 'en' }), pinned = draw({ language: 'en', value: '算法', onChange: setter(true) });
  assert.doesNotMatch(following.replace(/数据结构|算法/g, ''), han);
  assert.match(text(following), /Follows the current course/);
  assert.match(text(pinned), /Pinned/);
  assert.match(pinned, /<button[^>]*>(?:<[^>]+>)*Follow the current course instead/);
});
