import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

const h = React.createElement;
const noop = () => {};

const m = await loadUi(`
  export { setUiLanguage } from './ui/i18n.js';
  export { createDesktopConfigActions } from './ui/desktop/DesktopModelSetup.jsx';
  export { default as DesktopOpenAiForm } from './ui/desktop/DesktopOpenAiForm.jsx';
  export { default as ExtensionPanel, resetExtensionInstallStore } from './ui/ExtensionPanel.jsx';
  export { bez, layoutPath, pathPrereqPath } from './ui/graph-layout.js';
  export { sketchOrderCurve, sketchCubicPath } from './ui/graph-sketch/graph-sketch.js';
  export { StudyServicesContext } from './ui/study-context.jsx';
`);

const withServices = (node, services = {}) => h(m.StudyServicesContext.Provider, {
  value: {
    call: async () => ({}),
    act: async () => undefined,
    busy: false,
    notify: noop,
    askInChat: noop,
    host: {},
    openSettings: noop,
    navigate: noop,
    openModal: noop,
    ...services,
  },
}, node);

/* ---------- W1-09: Desktop API Key single error & single primary CTA ---------- */

test('W1-09: createDesktopConfigActions avoids duplicate parent error on saveOpenAi, handles endpoint save cleanly, and DesktopOpenAiForm never renders dual primary buttons', async () => {
  m.setUiLanguage('zh');
  let parentError = 'stale error';
  const actions = m.createDesktopConfigActions({
    call: async (op) => {
      if (op === 'desktop.config.save') throw new Error('Invalid API key');
      return { ok: true };
    },
    refresh: async () => {},
    setConfig: noop,
    setError: (msg) => { parentError = msg; },
    setWorking: noop,
  });

  // saveOpenAi (SecretKeyForm path): clears parent error and rethrows without setting duplicate parent error
  await assert.rejects(() => actions.saveOpenAi({ apiKey: 'bad' }), /Invalid API key/);
  assert.equal(parentError, '', 'SecretKeyForm owns saveOpenAi error; parent error stays cleared');

  // saveOpenAiEndpoint: catches error into parentError without unhandled rejection
  const endpointRes = await actions.saveOpenAiEndpoint({ baseUrl: 'bad', model: 'm' });
  assert.equal(endpointRes, null);
  assert.match(parentError, /Invalid API key/);

  // testOpenAi clears stale parent error
  await actions.testOpenAi({});
  assert.equal(parentError, '', 'testOpenAi clears stale parent error');

  // DesktopOpenAiForm: when endpoint save action is shown (hasKey && !active), SecretKeyForm demotes to secondary -> single primary button
  const html = renderToStaticMarkup(h(m.DesktopOpenAiForm, {
    openai: { hasKey: true, baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyLast4: '1234' },
    active: false,
    actions,
    working: '',
  }));
  const primaries = html.match(/sh-btn--primary/g) || [];
  assert.equal(primaries.length, 1, `expected single primary CTA when switching provider/mode, got ${primaries.length}`);
});

/* ---------- W1-13: ExtensionPanel shared single-flight store & single primary button ---------- */

