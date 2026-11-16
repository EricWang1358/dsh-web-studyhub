/* global document, window, localStorage -- Playwright browser callbacks */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { KNOWN_LAYOUT } from '../scripts/qa/journey.mjs';
import { DEFAULT_CLS_MAX, drainLayoutStability, installLayoutObserver, judgeLayoutStability } from '../scripts/qa/layout-stability.mjs';
import { loadUi } from './helpers/ui-module.mjs';
import { reviewElement } from './helpers/review-render.mjs';

const uiMods = await loadUi(`
  export { default as Review } from './ui/Review.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { setUiLanguage } from './ui/i18n.js';
`);

test('Issue #1093: KNOWN_LAYOUT drops case-practice, Review keeps .action-feedback-slot inside .review-sticky-bar, and length badge wraps', () => {
  assert.equal('case-practice' in KNOWN_LAYOUT, false, 'case-practice no longer needs a KNOWN_LAYOUT CLS exemption');

  const card = {
    id: 'q1',
    kind: 'open',
    topic: 'Architecture',
    prompt: 'Recommend a migration strategy for Harbourline.',
    marks: 10,
    rubricCriteria: [
      { id: 'c1', label: 'Recommendation', marks: 4 },
      { id: 'c2', label: 'Case linkage', marks: 3 },
      { id: 'c3', label: 'Assumptions', marks: 3 },
    ],
  };
  const caseData = {
    decks: [{ id: 'case-deck', title: 'Harbourline', format: 'case-study', caseSourceId: 'case-src' }],
    sources: [{ id: 'case-src', title: 'Harbourline Case', text: 'Paragraph 1.\n\nParagraph 2.' }],
    assist: [],
  };
  const baseProps = {
    data: caseData,
    busy: false,
    host: {},
    choice: false,
    isCloze: false,
    shellTitle: 'Harbourline',
    selected: [],
    response: '',
    clozeValues: {},
    feedback: '已发布，开始学习本轮',
  };

  uiMods.setUiLanguage('en');
  try {
    const gradingHtml = renderToStaticMarkup(reviewElement(uiMods.Review, uiMods.StudyServicesContext, {
      ...baseProps,
      run: { id: 'r1', deckId: 'case-deck', mode: 'path', index: 0, total: 2, card, revealed: false, feedback: null, grading: true, highlights: [] },
    }));
    const stickyStart = gradingHtml.indexOf('<div class="review-sticky-bar"');
    assert.ok(stickyStart >= 0, 'renders review-sticky-bar');
    const stickyOpenTag = gradingHtml.slice(stickyStart, gradingHtml.indexOf('>', stickyStart) + 1);
    assert.match(stickyOpenTag, /data-grading="true"/, 'sticky bar anchors at bottom while grading');
    const feedbackSlotAt = gradingHtml.indexOf('class="action-feedback-slot"');
    const assistAreaAt = gradingHtml.indexOf('assist-area');
    assert.ok(stickyStart >= 0 && feedbackSlotAt > stickyStart && assistAreaAt > feedbackSlotAt, 'action-feedback-slot lives inside review-sticky-bar');
    assert.match(gradingHtml, /sh-badge--wrap/, 'length-hint badge wraps cleanly on narrow screens');

    const answeredHtml = renderToStaticMarkup(reviewElement(uiMods.Review, uiMods.StudyServicesContext, {
      ...baseProps,
      run: {
        id: 'r1',
        deckId: 'case-deck',
        mode: 'path',
        index: 0,
        total: 2,
        card,
        revealed: true,
        feedback: {
          correct: true,
          grade: 4,
          rubric: { total: 7, max: 10, ratio: 0.7, band: 'good', summary: 'Solid recommendation.', criteria: [] },
        },
        highlights: [],
      },
    }));
    assert.match(answeredHtml, /<div class="review-sticky-bar"[^>]*data-answered="true"/);
  } finally {
    uiMods.setUiLanguage('zh');
  }
});

