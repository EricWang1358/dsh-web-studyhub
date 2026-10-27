/* global localStorage, document */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { createPreviewServer } from '../scripts/preview-server.mjs';
import { buildPreview } from '../scripts/build.mjs';
import { launchChromium } from '../scripts/qa/browser.mjs';

// 3.7.x delete track, D2 in the real app: 归档 from a deck row's ⋯ menu (notice with 撤销 and 永久删除…, which opens the one permanent-delete dialog), and 归档所选 on the
// Sources page (several documents, one call, one notice). Archive-first stays: nothing is deleted for good without that dialog.
test('archive from the deck row menu and from the checked materials, each with 撤销 and the shortcut to the permanent-delete dialog', { timeout: 120000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'delete-d2-browser-'));
  const service = new StudyService(join(root, 'library'));
  const card = id => ({ id, kind: 'flashcard', topic: 'Topic', objective: 'Recall', prompt: id, answer: 'Answer', hint: '', explanation: '', misconception: '', citations: [] });
  await service.store.update(s => {
    for (const n of [1, 2, 3]) s.sources.push({ id: `s${n}`, title: `Lecture ${n}`, text: `Evidence ${n}`, createdAt: new Date(Date.UTC(2026, 9, 20, 10, n)).toISOString(), courses: [] });
    s.decks.push({ id: 'a', title: 'Deck A', cards: [card('a1')] });
    s.decks.push({ id: 'b', title: 'Deck B', cards: [card('b1'), card('b2')] });
    s.decks.push({ id: 'c', title: 'Deck C', cards: [card('c1')] });
  });
  await service.call('review.start', { mode: 'path', scope: [{ deckId: 'b' }], fresh: true });
  const distDir = join(root, 'dist'); await buildPreview({ outdir: distDir });
  const server = await createPreviewServer({ libraryRoot: service.store.root, home: join(root, 'home'), port: 0, model: null, distDir });
  let browser;
  t.after(async () => { await browser?.close(); await server.close(); await service.dispose(); await rm(root, { recursive: true, force: true }); });
  try { browser = await launchChromium(); }
  catch (error) { if (!/Executable doesn't exist/.test(error.message)) throw error; t.skip('Chromium unavailable'); return; }
  const page = await browser.newPage({ viewport: { width: 1100, height: 900 } }), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => new URL(route.request().url()).hostname === '127.0.0.1' ? route.continue() : route.abort());
  await page.addInitScript(() => { localStorage.setItem('study-ui-language', 'en'); localStorage.setItem('study-autopilot', 'off'); });
  await page.goto(server.url);
  const row = title => page.locator('.map-deck').filter({ has: page.getByText(title, { exact: true }) });
  const menu = page.getByRole('menu');
  const notice = page.locator('.sh-toast');
  const hostDeck = async id => (await service.call('deck.get', { id }));

  // The menu: 归档 is the last entry (after Manage deck), and it is not a danger entry; a deck with an open run says what archiving ends before the click.
  await row('Deck A').getByRole('button', { name: 'More actions', exact: true }).click();
  const names = await menu.getByRole('menuitem').allInnerTexts();
  assert.equal(names.at(-1).split('\n')[0], 'Archive');
  assert.ok(names.findIndex(name => name.startsWith('Manage deck')) < names.length - 1, 'Archive comes after Manage deck');
  assert.equal(await menu.getByRole('menuitem', { name: /Permanently delete/ }).count(), 0, 'permanent delete is not on the menu: archive first');
  await page.keyboard.press('Escape');
  await row('Deck B').getByRole('button', { name: 'More actions', exact: true }).click();
  assert.match(await menu.getByRole('menuitem', { name: /^Archive/ }).innerText(), /Ends 1 practice run/);
  await page.keyboard.press('Escape');

  // Archive Deck A from the menu: the row leaves, the host has it archived, the notice offers Undo and Permanently delete…
  await row('Deck A').getByRole('button', { name: 'More actions', exact: true }).click();
  await menu.getByRole('menuitem', { name: /^Archive/ }).click();
  await notice.filter({ hasText: 'Archived “Deck A”' }).waitFor();
  await row('Deck A').waitFor({ state: 'hidden' });
  assert.equal((await hostDeck('a')).archived, true);
  const offer = notice.filter({ hasText: 'Archived “Deck A”' });
  assert.equal(await offer.getByRole('button', { name: 'Undo' }).count(), 1);
  assert.equal(await offer.getByRole('button', { name: 'Permanently delete…' }).count(), 1);

  // Undo: the deck is back, and the keyboard focus is on its menu button again.
  await offer.getByRole('button', { name: 'Undo' }).click();
  await row('Deck A').waitFor();
  assert.equal((await hostDeck('a')).archived, false);
  await page.waitForFunction(() => document.activeElement?.closest('[data-deck-id="a"]') !== null);

  // Archive again, then Permanently delete…: the existing dialog opens for this deck; Cancel keeps it archived; confirming deletes it for good.
  await row('Deck A').getByRole('button', { name: 'More actions', exact: true }).click();
  await menu.getByRole('menuitem', { name: /^Archive/ }).click();
  await notice.filter({ hasText: 'Archived “Deck A”' }).getByRole('button', { name: 'Permanently delete…' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Deck A/);
  assert.equal(await page.locator(':focus').textContent(), 'Cancel', 'the dialog opens on Cancel, as ever');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.equal((await hostDeck('a')).archived, true, 'cancelled: still archived, nothing deleted');
  await page.getByRole('button', { name: 'Archived', exact: true }).click();
  await row('Deck A').getByRole('button', { name: 'Permanently delete', exact: true }).click();
  await dialog.getByRole('button', { name: 'Confirm permanent deletion', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await assert.rejects(service.call('deck.get', { id: 'a' }), /not found/i);
  await page.getByRole('button', { name: 'Archived', exact: true }).click();

  // Deck B has an open run: archiving it says how many ended.
  await row('Deck B').getByRole('button', { name: 'More actions', exact: true }).click();
  await menu.getByRole('menuitem', { name: /^Archive/ }).click();
  await notice.filter({ hasText: 'Archived “Deck B”' }).waitFor();
  assert.match(await notice.filter({ hasText: 'Archived “Deck B”' }).innerText(), /ended 1 practice run/);

  // Sources: check two documents, 归档所选: one call, one notice with the count and Undo, and no single permanent-delete dialog for several.
  await page.locator('[data-tour="nav-sources"]').click();
  await page.locator('.source-organize > summary').click();
  const archiveChosen = page.locator('[data-archive-selected]');
  assert.equal(await archiveChosen.isDisabled(), true, 'nothing checked: nothing to archive');
  await page.getByRole('checkbox', { name: 'Select source: Lecture 1' }).check();
  await page.getByRole('checkbox', { name: 'Select source: Lecture 2' }).check();
  assert.match(await archiveChosen.innerText(), /Archive selected \(2\)/);
  await archiveChosen.click();
  const several = notice.filter({ hasText: 'Archived 2 sources' });
  await several.waitFor();
  assert.equal(await several.getByRole('button', { name: 'Permanently delete…' }).count(), 0);
  const archivedIds = async () => (await service.call('export')).sources.filter(source => source.archived).map(source => source.id).sort();
  assert.deepEqual(await archivedIds(), ['s1', 's2']);
  assert.equal(await page.locator('.source-doc', { hasText: 'Lecture 1' }).count(), 0, 'the archived rows leave the list');
  assert.equal(await page.locator('.source-doc', { hasText: 'Lecture 3' }).count(), 1);
  await several.getByRole('button', { name: 'Undo' }).click();
  await page.locator('.source-doc', { hasText: 'Lecture 1' }).waitFor();
  assert.deepEqual(await archivedIds(), [], 'Undo restores every one of them');

  // One checked document: the notice names it and keeps its own shortcut to the dialog.
  await page.getByRole('checkbox', { name: 'Select source: Lecture 3' }).check();
  await archiveChosen.click();
  const single = notice.filter({ hasText: 'Archived “Lecture 3”' });
  await single.waitFor();
  await single.getByRole('button', { name: 'Permanently delete…' }).click();
  await dialog.waitFor();
  assert.match(await dialog.innerText(), /Lecture 3/);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.deepEqual(await archivedIds(), ['s3'], 'cancelled: archived, not deleted');
  assert.deepEqual(errors, []);
});
