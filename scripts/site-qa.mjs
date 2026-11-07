// Real-browser checks of the built landing pages and architecture explorer, with all external requests blocked.
import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildSite } from './site-build.mjs';
import { createSiteServer } from './site-server.mjs';
import { launchChromium } from './qa/browser.mjs';
import { scrubProcessEnv } from './qa/env.mjs';
import { defaults, focusScheduleSettings, initialReview, schedule } from '../lib/sm2.js';
import { cardLevel } from '../lib/mastery.js';

scrubProcessEnv();
const out = resolve('output/site/qa-2.5.10');
await mkdir(out, { recursive: true });
const built = await buildSite(), server = await createSiteServer({ root: built.outdir });
const browser = await launchChromium();
const summary = { version: built.version, releaseStatus: built.releaseStatus, pages: [], checks: [], errors: [], externalRequests: [] };

async function verifyLinks(page) {
  const links = await page.locator('a[href]').evaluateAll(elements => elements.map(element => ({
    href: element.getAttribute('href'),
    target: element.target,
    rel: element.rel,
  })));
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
}

async function probeViewportFit(page, selector = 'main *, footer, .language-switch') {
  return page.evaluate(sel => {
    const width = document.documentElement.clientWidth;
    return {
      width,
      scrollWidth: document.documentElement.scrollWidth,
      clipped: [...document.querySelectorAll(sel)].filter(element => {
        if (element.closest('svg')) return false;
        const r = element.getBoundingClientRect();
        return r.width > 0 && (r.left < -1 || r.right > width + 1);
      }).map(element => `${element.tagName}.${element.className}`),
    };
  }, selector);
}

