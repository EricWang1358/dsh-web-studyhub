/* global document, window */
/* 复习全书 M5 on the page (static zh and en): the feedback of a graded case question shows its 分析题答案卡 in its parts instead of the plain reference
   answer, each unfound quote marked 未核实, the marks map, the state (已核对 / 部分未核对 / 被改过) with 「已核对 ≠ 答案正确」; without a card the
   reference answer as before and 「生成答题卡」, or the shared model gate (its own feature key) without a model. Fakes only. */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { loadUi } from './helpers/ui-module.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { CASE_TYPES } from '../lib/case-types.js';
import { answerCardBasis, answerCardState, checkAnswerCard, finishAnswerCard, normalizeAnswerCard } from '../lib/answer-card.js';
import { MATERIAL, SCENARIO, caseCard, criteria, goodCard } from './helpers/answer-card-library.mjs';

const ui = await loadUi(`
  export { default as AnswerCardSection, AnswerCardView } from './ui/AnswerCard.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';`);
const h = React.createElement, noop = () => {}, han = /[㐀-鿿]/;
const services = { call: async () => ({ followupIds: [], answerCardIds: [], courses: [] }), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {},
  openSettings: noop, navigate: noop, openModal: noop };
const render = element => renderToStaticMarkup(h(ui.StudyServicesContext.Provider, { value: services }, element));
const english = fn => { ui.setUiLanguage('en'); try { return fn(); } finally { ui.setUiLanguage('zh'); } };
const textOf = html => html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

const made = raw => {
  const card = caseCard();
  const answerCard = finishAnswerCard(checkAnswerCard(normalizeAnswerCard(raw, { types: CASE_TYPES, language: 'en' }), { stem: [{ id: 'prompt', text: card.prompt }, { id: 'case', text: SCENARIO }],
    materials: [{ id: 'mat1', ref: 'M1', title: 'Lecture 4 · Availability', text: MATERIAL }], criteria: criteria(), numbers: ['yearly downtime = (1 - A) x 8760 h'] }), { review: { ran: true, issues: [], repaired: false }, basis: answerCardBasis(card) });
  return { ...answerCard, state: answerCardState({ ...card, answerCard }) };
};
const ready = { model: { ready: true } };
const runWith = (solution, data = ready) => render(h(ui.AnswerCardSection, { run: { id: 'r1', deckId: 'case1', card: { id: 'q1' }, solution }, data, onSetupModel: noop }));

test('a question with an answer card: every part in order, the state and the notice, 未核实 where a quote was not found, the marks map', () => {
  const card = made({ ...goodCard(), facts: [...goodCard().facts, { text: 'Bookings stop', quote: 'A sentence that is in neither the question nor the case.' }] });
  const html = runWith({ answer: 'The reference answer.', answerCard: card }), text = textOf(html);
  assert.match(html, /data-answer-card="partial"/);
  assert.match(text, /答题卡 Availability 部分未核对/);
  assert.match(text, /已核对 ≠ 答案正确/);
  assert.match(text, /引文 4\/5 已在原文找到 · 评分点 3\/3/);
  const labels = [...html.matchAll(/<h4 class="answer-card__label">([^<]+)<\/h4>/g)].map(match => match[1]);
  assert.deepEqual(labels, ['识别信号', '题干事实', '概念', '假设', '推理链', '结论', '为什么满足目标', '代价与失败处理', '如何验证', '易错检查', '评分点对照'], 'the parts in the answer order');
  assert.equal((html.match(/answer-card__unverified/g) || []).length, 1, 'one 未核实');
  assert.match(text, /A sentence that is in neither the question nor the case\. 未核实/);
  assert.match(text, /（资料：Lecture 4 · Availability） Availability is the proportion of time/);
  assert.match(text, /Calculation · c1\.k1 2 One server/);
  assert.match(text, /原来的参考答案 The reference answer\./, 'the old answer stays, folded');
  assert.doesNotMatch(html, /data-answer-card-generate/, 'no 生成 button for a card that is there');
  const verified = textOf(runWith({ answer: 'x', answerCard: made(goodCard()) }));
  assert.match(verified, /答题卡 Availability 已核对/);
  const edited = runWith({ answer: 'x', answerCard: { ...made(goodCard()), state: 'edited' } });
  assert.match(textOf(edited), /被改过.*在答题卡生成后改过/);
  assert.match(edited, /data-answer-card-generate="again"/, '重新生成 for a changed question');
});

