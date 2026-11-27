import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadInteractiveUi, click, withBrowserGlobals } from './helpers/react-harness.mjs';

// Wave 4 item 5 (#135): what can be a Button / Chip is one; what is left is a raw <button> for a documented reason, and the list below is
// the whole of it. A new raw button outside ui/components needs a line here (with its reason) or must be a Button.
const baseline = JSON.parse(readFileSync('tests/fixtures/ui-guardrail-baseline.json', 'utf8')).metrics.rawButton;

/* file (under ui/) -> why its raw buttons are not a Button / IconButton / Chip. */
const EXCEPTIONS = {
  // A whole row or card is the click target (its own geometry, several lines of content inside).
  'review/QuestionRun.jsx': 'option cards, grade scale cells and prerequisite rows: card-sized targets',
  'Exam.jsx': 'exam option card', 'FlipCard.jsx': 'the whole card face is the flip control', 'ReviewNavigator.jsx': 'numbered dots of the question rail',
  'Sources.jsx': 'row title and group header: row-sized targets', 'WrongBook.jsx': 'group header, row and recommendation toggles (one FoldButton): row-sized',
  'BlogNotes.jsx': 'note list rows', 'CourseSettings.jsx': 'course row toggle', 'document-preview/DocumentViewer.jsx': 'reader scrim and pager links',
  'host/workspace.jsx': 'candidate list rows in DSH\'s own sidebar', 'study-map/DeckRow.jsx': 'tree rows and play marks', 'study-map/DeckTree.jsx': 'tree rows',
  'study-map/DeskIntro.jsx': 'resume row', 'study-map/HomeActivity.jsx': 'draft row', 'study-map/NotebookDirectory.jsx': 'notebook rows',
  'board/Card.jsx': 'card title, tick box and meta links on a board card', 'board/CardEditor.jsx': 'label chips with hue, checklist ticks, meta links',
  'board/FilterBar.jsx': 'label filter chips with a hue per label',
  'document-preview/reader/OutlinePanel.jsx': 'outline rows', 'document-preview/reader/ReadingSections.jsx': 'the inline figure peek mark',
  'document-preview/peek/PagePeekView.jsx': 'resize grips (pointer-drag handles)', 'document-preview/translation/TranslationMenu.jsx': 'the floating selection chip button',
  'StudyImage.jsx': 'the image itself opens the zoom',
  // Custom geometry or semantics a Button does not model.
  'CaseWorkspace.jsx': 'pen toggle, highlight swatches and the paper write rows',
  'CourseActive.jsx': 'role=switch', 'CourseField.jsx': 'course picks (hue, parked state, group counts)', 'Skeleton.jsx': 'node rows, tabs of the canvas and chapter picks',
  'SkeletonCanvas.jsx': 'canvas nodes and the minimap', 'ThumbFeedback.jsx': 'the two 17px thumb icon buttons of the question toolbar',
  'UpdateCenter.jsx': 'the update status chip (state-coloured pill)',
  'WorkflowPortal.jsx': 'route link (wf-route-link)',
  // The navigation system itself.
  'SideNav.jsx': 'the nav rows', 'Settings.jsx': 'settings category rows', 'Inbox.jsx': 'mailbox rows',
};