test('W1-13: ExtensionPanel demotes IndexBuilder when outdated update primary is shown and shares install state across mounts', async () => {
  m.setUiLanguage('zh');
  m.resetExtensionInstallStore();
  const status = {
    extension: { installed: true, outdated: true, canInstall: true, version: '0.1.0', expected: '0.2.0', desktopHost: true },
    companion: { running: true },
  };
  const html = renderToStaticMarkup(withServices(h(m.ExtensionPanel, {
    status,
    courses: [{ name: 'OS' }],
    initialPlan: { course: 'OS', pages: 10, toIndex: 10, toRemove: 0, canIndex: true },
  })));
  const primaries = html.match(/sh-btn--primary/g) || [];
  assert.equal(primaries.length, 1, `expected single primary CTA (update notice only, IndexBuilder demoted), got ${primaries.length}`);

  const src = await readFile(new URL('../ui/ExtensionPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /useSyncExternalStore\(subscribeInstall, getInstallState/, 'shares install state in module-level external store');
  assert.match(src, /if \(installInFlight\) return installInFlight/, 'dedupes concurrent install requests');
});

/* ---------- W1-21: MineruInstallCard chooseHere echoes folder/blocking & aria-disabled CSS flat ---------- */

test('W1-21: MineruInstallCard chooseHere renders folder & blocking error, and components.css unifies aria-disabled without hover lift', async () => {
  const mineruSrc = await readFile(new URL('../ui/MineruInstallCard.jsx', import.meta.url), 'utf8');
  const chooseHereBlock = mineruSrc.slice(mineruSrc.indexOf('const chooseHere'), mineruSrc.indexOf('const unfinishedTier'));
  assert.match(chooseHereBlock, /mineru-install__where/, 'chooseHere echoes selected folder');
  assert.match(chooseHereBlock, /blocking && <InlineMessage tone="error"/, 'chooseHere displays blocking InlineMessage error');
  assert.match(chooseHereBlock, /mineru-install__facts/, 'chooseHere displays disk space / facts');

  const compCss = await readFile(new URL('../ui/components/components.css', import.meta.url), 'utf8');
  assert.match(compCss, /\.sh-btn:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(compCss, /\.sh-btn--primary:hover:not\(:disabled\):not\(\[aria-disabled="true"\]\)/);
  assert.match(compCss, /\.sh-btn--primary\[aria-disabled="true"\]/);
  const overlaysCss = await readFile(new URL('../ui/components/overlays.css', import.meta.url), 'utf8');
  assert.doesNotMatch(overlaysCss, /\.sh-btn\[aria-disabled="true"\]/, 'duplicate aria-disabled style removed from overlays.css');
});

/* ---------- W1-22: Graph mastery mode demotes FullscreenButton & locks practiseOutlineKeys ---------- */

test('W1-22: Graph demotes FullscreenButton in mastery mode and guards practiseOutlineKeys with single-flight ref + local practising prop', async () => {
  const graphSrc = await readFile(new URL('../ui/Graph.jsx', import.meta.url), 'utf8');
  assert.match(graphSrc, /variant=\{fullscreen\.full \|\| isMastery \? "secondary" : "primary"\}/);
  assert.match(graphSrc, /practisingRef\.current/);
  assert.match(graphSrc, /practising=\{practising\}/);
  const mmSrc = await readFile(new URL('../ui/mastery-map/MasteryMap.jsx', import.meta.url), 'utf8');
  assert.match(mmSrc, /const busy = studyBusy \|\| practising;/);
});

/* ---------- W1-33: Serpentine even-row arrows point left & same-row prereqs arch cleanly ---------- */

test('W1-33: layoutPath even-row curves travel right-to-left inside the gap and pathPrereqPath avoids cutting across cards', () => {
  const nodes = Array.from({ length: 12 }, (_, i) => ({ id: `c:${i + 1}`, label: `Q${i + 1}` }));
  const layout = m.layoutPath(nodes, [], 6);
  // Node index 6 (step 7, row 1 col 5) -> index 7 (step 8, row 1 col 4): right-to-left on even row (0-indexed row 1)
  const a = layout.placed[6];
  const b = layout.placed[7];
  assert.ok(a.x > b.x, 'even row steps go right to left');
  const d = layout.orderPaths[6];
  const match = /^M\s*([-\d.]+)\s+([-\d.]+)\s+C\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)$/.exec(d);
  assert.ok(match, `expected cubic bezier path, got: ${d}`);
  const [, x1, , cx1, , cx2, , x2] = match.map(Number);
  assert.equal(x1, a.x, 'starts at left edge of right card');
  assert.equal(x2, b.x + b.w, 'ends at right edge of left card');
  assert.ok(cx1 < x1, `first control point (${cx1}) must head left from x1 (${x1}), not fold back into card a`);
  assert.ok(cx2 > x2, `second control point (${cx2}) must approach x2 (${x2}) from the right so arrow tangent points LEFT`);

  // Same-row prereq skipping intermediate cards (step 7 col 5 -> step 10 col 2) arches cleanly above the row
  const farLeft = layout.placed[9];
  const prereqD = m.pathPrereqPath(a, farLeft);
  const pm = /^M\s*([-\d.]+)\s+([-\d.]+)\s+C\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+),\s*([-\d.]+)\s+([-\d.]+)$/.exec(prereqD);
  assert.ok(pm, `expected cubic arch for skipping same-row prereq, got: ${prereqD}`);
  const [, px1, py1, , pcy1, , pcy2, px2, py2] = pm.map(Number);
  assert.equal(py1, a.y - a.h / 2, 'leaves top edge of card');
  assert.equal(py2, farLeft.y - farLeft.h / 2, 'arrives at top edge of target card');
  assert.ok(pcy1 < py1 && pcy2 < py2, 'arches above the row rather than cutting across intermediate cards');
  assert.ok(pcy1 >= 0 && pcy2 >= 0, 'stays inside SVG top canvas bounds');
  assert.ok(px1 > px2);

  // Structure-mode default bez(x1, y1, x2, y2) with x2 < x1 preserves dir = +1 (right-out, left-in)
  const structD = m.bez(300, 100, 100, 200);
  assert.match(structD, /^M 300 100 C 390 100, 10 200, 100 200$/, 'default bez keeps right-out left-in for structure vertical prereqs');
});

/* ---------- W1-12: wrongbook.css narrow container rules use :is() specificity ---------- */

test('W1-12: wrongbook.css narrow viewport rules use :is(.study-app, .study-seat) instead of zero-specificity :where()', async () => {
  const css = await readFile(new URL('../ui/wrongbook.css', import.meta.url), 'utf8');
  const narrowSection = css.slice(css.indexOf('@container study (max-width: 640px)'));
  assert.doesNotMatch(narrowSection, /:where\(\.study-app, \.study-seat\)/, 'must not use zero-specificity :where() in narrow container block');
  assert.match(narrowSection, /\.wb-retrain-copy small \{ white-space: normal; \}/);
  assert.match(narrowSection, /\.wb-rec-line \.wb-why \{/);
  assert.match(narrowSection, /\.wb-rec-line \.wb-why-tip \{ flex: 1 1 100%; \}/);
  assert.match(narrowSection, /\.wb-row-toggle \{ flex-wrap: wrap; align-items: center; \}/);
});
