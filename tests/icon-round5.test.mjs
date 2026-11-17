import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { uiSources } from './helpers/icon-stand-ins.mjs';
import { GO_ON_WORDS, actionProblems, buttonElements, goOnProblems, inPlaceWhy, labelHelpers, labelsOf, specProblems, varsOf } from './helpers/go-on.mjs';

/* #1073 / #1074, round 5 of the review of PR #1118: the arrow rule is decided by what a control does, in one place (tests/helpers/go-on.mjs), so a label
   that is not led by 去 / 练 / 继续 / 开始 / 接着 can no longer slip through; plus the wording the review found. */

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const locale = async (name) => JSON.parse(await read(`ui/locales/${name}`));

/* ---- 1: the arrow rule, by what the control does ----------------------------------------------------------------------------------------------------------------- */

test('1: the words of going somewhere are one list: 去 / 练 / 继续 / 开始 / 接着, and 前往 / 打开 (前往设置, 打开资料 …)', () => {
  assert.deepEqual(GO_ON_WORDS, ['去', '练', '继续', '开始', '接着', '前往', '打开']);
});

test('1: a navigating label that is not led by a go-on verb (前往设置, 打开资料) needs the arrow like any other control that takes the learner somewhere', () => {
  assert.equal(goOnProblems('<Button variant="link" size="sm" onClick={onSettings}>{ui("前往设置")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button variant="link" size="sm" iconEnd="arrow-right" onClick={onSettings}>{ui("前往设置")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button variant="link" size="sm" onClick={onSources}>{ui(\'打开资料\')}</Button>').length, 1);
  assert.equal(goOnProblems('<Button variant="link" onClick={() => settingsFor(\'settings-mineru\')}>{ui(\'前往设置\')}</Button>').length, 1);
  assert.equal(goOnProblems('<Button icon="plug" onClick={() => host.openPluginManager()}>{ui(\'打开 DSH 插件管理器\')}</Button>').length, 0, 'a Button with its own leading icon takes no arrow');
});

test('1: what the control does decides, not its words: a control that only sets state on this page (a dialog, a fold) acts in place, so it has no arrow whatever it says', () => {
  assert.match(inPlaceWhy('<Button onClick={() => setEditing(true)}>'), /state/);
  assert.match(inPlaceWhy('<Button onClick={() => setOpen((open) => !open)}>'), /state/);
  assert.equal(inPlaceWhy('<Button onClick={() => onOpenSettings(\'settings-marker\')}>'), '', 'a call of a prop leaves the page');
  assert.equal(inPlaceWhy('<Button onClick={() => nav.navigate(\'settings\')}>'), '');
  assert.equal(inPlaceWhy('<Button onClick={() => host.setModal({ type: \'add\' })}>'), '', 'a dotted call is not a local setter');
  assert.equal(goOnProblems('<Button onClick={() => setOpened(row)}>{ui("打开")}</Button>').length, 0);
  assert.equal(goOnProblems('<Button iconEnd="arrow-right" onClick={() => setOpened(row)}>{ui("打开")}</Button>').length, 1);
  assert.equal(goOnProblems('<Button iconEnd="arrow-right" onClick={() => setEditing(true)}>{ui("修改并导入")}</Button>').length, 1, '修改并导入 opens a dialog in place: no arrow, whatever its words');
  assert.equal(goOnProblems('<Button onClick={() => setEditing(true)}>{ui("修改并导入")}</Button>').length, 0);
});

test('1: the job card\'s action spec decides the same way: a run that only sets state here (修改并导入 opens a dialog) is `here`, so the card draws no arrow', () => {
  assert.equal(specProblems("const primary = { label: HELD_ENTRY(), run: () => setEditing(true) };").length, 1);
  assert.equal(specProblems("const primary = { label: HELD_ENTRY(), here: true, run: () => setEditing(true) };").length, 0);
  assert.equal(specProblems("{ label: ui('前往设置'), run: () => onOpenSettings('settings-marker') }").length, 0);
  assert.equal(specProblems("{ label: ui('前往设置'), here: true, run: () => onOpenSettings('settings-marker') }").length, 1, 'a spec that leaves the page is not `here`');
});

test('1: the rule reads a label however it arrives: a variable holding a helper\'s result, through the helpers that call helpers (the model-settings link of the first-run line)', () => {
  const sources = [{ source: "export const modelSettingsLabel = (host) => (host?.openModelSettings ? ui('打开模型设置') : ui('前往设置'));\nexport const useModelSettingsLabel = () => modelSettingsLabel(useStudy().host);" }];
  const helpers = labelHelpers(sources);
  const page = "const live = useRef(true), settingsLabel = useModelSettingsLabel();\nreturn <Button variant=\"link\" onClick={on.openModelSettings}>{settingsLabel}</Button>;";
  assert.deepEqual(labelsOf('{settingsLabel}', helpers, varsOf(page)), ['打开模型设置', '前往设置']);
  assert.equal(goOnProblems(page, { helpers }).length, 1);
  assert.equal(goOnProblems(page.replace('variant="link"', 'variant="link" iconEnd="arrow-right"'), { helpers }).length, 0);
});