test('every file that still has a raw <button> is on the documented list, and no file holds more than the baseline says (#135)', () => {
  const unlisted = Object.keys(baseline).filter((file) => !EXCEPTIONS[file.replace(/^ui\//, '')]);
  assert.deepEqual(unlisted, [], 'document why these cannot be a Button, or convert them');
  const stale = Object.keys(EXCEPTIONS).filter((file) => !baseline[`ui/${file}`]);
  assert.deepEqual(stale, [], 'these files have no raw <button> any more: delete their exception line');
  for (const [file, count] of Object.entries(baseline)) assert.equal((readFileSync(file, 'utf8').match(/<button\b/g) || []).length, count, `${file}: the baseline counts the real number`);
});

test('the converted surfaces have no raw <button> left: coach debrief, generate assist, review toolbar, catalog toolbar (#135)', async () => {
  for (const file of ['ui/CoachDebrief.jsx', 'ui/GenerateAssist.jsx', 'ui/ReviewToolbar.jsx', 'ui/study-map/CatalogToolbar.jsx']) assert.doesNotMatch(readFileSync(file, 'utf8'), /<button\b/, file);
  assert.match(readFileSync('ui/Skeleton.jsx', 'utf8'), /<Chip /);

  const ui = await loadInteractiveUi(`
    export { default as ThumbFeedback } from './ui/ThumbFeedback.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    ui.exports.setUiLanguage('zh');
    const services = { call: async () => ({ tags: [], scheduled: [] }), act: async () => undefined, busy: false, notify: () => {}, openModal: () => {} };
    const run = { id: 'r1', deckId: 'd1', card: { id: 'c1', prompt: 'Explain entropy.' } };
    const mounted = ui.mount(() => ui.React.createElement(
      ui.exports.StudyServicesContext.Provider,
      { value: services },
      ui.React.createElement(ui.exports.ThumbFeedback, { run, canShortcut: () => true }),
    ));
    try {
      const downBtn = mounted.find((n) => n.type === 'button' && n.props?.['aria-label'] === '这题有问题');
      assert.ok(downBtn, 'thumbs-down button renders');
      await mounted.act(() => click(downBtn));
      await mounted.flush();

      const tray = mounted.find((n) => n.props?.className === 'thumb-tray');
      assert.ok(tray, 'clicking thumbs-down opens .thumb-tray');

      const chipWrappers = mounted.findAll((n) => typeof n.props?.className === 'string' && n.props.className.split(/\s+/).includes('sh-chip'), tray);
      assert.equal(chipWrappers.length, 7, 'all 7 feedback tags render as <Chip>');

      const chipButtons = chipWrappers.map((chip) => mounted.find((n) => n.type === 'button' && n.props?.className === 'sh-chip__main', chip));
      assert.equal(chipButtons.filter(Boolean).length, 7, 'each <Chip> renders its .sh-chip__main toggle button');
      for (const btn of chipButtons) assert.equal(btn.props['aria-pressed'], false, 'tags start unpressed');

      await mounted.act(() => click(chipButtons[0]));
      const updatedTray = mounted.find((n) => n.props?.className === 'thumb-tray');
      const updatedFirstBtn = mounted.find((n) => n.type === 'button' && n.props?.className === 'sh-chip__main', updatedTray);
      assert.equal(updatedFirstBtn.props['aria-pressed'], true, 'clicking a tag chip toggles aria-pressed="true"');

      const coachChips = mounted.findAll((n) => typeof n.props?.className === 'string' && n.props.className.includes('coach-chip'));
      assert.equal(coachChips.length, 0, 'zero elements carry legacy coach-chip class');
    } finally {
      mounted.unmount();
      ui.exports.setUiLanguage('zh');
    }
  });
});

test('the chip classes that nothing uses any more are gone from the stylesheets (#135)', () => {
  for (const file of ['ui/coach.css', 'ui/generate-form.css', 'ui/study-map/catalog.css', 'ui/skeleton.css']) {
    const css = readFileSync(file, 'utf8');
    assert.doesNotMatch(css, /\.coach-chip|\.generate-chip\b|\n\s*\.chip\b|sk-filter\b(?!s)/, file);
  }
});

const require = createRequire(import.meta.url);
const compiled = await build({ stdin: { contents: `export { Chip } from './ui/components/index.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, module, module.exports);

test('Chip can be disabled: its button is, and it stays a pressed toggle (#135)', () => {
  const html = renderToStaticMarkup(React.createElement(module.exports.Chip, { selected: true, disabled: true, onClick() {} }, 'tag'));
  assert.match(html, /<button[^>]*aria-pressed="true"[^>]*disabled=""|<button[^>]*disabled=""[^>]*aria-pressed="true"/);
});
