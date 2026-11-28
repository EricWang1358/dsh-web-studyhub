/* global document, window -- page.evaluate callbacks run in the browser */
/* #1690: At 420px width, `.desk > .desk-intro` switches to `display: contents` and assigns explicit
   grid `order` to each child. `.pace-meta` had no `order` rule, so it defaulted to `order: 0` and
   jumped above the course heading (`order: 1`). It now gets `order: 6` (immediately after `.desk-mastery`)
   and any future unordered child falls back to `order: 99`. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPreview } from '../scripts/build.mjs';
import { createPreviewServer, previewCall } from '../scripts/preview-server.mjs';
import { createFakeModel } from '../scripts/fake-model.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';
import { scrubProcessEnv } from '../scripts/qa/env.mjs';
import { openPage, settleAnimations } from '../scripts/qa/layout-late.mjs';

test('at 420px width on home desk, .pace-meta stays below mastery and all .desk-intro children follow monotonic visual order (#1690)', { timeout: 600000 }, async (t) => {
  let browser;
  try { browser = await launchChromium(); } catch (error) { t.skip(`no Chromium: ${String(error.message).split('\n')[0]}`); return; }
  scrubProcessEnv();
  const base = await mkdtemp(join(tmpdir(), 'study-desk-order-'));
  const dist = join(base, 'dist');
  await buildPreview({ outdir: dist });
  const server = await createPreviewServer({ libraryRoot: join(base, 'library'), home: join(base, 'home'), port: 0, model: createFakeModel({ latencyMs: 50 }), distDir: dist });
  try {
    await previewCall(server, 'sample.load', { language: 'zh' });
    const { page, context, errors } = await openPage(browser, { server }, { lang: 'zh', theme: 'light', width: 420, height: 844 });
    await page.goto(server.url);
    await page.locator('[data-first-run="later"], .desk > .desk-intro > .pace-meta').first().waitFor({ timeout: 60000 });
    const laterBtn = page.locator('[data-first-run="later"]');
    if (await laterBtn.count()) {
      await laterBtn.first().click();
    }
    await page.locator('.desk > .desk-intro > .pace-meta').waitFor({ timeout: 30000 });
    await settleAnimations(page);

    const layout = await page.evaluate(() => {
      const intro = document.querySelector('.desk > .desk-intro');
      const children = [...intro.children]
        .map((el) => {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return {
            className: el.className,
            order: Number(style.order),
            top: Math.round(rect.top),
            bottom: Math.round(rect.bottom),
            height: Math.round(rect.height),
          };
        })
        .filter((c) => c.height > 0);

      // Also verify an unexpected future child without a bespoke CSS rule lands at the end (order: 99), never above the heading
      const probe = document.createElement('p');
      probe.className = 'desk-intro-unlisted-probe';
      probe.textContent = 'probe';
      intro.appendChild(probe);
      const probeOrder = Number(window.getComputedStyle(probe).order);
      probe.remove();

      return { children, probeOrder };
    });

    const heading = layout.children.find((c) => /\bcourse-head(ing|er)\b/.test(c.className));
    const mastery = layout.children.find((c) => /\bdesk-mastery\b/.test(c.className));
    const pace = layout.children.find((c) => /\bpace-meta\b/.test(c.className));
    const next = layout.children.find((c) => /\bdesk-next\b/.test(c.className));

    assert.ok(heading, `missing course heading in .desk-intro: ${JSON.stringify(layout.children)}`);
    assert.ok(mastery, `missing .desk-mastery in .desk-intro: ${JSON.stringify(layout.children)}`);
    assert.ok(pace, `missing .pace-meta in .desk-intro: ${JSON.stringify(layout.children)}`);

    assert.ok(pace.order >= 1, `.pace-meta order (${pace.order}) must not default to 0`);
    assert.ok(heading.top < pace.top, `course heading (top=${heading.top}) must appear above .pace-meta (top=${pace.top})`);
    assert.ok(mastery.bottom <= pace.top + 2, `.pace-meta (top=${pace.top}) must appear after .desk-mastery (bottom=${mastery.bottom})`);
    if (next) {
      assert.ok(pace.bottom <= next.top + 2, `.pace-meta (bottom=${pace.bottom}) must appear before .desk-next (top=${next.top})`);
    }

    for (let i = 0; i < layout.children.length; i += 1) {
      const child = layout.children[i];
      assert.ok(child.order >= 1, `.desk-intro child "${child.className}" has order=${child.order}; must be >= 1`);
      if (i > 0) {
        const prev = layout.children[i - 1];
        assert.ok(
          prev.top <= child.top,
          `.desk-intro visual order inverted: "${prev.className}" (top=${prev.top}, order=${prev.order}) vs "${child.className}" (top=${child.top}, order=${child.order})`,
        );
      }
    }

    assert.equal(layout.probeOrder, 99, 'unlisted future .desk-intro child must default to order 99 instead of 0');
    assert.deepEqual(errors, [], 'no console or page errors');
    await context.close();
  } finally {
    await browser.close();
    await server.close();
    await rm(base, { recursive: true, force: true });
  }
});
