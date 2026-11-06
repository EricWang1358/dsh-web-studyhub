import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* A saved 定制方案 names chapters, and a re-converted or re-imported book can lose one (#758). course.custom.preview has always reported the ids in
   unknownChapters, and apply waits for the chat — but the card dropped them, so a learner looking at 「你的定制」 saw nothing wrong. The words are one
   pure function here; the card's own rendering (an effect fetches the preview, which a static render does not run) is covered by
   tests/custom-plan-browser.test.mjs, where a plan naming a chapter the book no longer holds must say so on the card. */

const m = await loadUi("export * as model from './ui/custom-plan-model.js';\nexport { setUiLanguage } from './ui/i18n.js';");
const say = (unknownChapters, language = 'zh') => { m.setUiLanguage(language); try { return m.model.unknownChaptersText({ unknownChapters }); } finally { m.setUiLanguage('zh'); } };

test('the card says how many chapters the material no longer holds, and says nothing when every one is there (#758)', () => {
  assert.equal(say([]), '');
  assert.equal(say(['pdf:a#3']), '有 1 章在资料里找不到了，需要重新选');
  assert.equal(say(['pdf:a#3', 'pdf:a#9']), '有 2 章在资料里找不到了，需要重新选');
  assert.equal(m.model.unknownChaptersText(null), '');
  assert.equal(m.model.unknownChaptersText({}), '');
  assert.equal(m.model.unknownChaptersText({ unknownChapters: 'pdf:a#3' }), '', 'a string is not a list');
  assert.equal(say(['x'], 'en'), '1 chapter(s) are no longer in the material and must be picked again');
  assert.doesNotMatch(say(['x'], 'en'), /[\u3400-\u9fff]/);
});
