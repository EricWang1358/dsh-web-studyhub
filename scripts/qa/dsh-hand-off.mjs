/* The 「发给主会话」 step of npm run qa:dsh (scripts/qa/dsh-e2e.mjs; the hand-off plan S2a): in the real DSH host, StudyHub must never overwrite what the
   learner already typed into the main chat's input box and must never send anything.
     seedHandOffBook(workspace, home)  puts a 复习全书 (tests/helpers/book-fixtures.mjs, 'archss') into the workspace's library once, before DSH boots;
     handOffStep(page, { lang, model, shot })  opens a new conversation and types into its input box, goes to the top-level StudyHub page (it follows the
       selected conversation), hands a book point over from 问 AI and checks: the receipt 留 says the learner's text was kept and the message copied (with
       去主会话, as this host can show the chat), the clipboard holds the message, and back in the conversation the typed words are still there; then, with
       the box emptied, the same hand-off fills it (the learner's sentence on the first line, no tool name in it) and reveals the conversation. The model must get no request at all, and the box is emptied at the end. Returns what it saw. */
/* global document, navigator */
import { StudyService } from '../../lib/service.js';
import { workspaceLibrary } from '../../lib/host.js';
import { seedBookFixture } from '../../tests/helpers/book-fixtures.mjs';
import { createStudyRuntime } from '../../lib/runtime/builtins.js';
import { makeTextPdf } from '../../tests/helpers/text-pdf.mjs';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** Seed the book into the library DSH's default workspace opens (once: a library that already has a book is left alone). Machine settings go to `home`. */
export async function seedHandOffBook(workspace, home) {
  const before = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    const root = await workspaceLibrary(workspace);
    const service = new StudyService(root);
    let has = false, hasPdf = false;
    try {
      const sources = (await service.store.read()).sources || [];
      has = sources.some((source) => source.provenance === 'course-book-doc');
      hasPdf = sources.some((source) => /picture-qa/.test(`${source.title} ${source.document?.filename}`));
    } finally { await service.dispose(); }
    if (!has) await seedBookFixture(root, 'archss');
    if (has && hasPdf) return { root, seeded: false };
    if (hasPdf) return { root, seeded: true };
    // The PDF of pagePictureStep below: its original is kept, so 原始 PDF opens.
    const runtime = createStudyRuntime(root);
    await runtime.call('materials.document.import', { filename: 'picture-qa.pdf', dataBase64: (await makeTextPdf([['Picture QA page one'], ['Picture QA page two']])).toString('base64'), courses: ['ArchSS'] });
    runtime.dispose();
    return { root, seeded: true };
  } finally {
    if (before === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = before;
  }
}

