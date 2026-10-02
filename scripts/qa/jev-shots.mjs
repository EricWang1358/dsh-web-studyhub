/* global document */
/* node scripts/qa/jev-shots.mjs [--out <dir>] [--quick]
   The experimental Jev layer in the real app (browser preview), against a LOCAL FAKE Jev server (tests/helpers/fake-jev.mjs):
   no network call, no real key. zh/en x dark/light at 1440 and 420 px, each with a layout audit and a page-error check:
     1. Settings: the section as it is by default (everything off, the privacy note, the unchecked confirmation);
     2. the confirmation, the (fake) key saved and tested, the master and course switches turned on;
     3. Sources > Organize courses: "Jev 建议" on a seeded library: probabilities, filled / left-alone rows, the parent suggestion,
        then the EXISTING apply button (only the included rows change; nothing was saved before it);
     4. the kill switch: the button is gone at once;
     5. a failing Jev (the fake answers 401): a small note, "Suggest with AI" and the manual field still there.
   The preview runs on a temporary home (the key file lives there) with every key/token/base-url variable removed from the
   environment; only JEV_BASE_URL is set afterwards, to the fake server. Chromium: PLAYWRIGHT_CHROMIUM or the one under ms-playwright. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { launchChromium } from './browser.mjs';
import { layoutAudit } from './mineru-layout.mjs';
import { scrubProcessEnv } from './env.mjs';
import { defaultAnswer, startFakeJev } from '../../tests/helpers/fake-jev.mjs';
import { NONE_KEY } from '../../lib/jev-course-suggest.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const args = process.argv.slice(2);
const flag = (name, fallback) => args.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;
const out = resolve(flag('out', join(root, 'output/qa/jev')));
const quick = args.includes('--quick');
const sleep = ms => new Promise(done => setTimeout(done, ms));

scrubProcessEnv();
const scratch = await mkdtemp(join(tmpdir(), 'jev-qa-'));
process.env.USERPROFILE = scratch; process.env.HOME = scratch;
await mkdir(out, { recursive: true });

// What the fake Jev answers, decided by the title of the source it is asked about.
const TABLE = {
  'Transactions and locking': { Databases: 0.94, 'Operating Systems': 0.03, Networks: 0.01, [NONE_KEY]: 0.02 },
  'Page replacement notes': { 'Operating Systems': 0.88, Databases: 0.06, Networks: 0.02, [NONE_KEY]: 0.04 },
  'Service mesh overview': { 'Design / 05 Kubernetes': 0.45, 'Design / 06 Istio': 0.4, Design: 0.05, [NONE_KEY]: 0.1 },
  'Week 9 reading': { Databases: 0.5, 'Operating Systems': 0.4, [NONE_KEY]: 0.1 },
  'Lunch menu': { [NONE_KEY]: 0.92, Networks: 0.08 },
};
const answer = (name, question, state) => {
  if (question.type !== 'choice') return defaultAnswer(question); // the key test's greeting question
  const keys = Object.keys(question.criteria), wanted = TABLE[state.title] ?? {};
  const rest = keys.filter(key => !(key in wanted)), left = Math.max(0, 1 - Object.values(wanted).reduce((a, b) => a + b, 0));
  const probabilities = Object.fromEntries(keys.map(key => [key, key in wanted ? wanted[key] : rest.length ? left / rest.length : 0]));
  const top = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { type: 'choice', choice: top[0], confidence: (top[1] - 1 / keys.length) / (1 - 1 / keys.length), probabilities };
};
const fake = await startFakeJev({ answer, usage: () => ({ input_tokens: 410, output_tokens: 9 }) });
process.env.JEV_BASE_URL = fake.baseUrl;

const text = 'Lecture notes. '.repeat(40);
const ANCHORS = [['Intro to SQL', 'Databases'], ['Joins and indexes', 'Databases'], ['Process scheduling', 'Operating Systems'], ['Virtual memory', 'Operating Systems'],
  ['TCP handshake', 'Networks'], ['K8s pods', 'Design / 05 Kubernetes'], ['Istio basics', 'Design / 06 Istio']];
const LOOSE = Object.keys(TABLE);
async function seed(server) {
  for (const [title, course] of ANCHORS) await previewCall(server, 'source.add', { title, text: `${title}. ${text}`, courses: [course] });
  for (const title of LOOSE) await previewCall(server, 'source.add', { title, text: `${title}. ${text}`, courses: [] });
}

const browser = await launchChromium();
const shots = [], problems = [];
const combos = quick ? [['zh', 'dark', 1440], ['en', 'light', 420]] : ['zh', 'en'].flatMap(lang => ['dark', 'light'].flatMap(theme => [1440, 420].map(width => [lang, theme, width])));
const audit = async (tab, where, options) => {
  const result = await tab.evaluate(layoutAudit, options);
  for (const item of result.problems) problems.push(`${where}: ${item}`);
};
let port = 4480;
try {
  for (const [lang, theme, width] of combos) {
    const tag = `${lang}/${theme}/${width}`;
    fake.requests.length = 0; fake.clearFailures();
    const server = await createPreviewServer({ libraryRoot: join(scratch, `lib-${lang}-${theme}-${width}`), home: join(scratch, `home-${lang}-${theme}-${width}`), port: port++ });
    try {
      await seed(server);
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
      const tab = await context.newPage();
      tab.on('pageerror', error => problems.push(`${tag}: ${error.message}`));
      tab.on('console', message => { if (message.type() === 'error') problems.push(`${tag}: console ${message.text()}`); });
      const settle = async (ms = 350) => { await tab.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
      const shot = async label => { const path = join(out, `${label}-${lang}-${theme}-${width}.png`); await tab.screenshot({ path }); shots.push(path); };
      // Show only the sources that have no course yet (the anchors keep theirs) and select them all.
      const pickLoose = async () => { await tab.getByLabel(/课程范围|Course scope/).selectOption(''); await settle(300); await tab.getByRole('button', { name: /选择当前范围|Select this scope/ }).click(); await settle(200); };
      const openPage = async nav => { await tab.locator(`[data-tour="nav-${nav}"]`).first().click(); await settle(); };
      const toSection = async () => { const section = tab.locator('[data-tour="settings-jev"]'); await section.waitFor({ timeout: 15000 }); await section.evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(400); return section; };
      try {
      await tab.goto(server.url); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(800);

      // 1. Settings, as it is by default.
      await openPage('settings');
      let section = await toSection();
      await shot('1-settings-default'); await audit(tab, `settings-default/${tag}`, { scopes: ['.jev-privacy', '.jev-card', '.jev-switches'] });
      if (await section.locator('.jev-switches[disabled]').count() !== 1) problems.push(`${tag}: the switches are not locked before the key and the confirmation`);
      if (fake.requests.length) problems.push(`${tag}: Jev was contacted before anything was set up`);

      // 2. Confirm, save the (fake) key, test it, switch the experiment on.
      await section.locator('.jev-privacy input[type="checkbox"]').click(); await section.locator('.jev-privacy[data-confirmed="true"]').waitFor({ timeout: 15000 }); await settle(300);
      await section.locator('input[name="jev-key"]').fill(fake.key);
      await section.getByRole('button', { name: /保存 Jev 密钥|Save the Jev key/ }).click(); await settle(700);
      await section.locator('.sh-inline--success').waitFor({ timeout: 15000 });
      await section.evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(200);
      await shot('2-key-saved-and-tested'); await audit(tab, `key-saved/${tag}`, { scopes: ['.jev-privacy', '.jev-card', '.jev-switches'] });
      if (await tab.getByText(fake.key).count()) problems.push(`${tag}: the key appears on the page`);
      await section.locator('.jev-switch--master input').click(); await section.locator('.jev-switch--master input:checked').waitFor({ timeout: 15000 }); await settle(250);
      await section.locator('[data-feature="courseSuggest"] input').click(); await section.locator('[data-feature="courseSuggest"] input:checked').waitFor({ timeout: 15000 }); await settle(400);
      await shot('3-switches-on'); await audit(tab, `switches-on/${tag}`, { scopes: ['.jev-switches'] });
      // The usage block, opened (a closed <details> still has boxes the audit would measure).
      await section.locator('.jev-usage__more summary').click(); await settle(200);
      await section.locator('.jev-usage').scrollIntoViewIfNeeded(); await settle(200);
      { const path = join(out, `3b-usage-${lang}-${theme}-${width}.png`); await section.locator('.jev-usage').screenshot({ path }); shots.push(path); }
      await audit(tab, `usage/${tag}`, { scopes: ['.jev-usage'] });

      // 3. Organize courses with Jev.
      await openPage('sources');
      await tab.locator('details.source-organize > summary').click(); await settle(300);
      await pickLoose();
      const before = JSON.stringify((await previewCall(server, 'source.list', {})).sources.map(source => [source.id, source.courses]));
      await tab.locator('.jev-suggest-button').click();
      await tab.locator('.jev-probs').first().waitFor({ timeout: 20000 }); await settle(400);
      if (JSON.stringify((await previewCall(server, 'source.list', {})).sources.map(source => [source.id, source.courses])) !== before) problems.push(`${tag}: suggesting saved something`);
      await tab.locator('.source-course-proposals').scrollIntoViewIfNeeded(); await settle(200);
      await shot('4-jev-suggestions'); await audit(tab, `suggestions/${tag}`, { scopes: ['.jev-probs'] });
      const included = await tab.locator('.source-proposal-select input:checked').count();
      if (included !== 3) problems.push(`${tag}: expected 3 suggestions to start included (two courses and the parent), found ${included}`);
      // The existing apply button.
      await tab.getByRole('button', { name: /确认应用建议|Apply suggestions/ }).click(); await settle(700);
      const after = (await previewCall(server, 'source.list', {})).sources;
      const courseOf = title => after.find(source => source.title === title)?.courses?.join(';');
      if (courseOf('Transactions and locking') !== 'Databases' || courseOf('Page replacement notes') !== 'Operating Systems' || courseOf('Service mesh overview') !== 'Design')
        problems.push(`${tag}: the existing apply did not set the expected courses (${['Transactions and locking', 'Page replacement notes', 'Service mesh overview'].map(courseOf).join(' | ')})`);
      if (courseOf('Week 9 reading') !== '' || courseOf('Lunch menu') !== '') problems.push(`${tag}: a low-confidence source was changed`);
      await shot('5-after-apply');

      // 4. The kill switch.
      await openPage('settings'); section = await toSection();
      await section.locator('.jev-switch--master input').click(); await section.locator('.jev-switch--master input:not(:checked)').waitFor({ timeout: 15000 }); await settle(400);
      await shot('6-kill-switch-off');
      await openPage('sources'); await tab.locator('details.source-organize > summary').click(); await settle(300);
      if (await tab.locator('.jev-suggest-button').count()) problems.push(`${tag}: the Jev button is still there after the kill switch`);
      await shot('7-organizer-without-jev');

      // 5. A failing Jev falls back.
      await previewCall(server, 'jev.settings.set', { enabled: true });
      fake.fail(401, 401, 401, 401);
      await openPage('settings'); await openPage('sources');
      await tab.locator('details.source-organize > summary').click(); await settle(300);
      await pickLoose();
      await tab.locator('.jev-suggest-button').click();
      await tab.locator('.jev-note').waitFor({ timeout: 20000 }); await settle(300);
      await shot('8-jev-failed-fallback'); await audit(tab, `failed/${tag}`, { scopes: ['.jev-note'] });
      if (!await tab.getByRole('button', { name: /请 AI 建议|Suggest with AI/ }).count()) problems.push(`${tag}: "Suggest with AI" disappeared when Jev failed`);
      const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (overflow > 1) problems.push(`${tag}: horizontal overflow ${overflow}px`);
      } catch (error) { await tab.screenshot({ path: join(out, `FAILED-${lang}-${theme}-${width}.png`) }).catch(() => {}); throw error; }
      await context.close();
    } finally { await server.close(); }
  }
} finally { await browser.close(); await fake.close(); await rm(scratch, { recursive: true, force: true }).catch(() => {}); }

console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`PROBLEMS:\n- ${problems.join('\n- ')}`); process.exitCode = 1; } else console.log('no page errors, no horizontal overflow, no key on the page, nothing saved before apply');