try {
  const scenes = [[360, 740, 'xs'], [420, 900, 'phone'], [768, 1024, 'tablet'], [1280, 900, 'desktop'], [1680, 1050, 'wide']];
  for (const lang of ['zh', 'en']) for (const [width, height, name] of scenes) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === server.url) return route.continue();
      summary.externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage(), record = { page: 'landing', lang, width, name };
    page.on('pageerror', error => summary.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') summary.errors.push(message.text()); });
    try {
      await page.goto(`${server.url}/${lang === 'en' ? 'en.html' : 'index.html'}`);
      await page.waitForFunction(() => window.STUDY_DEMO && document.querySelectorAll('.rail-node').length === 9);
      await page.evaluate(async () => { for (const image of document.images) { image.loading = 'eager'; await image.decode(); } });
      assert.ok((await page.title()).includes(`StudyHub ${built.version}`));
      const probe = await probeViewportFit(page);
      record.layout = probe;
      assert.ok(probe.scrollWidth <= probe.width + 1, JSON.stringify(probe));
      assert.deepEqual(probe.clipped, [], 'content must fit the viewport');
      const mainText = await page.locator('main').innerText();
      for (const forbidden of ['v0.8.0', '55 毫秒', '55 ms', 'npm install --legacy-peer-deps', 'npm run build']) assert.ok(!mainText.includes(forbidden), forbidden);
      if (lang === 'en') assert.ok(!/[\u4e00-\u9fff]/.test(mainText.replace('中文', '')), 'English content must be translated');
      await verifyLinks(page);
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
    console.log(`${record.status}: landing/${lang}/${width}${record.error ? ' ' + record.error.split('\n')[0] : ''}`);
    summary.pages.push(record); await context.close();
  }

  // Explorer checks across all 5 widths x both themes (dark & light) x both languages (zh & en)
  for (const lang of ['zh', 'en']) for (const [width, height, name] of scenes) {
    const context = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', colorScheme: 'dark' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === server.url) return route.continue();
      summary.externalRequests.push(route.request().url()); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => summary.errors.push(String(error)));
    page.on('console', message => { if (message.type() === 'error') summary.errors.push(message.text()); });

    for (const theme of ['dark', 'light']) {
      const record = { page: 'explorer', lang, theme, width, name };
      try {
        if (theme === 'dark') {
          await page.goto(`${server.url}/${lang === 'en' ? 'explorer-en.html' : 'explorer.html'}`);
          await page.waitForFunction(() => window.STUDY_DEMO && document.querySelectorAll('.rail-node').length === 4);
          assert.ok((await page.title()).includes(`StudyHub ${built.version}`));
          await verifyLinks(page);
        } else {
          await page.locator('#themeToggle').click();
          assert.equal(await page.locator('#themeToggle').getAttribute('aria-pressed'), 'true');
        }

        const expectedBg = theme === 'dark' ? 'rgb(22, 20, 18)' : 'rgb(241, 237, 230)';
        const styleProbe = await page.evaluate(() => ({
          bg: getComputedStyle(document.body).backgroundColor,
          hasBackdrop: [...document.querySelectorAll('*')].some(el => {
            const bf = getComputedStyle(el).backdropFilter || getComputedStyle(el).webkitBackdropFilter || 'none';
            return bf !== 'none';
          }),
        }));
        assert.equal(styleProbe.bg, expectedBg, `Ink-desk ${theme} canvas color mismatch`);
        assert.equal(styleProbe.hasBackdrop, false, 'Explorer must never use backdrop-filter');

        const probe = await probeViewportFit(page, 'main *, footer, .topbar *');
        record.layout = probe;
        assert.ok(probe.scrollWidth <= probe.width + 1, JSON.stringify(probe));
        assert.deepEqual(probe.clipped, [], `explorer ${lang}/${theme}/${width} must fit viewport`);

        if (lang === 'en') {
          const visibleNoSwitch = await page.evaluate(() => {
            const clone = document.body.cloneNode(true);
            clone.querySelectorAll('.language-switch, script').forEach(el => el.remove());
            return clone.innerText;
          });
          assert.doesNotMatch(visibleNoSwitch, /[\u4e00-\u9fff]/, 'explorer-en.html must have zero CJK characters');
        }

        // Interactive walkthrough across all 4 explorers on both themes at desktop width (and dark at xs mobile)
        if (width === 1280 || (width === 360 && theme === 'dark')) {
          // 1. Overview map filter & node click
          await page.locator('[data-map-filter="contexts"]').click();
          await page.locator('[data-node-id="ctx-learner"]').click();
          assert.equal(await page.locator('#inspCode').innerText(), 'learner');
          await page.locator('[data-node-id="ctx-study"]').click();
          assert.equal(await page.locator('#inspCode').innerText(), 'study');
          await page.locator('[data-map-filter="all"]').click();

          // 2. Pipeline stepper & failure-mode toggle
          await page.locator('[data-stage-step="3"]').click();
          assert.match(await page.locator('#pipeBadge').innerText(), /03 \/ 05/);
          await page.locator('[data-failure-mode="context-or-leak"]').click();
          assert.match(await page.locator('#pipeBadge').innerText(), /04 \/ 05/);
          await page.locator('[data-stage-step="1"]').click();

          // 3. FSRS-6 & mastery simulator parity against lib/sm2.js + lib/mastery.js
          await page.locator('#fsrsReset').click();
          let simReview = initialReview(), simAt = '2026-01-01T00:00:00.000Z';
          for (let n = 0; n < 4; n++) {
            simReview = schedule(simReview, 4, simAt, defaults);
            simAt = simReview.due_at;
            await page.locator('[data-fsrs-grade="4"]').click();
            assert.match(await page.locator('#fsrsInterval').innerText(), new RegExp(`^${simReview.interval_days}`));
            assert.equal(await page.locator('#fsrsMasteryBadge').getAttribute('data-level'), cardLevel({ review: simReview }, 4));
          }
          await page.locator('[data-fsrs-grade="1"]').click();
          assert.equal(await page.locator('#fsrsMasteryBadge').getAttribute('data-level'), 'weak');
          await page.locator('#fsrsReset').click();
          assert.equal(await page.locator('#fsrsMasteryBadge').getAttribute('data-level'), 'new');
          await page.locator('#fsrsFocusToggle').click();
          const focusCfg = focusScheduleSettings(defaults, { isFocus: true });
          const easyReview = schedule(initialReview(), 5, '2026-01-01T00:00:00.000Z', focusCfg);
          await page.locator('[data-fsrs-grade="5"]').click();
          assert.match(await page.locator('#fsrsInterval').innerText(), new RegExp(`^${easyReview.interval_days}`));
          assert.equal(await page.locator('#fsrsMasteryBadge').getAttribute('data-level'), 'mastered');
          await page.locator('#fsrsFocusToggle').click();
          await page.locator('#fsrsReset').click();

          // 4. Deterministic test & LPT sharding explorer
          await page.locator('[data-test-tier="fast"]').click();
          await page.locator('#shardCountSlider').fill('4');
          await page.locator('#shardCountSlider').dispatchEvent('input');
          assert.equal(await page.locator('#shardBars [data-shard-index]').count(), 4);
          await page.locator('[data-shard-index="2"]').click();
          assert.equal((await page.locator('#shardCmd').innerText()).trim(), 'node scripts/test.mjs --fast --shard=2/4');
          await page.locator('[data-test-tier="browser"]').click();
          assert.match(await page.locator('#shardCmd').innerText(), /--shard=I\/N[\s\S]*node scripts\/test\.mjs tests\//);
          await page.locator('[data-test-tier="all"]').click();

          if (lang === 'en') {
            const afterClickText = await page.locator('main').innerText();
            assert.doesNotMatch(afterClickText, /[\u4e00-\u9fff]/, 'explorer-en.html interactions must not introduce CJK');
          }
        }

        if (width === 360 || width === 1280) {
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: join(out, `explorer-${lang}-${name}-${theme}.png`) });
        }
        record.status = 'passed';
      } catch (error) {
        record.status = 'failed';
        record.error = String(error.stack || error);
      }
      console.log(`${record.status}: explorer/${lang}/${theme}/${width}${record.error ? ' ' + record.error.split('\n')[0] : ''}`);
      summary.pages.push(record);
    }
    await context.close();
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
    summary.checks.push(`${lang}: landing keyboard, focus, Space activation, 200% text`); await page.close();

    const plain = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    await plain.goto(`${server.url}/${lang === 'en' ? 'en.html' : 'index.html'}`);
    assert.equal(await plain.locator('.sec').count(), 9);
    assert.ok(await plain.locator('#start a').first().isVisible());
    summary.checks.push(`${lang}: landing no-JavaScript content and install links`); await plain.close();

    // Explorer keyboard, prefers-color-scheme: light, 200% zoom, and no-JavaScript progressive enhancement
    const expLight = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme: 'light' });
    await expLight.goto(`${server.url}/${lang === 'en' ? 'explorer-en.html' : 'explorer.html'}`);
    assert.equal(await expLight.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(241, 237, 230)', 'prefers-color-scheme: light applies paper canvas');
    for (let n = 0; n < 14; n++) {
      await expLight.keyboard.press('Tab');
      assert.ok(await expLight.evaluate(() => {
        const style = getComputedStyle(document.activeElement);
        return style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      }), `explorer visible keyboard focus ${lang}/${n}`);
    }
    await expLight.locator('[data-stage-step="2"]').focus();
    await expLight.keyboard.press('Enter');
    assert.match(await expLight.locator('#pipeBadge').innerText(), /02 \/ 05/, 'Enter activates pipeline tab');
    await expLight.locator('[data-fsrs-grade="4"]').focus();
    await expLight.keyboard.press('Space');
    assert.equal(await expLight.locator('#fsrsMasteryBadge').getAttribute('data-level'), 'learning', 'Space activates FSRS grade button');
    await expLight.addStyleTag({ content: 'html { font-size: 200%; }' });
    assert.ok(await expLight.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'explorer 200% text enlargement');
    summary.checks.push(`${lang}: explorer prefers-color-scheme light, keyboard Tab/Enter/Space, 200% text`);
    await expLight.close();

    const expNoJs = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
    await expNoJs.goto(`${server.url}/${lang === 'en' ? 'explorer-en.html' : 'explorer.html'}`);
    assert.equal(await expNoJs.locator('.sec').count(), 4);
    for (const secId of ['#overview', '#pipeline', '#fsrs', '#testing']) {
      assert.ok(await expNoJs.locator(secId).isVisible(), `${secId} visible without JS`);
      assert.ok((await expNoJs.locator(secId).innerText()).trim().length > 80, `${secId} readable without JS`);
    }
    assert.ok((await expNoJs.locator('a.src-link').count()) >= 15, 'GitHub source links readable without JS');
    assert.match(await expNoJs.locator('#overview').innerText(), /lib\/contexts\/<id>\//, '<id> placeholder visible without HTML tag swallowing');
    assert.equal((await expNoJs.locator('#fsrsInterval').innerText()).trim(), lang === 'en' ? '0d' : '0天', 'localized no-JS day suffix');
    summary.checks.push(`${lang}: explorer no-JavaScript progressive enhancement`);
    await expNoJs.close();
  }
  assert.deepEqual(summary.errors, []); assert.deepEqual(summary.externalRequests, []);
} catch (error) { summary.errors.push(String(error.stack || error)); }
finally { await browser.close(); await server.close(); }
summary.ok = summary.pages.every(page => page.status === 'passed') && summary.errors.length === 0 && summary.externalRequests.length === 0;
await writeFile(join(out, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
const assets = await readFile(join(built.outdir, 'build-manifest.json'), 'utf8');
await writeFile(join(out, 'build-manifest.json'), assets);
console.log(summary.ok ? 'All landing-page and explorer checks passed.' : `Site QA checks failed: ${out}/summary.json`);
process.exitCode = summary.ok ? 0 : 1;
