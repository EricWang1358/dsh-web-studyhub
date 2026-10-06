/* global document */
/* node scripts/qa/jev-shots.mjs [--out <dir>] [--quick]
   The experimental Jev layer in the real app (browser preview), against a LOCAL FAKE Jev server (tests/helpers/fake-jev.mjs) and the preview's
   fake study model: no network call, no real key. zh/en x dark/light at 1440 and 420 px, each with a layout audit, a console/page-error check and
   a horizontal-overflow check:
     A. HIDDEN (the default): walk Settings (the Advanced group), Sources (the organizer), a library holding a draft with Jev traces, the home page
        and the whole feature tour; a DOM scan (text, every attribute, class names, style elements) finds no Jev anywhere and the browser sends no
        jev.* request;
     B. Settings › Advanced › Show experimental features turned on: the guided block in its order (walk-through with next/back/skip, provider and
        key source, per-site switches); a switch with a missing prerequisite explains it; the OpenCode Zen preset reads its key from OPENCODE_GO_API_KEY_2
        (found / not found, never the value), the privacy confirmation is per provider, the connection test reaches the Zen path with jev-1.13-free;
     C. the replacements working: switches turn on at once, "请 AI 建议" decided partly by Jev (marked) and partly by the model (one notice), nothing saved
        before the apply button; a generated draft whose review Jev decided (marks and one summary line); a failing Jev falls back with one notice;
     D. the switch turned off again: everything hides and no Jev request is made.
   The preview runs on a temporary home (the key file lives there) with every key/token/base-url variable removed from the environment; only
   JEV_BASE_URL (the fake server) and OPENCODE_GO_API_KEY_2 (the FAKE key, in the preview process only) are set afterwards.
   Chromium: PLAYWRIGHT_CHROMIUM or the one under ms-playwright. */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPreviewServer, previewCall } from '../preview-server.mjs';
import { launchChromium } from './browser.mjs';
import { pick } from './pick.mjs';
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
const scratch = await mkdtemp(join(tmpdir(), 'qa-shots-'));
process.env.USERPROFILE = scratch; process.env.HOME = scratch;
await mkdir(out, { recursive: true });

