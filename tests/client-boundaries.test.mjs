import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import vm from 'node:vm';
import React from 'react';
import ReactDOM from 'react-dom';
import { renderToStaticMarkup } from 'react-dom/server';

const packageId = '@ericwang1358/dsh-daily-flashcard';

// Portable harness for the official DSH 0.2.0-rc.1 classic chunk contract.
// Separately verified 2026-10-01 against the actual ClientModuleSystem at
// D:/Program Files/nodejs/node_global/node_modules/@deepseek-ai/dsh/node_modules/
// @deepseek-ai/dsh-client-modules/lib/client.js: native activation and all seven
// real lazy importers materialized through 24 revisioned module arrivals.
// index.js serves sibling client.*.js; client.js invalidates their factories,
// caches and stylesheet ownership with the parent plugin, not another plugin.

test('generated native modules resolve through classic chunk factories and share host React', async () => {
  const { buildHostClient, buildPreview } = await import('../scripts/build.mjs');
  assert.equal(typeof buildHostClient, 'function');
  assert.equal(typeof buildPreview, 'function');
  const result = await buildHostClient({ write: false });
  const files = new Map(result.outputFiles.map(file => [basename(file.path), file.text]));
  assert.ok(files.size > 5, 'features and shared dependencies must be separate emitted modules');
  assert.ok(files.has('client.js'));
  for (const name of files.keys()) assert.match(name, /^client(?:\.[A-Za-z0-9][A-Za-z0-9._-]*)?\.js$/);
  assert.ok(!Object.keys(result.metafile.inputs).some(path => /node_modules[\\/]react(?:-dom)?[\\/]/.test(path)),
    'native modules must never contain a React or React DOM implementation: the host supplies both');

  const factories = new Map(), cache = new Map(), arrivals = [], materialized = [], lazyLoads = [];
  let captureEffects = null;
  const hostReact = new Proxy(React, { get(target, key) {
    if (key === 'lazy') return load => { lazyLoads.push(load); return target.lazy(load); };
    if (key === 'useEffect' && captureEffects) return fn => { captureEffects.push(fn); };
    return Reflect.get(target, key);
  } });
  const slots = [], styles = [], effects = [];
  const browser = { addEventListener() {}, removeEventListener() {},
    document: { compatMode: 'CSS1Compat', documentElement: { style: {} },
      createElement: () => ({ style: {}, remove() {} }), head: { append: node => styles.push(node), appendChild: node => styles.push(node) } } };
  const context = vm.createContext({ window: browser, document: browser.document, console, TextDecoder, TextEncoder, URL,
    navigator: { platform: 'Win32', userAgent: 'test' },
    setTimeout, clearTimeout, setInterval: () => 1, clearInterval() {} });
  browser.__ModuleLoader__ = { load({ id, chunk, factory }) {
    assert.equal(id, packageId);
    const key = chunk ? `${id}/${chunk}` : id;
    assert.equal(factories.has(key), false, 'a module must register once');
    factories.set(key, factory);
  } };
  async function asyncModule(spec) {
    assert.match(spec, /^\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/);
    const name = spec.slice(2), key = `${packageId}/${name}`;
    if (!factories.has(key)) {
      assert.ok(files.has(name), `missing emitted chunk ${name}`);
      arrivals.push(name);
      vm.runInContext(files.get(name), context, { filename: name });
    }
    return materialize(key);
  }
  function materialize(id) {
    if (id === 'react') return hostReact;
    if (id === 'react-dom') return ReactDOM;
    if (cache.has(id)) return cache.get(id);
    assert.ok(factories.has(id), `missing registered module ${id}`);
    const require = spec => materialize(spec);
    require.async = asyncModule;
    const exports = factories.get(id)(require);
    cache.set(id, exports); materialized.push(id);
    return exports;
  }
  vm.runInContext(files.get('client.js'), context, { filename: 'client.js' });
  assert.equal(factories.size, 1, 'arrival only registers the entry factory');
  assert.equal(styles.length, 0);
  const entry = materialize(packageId);
  assert.deepEqual([...entry.inject], ['slots', 'locale']);
  assert.equal(arrivals.length, 0, 'entry materialization does not fetch optional features');
  const ctx = {
    get: () => undefined,
    effect(fn, label) { effects.push(label); fn(); },
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (_name, fn) => fn(), register: (descriptor, component) => { slots.push({ descriptor, component }); return () => {}; } },
    sidebarRightTabs: { register: () => () => {} },
    documentPreviews: { register: () => () => {} },
    inject: (_services, fn) => fn(ctx),
  };
  await entry.apply(ctx);
  assert.equal(arrivals.length, 0, 'host activation registers slots without fetching optional UI chunks (#630)');
  for (const id of ['study-workspace', 'study-selection-learning'])
    assert.ok(slots.some(slot => slot.descriptor.id === id), `missing native slot ${id}`);
  assert.ok(slots.some(slot => slot.descriptor.key === 'study-html'), 'native selection preview must remain registered');
  const workspaceEntry = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === 'ui/host/workspace.jsx');
  const nativeEntry = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === 'ui/document-preview/native.jsx');
  assert.ok(workspaceEntry && nativeEntry, 'workspace and document-preview surfaces keep their lazy entry boundaries');
  captureEffects = [];
  renderToStaticMarkup(React.createElement(slots.find(slot => slot.descriptor.id === 'study-workspace').component, { sessionId: 's', openView() {} }));
  renderToStaticMarkup(React.createElement(slots.find(slot => slot.descriptor.key === 'study-html').component, {
    content: { kind: 'text', text: '<p>Notes</p>' }, resourceAddress: 'dsh-resource://file/session/s/D:/notes.html', sessionId: 's',
  }));
  const mountEffects = captureEffects;
  captureEffects = null;
  for (const runEffect of mountEffects) runEffect();
  for (let tick = 0; tick < 40 && !(effects.includes('study conversation panel bridge') && effects.includes('study document learning styles')); tick++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.ok(effects.includes('study conversation panel bridge'));
  assert.ok(effects.includes('study document learning styles'));
  const loadedAtBoot = [...materialized];
  const mathEntry = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === 'ui/study-math-render.js');
  assert.ok(mathEntry, 'formulas must keep their own optional renderer boundary');
  const mathName = basename(mathEntry[0]);
  assert.ok(!loadedAtBoot.includes(`${packageId}/${mathName}`), 'the formula renderer must stay optional at host activation');
  const featureInputs = ['ui/BlogNotes.jsx', 'ui/Skeleton.jsx', 'ui/Workflows.jsx'];
  for (const input of featureInputs) {
    const output = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === input);
    assert.ok(output, `missing optional module boundary for ${input}`);
    const name = basename(output[0]);
    assert.ok(!loadedAtBoot.includes(`${packageId}/${name}`), `${input} must stay optional at host activation`);
  }
  // Execute the real React.lazy importers, including editor libraries.
  // A missing shared registration, or an incorrect async load order, fails here.
  for (const [, output] of Object.entries(result.metafile.outputs)) {
    for (const edge of output.imports.filter(edge => edge.kind === 'dynamic-import')) {
      assert.ok(files.has(basename(edge.path)));
    }
  }
  const notesEntry = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === 'ui/BlogNotes.jsx');
  assert.ok(notesEntry);
  const settingsPanes = (await readFile('ui/settings-groups.js', 'utf8')).match(/^  category\(\{ id:/gm).length;
  assert.equal(lazyLoads.length, 28 + settingsPanes, 'the sixteen views (notes, skeleton, workflows, graph, audio usage, reader, live class, tasks, guided study, statistics, mock exam, exam prep, exam coach, outline, review book, board; the review-book editor loads inside the review book), 看原页 (pdf.js), the Select and Combobox popups (Base UI), the audio setup guide of the voice button, the depth and cost matrix in the more options of 创建题组 and the line of rough costs beside its presets (both ui/presets/PresetsFold.jsx), 知识点查缺 on the draft page (ui/coverage/PointGaps.jsx), the local PDF converter of 添加资料 and of the large-document card (ui/PdfConversion.jsx), the PDF conversion cards and history on 资料 (ui/PdfConvertJob.jsx, which in turn lazy-loads ui/PdfExternalConvertGuide.jsx), the post-answer learning loop panels (SimilarTry and RetellPanel), 找功能 (the sheet and its index, ui/finder/FinderSheet.jsx) and one pane per settings category');
  // A lazily loaded view may declare its own (the review-book editor inside the review book): load until no new boundary appears.
  for (let loaded = 0; loaded < lazyLoads.length;) { const batch = lazyLoads.slice(loaded); loaded = lazyLoads.length; await Promise.all(batch.map(load => load())); }
  // 看原页 asks pdf.js's wasm decoders, CMaps and fonts from its own lazily loaded chunks (assets/*.js); load each the way the peek does.
  const assetOutputs = Object.entries(result.metafile.outputs).filter(([, record]) => Object.keys(record.inputs).some(path => /document-preview[/]peek[/]assets[/]/.test(path)));
  assert.equal(assetOutputs.length, 7, 'jbig2, openjpeg, the standard fonts and the CMaps of four scripts');
  for (const [path] of assetOutputs) {
    const asset = await asyncModule(`./${basename(path)}`);
    assert.ok(typeof asset.default === 'string' ? asset.default.length > 1000 : Object.keys(asset.default).length > 0, `${basename(path)} carries its data`);
  }
  // The bundled Inter (ui/fonts/inter-face.js) is a data: URI in a chunk of its own, reached by a dynamic import when StudyHub opens;
  // load it the way the installer does and check it carries the woff2.
  const fontOutput = Object.entries(result.metafile.outputs).find(([, record]) => Object.keys(record.inputs).some(path => /ui[/]fonts[/]inter-data\.js$/.test(path)));
  assert.ok(fontOutput, 'the font has a chunk of its own');
  assert.ok(Object.entries(result.metafile.outputs).some(([, record]) => record.imports.some(edge => edge.kind === 'dynamic-import' && basename(edge.path) === basename(fontOutput[0]))), 'only a dynamic import reaches it');
  assert.match((await asyncModule(`./${basename(fontOutput[0])}`)).default, /^data:font\/woff2;base64,d09GMg/, 'the chunk carries the woff2');
  // The formula fonts (#996) likewise: a chunk of their own, reached only by the dynamic import in ui/study-math-render.js at the first formula,
  // so a view that only might show a formula (the book, the reader, workflows, notes) never fetches them.
  const mathFonts = Object.entries(result.metafile.outputs).find(([, record]) => Object.keys(record.inputs).some(path => /ui[/]fonts[/]math-data\.js$/.test(path)));
  assert.ok(mathFonts, 'the formula fonts have a chunk of their own');
  assert.ok(!Object.keys(mathEntry[1].inputs).some(path => /ui[/]fonts[/]math-data\.js$/.test(path)), 'not inside the renderer');
  assert.ok(Object.values(result.metafile.outputs).every(record => !record.imports.some(edge => edge.kind !== 'dynamic-import' && basename(edge.path) === basename(mathFonts[0]))),
    'only a dynamic import reaches it');
  assert.match((await asyncModule(`./${basename(mathFonts[0])}`)).default, /@font-face\{font-family:KaTeX_[\s\S]*data:font\/woff2;base64,d09GMg/, 'the chunk carries the fonts');
  // Sound-effect MP3 assets (ui/sound-effects-assets.js) are also split into their own lazily loaded chunk, reached only via dynamic import when sound plays.
  const soundAssets = Object.entries(result.metafile.outputs).find(([, record]) => Object.keys(record.inputs).some(path => /ui[/]sound-effects-assets\.js$/.test(path)));
  assert.ok(soundAssets, 'the sound-effect assets have a chunk of their own');
  assert.ok(!loadedAtBoot.includes(`${packageId}/${basename(soundAssets[0])}`), 'sound-effect assets stay optional at host activation');
  assert.ok(Object.values(result.metafile.outputs).every(record => !record.imports.some(edge => edge.kind !== 'dynamic-import' && basename(edge.path) === basename(soundAssets[0]))),
    'only a dynamic import reaches sound-effect assets');
  const loadedSoundAssets = await asyncModule(`./${basename(soundAssets[0])}`);
  assert.ok(Object.keys(loadedSoundAssets.BAKED_SAMPLE_DATA_URIS || {}).length > 0, 'the sound-effect chunk carries its audio assets');
  // StudyMath imports from its effect rather than React.lazy. Exercise that
  // package-local factory path and its shared engine before counting modules.
  const math = await asyncModule(`./${mathName}`);
  assert.match(math.renderStudyFormula(String.raw`\frac{1}{2} + x_i^2`, true), /<math[\s>]/);
  const reaction = math.renderStudyFormula(String.raw`\ce{2H2(g) + O2(g) -> 2H2O(l)}`, true);
  assert.match(reaction, /<math[\s>]/);
  assert.match(reaction, /<msub>/, 'native chemistry must use the registered mhchem engine');
  // StudyDiagram mirrors StudyMath: dynamic import inside its effect keeps the diagram renderer out of boot and workspace closures.
  const diagramEntry = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === 'ui/study-diagram-render.js');
  assert.ok(diagramEntry, 'inline diagrams must keep their own optional renderer boundary');
  const diagramName = basename(diagramEntry[0]);
  assert.ok(!loadedAtBoot.includes(`${packageId}/${diagramName}`), 'the diagram renderer must stay optional at host activation');
  const diagramMod = await asyncModule(`./${diagramName}`);
  assert.match(diagramMod.renderStudyDiagram('flowchart LR\n  A[Start] --> B[End]').svg, /<svg[\s>]/);
  for (const [input, verify] of [
    ['lib/chemistry-balance.js', module => assert.equal(module.balanceEquation('H2 + O2 -> H2O').equation, '2 H2 + O2 -> 2 H2O')],
    ['lib/symbolic-proof.js', module => assert.equal(module.proveIdentity('(x+1)^2', 'x^2+2*x+1').status, 'proved')],
  ]) {
    const output = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === input);
    assert.ok(output, `missing optional local tool boundary for ${input}`);
    const name = basename(output[0]);
    assert.ok(!loadedAtBoot.includes(`${packageId}/${name}`), `${input} stays optional at activation`);
    verify(await asyncModule(`./${name}`));
  }
  // Optional artistic/tactile libraries load on demand via dynamic import() only when the learner opens the
  // sketchy graph/tide, editorial marks, or milestone celebrations — never at host activation.
  for (const [label, pattern, verify] of [
    ['rough-notation', /node_modules[/\\]rough-notation[/\\]/, module => assert.equal(typeof module.annotate, 'function')],
    ['canvas-confetti', /node_modules[/\\]canvas-confetti[/\\]/, module => assert.equal(typeof (module.default ?? module), 'function')],
    ['roughjs', /node_modules[/\\]roughjs[/\\]/, module => assert.equal(typeof (module.default?.generator ?? module.generator), 'function')],
  ]) {
    const output = Object.entries(result.metafile.outputs).find(([, record]) => Object.keys(record.inputs).some(path => pattern.test(path)));
    assert.ok(output, `missing optional chunk boundary for ${label}`);
    const name = basename(output[0]);
    assert.ok(!loadedAtBoot.includes(`${packageId}/${name}`), `${label} stays optional at host activation`);
    assert.ok(Object.values(result.metafile.outputs).every(record => !record.imports.some(edge => edge.kind !== 'dynamic-import' && basename(edge.path) === name)),
      `only a dynamic import reaches ${label}`);
    verify(await asyncModule(`./${name}`));
  }
  // Optional Wave 1 & Wave 2 artistic UI panels/dialogs also load on demand via runtime dynamic import() (outside React.lazy)
  // so they stay out of the workspace first-load closure; materialize their static dependency graph first as loadExpression does.
  const outputByName = new Map(Object.entries(result.metafile.outputs).map(([path, record]) => [basename(path), record]));
  async function loadDynamicBoundary(name, visiting = new Set()) {
    if (visiting.has(name)) return asyncModule(`./${name}`);
    visiting.add(name);
    const deps = (outputByName.get(name)?.imports || [])
      .filter(edge => !edge.external && edge.kind === 'import-statement')
      .map(edge => basename(edge.path));
    for (const dep of deps) await loadDynamicBoundary(dep, visiting);
    return asyncModule(`./${name}`);
  }
  for (const [entryPoint, verify] of [
    ['ui/desk-atelier/DeskAtelierPanel.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/desk-atelier/DeskChimeDialog.jsx', module => assert.equal(typeof module.default, 'function')],
    // 极简模式 stops a playing soundscape through a dynamic import of the engine (ui/desk-atelier/DeskAtelierButton.jsx).
    ['ui/desk-atelier/soundscape-engine.js', module => {
      assert.equal(typeof module.startSoundscape, 'function');
      assert.equal(typeof module.stopSoundscape, 'function');
      assert.equal(typeof module.toggleSoundscape, 'function');
    }],
    ['ui/desk-atelier/soundscape-assets.js', module => {
      assert.equal(Object.keys(module.SOUNDSCAPE_DATA_URIS || {}).length, 5, 'all 5 CC0 ambient channels are present');
      assert.equal(Object.keys(module.SOUNDSCAPE_CHANNEL_GAINS || {}).length, 5, 'all 5 ambient channel gains are present');
    }],
    ['ui/seal-press/seal-press-runtime.js', module => {
      assert.equal(typeof module.FlowSealCue, 'function');
      assert.equal(typeof module.RoundSealSection, 'function');
    }],
    ['ui/seal-press/PostcardStudioDialog.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/seal-press/SealAlbumDialog.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/seal-press/WrongBookClearStamp.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/desk-play/DeskPlayStrip.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/letterpress/letterpress-runtime.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/review/ReviewFocusPill.jsx', module => assert.equal(typeof module.default, 'function')],
    ['ui/review/SocraticInlineDrawer.jsx', module => assert.equal(typeof (module.default?.type ?? module.default), 'function')],
  ]) {
    const output = Object.entries(result.metafile.outputs).find(([, record]) => record.entryPoint === entryPoint);
    assert.ok(output, `missing optional UI boundary for ${entryPoint}`);
    const name = basename(output[0]);
    assert.ok(!loadedAtBoot.includes(`${packageId}/${name}`), `${entryPoint} stays optional at host activation`);
    assert.ok(Object.values(result.metafile.outputs).every(record => !record.imports.some(edge => edge.kind !== 'dynamic-import' && basename(edge.path) === name)),
      `only a dynamic import reaches ${entryPoint}`);
    verify(await loadDynamicBoundary(name));
  }
  assert.equal(cache.size, files.size, 'every emitted module can materialize');
  const notes = cache.get(`${packageId}/${basename(notesEntry[0])}`);
  assert.equal(React.isValidElement(React.createElement(notes.default, {})), true);
  const native = slots.find(slot => slot.descriptor.id === 'study-selection-learning');
  assert.equal(renderToStaticMarkup(React.createElement(native.component, { sessionId: 's', absolutePath: 'D:/notes.html' })), '');
  const preview = await buildPreview({ write: false });
  assert.deepEqual(preview.outputFiles.map(file => basename(file.path)).sort(), ['app.css', 'app.js'],
    'the existing local preview server must still serve every preview asset');
  assert.doesNotMatch(preview.outputFiles.find(file => basename(file.path) === 'app.js').text, /require\.async\(/);
});
