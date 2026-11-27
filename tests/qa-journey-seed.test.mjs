/* The state qa:journey creates through the API for a step that runs without the earlier ones (`--steps job-progress,draft,publish`, or any step after a
   failed one) must be the state those steps wait for: the first-run line offers the finished draft (发布并开始练 or 检查草稿). A seed that left out what
   创建题组 always sends made a plain run, which ended 「补题」: its card stood on the line, so three steps failed after `generate` had (2026-11-27). The run
   goes through the real preview server with the fake model, and the line is read the way the home reads it (ui/first-run/use-first-run-line.js). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { sampleMaterial, sampleMarkdown } from '../scripts/qa/fixtures.mjs';
import { seedGeneration } from '../scripts/qa/journey-seed.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const ui = await loadUi(`export { firstRunLine, firstRunDraft } from './ui/first-run/line.js';
  export { draftShortfall } from './ui/coverage/use-shortfall.js';
  export { canPublishAtOnce } from './ui/draft-publish.js';
  export { partTargets } from './ui/DraftPart.jsx';`);

for (const lang of ['zh', 'en']) {
  test(`qa:journey's seeded first run leaves its draft on the first-run line (${lang})`, { timeout: 120000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'qa-journey-seed-'));
    const server = await createPreviewServer({ libraryRoot: join(root, 'library'), home: join(root, 'home'), port: 0,
      model: createFakeModel({ latencyMs: 0, generationLatencyMs: 0 }) });
    t.after(async () => { await server.close(); await rm(root, { recursive: true, force: true }); });
    const call = (action, args = {}) => previewCall(server, action, { ...args, uiLanguage: lang });
    // Two materials, as the journey has by then: with several sections a run of 4 questions can leave one without a question.
    await call('source.add', sampleMaterial(lang));
    const markdown = sampleMarkdown(lang);
    await call('source.add', { title: markdown.name, text: markdown.text });
    const sourceIds = (await call('snapshot')).sources.map((source) => source.id);

    const { jobId } = await call('generate', seedGeneration(lang, sourceIds));
    const done = await call('job.wait', { jobId, timeoutSeconds: 60 });
    assert.equal(done.status, 'complete', done.stage);

    const data = await call('snapshot');
    const draft = ui.firstRunDraft(data);
    const shortfall = ui.draftShortfall(draft, { view: await call('coverage.get', { draftId: draft.id }), jobs: data.jobs });
    const publishAtOnce = ui.canPublishAtOnce({ draft, shortfall, jobs: data.jobs, targets: ui.partTargets(draft, data) });
    const step = ui.firstRunLine(data, { publishAtOnce, shortfallAction: shortfall.action }).steps[2];
    assert.ok(['draft-clean', 'draft-review'].includes(step.status),
      `the line offers the draft; it says ${step.status} (shortfall ${shortfall.state} / ${shortfall.reason}, action ${shortfall.action})`);
  });
}