/** Mark DSH's composer (the visible contenteditable outside StudyHub) with data-qa-composer; false when there is none on screen. */
const markComposer = (page) => page.evaluate(() => {
  document.querySelectorAll('[data-qa-composer]').forEach((element) => element.removeAttribute('data-qa-composer'));
  const boxes = [...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')]
    .filter((element) => !element.closest('.study-app, .study-seat') && element.getClientRects().length && element.getBoundingClientRect().width > 80);
  const box = boxes.at(-1);
  if (box) box.setAttribute('data-qa-composer', '');
  return !!box;
});

export async function handOffStep(page, { lang = 'zh', model, shot = async () => {} }) {
  const result = { kept: null, filled: null, requests: 0 };
  const en = lang === 'en';
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin }).catch(() => {});
  const composer = page.locator('[data-qa-composer]');
  const composerText = () => composer.evaluate((element) => (element.innerText || '').replace(/​/g, '').trim());
  const needComposer = async (what) => { await sleep(800); if (!await markComposer(page)) { await shot('13-hand-off-no-composer'); throw new Error(`no chat input box on screen ${what}`); } };
  const clear = async () => { await composer.click(); await page.keyboard.press('Control+A'); await page.keyboard.press('Backspace'); await sleep(300); };
  // The top-level StudyHub page (DSH's sidebar entry), on the book.
  const openBook = async () => {
    await page.getByRole('button', { name: /^StudyHub$/ }).first().click();
    await page.locator('[data-tour="nav-book"]:visible').first().click({ force: true });
    await page.locator('[data-book-point]:visible').first().waitFor({ timeout: 60000 });
    await sleep(800);
  };
  const handOver = async () => {
    await page.locator('.book-step [data-book-ask-open]:visible').first().click();
    const panel = page.locator('.book-ask[data-placed]');
    await panel.waitFor({ timeout: 10000 });
    await panel.locator('textarea').fill(en ? 'Explain it more slowly (QA)' : '讲得再慢一点（QA）');
    await panel.locator('[data-book-ask="chat"]').click();
    await panel.waitFor({ state: 'detached', timeout: 10000 });
  };
  const requestsBefore = model.log.length;
  // 1. A new conversation with the learner's own words in its box (not sent).
  await page.getByText(/^(新会话|New (chat|session))$/).first().click();
  await needComposer('in a new conversation');
  const typed = en ? 'my own words, typed first' : '我自己先打的字';
  await clear();
  await composer.click();
  await page.keyboard.type(typed);
  await sleep(500);
  // 2. From the book: StudyHub must not write over them; the prompt is copied and the notice says why.
  await openBook();
  await handOver();
  const receipt = page.locator('.sh-toast--receipt[data-receipt="kept"]').first();
  await receipt.waitFor({ timeout: 10000 });
  result.keptReceipt = { title: await receipt.locator('.sh-toast__title').innerText(), action: await receipt.locator('.sh-toast__action').allInnerTexts() };
  if (result.keptReceipt.title !== (en ? 'Your typed text is kept' : '输入框里你写的字都留着')) throw new Error(`the kept receipt says ${result.keptReceipt.title}`);
  await sleep(800);
  await shot('13-hand-off-kept-notice');
  const clipboard = await page.evaluate(() => navigator.clipboard.readText().catch((error) => `!${error.message}`));
  // 3. Back in the conversation (its entry in DSH's list): the words are as typed.
  await page.getByText(/^(新会话|New (chat|session))$/).last().click();
  await needComposer('back in the conversation');
  result.kept = { text: await composerText(), clipboardHasPrompt: /study-book/.test(clipboard), clipboardHead: clipboard.slice(0, 60) };
  await shot('13-hand-off-kept-box');
  if (result.kept.text !== typed) throw new Error(`the typed words were changed: ${JSON.stringify(result.kept.text.slice(0, 200))}`);
  if (!result.kept.clipboardHasPrompt) throw new Error(`the prompt was not copied: ${result.kept.clipboardHead}`);
  // 4. An empty box: the same hand-off fills it and reveals the conversation; still nothing is sent.
  await clear();
  await openBook();
  await handOver();
  await needComposer('after the hand-off revealed the conversation');
  const filled = await composerText();
  const firstLine = filled.split('\n')[0];
  result.filled = { hasPrompt: /study-book/.test(filled), endsWithLanguage: (en ? /do not translate them\.$/ : /不要翻译。$/).test(filled), length: filled.length, firstLine: firstLine.slice(0, 80) };
  await shot('13-hand-off-filled');
  if (!result.filled.hasPrompt) throw new Error(`the empty box did not get the prompt: ${JSON.stringify(filled.slice(0, 200))}`);
  if (/study_workspace|study-book|book\.\w/.test(firstLine)) throw new Error(`the first line is not the learner's own: ${firstLine}`);
  await clear();
  await sleep(1500);
  result.requests = model.log.length - requestsBefore;
  if (result.requests) throw new Error(`a hand-off sent ${result.requests} request(s) to the model; it must only fill the box`);
  return result;
}

/* #488, in the real host: 发给主会话 from a page of 原始 PDF puts the text AND the picture of the page into the chat's input box (conversation.createDrafts +
   input.addAttachments are not in a public contract, so only this proves they still work), and sends nothing. On a host without those faces the old screenshot way
   stays: `attached` is false and the step only checks the text. The picture is taken out again at the end. */