// What the fake Jev answers: a choice by the title of the source it is asked about, every yes/no check "passes".
const TABLE = {
  'Transactions and locking': { Databases: 0.94, 'Operating Systems': 0.03, Networks: 0.01, [NONE_KEY]: 0.02 },
  'Page replacement notes': { 'Operating Systems': 0.88, Databases: 0.06, Networks: 0.02, [NONE_KEY]: 0.04 },
  'Service mesh overview': { 'Design / 05 Kubernetes': 0.45, 'Design / 06 Istio': 0.4, Design: 0.05, [NONE_KEY]: 0.1 },
  'Week 9 reading': { Databases: 0.5, 'Operating Systems': 0.4, [NONE_KEY]: 0.1 },
  'Lunch menu': { [NONE_KEY]: 0.92, Networks: 0.08 },
};
const answer = (name, question, state) => {
  if (question.type === 'noul') return { type: 'noul', noul: 0.95 };
  if (question.type !== 'choice') return defaultAnswer(question);
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
/** Everything the page shows or carries that mentions Jev: visible text, every attribute (names and values), class names, style elements. */
const jevTrace = (tab, { styles = true } = {}) => tab.evaluate(({ styles: withStyles }) => {
  const hits = [], body = document.body.innerText;
  if (/jev/i.test(body)) hits.push(`text: ${(body.match(/.{0,30}jev.{0,30}/i) ?? [''])[0].replace(/\s+/g, ' ')}`);
  for (const element of document.querySelectorAll('*')) if (withStyles || element.tagName !== 'STYLE') for (const attribute of element.attributes) if (/jev/i.test(attribute.name) || /jev/i.test(attribute.value)) hits.push(`${element.tagName.toLowerCase()}[${attribute.name}=${attribute.value.slice(0, 60)}]`);
  if (document.querySelector('[data-experimental]')) hits.push('[data-experimental]');
  return [...new Set(hits)].slice(0, 6);
}, { styles });
let port = 4480;
try {
  for (const [lang, theme, width] of combos) {
    const tag = `${lang}/${theme}/${width}`;
    fake.requests.length = 0; fake.clearFailures();
    delete process.env.OPENCODE_GO_API_KEY_2;
    const server = await createPreviewServer({ libraryRoot: join(scratch, `lib-${lang}-${theme}-${width}`), home: join(scratch, `home-${lang}-${theme}-${width}`), port: port++, model: 'fake', fakeLatencyMs: 20 });
    try {
      await seed(server);
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 1, locale: lang === 'en' ? 'en-US' : 'zh-CN', colorScheme: theme });
      await context.addInitScript(([l, t]) => { try { localStorage.setItem('study-ui-language', l); localStorage.setItem('study-theme', t); } catch { /* blocked */ } }, [lang, theme]);
      const tab = await context.newPage();
      const jevCalls = [];
      tab.on('pageerror', error => problems.push(`${tag}: ${error.message}`));
      tab.on('console', message => { if (message.type() === 'error') problems.push(`${tag}: console ${message.text()}`); });
      tab.on('response', async response => {
        if (!response.url().endsWith('/api/call')) return;
        const body = await response.json().catch(() => null), action = JSON.parse(response.request().postData() || '{}').action;
        if (body && body.ok === false) problems.push(`${tag}: ${action} failed: ${JSON.stringify(body).slice(0, 240)} with ${(response.request().postData() || '').slice(0, 200)}`);
      });
      tab.on('request', request => { if (request.url().endsWith('/api/call') && /"action":"(jev|experimental)\./.test(request.postData() || '')) jevCalls.push(request.postData().slice(0, 60)); });
      const settle = async (ms = 350) => { await tab.waitForLoadState('networkidle').catch(() => {}); await sleep(ms); };
      const shot = async label => { const path = join(out, `${label}-${lang}-${theme}-${width}.png`); await tab.screenshot({ path }); shots.push(path); };
      const noJev = async (where, options) => { const hits = await jevTrace(tab, options); if (hits.length) problems.push(`${tag}: Jev is visible with experimental features hidden (${where}): ${hits.join(' | ')}`); };
      const pickLoose = async () => { await pick(tab, tab.getByRole('combobox', { name: /课程范围|Course scope/ }), /未分类|Uncategorised/); await settle(300); await tab.getByRole('button', { name: /选择当前范围|Select this scope/ }).click(); await settle(200); };
      const openPage = async nav => { await tab.locator(`[data-tour="nav-${nav}"]`).first().click(); await settle(); };
      // Settings is a list of categories and one pane: the experimental switch (and the Jev block under it) is the 实验性功能 category.
      const advanced = async () => {
        const item = tab.locator('[data-category="experimental"]');
        await item.waitFor({ timeout: 15000 });
        if ((await item.getAttribute('aria-current')) !== 'page') await item.click();
        const pane = tab.locator('.settings-pane');
        await pane.evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(300);
        return pane;
      };
      const block = () => tab.locator('[data-tour="settings-jev"]');
      const fit = async where => { const overflow = await tab.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); if (overflow > 1) problems.push(`${tag}: horizontal overflow ${overflow}px (${where})`); };
      try {
      await tab.goto(server.url); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(800);

      // A. HIDDEN by default: nothing anywhere.
      await noJev('home'); await shot('1-hidden-home');
      await openPage('settings');
      let group = await advanced();
      if (await group.locator('input[name="show-experimental"]:checked').count()) problems.push(`${tag}: the experimental switch starts on`);
      await noJev('settings'); await shot('2-hidden-settings-advanced'); await fit('hidden settings');
      await openPage('sources');
      await tab.locator('details.source-organize > summary').click(); await settle(300);
      await noJev('sources organizer');
      await openPage('library'); await noJev('library');
      // A draft that holds Jev traces (pre-check signals, a Jev-decided review): hidden too.
      const [anchor] = (await previewCall(server, 'source.list', {})).sources.filter(source => source.title === 'Intro to SQL');
      const card = (id, prompt, objective) => ({ id, kind: 'flashcard', topic: 'Transactions', objective, prompt, answer: 'Isolation keeps concurrent changes apart.', hint: 'Think about two sessions.',
        explanation: 'Lecture notes explain it.', misconception: 'Isolation means no concurrency.', citations: [{ sourceId: anchor.id, quote: 'Lecture notes. Lecture notes.' }] });
      const check = (p, failure, failed) => ({ p, failure, failed });
      await previewCall(server, 'draft.save', { deck: { id: 'qa-jev-draft', title: 'QA pre-check draft', course: 'Databases', cards: [card('qa1', 'Why do databases isolate concurrent transactions?', 'Explain isolation'),
        card('qa2', 'What does a rewritten question look like after the pre-check?', 'Explain a rewrite')],
      editorial: { summary: 'Approved 2 questions in one review round (2 of the reviewed candidates judged by an experimental decision service, 0 by the independent model review); 0 candidates omitted.',
        jevDecided: { version: 1, site: 'cardReview', threshold: 0.8, language: lang, judged: 2, model: 0, accepted: 2, rejected: 0, cards: { qa1: { verdict: 'accept', confidence: 0.95 }, qa2: { verdict: 'accept', confidence: 0.91 } }, fallback: null },
        jev: { version: 1, threshold: 0.8, signals: {
          qa1: { checks: { stemLeaksAnswer: check(0.04, 0.04, false), needsSource: check(0.07, 0.07, false), answerInEvidence: check(0.93, 0.07, false) }, flagged: false, failures: [] },
          qa2: { checks: { stemLeaksAnswer: check(0.96, 0.96, true), needsSource: check(0.1, 0.1, false), answerInEvidence: check(0.9, 0.1, false) }, flagged: true, failures: ['stemLeaksAnswer'], rewritten: true } } } } } });
      await tab.reload(); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(600);
      await openPage('library');
      await tab.locator('.draft-row .draft-open').first().click();
      await tab.locator('.draft-card').first().waitFor({ timeout: 15000 }); await settle(400);
      await tab.locator('.draft-card').first().locator('summary').click(); await settle(300);
      await noJev('draft'); await shot('3-hidden-draft');
      // The whole feature tour (the settings page opens every group in it): not one step mentions Jev.
      await openPage('settings'); await settle(400);
      const tourButton = tab.getByRole('button', { name: /功能导览|feature tour/i });
      if (await tourButton.count()) {
        await tourButton.first().click();
        let steps = 0;
        for (let guard = 0; guard < 60; guard++) {
          const pop = tab.locator('.tour-layer:not(.is-measuring) .tour-pop');
          await pop.first().waitFor({ timeout: 8000 }).catch(() => {});
          if (!await pop.count()) break;
          await settle(450);
          await noJev(`tour step ${++steps}`);
          // The primary button of every step (start, next, finish) goes on; a step without one is skipped.
          const primary = pop.first().locator('.sh-btn--primary');
          if (await primary.count()) await primary.first().click(); else await pop.first().locator('.tour-pop__skip').click();
          await sleep(450);
        }
        if (await tab.locator('.tour-layer').count()) { await tab.locator('.tour-pop__skip').first().click().catch(() => {}); await tab.locator('.tour-layer').waitFor({ state: 'detached', timeout: 15000 }).catch(() => problems.push(`${tag}: the tour did not close`)); }
        // Whatever dialog the tour's end opens is closed with Escape (it is scanned first).
        for (let guard = 0; guard < 4 && await tab.locator('dialog[open]').count(); guard++) { await noJev('dialog after the tour'); await tab.keyboard.press('Escape'); await sleep(350); }
        if (steps < 3) problems.push(`${tag}: the tour walk saw only ${steps} steps`);
      } else problems.push(`${tag}: no tour button found to walk the tour`);
      if (jevCalls.length) problems.push(`${tag}: the page sent Jev requests while hidden: ${jevCalls.join(' | ')}`);
      if (fake.requests.length) problems.push(`${tag}: Jev was contacted while hidden`);

      // B. Show experimental features: the guided block, in order.
      await openPage('settings'); group = await advanced();
      await group.locator('input[name="show-experimental"]').click();
      await block().waitFor({ timeout: 15000 }); await settle(500);
      group = await advanced();
      await block().evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(300);
      await shot('4-shown-guide-step1'); await audit(tab, `guide/${tag}`, { scopes: ['.jev-guide', '.jev-provider'] }); await fit('shown block');
      const order = await block().evaluate(element => ['.jev-guide', '.jev-provider [role="combobox"]', 'input[name="jev-key"]', '.jev-replace', '.jev-switches'].map(selector => element.querySelector(selector)?.getBoundingClientRect().top ?? -1));
      if (order.some(value => value < 0) || order.some((value, index) => index && value <= order[index - 1])) problems.push(`${tag}: the guided block is not in order (guide, provider, key, replace switches, master): ${order.join(', ')}`);
      await block().getByRole('button', { name: /下一个|Next/ }).click(); await settle(200);
      if (!await block().locator('[data-jev-guide="2"]').count()) problems.push(`${tag}: the walk-through did not advance`);
      await shot('5-guide-step2'); await audit(tab, `guide2/${tag}`, { scopes: ['.jev-guide'] });
      await block().getByRole('button', { name: /上一个|Back/ }).click(); await settle(150);
      if (!await block().locator('[data-jev-guide="1"]').count()) problems.push(`${tag}: the walk-through did not go back`);
      await block().getByRole('button', { name: /跳过|Skip/ }).click(); await settle(200);
      if (!await block().locator('[data-jev-guide="done"]').count()) problems.push(`${tag}: skipping did not fold the walk-through`);
      await shot('6-guide-skipped');

      // The provider: OpenCode Zen free; its key variable is not set yet.
      await pick(tab, block().locator('.jev-provider [role="combobox"]'), /Jev (免费|Free)/); await settle(500);
      await block().locator('[data-provider="opencode-zen-free"]').first().waitFor({ timeout: 15000 });
      if (!await block().getByText(/OPENCODE_GO_API_KEY_2/).count()) problems.push(`${tag}: the key variable name is not shown`);
      await shot('7-provider-zen-key-missing'); await audit(tab, `provider/${tag}`, { scopes: ['.jev-provider', '.jev-card', '.jev-privacy', '.jev-replace'] });
      // A switch with a missing prerequisite says what is missing instead of staying off silently.
      await block().locator('[data-replace="cardReview"] input').click(); await settle(300);
      await block().locator('.jev-prereq__blocked').waitFor({ timeout: 5000 }).catch(() => problems.push(`${tag}: no explanation after flipping a switch whose key is missing`));
      if (await block().locator('[data-replace="cardReview"] input:checked').count()) problems.push(`${tag}: the switch turned on without a key`);
      await shot('8-switch-blocked'); await audit(tab, `blocked/${tag}`, { scopes: ['.jev-replace'] });

      // The key comes from the environment variable: found, never shown, never stored.
      process.env.OPENCODE_GO_API_KEY_2 = fake.key;
      await tab.reload(); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(600);
      await openPage('settings'); await advanced(); await block().waitFor({ timeout: 15000 }); await settle(500);
      await block().evaluate(element => element.scrollIntoView({ block: 'start' })); await settle(200);
      if (!await block().locator('[data-key-source="env-found"]').count()) problems.push(`${tag}: the key was not found from OPENCODE_GO_API_KEY_2`);
      if ((await tab.locator('body').innerText()).includes(fake.key)) problems.push(`${tag}: the key appears on the page`);
      await block().locator('.jev-privacy input[type="checkbox"]').click(); await block().locator('.jev-privacy[data-confirmed="true"]').waitFor({ timeout: 15000 }); await settle(300);
      await block().getByRole('button', { name: /验证 Jev 密钥|Test the Jev key/ }).click();
      await block().locator('.sh-inline--success').waitFor({ timeout: 15000 }); await settle(300);
      const zen = fake.requests.at(-1);
      if (!zen || zen.path !== '/zen/v1/systemone' || zen.payload.model !== 'jev-1.13-free' || zen.headers.authorization !== `Bearer ${fake.key}`) problems.push(`${tag}: the connection test did not reach the Zen path with the free model and the environment key`);
      await block().locator('.jev-card').scrollIntoViewIfNeeded(); await settle(200);
      await shot('9-key-from-environment-tested'); await audit(tab, `key/${tag}`, { scopes: ['.jev-card', '.jev-privacy', '.jev-provider'] });
      // Another provider has its own confirmation.
      await pick(tab, block().locator('.jev-provider [role="combobox"]'), 'OpenCode Zen · Jev', { exact: true }); await settle(500);
      if (!await block().locator('.jev-privacy[data-confirmed="false"]').count()) problems.push(`${tag}: the paid preset inherited the confirmation of the free one`);
      await pick(tab, block().locator('.jev-provider [role="combobox"]'), /Jev (免费|Free)/); await settle(500);
      if (!await block().locator('.jev-privacy[data-confirmed="true"]').count()) problems.push(`${tag}: the confirmation of the free preset was lost`);

      // C. The switches turn on at once.
      await block().locator('[data-replace="cardReview"] input').click();
      await block().locator('[data-replace="cardReview"] input:checked').waitFor({ timeout: 15000 });
      await block().locator('[data-replace="courseOrganize"] input').click();
      await block().locator('[data-replace="courseOrganize"] input:checked').waitFor({ timeout: 15000 });
      if (!await block().locator('.jev-switch--master input:checked').count()) problems.push(`${tag}: the master switch was not switched on with the first site`);
      await settle(300);
      await block().locator('.jev-replace').scrollIntoViewIfNeeded(); await settle(200);
      await shot('10-switches-on'); await audit(tab, `switches/${tag}`, { scopes: ['.jev-replace', '.jev-switches'] });
      await block().locator('.jev-usage__more summary').count().then(async count => { if (count) { await block().locator('.jev-usage__more summary').click(); await settle(200); } });
      await block().locator('.jev-usage').scrollIntoViewIfNeeded(); await settle(200);
      { const path = join(out, `10b-usage-${lang}-${theme}-${width}.png`); await block().locator('.jev-usage').screenshot({ path }); shots.push(path); }
      await audit(tab, `usage/${tag}`, { scopes: ['.jev-usage'] });

      // Organize courses: "请 AI 建议" decided partly by Jev, partly by the model; saved only by the apply button.
      await openPage('sources');
      await tab.locator('details.source-organize > summary').click(); await settle(300);
      await pickLoose();
      const before = JSON.stringify((await previewCall(server, 'source.list', {})).sources.map(source => [source.id, source.courses]));
      await tab.getByRole('button', { name: /请 AI 建议|Suggest with AI/ }).click();
      await tab.locator('.source-course-proposals').waitFor({ timeout: 30000 }); await settle(500);
      if (JSON.stringify((await previewCall(server, 'source.list', {})).sources.map(source => [source.id, source.courses])) !== before) problems.push(`${tag}: suggesting saved something`);
      const decided = await tab.locator('[data-jev-decided="row"]').count();
      if (decided !== 3) problems.push(`${tag}: expected 3 rows decided by Jev, found ${decided}`);
      if (await tab.locator('.jev-run-note').count() !== 1) problems.push(`${tag}: expected exactly one run note, found ${await tab.locator('.jev-run-note').count()}`);
      await tab.locator('.source-course-proposals').scrollIntoViewIfNeeded(); await settle(200);
      await shot('11-ai-suggest-decided-by-jev'); await audit(tab, `organize/${tag}`, { scopes: ['.jev-run-note', '.jev-probs'] });
      await fit('organizer');

      // A generated draft whose review Jev decided.
      const job = await previewCall(server, 'generate', { sourceIds: [anchor.id], count: 3, kind: 'flashcard' });
      const done = await previewCall(server, 'job.wait', { jobId: job.jobId });
      if (done.status !== 'complete') problems.push(`${tag}: the generation job did not complete (${done.status}: ${done.stage})`);
      const requestsBefore = fake.requests.length;
      await tab.reload(); await tab.locator('aside, nav').first().waitFor({ timeout: 30000 }); await settle(600);
      await openPage('library');
      await tab.locator('.draft-row .draft-open').last().click();
      await tab.locator('.draft-card').first().waitFor({ timeout: 15000 }); await settle(400);
      const marks = await tab.locator('[data-jev-decided="card"]').count(), cards = await tab.locator('.draft-card').count();
      if (!marks || marks > cards) problems.push(`${tag}: expected cards marked "decided by Jev" in the generated draft, found ${marks} of ${cards}`);
      if (await tab.locator('[data-jev-decided="summary"]').count() !== 1) problems.push(`${tag}: expected one summary line of who decided the review`);
      if (!requestsBefore) problems.push(`${tag}: Jev was not asked while generating`);
      await tab.locator('.draft-card').first().scrollIntoViewIfNeeded(); await settle(200);
      await shot('12-draft-decided-by-jev'); await audit(tab, `draft-decided/${tag}`, { scopes: ['.jev-decided-note'] });

      // A failing Jev falls back to the model, with one notice.
      await openPage('sources');
      await tab.locator('details.source-organize > summary').click(); await settle(300);
      await pickLoose();
      fake.fail(...Array(60).fill(401));
      await tab.getByRole('button', { name: /请 AI 建议|Suggest with AI/ }).click();
      await tab.locator('.source-course-proposals').waitFor({ timeout: 30000 }); await settle(500);
      if (await tab.locator('[data-jev-decided="row"]').count()) problems.push(`${tag}: a row is marked decided by Jev although Jev failed`);
      if (await tab.locator('.jev-run-note').count() !== 1) problems.push(`${tag}: expected exactly one fallback notice, found ${await tab.locator('.jev-run-note').count()}`);
      await shot('13-jev-failed-fallback'); await audit(tab, `fallback/${tag}`, { scopes: ['.jev-run-note'] });
      fake.clearFailures();

      // D. Turn the one switch off again: everything hides and stops.
      await openPage('settings'); await advanced();
      await tab.locator('input[name="show-experimental"]').click();
      await block().waitFor({ state: 'detached', timeout: 15000 }); await settle(400);
      // (A stylesheet injected while it was on stays in the page until reload; it draws nothing, so only the visible page is scanned here.)
      await noJev('settings after turning it off', { styles: false }); await shot('14-hidden-again');
      const asked = fake.requests.length;
      await openPage('sources');
      await tab.locator('details.source-organize > summary').click(); await settle(300);
      await pickLoose();
      await tab.getByRole('button', { name: /请 AI 建议|Suggest with AI/ }).click();
      await tab.locator('.source-course-proposals').waitFor({ timeout: 30000 }); await settle(400);
      await noJev('sources after turning it off', { styles: false });
      if (fake.requests.length !== asked) problems.push(`${tag}: Jev was asked after experimental features were turned off`);
      } catch (error) { await tab.screenshot({ path: join(out, `FAILED-${lang}-${theme}-${width}.png`) }).catch(() => {}); throw error; }
      await context.close();
    } finally { await server.close(); }
  }
} finally {
  if (problems.length) console.log(`PROBLEMS SO FAR:\n- ${problems.join('\n- ')}`);
  await browser.close(); await fake.close(); await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

console.log(`${shots.length} screenshots in ${out}`);
if (problems.length) { console.log(`PROBLEMS:\n- ${problems.join('\n- ')}`); process.exitCode = 1; }
else console.log('no page errors, no horizontal overflow, no Jev anywhere while hidden (text, attributes, requests, the whole tour), the guided flow in order, the key never on the page, one run note per run, nothing saved before apply');