test('Browser E2E (#1093): narrow 420px & 390px case-practice grading stays under 0.05 CLS with zero overflow and toolbar anchored', { timeout: 240000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) {
    t.skip(`Chromium unavailable: ${String(error.message).split('\n')[0]}`);
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'study-case-cls-'));
  const distDir = join(root, 'dist');
  const libraryRoot = join(root, 'library');
  const service = new StudyService(libraryRoot);
  const scenarioText = [
    'Harbourline Freight runs legacy customs portals across four regional ports.',
    'Last winter, failed logins and altered release notes went undetected over a busy weekend.',
    'Seasonal peaks create bursty manifest uploads without warning.',
    'Management has not fixed a specific migration budget yet.',
  ].join('\n\n');
  await service.store.update((s) => {
    s.sources.push({ id: 'case-src', title: 'Harbourline Case', text: scenarioText, format: 'text' });
    s.decks.push({
      id: 'case-deck',
      title: 'Harbourline Case',
      course: 'Architecture',
      format: 'case-study',
      caseSourceId: 'case-src',
      cards: [
        {
          id: 'q1',
          kind: 'open',
          topic: 'Migration Strategy',
          prompt: 'Applying event-driven design and strangler fig patterns, what would you recommend for Harbourline?',
          answer: 'Migrate incrementally with audit logging.',
          marks: 10,
          rubricCriteria: [
            { id: 'c1', label: 'Recommendation using event-driven strangler pattern', marks: 4 },
            { id: 'c2', label: 'Case linkage to altered release notes & seasonal peaks', marks: 3 },
            { id: 'c3', label: 'Explicit budget assumptions and trade-offs', marks: 3 },
          ],
        },
        {
          id: 'q2',
          kind: 'open',
          topic: 'Observability',
          prompt: 'How should Harbourline detect tampering quickly?',
          answer: 'Immutable audit logs and alerting.',
          marks: 6,
          rubricCriteria: [{ id: 'c4', label: 'Audit log design', marks: 6 }],
        },
      ],
    });
  });
  await service.dispose();

  await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({
    libraryRoot,
    home: join(root, 'home'),
    port: 0,
    model: createFakeModel({ latencyMs: 650 }),
    distDir,
  });
  t.after(async () => {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const cases = [
    { lang: 'zh', theme: 'dark', width: 420, height: 900, submitLabel: '提交批改' },
    { lang: 'en', theme: 'light', width: 390, height: 844, submitLabel: 'Submit for grading' },
  ];

  for (const cfg of cases) {
    for (const open of (await previewCall(server, 'snapshot', {})).runs || []) {
      await previewCall(server, 'review.end', { runId: open.id });
    }
    await previewCall(server, 'review.start', { mode: 'path', fresh: true, ordered: true, scope: [{ deckId: 'case-deck' }] });

    const context = await browser.newContext({ viewport: { width: cfg.width, height: cfg.height }, colorScheme: cfg.theme });
    await context.addInitScript(installLayoutObserver);
    await context.addInitScript(([lang, theme]) => {
      localStorage.setItem('study-ui-language', lang);
      localStorage.setItem('study-theme', theme);
      localStorage.setItem('study-autopilot', 'off');
    }, [cfg.lang, cfg.theme]);

    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await page.goto(server.url);
    await page.getByRole('button', { name: /Harbourline|继续|Continue|接着做/ }).first().click();
    await page.locator('.rubric-answer textarea').first().waitFor({ timeout: 20000 });
    await page.waitForTimeout(300);
    await drainLayoutStability(page); // ignore initial route paint before typing/grading

    const answer = [
      'I recommend an event-driven architecture migrated step by step with the strangler fig pattern.',
      'The failed logins and altered release notes call for immutable audit trails.',
      'Because no budget is specified, I assume a small first phase.',
    ].join('\n');
    await page.locator('.rubric-answer textarea').first().fill(answer);
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: cfg.submitLabel }).first().click();
    await page.locator('.rubric-result').first().waitFor({ timeout: 30000 });
    await page.waitForTimeout(400);

    const log = await drainLayoutStability(page);
    const verdict = judgeLayoutStability(log, { maxCls: DEFAULT_CLS_MAX });
    assert.equal(verdict.ok, true, `${cfg.lang} ${cfg.width}px CLS must stay <= ${DEFAULT_CLS_MAX}, got: ${verdict.message}`);

    const layoutCheck = await page.evaluate(() => {
      const overflow = document.documentElement.scrollWidth - window.innerWidth;
      const toolbar = document.querySelector('.question-toolbar')?.getBoundingClientRect();
      return {
        overflow,
        toolbarVisible: !!toolbar && toolbar.height > 0 && toolbar.bottom <= window.innerHeight + 1 && toolbar.top >= 0,
      };
    });
    assert.ok(layoutCheck.overflow <= 0, `${cfg.lang} ${cfg.width}px expected zero horizontal overflow, got ${layoutCheck.overflow}`);
    assert.equal(layoutCheck.toolbarVisible, true, `${cfg.lang} ${cfg.width}px question toolbar remains visible in viewport`);
    assert.deepEqual(errors, []);
    await context.close();
  }
});