test('a question without one: the reference answer as before and 「生成答题卡」; without a model the gate with its own words', () => {
  const html = runWith({ answer: 'The reference answer.' }), text = textOf(html);
  assert.match(text, /参考答案（批改后揭晓） The reference answer\./);
  assert.match(html, /data-answer-card-generate="new"[^>]*>[\s\S]*生成答题卡/);
  assert.doesNotMatch(html, /data-answer-card=/);
  const off = textOf(runWith({ answer: 'x' }, { model: { ready: false, reason: 'no-route' } }));
  assert.match(off, /生成答题卡需要先配置模型|参考答案照常能看/);
});

test('AnswerCard in English: the answer-card surface\'s own words', () => english(() => {
  const html = runWith({ answer: 'The reference answer.', answerCard: made(goodCard()) }) + runWith({ answer: 'x' });
  const own = textOf(html).replace(/可用性/g, '');
  assert.equal(han.test(own), false, own);
  assert.match(textOf(html), /Answer card Availability Checked/);
  assert.match(textOf(html), /Checked ≠ correct/);
  assert.match(textOf(html), /Generate answer card/);
}));

test('the gate\'s feature key is the answer card\'s own; the case feedback uses the section with onSetupModel wired', async () => {
  const interactive = await loadInteractiveUi(`
    export { default as ModelSetupGate } from './ui/ModelSetupGate.jsx';
    export { RubricAnswer } from './ui/CaseWorkspace.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  const { ModelSetupGate, RubricAnswer, StudyServicesContext, setUiLanguage } = interactive.exports;
  const ih = interactive.React.createElement;
  const noModel = { ready: false, reason: 'no-route' };

  // 1. ModelSetupGate with feature="answerCard" renders dedicated answer-card copy in ZH & EN (not the default generate fallback).
  setUiLanguage('zh');
  const zhBlock = interactive.mount(ih(ModelSetupGate, { feature: 'answerCard', variant: 'block', model: noModel, onOpenSettings: noop }));
  try {
    assert.match(zhBlock.text(), /生成答题卡要调用 AI 模型；参考答案和已经生成的答题卡不需要模型也能看。/);
    assert.match(zhBlock.text(), /回到这道题，点「生成答题卡」/);
    assert.doesNotMatch(zhBlock.text(), /出题需要一个可用的 AI 模型|还没有选择用来出题的 AI 模型/);
  } finally {
    zhBlock.unmount();
  }
  const zhCompact = interactive.mount(ih(ModelSetupGate, { feature: 'answerCard', variant: 'compact', model: noModel, onOpenSettings: noop }));
  try {
    assert.match(zhCompact.text(), /生成答题卡需要先配置模型；参考答案照常能看。/);
  } finally {
    zhCompact.unmount();
  }
  setUiLanguage('en');
  try {
    const enBlock = interactive.mount(ih(ModelSetupGate, { feature: 'answerCard', variant: 'block', model: noModel, onOpenSettings: noop }));
    try {
      assert.equal(han.test(enBlock.text()), false, enBlock.text());
      assert.match(enBlock.text(), /Generating an answer card calls an AI model/);
    } finally {
      enBlock.unmount();
    }
    const enCompact = interactive.mount(ih(ModelSetupGate, { feature: 'answerCard', variant: 'compact', model: noModel, onOpenSettings: noop }));
    try {
      assert.equal(han.test(enCompact.text()), false, enCompact.text());
      assert.match(enCompact.text(), /Generating an answer card needs a model first; the reference answer is still shown\./);
    } finally {
      enCompact.unmount();
    }
  } finally {
    setUiLanguage('zh');
  }

  // 2. RubricAnswer in CaseWorkspace renders AnswerCardSection in its feedback state and wires onSetupModel into the gate.
  await withBrowserGlobals(async () => {
    const feedback = {
      answer: 'My draft answer.',
      rubric: { total: 6, max: 10, band: 'pass', summary: 'Solid start.', criteria: [{ id: 'c1', label: 'Calculation', score: 6, max: 10, ratio: 0.6 }] },
    };
    const baseRun = {
      id: 'r1',
      index: 0,
      deckId: 'case1',
      card: { id: 'q1', marks: 10, prompt: caseCard().prompt, rubricCriteria: [{ id: 'c1', label: 'Calculation', marks: 10 }] },
      feedback,
    };

    const withCard = interactive.mount(ih(
      StudyServicesContext.Provider,
      { value: services },
      ih(RubricAnswer, {
        run: { ...baseRun, solution: { answer: 'The reference answer.', answerCard: made(goodCard()) } },
        data: ready,
        onSetupModel: noop,
      }),
    ));
    try {
      assert.ok(withCard.find(n => n.props?.['data-answer-card'] === 'verified'), 'case feedback renders AnswerCardSection when solution has an answerCard');
      assert.match(withCard.text(), /答题卡.*Availability.*已核对/);
      assert.match(withCard.text(), /原来的参考答案.*The reference answer\./);
    } finally {
      withCard.unmount();
    }

    let setupCalls = 0;
    const withoutModel = interactive.mount(ih(
      StudyServicesContext.Provider,
      { value: services },
      ih(RubricAnswer, {
        run: { ...baseRun, solution: { answer: 'The reference answer.' } },
        data: { model: noModel },
        onSetupModel: () => { setupCalls += 1; },
      }),
    ));
    try {
      const gateNode = withoutModel.find(n => n.props?.['data-model-gate'] === 'compact');
      assert.ok(gateNode, 'case feedback renders AnswerCardSection compact gate when no model is ready');
      assert.match(withoutModel.text(gateNode), /生成答题卡需要先配置模型；参考答案照常能看。/);
      const gateBtn = withoutModel.find(n => n.type === 'button' && typeof n.props?.onClick === 'function', gateNode);
      assert.ok(gateBtn, 'gate offers a settings button');
      click(gateBtn);
      assert.equal(setupCalls, 1, 'clicking the gate button invokes onSetupModel wired through CaseWorkspace RubricAnswer');
    } finally {
      withoutModel.unmount();
    }
  });
});

test('answer card table tracks horizontal scroll edges with token-based shadow cues', { timeout: 60000 }, async t => {
  const card = made(goodCard());
  const html = runWith({ answer: 'The reference answer.', answerCard: card });
  assert.match(html, /<div class="answer-card__table"><div class="answer-card__table-scroll"><table>/);

  for (const sheet of ['../ui/markdown.css', '../ui/answer-card.css']) {
    const css = (await readFile(new URL(sheet, import.meta.url), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
    assert.match(css, /\[data-edge-left="true"\]/, sheet);
    assert.match(css, /\[data-edge-right="true"\]/, sheet);
    assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b|rgba?\(/i, sheet);
  }

  const bundle = await build({
    stdin: {
      contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { AnswerCardView } from './ui/AnswerCard.jsx';
        import { StudyServicesContext } from './ui/study-context.jsx';
        import answerCardCss from './ui/answer-card.css';
        import { setUiLanguage } from './ui/i18n.js';
        setUiLanguage('zh');
        const card = ${JSON.stringify(card)};
        const noop = () => {};
        const services = { call: async () => ({ courses: [] }), act: async () => undefined, busy: false, notify: noop, askInChat: noop, host: {}, openSettings: noop, navigate: noop, openModal: noop };
        createRoot(document.getElementById('root')).render(
          <StudyServicesContext.Provider value={services}>
            <div className="study-app" style={{ width: 180 }}>
              <style>{answerCardCss + '.answer-card__table th, .answer-card__table td { white-space: nowrap; }'}</style>
              <AnswerCardView card={card} />
            </div>
          </StudyServicesContext.Provider>
        );`,
      resolveDir: process.cwd(),
      loader: 'jsx',
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', loader: { '.css': 'text' }, logLevel: 'silent',
  });

  let browser;
  try { browser = await launchChromium(); }
  catch (error) {
    if (!/browserType\.launch: Executable doesn't exist/.test(String(error.message))) throw error;
    t.skip('Chromium unavailable'); return;
  }
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 400, height: 800 } });
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.setContent('<main id="root"></main>');
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.locator('.answer-card__table').waitFor();

  await page.waitForFunction(() => document.querySelector('.answer-card__table')?.getAttribute('data-edge-right') === 'true');
  assert.deepEqual(await page.evaluate(() => ({
    left: document.querySelector('.answer-card__table')?.getAttribute('data-edge-left'),
    right: document.querySelector('.answer-card__table')?.getAttribute('data-edge-right'),
  })), { left: null, right: 'true' });

  await page.evaluate(() => {
    const scroller = document.querySelector('.answer-card__table-scroll');
    scroller.scrollLeft = 24;
    scroller.dispatchEvent(new window.Event('scroll'));
  });
  await page.waitForFunction(() => document.querySelector('.answer-card__table')?.getAttribute('data-edge-left') === 'true');
  assert.equal(await page.evaluate(() => document.querySelector('.answer-card__table')?.getAttribute('data-edge-right')), 'true');

  await page.evaluate(() => {
    const scroller = document.querySelector('.answer-card__table-scroll');
    scroller.scrollLeft = scroller.scrollWidth;
    scroller.dispatchEvent(new window.Event('scroll'));
  });
  await page.waitForFunction(() => !document.querySelector('.answer-card__table')?.getAttribute('data-edge-right'));
  assert.equal(await page.evaluate(() => document.querySelector('.answer-card__table')?.getAttribute('data-edge-left')), 'true');
  assert.deepEqual(errors, []);
});
