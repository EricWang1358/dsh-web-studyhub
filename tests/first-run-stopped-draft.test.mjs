/* A first run that stands over its draft keeps one button on its card (为没覆盖的部分补题, 接着做, 去配置模型), and until the first deck is published that card is the
   only thing on the first screen that is about the draft: 待发布 is not drawn there. So the card also carries a quiet 检查草稿; without it the questions that
   passed could not be opened from the screen that says they are not finished. The runs go through the real preview server with the fake model, and the home is
   the real first-run page (ui/StudyMap.jsx), asking the same server for the coverage. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { sampleMaterial, sampleMarkdown } from '../scripts/qa/fixtures.mjs';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const home = await loadInteractiveUi(`export { default as StudyMap } from './ui/StudyMap.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { AppContext } from './ui/app/app-context.js';
  export { forgetCoverage } from './ui/coverage/use-coverage.js';
  export { setUiLanguage } from './ui/i18n.js';`);
const form = await loadUi(`export { generationRequest } from './ui/generate-form.js';
  export { freshGeneration } from './ui/generation-status.js';`);

const noop = () => {};
const pause = (ms) => new Promise((done) => { setTimeout(done, ms); });
const classed = (name) => (node) => typeof node.props?.className === 'string' && node.props.className.split(/\s+/).includes(name);

/** The genuinely unfinished ways a learner hits step 3 with a standing run:
 *  1) 创建题组 with 精简 stops after round 1 and waits (`action: 'topup'`),
 *  2) a plain count run that ends short of its requested count (`action: 'continue'`).
 *  `roundLimit` makes the fake library's small material plan more than one round. */
const STOPPED_WAYS = [
  { name: '创建题组 with 精简 stops after round 1', coverage: { roundLimit: 2 }, expectedAction: /为没覆盖的部分补题/,
    request: ({ sourceIds, settings }) => form.generationRequest({ ...form.freshGeneration(settings), coverageLevel: 'lean' }, { course: '', sourceIds }) },
  { name: 'a plain count run that stopped short of its requested count', expectedAction: /接着做/,
    request: ({ sourceIds }) => ({ sourceIds, count: 4, kind: 'quiz' }),
    shorten: (data) => ({
      ...data,
      drafts: data.drafts.map((item, idx) => (idx === 0 ? { ...item, cards: item.cards.slice(0, 2) } : item)),
      jobs: data.jobs.map((job) => (job.draftId ? { ...job, savedCount: 2 } : job)),
    }) },
];

/** The library after a run, and the preview that made it. */
async function runFirstDeck(t, { coverage = null, request, shorten }) {
  const root = await mkdtemp(join(tmpdir(), 'first-run-stopped-'));
  const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0, coverage,
    model: createFakeModel({ latencyMs: 0, generationLatencyMs: 0 }) });
  t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
  const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: 'zh' });
  await call('source.add', sampleMaterial('zh'));
  const markdown = sampleMarkdown('zh');
  await call('source.add', { title: markdown.name, text: markdown.text });
  const before = await call('snapshot');
  const { jobId } = await call('generate', request({ sourceIds: before.sources.map((source) => source.id), settings: before.settings?.generation }));
  const done = await call('job.wait', { jobId, timeoutSeconds: 60 });
  assert.equal(done.status, 'complete', done.stage);
  const raw = await call('snapshot');
  return { call, data: shorten ? shorten(raw) : raw };
}

