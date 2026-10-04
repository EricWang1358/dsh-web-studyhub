/* global document, getComputedStyle */
/* node scripts/qa/settings-fields.mjs [--lang zh|en] [--theme dark|light] [--width 1280|420] [--out <dir>]
   Settings with the shared field primitives (WP-G, #138 #139 #140): one screenshot per category, then the rows the primitives
   are about (a switch, a radio-card group, a confirmation opened from Settings), and a computed-style check across every
   category: every field label has one font weight, every hint one font size, and no page scrolls sideways.
   Runs the preview server with the fake model on a temporary library; MinerU's local status is stubbed to "needs models" so
   the tier radio cards show (nothing is downloaded). Build first (npm run build) so the preview serves the current UI. */
import { seedLibrary } from './perf-seed.mjs';
import { finishCli, overflowProbe, parseQaArgs, runQa, sleep } from './harness.mjs';

const options = parseQaArgs(process.argv.slice(2), 'settings-fields', {});
const probeStyles = () => {
  const values = (selector, property) => [...new Set([...document.querySelectorAll(selector)].map((node) => getComputedStyle(node)[property]))];
  return { labelWeights: values('.settings-pane .sh-field__label, .settings-pane .sh-check__label', 'fontWeight'),
    hintSizes: values('.settings-pane .sh-hint', 'fontSize'), fields: document.querySelectorAll('.settings-pane .sh-field').length,
    switches: document.querySelectorAll('.settings-pane [role="switch"]').length, checkboxes: document.querySelectorAll('.settings-pane input[type="checkbox"]:not([role])').length };
};

const summary = await runQa({ name: 'settings-fields', options, seed: (root) => seedLibrary(root, { sources: 6, decks: 2, cardsPerDeck: 6, runs: 2, attempts: 12, courses: 3, largeSources: 1, largeSourceChars: 4000 }),
  async run({ page, step, check, t }) {
    await page.route('**/api/call', async (route) => {
      const body = route.request().postDataJSON?.() || {};
      if (body.action !== 'mineru.local.status') return route.continue();
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, value: { state: 'needs-models', modelsMbByTier: { basic: 800, standard: 1200 }, estimates: { basic: 1.6, standard: 2.5 } } }) });
    });
    await step('open-settings', async () => { await page.getByRole('button', { name: t('设置', 'Settings'), exact: true }).first().click(); await page.waitForSelector('.settings-page'); });
    const categories = await page.locator('.settings-nav__item').evaluateAll((items) => items.map((item) => item.dataset.category));
    const measured = [];
    for (const id of categories) {
      await step(`category-${id}`, async () => {
        await page.locator(`[data-category="${id}"]`).click();
        await page.waitForSelector('.settings-pane fieldset, .settings-pane section', { timeout: 15000 });
        await sleep(500);
        measured.push({ id, ...(await page.evaluate(probeStyles)), overflow: await page.evaluate(overflowProbe) });
        return id;
      });
    }
    await step('switch-row', async () => {
      await page.locator('[data-category="usage"]').click();
      await page.waitForSelector('[data-tour="settings-usage"]');
      const row = page.locator('[data-tour="settings-usage"] [role="switch"]').first();
      await row.scrollIntoViewIfNeeded();
      const before = await row.isChecked();
      await row.check({ force: true }).catch(() => {});
      await sleep(400);
      return { before, after: await row.isChecked() };
    });
    await step('experimental-on', async () => {
      await page.locator('[data-category="experimental"]').click();
      await page.waitForSelector('[name="show-experimental"]');
      const shown = page.locator('[name="show-experimental"]');
      if (!await shown.isChecked()) await shown.click();
      await page.waitForSelector('.jev-settings .sh-field', { timeout: 15000 });
      await sleep(600);
      measured.push({ id: 'experimental-on', ...(await page.evaluate(probeStyles)), overflow: await page.evaluate(overflowProbe) });
      const replace = page.locator('.jev-replace [role="switch"]').first();
      await replace.scrollIntoViewIfNeeded();
      return { switches: await page.locator('.jev-settings [role="switch"]').count() };
    });
    await step('radio-card-group', async () => {
      await page.locator('[data-category="mineru"]').click();
      await page.waitForSelector('.sh-radio-group', { timeout: 15000 }).catch(async (error) => {
        const detail = await page.evaluate(() => [...document.querySelectorAll('.mineru-settings, .sh-provider-grid, .sh-provider-grid__items, .sh-provider')].map((node) => {
          const box = node.getBoundingClientRect();
          const style = getComputedStyle(node);
          return `${node.className.split(' ')[0]} ${Math.round(box.width)}x${Math.round(box.height)} ${style.display} ct=${style.containerType} kids=${node.children.length} text=${node.textContent.length} pad=${style.padding} vis=${style.visibility} cv=${style.contentVisibility} ov=${style.overflow}`;
        }).join(' | '));
        throw new Error(`${error.message.split(/\r?\n/)[0]} [${detail}]`);
      });
      const second = page.locator('.sh-radio-card').nth(1);
      await second.scrollIntoViewIfNeeded();
      await second.click();
      await sleep(300);
      return await page.locator('.sh-radio-card.is-selected').count();
    });
    await step('confirm-dialog', async () => {
      await page.locator('[data-category="profile"]').click();
      await page.waitForSelector('[data-tour="settings-profile"], .coach-settings', { timeout: 15000 });
      const clear = page.getByRole('button', { name: t('清空画像', 'Clear profile'), exact: true }).first();
      await clear.scrollIntoViewIfNeeded();
      await clear.click();
      await page.waitForSelector('dialog[open]', { timeout: 5000 });
      return await page.locator('dialog[open] .sh-btn').allTextContents();
    });
    await check('one label weight and one hint size on every category', async () => {
      const weights = new Set(measured.flatMap((entry) => entry.labelWeights)), sizes = new Set(measured.flatMap((entry) => entry.hintSizes));
      if (weights.size > 1) throw new Error(`label weights: ${[...weights].join(', ')}`);
      if (sizes.size > 1) throw new Error(`hint sizes: ${[...sizes].join(', ')}`);
      return { weights: [...weights], sizes: [...sizes], fields: measured.reduce((sum, entry) => sum + entry.fields, 0) };
    });
    await check('no category scrolls sideways', async () => {
      const wide = measured.filter((entry) => entry.overflow.scrollWidth > entry.overflow.clientWidth + 1);
      if (wide.length) throw new Error(wide.map((entry) => entry.id).join(', '));
    });
  } });
finishCli('settings-fields', options, summary);
