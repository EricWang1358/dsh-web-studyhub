import test from 'node:test';
import assert from 'node:assert/strict';
import { loadUi } from './helpers/ui-module.mjs';

/* 「交给主会话细化」 of the reader's 思维导图: registry id reader.map (ui/agent-prompts/reader.js). The general shape of every message is tests/hand-off-registry.test.mjs. */
const hand = await loadUi(`export { handOffText } from './ui/agent-prompts/index.js';`);
const input = { title: 'Macroeconomics', chapter: 'Chapter 11', from: 201, to: 220, outline: '11 Fiscal policy\n  11.1 Spending' };

test('reader.map names the material, the chapter and its pages, carries the tree in a data fence and saves nothing (zh and en)', () => {
  const zh = hand.handOffText('reader.map', input, 'zh'), en = hand.handOffText('reader.map', input, 'en');
  assert.match(zh, /细化资料 `Macroeconomics` 里「`Chapter 11`」这一章的思维导图（第 201–220 页）/);
  assert.match(en, /refine the mind map of the chapter `Chapter 11` in the material `Macroeconomics` \(pages 201–220\)/);
  assert.match(zh, /```data 这一章的标题树\n11 Fiscal policy\n {2}11\.1 Spending\n```/);
  assert.match(en, /```data Heading tree of this chapter\n11 Fiscal policy/);
  assert.match(zh, /不会写进学习库/);
  assert.match(en, /not written into the study library/);
  assert.match(en, /source\.pages/, 'the notes name the way to read the chapter');
});

test('reader.map without a page range leaves the range out of the sentence', () => {
  const text = hand.handOffText('reader.map', { title: 'T', chapter: 'C', outline: 'x' }, 'en');
  assert.match(text, /mind map of the chapter `C` in the material `T`\./);
  assert.doesNotMatch(text, /pages \d/);
});