for (const way of STOPPED_WAYS) {
  test(`the first-run screen opens the draft of a run that stands: ${way.name}`, { timeout: 120000 }, async (t) => {
    const { call, data } = await runFirstDeck(t, way);
    const [draft] = data.drafts;
    assert.ok(draft?.cards.length, 'the run left questions in a draft');
    home.exports.setUiLanguage('zh');
    home.exports.forgetCoverage();
    await withBrowserGlobals(async () => {
      const opened = [];
      const services = { call, act: async () => undefined, busy: false, notify: noop, host: {}, openModal: noop, openSettings: noop, navigate: noop, askInChat: noop };
      const h = home.React.createElement;
      const page = home.mount(() => h(home.exports.StudyServicesContext.Provider, { value: services },
        h(home.exports.AppContext.Provider, { value: { drafts: { publishAndPractice: noop }, core: {}, lib: {}, nav: {} } },
          h(home.exports.StudyMap, { data, actions: { openDraft: (item) => opened.push(item.id), topUpDraft: noop, addSource: noop }, firstRun: { form: 'page', on: {} } }))));
      try {
        const primary = () => page.find((node) => node.type === 'button' && classed('cjc__go')(node));
        // The card says what its one action is once the coverage has arrived from the server.
        for (const end = Date.now() + 30000; Date.now() < end && !way.expectedAction.test(primary() ? page.text(primary()) : '');) { await pause(50); await page.flush(); page.rerender(); }
        assert.equal(page.find((node) => node.props?.['data-step'] === 'deck').props['data-status'], 'stopped', 'this is the screen: 「第一组题没有出完」');
        assert.match(page.text(), /第一组题没有出完/);
        assert.equal(page.findAll((node) => node.type === 'button' && classed('cjc__go')(node)).length, 1, 'still one button');
        assert.match(page.text(primary()), way.expectedAction, 'and it is still the way to finish');
        assert.equal(page.findAll((node) => node.type === 'button' && classed('sh-btn--primary')(node)).length, 0, 'nothing else on the screen competes with it');
        const links = page.find(classed('cjc__links'));
        assert.ok(links, 'the card has its quiet line');
        const look = page.findAll((node) => node.type === 'button' && page.text(node).trim() === '检查草稿', links);
        assert.equal(look.length, 1, 'one quiet 检查草稿 on the card');
        assert.ok(classed('sh-btn--quiet')(look[0]), 'quiet, not a second primary');
        click(look[0]);
        assert.deepEqual(opened, [draft.id], 'it opens the draft');
      } finally { page.unmount(); }
    });
  });
}

test('#1649: a completed plain count run lands on 「第一组题出好了」 even when sections of the material have no question yet', { timeout: 120000 }, async (t) => {
  const { call, data } = await runFirstDeck(t, { request: ({ sourceIds }) => ({ sourceIds, count: 4, kind: 'quiz' }) });
  const [draft] = data.drafts;
  assert.equal(draft?.cards.length, 4, 'all 4 requested questions were delivered');
  const cov = await call('coverage.get', { draftId: draft.id });
  assert.ok(cov.coverage.leaves > cov.coverage.covered, 'the two materials still have uncovered sections');
  home.exports.setUiLanguage('zh');
  home.exports.forgetCoverage();
  await withBrowserGlobals(async () => {
    let coverageSettled = false;
    const trackedCall = async (action, args) => {
      const res = await call(action, args);
      if (action === 'coverage.get') coverageSettled = true;
      return res;
    };
    const services = { call: trackedCall, act: async () => undefined, busy: false, notify: noop, host: {}, openModal: noop, openSettings: noop, navigate: noop, askInChat: noop };
    const h = home.React.createElement;
    const page = home.mount(() => h(home.exports.StudyServicesContext.Provider, { value: services },
      h(home.exports.AppContext.Provider, { value: { drafts: { publishAndPractice: noop }, core: {}, lib: {}, nav: {} } },
        h(home.exports.StudyMap, { data, actions: { openDraft: noop, topUpDraft: noop, addSource: noop }, firstRun: { form: 'page', on: {} } }))));
    try {
      for (const end = Date.now() + 30000; Date.now() < end && !coverageSettled;) { await pause(25); await page.flush(); }
      assert.ok(coverageSettled, 'coverage.get settled before asserting');
      await page.flush();
      page.rerender();
      const deckStatus = page.find((node) => node.props?.['data-step'] === 'deck').props['data-status'];
      assert.ok(['draft-clean', 'draft-review'].includes(deckStatus), `expected draft-clean or draft-review after coverage arrives, got ${deckStatus}`);
      assert.match(page.text(), /第一组题出好了/);
      assert.doesNotMatch(page.text(), /第一组题没有出完/);
      assert.doesNotMatch(page.text(), /为没覆盖的部分补题/);
    } finally { page.unmount(); }
  });
});