export async function pagePictureStep(page, { lang = 'zh', model, shot = async () => {} }) {
  const en = lang === 'en', requestsBefore = model.log.length, result = { attached: false, thumbnails: 0, requests: 0 };
  await page.getByText(/^(新会话|New (chat|session))$/).first().click();
  await sleep(800);
  await page.getByRole('button', { name: /^StudyHub$/ }).first().click();
  await page.locator('[data-tour="nav-sources"]:visible').first().click({ force: true });
  await sleep(1500);
  await shot('14-page-picture-sources');
  await page.locator('.source-doc:visible', { hasText: 'picture-qa' }).first().locator('.source-main').click({ timeout: 15000 });
  await page.locator('.study-document-viewer:visible').waitFor({ timeout: 30000 });
  await sleep(2500); // the original file loads first; before that the tab offers to attach one
  await page.locator('.study-document-viewer:visible .sh-seg__item', { hasText: en ? 'Original PDF' : '原始 PDF' }).click();
  if (!await page.locator('[data-tour="source-tools"]:visible').count()) await page.locator('[data-tour="source-tools-toggle"]:visible').click();
  const button = page.locator('.study-page-ask:visible [data-hand-off="reader.page"]').first();
  await button.waitFor({ timeout: 30000 }).catch(async (error) => { await shot('14-page-picture-no-button'); throw error; });
  result.lead = await page.locator('.study-page-ask:visible .sh-handoff__lead').first().innerText();
  await shot('14-page-picture-panel');
  await button.click();
  // The host reveals the conversation once the box is filled; drawing the page comes first.
  await page.waitForFunction(() => ![...document.querySelectorAll('[contenteditable="true"], [role="textbox"]')].every((element) => element.closest('.study-app, .study-seat') || !element.getClientRects().length || !(element.innerText || '').trim()), null, { timeout: 60000 });
  await sleep(1500);
  await shot('14-page-picture-box');
  if (!await markComposer(page)) throw new Error('no chat input box after the hand-off');
  const composer = page.locator('[data-qa-composer]'), text = await composer.evaluate((element) => element.innerText || '');
  result.hasPageText = /Picture QA page one/.test(text);
  result.saysAttached = (en ? /attached to this message/ : /附件/).test(text);
  result.thumbnails = await page.evaluate(() => [...document.querySelectorAll('img[src^="blob:"]')].filter((image) => !image.closest('.study-app, .study-seat') && image.getClientRects().length).length);
  result.attached = result.thumbnails === 1;
  // The thumbnail is a crop: the picture itself must be the page, drawn large enough to read, with ink on it (never a blank one).
  if (result.attached) result.picture = await page.evaluate(() => {
    const image = [...document.querySelectorAll('img[src^="blob:"]')].find((item) => !item.closest('.study-app, .study-seat') && item.getClientRects().length);
    const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d'); context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
    let inked = 0; for (let at = 0; at < data.length; at += 4) if (data[at] < 128) inked += 1;
    return { width: canvas.width, height: canvas.height, inked };
  });
  if (result.attached && !(Math.max(result.picture.width, result.picture.height) >= 1000 && result.picture.inked > 50)) throw new Error(`the picture is not the page: ${JSON.stringify(result.picture)}`);
  if (!result.hasPageText) throw new Error(`the box did not get the page text: ${text.slice(0, 200)}`);
  if (result.saysAttached !== result.attached) throw new Error(`the message and the box disagree: says attached ${result.saysAttached}, ${result.thumbnails} picture(s)`);
  await composer.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  const remove = page.locator('button[aria-label*="移除"], button[aria-label*="Remove"], button[aria-label*="删除"]').first();
  if (result.attached && await remove.count()) { await remove.click({ force: true }).catch(() => {}); await sleep(300); }
  result.requests = model.log.length - requestsBefore;
  if (result.requests) throw new Error(`a hand-off sent ${result.requests} request(s) to the model; it must only fill the box`);
  return result;
}
