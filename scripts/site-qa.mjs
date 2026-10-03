// Real-browser checks of the built landing pages, with all external requests blocked.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildSite } from './site-build.mjs';
import { createSiteServer } from './site-server.mjs';
import { launchChromium } from './qa/browser.mjs';
import { scrubProcessEnv } from './qa/env.mjs';
import { defaults, initialReview, schedule } from '../lib/sm2.js';

scrubProcessEnv();
const out = resolve('output/site/qa-2.5.10');
await mkdir(out, { recursive: true });
const built = await buildSite(), server = await createSiteServer({ root: built.outdir });
const browser = await launchChromium();
const summary = { version: built.version, releaseStatus: built.releaseStatus, pages: [], checks: [], errors: [], externalRequests: [] };
try {
  const scenes = [[360, 740, 'xs'], [420, 900, 'phone'], [768, 1024, 'tablet'], [1280, 900, 'desktop'], [1680, 1050, 'wide']];
  for (const lang of ['zh', 'en']) for (const [width, height, name] of scenes) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === server.url) return route.continue();
      summary.externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(), record = { lang, width, name };
    page.on('pageerror', error => summary.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') summary.errors.push(message.text()); });
    try {
      await page.goto(`${server.url}/${lang === 'en' ? 'en.html' : 'index.html'}`);
      await page.waitForFunction(() => window.STUDY_DEMO && document.querySelectorAll('.rail-node').length === 9);
      await page.evaluate(async () => { for (const image of document.images) { image.loading = 'eager'; await image.decode(); } });
      assert.ok((await page.title()).includes(`StudyHub ${built.version}`));
      const probe = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        return { width, scrollWidth: document.documentElement.scrollWidth,
          clipped: [...document.querySelectorAll('main *, footer, .language-switch')].filter(element => {
            if (element.closest('svg')) return false;
            const r = element.getBoundingClientRect();
            return r.width > 0 && (r.left < -1 || r.right > width + 1);
          }).map(element => `${element.tagName}.${element.className}`) };
      });
      record.layout = probe;
      assert.ok(probe.scrollWidth <= probe.width + 1, JSON.stringify(probe));
      assert.deepEqual(probe.clipped, [], 'content must fit the viewport');
      const mainText = await page.locator('main').innerText();
      for (const forbidden of ['v0.8.0', '55 毫秒', '55 ms', 'npm install --legacy-peer-deps', 'npm run build']) assert.ok(!mainText.includes(forbidden), forbidden);
      if (lang === 'en') assert.ok(!/[\u4e00-\u9fff]/.test(mainText.replace('中文', '')), 'English content must be translated');
      const links = await page.locator('a[href]').evaluateAll(elements => elements.map(element => ({ href: element.getAttribute('href'), target: element.target, rel: element.rel })));
      for (const link of links) {
        if (link.href.startsWith('#')) assert.equal(await page.locator(link.href).count(), 1, link.href);
        else if (!link.href.includes('://')) assert.ok((await page.request.get(new URL(link.href, page.url()).href)).ok(), link.href);
        else {
          const url = new URL(link.href); assert.equal(url.protocol, 'https:');
          if (url.hostname === 'github.com' && url.pathname.includes('/blob/main/')) {
            const path = decodeURIComponent(url.pathname.split('/blob/main/')[1]); await access(resolve(path));
          }
          if (link.target === '_blank') assert.ok(link.rel.split(/\s+/).includes('noopener'));
        }
      }
      await page.locator('#grounded').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.waitForFunction(() => !document.querySelector('#demo mark').classList.contains('dim'));
      await page.locator('#citeBtn').click();
      assert.equal(await page.locator('#demo mark.dim').count(), 2);
      await page.locator('#citeBtn').click();
      assert.equal(await page.locator('#demo mark.dim').count(), 0);
      await page.locator('#graphPlay').click();
      assert.ok(await page.locator('#graphPlay').isDisabled());
      await page.locator('#graphReset').click();
      assert.ok(await page.locator('#graphPlay').isEnabled());
      let review = initialReview(), timestamp = '2026-01-01T00:00:00.000Z';
      for (let n = 0; n < 4; n++) {
        review = schedule(review, 4, timestamp, defaults); timestamp = review.due_at;
        await page.locator('[data-sm2="pass"]').click();
        assert.match(await page.locator('#sm2Next').innerText(), new RegExp(`\\b${review.interval_days}\\b`));
      }
      await page.locator('[data-sm2="fail"]').click();
      assert.equal(await page.locator('#sm2Chip').getAttribute('data-level'), 'bad');
      await page.locator('[data-sm2="reset"]').click();
      assert.equal(await page.locator('#sm2Chip').getAttribute('data-level'), 'none');
      await page.locator('#start').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: join(out, `${lang}-${name}-install.png`) });
      await page.locator('#hero').evaluate(element => element.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: join(out, `${lang}-${name}-hero.png`) });
      record.status = 'passed';
    } catch (error) { record.status = 'failed'; record.error = String(error.stack || error); }
    console.log(`${record.status}: ${lang}/${width}${record.error ? ' ' + record.error.split('\n')[0] : ''}`);
    summary.pages.push(record); await context.close();
  }
  for (const lang of ['zh', 'en']) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    await page.goto(`${server.url}/${lang === 'en' ? 'en.html' : 'index.html'}`);
    await page.keyboard.press('ArrowDown');
    assert.ok(await page.evaluate(() => window.scrollY > 200));
    await page.keyboard.press('End');
    assert.ok(await page.evaluate(() => window.scrollY >= document.querySelector('#start').offsetTop - 1));
    await page.goto(page.url());
    for (let n = 0; n < 14; n++) {
      await page.keyboard.press('Tab');
      assert.ok(await page.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      }), `visible keyboard focus ${lang}/${n}`);
    }
    await page.locator('#retention').evaluate(element => element.scrollIntoView());
    await page.locator('[data-sm2="pass"]').focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('#sm2Chip').getAttribute('data-level'), 'warn', 'Space must activate the focused demo button');
    await page.addStyleTag({ content: 'html { font-size: 200%; }' });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), '200% text enlargement');
    summary.checks.push(`${lang}: keyboard, focus, Space activation, 200% text`); await page.close();
    const plain = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    await plain.goto(`${server.url}/${lang === 'en' ? 'en.html' : 'index.html'}`);
    assert.equal(await plain.locator('.sec').count(), 9);
    assert.ok(await plain.locator('#start a').first().isVisible());
    summary.checks.push(`${lang}: no-JavaScript content and install links`); await plain.close();
  }
  assert.deepEqual(summary.errors, []); assert.deepEqual(summary.externalRequests, []);
} catch (error) { summary.errors.push(String(error.stack || error)); }
finally { await browser.close(); await server.close(); }
summary.ok = summary.pages.every(page => page.status === 'passed') && summary.errors.length === 0 && summary.externalRequests.length === 0;
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const assets = await readFile(join(built.outdir, 'build-manifest.json'), 'utf8');
await writeFile(join(out, 'build-manifest.json'), assets);
console.log(summary.ok ? 'All landing-page checks passed.' : `Landing-page checks failed: ${out}/summary.json`);
process.exitCode = summary.ok ? 0 : 1;