test('1: the message and empty-state actions { label, onClick } decide the same way: 打开模型设置 in a banner or an inline note ends in the arrow, however its label arrives', () => {
  assert.equal(actionProblems("const action = { label: ui('打开模型设置'), onClick: onModelSettings };").length, 1);
  assert.equal(actionProblems("const action = { label: ui('打开模型设置'), iconEnd: 'arrow-right', onClick: onModelSettings };").length, 0);
  assert.equal(actionProblems("const action = { label: ui('打开音频设置'), icon: 'key', onClick: onSettings };").length, 0, 'an action with its own leading icon takes no arrow');
  assert.equal(actionProblems("const action = { label: ui('重试'), onClick: onRetry };").length, 0);
  assert.equal(actionProblems("const action = { label: ui('打开'), onClick: () => setOpened(row) };").length, 0, 'it only sets state here');
  const helpers = labelHelpers([{ source: ["export const modelSettingsLabel = (host) => (host?.openModelSettings ? ui('打开模型设置') : ui('前往设置'));", 'export const useModelSettingsLabel = () => modelSettingsLabel(useStudy().host);'].join('\n') }]);
  assert.equal(actionProblems(['const settingsLabel = useModelSettingsLabel();', 'const action = { label: settingsLabel, onClick: onSettings };'].join('\n'), { helpers }).length, 1);
});

test('1: every control of ui/ that says 前往设置 or 打开资料 ends in the arrow, however it is drawn (a Button or the job card\'s action spec), except the ones that act in place', async () => {
  const sources = await uiSources(), helpers = labelHelpers(sources), missing = [];
  let seen = 0;
  for (const { file, source } of sources) {
    for (const { open, children } of buttonElements(source)) {
      if (!labelsOf(children, helpers, varsOf(source)).some((label) => /^(?:前往设置|打开资料)/.test(label)) || /\sicon=/.test(open)) continue;
      seen++;
      if (!/\biconEnd=/.test(open) && !inPlaceWhy(open, file)) missing.push(`${file}: ${open.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  assert.ok(seen >= 12, `the scan finds the 前往设置 / 打开资料 Buttons of ui/ (${seen})`);
  assert.deepEqual(missing, [], 'the arrow says the control takes the learner somewhere (ui/DESIGN.md, Icons)');
});

test('1: the whole of ui/ agrees with the rule: no go-on or navigating Button without its arrow, none with an arrow that acts in place, no job-card spec that opens a dialog without `here`', async () => {
  const sources = await uiSources(), helpers = labelHelpers(sources), found = [];
  for (const { file, source } of sources) {
    for (const { label, open, want } of goOnProblems(source, { file, helpers })) found.push(`${file}: ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of specProblems(source)) found.push(`${file}: spec ${label} wants ${want}  ${open.slice(0, 80)}`);
    for (const { label, open, want } of actionProblems(source, { helpers })) found.push(`${file}: action ${label} wants ${want}  ${open.slice(0, 80)}`);
  }
  assert.deepEqual(found, []);
});

test('1: DESIGN.md names the list and the decision once', async () => {
  const design = await read('ui/DESIGN.md');
  assert.match(design, /前往 \/ 打开/);
  assert.match(design, /sets state on this page|only sets state/);
});

/* ---- 4, 5: the English wording ---------------------------------------------------------------------------------------------------------------------------------- */

test('4: 「用资料出第一组题」 is worded for one source or many, never "it" (it is the home headline and also follows 「{0} and the rest: {1} sources added」)', async () => {
  const headline = (await locale('en.generate.json'))['用资料出第一组题'];
  assert.ok(headline && !/it/i.test(headline), `「${headline}」 does not say "it"`);
  assert.doesNotMatch(headline, /sources?|materials?/i, 'and counts nothing, so it is right for one source and for ten');
});

test('4: the generate form line 「将从 {0}出 {1}」 counts the sources in the word of the card button ("1 source", "{0} sources", beside 「Add another source」), in every catalogue that defines it', async () => {
  const seen = [];
  for (const name of (await readdir(new URL('../ui/locales/', import.meta.url))).filter((entry) => /^en(?:\..+)?\.json$/.test(entry))) {
    const catalogue = await locale(name);
    for (const [key, word] of [['1 份资料', '1 source'], ['{0} 份资料', '{0} sources'], ['含子课程共 {0} 份资料', '{0} sources incl. sub-courses']]) if (key in catalogue) { seen.push(key); assert.equal(catalogue[key], word, `${name}: ${key}`); }
  }
  assert.ok(seen.includes('1 份资料') && seen.includes('{0} 份资料'), 'the line is counted by one of the catalogues');
});

test('5: 接着练 {0}/{1} is "Resume {0}/{1}" in English on the outline row, as on the deck row and the selection bar: one action, one word', async () => {
  const outline = await locale('en.outline.json');
  assert.equal(outline['接着练 {0}/{1}'], 'Resume {0}/{1}');
  const all = {};
  for (const name of (await readdir(new URL('../ui/locales/', import.meta.url))).filter((entry) => /^en(?:\..+)?\.json$/.test(entry))) Object.assign(all, await locale(name));
  for (const key of ['继续 {0}/{1}', '接着练 {0}/{1}']) if (all[key]) assert.equal(all[key], 'Resume {0}/{1}', key);
});
