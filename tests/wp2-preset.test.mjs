import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('package.json'));

/* The 学习模式 preset is the official DSH `standard` preset plus the StudyHub tutor
   persona (owner decision 2026-10-19): the same rows as
   @deepseek-ai/dsh-web-app@0.2.1-rc.2 presets/standard.patch.yml, kept verbatim in
   tests/fixtures/dsh-standard-preset/. The 0.2.0-rc.2 copy is there because the
   same file must also work on that host (npm run qa:dsh -- --dsh-version 0.2.0-rc.2). */
// YAML `!!js` scalars (the host Loader's dialect, evaluated at activation), kept as expression nodes.
const jsTag = { tag: 'tag:yaml.org,2002:js', resolve: source => ({ __jsExpr: source }) };
const parseYaml = text => parse(text, { customTags: [jsTag] });
const standardRows = async version => parseYaml(await read(`tests/fixtures/dsh-standard-preset/${version}.patch.yml`))[0].insert[0].config.plugins;
/* The documented exceptions (see the header of presets/study.patch.yml), each tested below:
   - tool-subagent / tool-subagent-fork keep the 0.2.0-rc.2 `backgroundMode: continuable` (0.2.1 has no such option);
   - tool-schedule is disabled where its package does not resolve: 0.2.0-rc.2 ships no @deepseek-ai/dsh-tool-schedule,
     and there an enabled row whose package is missing breaks the whole preset (measured with npm run qa:dsh). */
const CONTINUABLE = new Set(['tool-subagent', 'tool-subagent-fork']);
const SCHEDULE = 'tool-schedule';

/** Every row of a composition in order, with the id of the group it sits in. */
function rows(list, out = [], parent = null) {
  for (const row of list || []) {
    out.push({ ...row, parent });
    if (row.group) rows(row.config, out, row.id);
  }
  return out;
}
/** What a row is, without its children (a group's children are rows of their own). */
const shape = ({ id, name, group, isolate, disabled, config, parent }) =>
  ({ id, name, group: !!group, isolate: isolate ?? null, disabled: disabled ?? null, config: group ? null : config ?? null, parent });
async function preset(file = 'presets/study.patch.yml') {
  const document = parseYaml(await read(file));
  assert.ok(Array.isArray(document), 'a bundle patch is a top-level YAML array');
  assert.equal(document.length, 1, 'the preset file only inserts its own row');
  const inserted = document[0].insert;
  assert.ok(Array.isArray(inserted) && inserted.length === 1);
  return inserted[0];
}
const persona = async () => rows((await preset()).config.plugins).find(plugin => plugin.name === '@deepseek-ai/dsh-persona').config;

test('the plugin bundle ships the study preset next to its component patch', () => {
  assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './presets/study.patch.yml', './presets/study-worker.patch.yml']);
  assert.ok(manifest.files.includes('presets'), 'the preset must be published with the package');
});

test('DSH peer packages follow the 0.2 line the preset and client store need', () => {
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'])
    assert.equal(manifest.peerDependencies[name], '>=0.2.0-rc.2 <0.3', name);
});

test('the study preset row is a valid agent preset', async () => {
  const row = await preset();
  assert.equal(row.id, 'preset-study');
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row.config.id, 'study');
  assert.equal(typeof row.config.order, 'number');
  assert.match(row.config.name, /StudyHub/);
  assert.match(row.config.description, /StudyHub/);
  assert.doesNotMatch(row.config.description, /不运行命令|不改文件|no shell|no file/i, 'the description must not promise what the preset no longer does');
  const ids = rows(row.config.plugins).map(plugin => plugin.id);
  assert.equal(new Set(ids).size, ids.length, 'row ids are unique inside the composition');
  assert.equal(row.config.plugins[0].name, '@deepseek-ai/dsh-persona', 'the persona comes first, as in standard');
});

test('the study preset composes every row of the DSH 0.2.1 standard preset, the same way', async () => {
  const study = rows((await preset()).config.plugins), standard = rows(await standardRows('0.2.1-rc.2'));
  assert.deepEqual(study.map(row => [row.parent, row.id]), standard.map(row => [row.parent, row.id]), 'the same rows, groups and order');
  for (const [index, row] of study.entries()) {
    const expected = shape(standard[index]), actual = shape(row);
    if (row.id === 'persona') { assert.equal(actual.name, expected.name); continue; }
    if (CONTINUABLE.has(row.id)) expected.config = { ...expected.config, backgroundMode: 'continuable' };
    if (row.id === SCHEDULE) { assert.ok(row.disabled?.__jsExpr, 'the schedule row is guarded'); expected.disabled = row.disabled; }
    assert.deepEqual(actual, expected, `row ${row.id} differs from standard`);
  }
  // the platform shell rows are standard's own expressions: pwsh on Windows, bash elsewhere
  const byId = Object.fromEntries(study.map(row => [row.id, row]));
  assert.equal(byId['tool-bash'].disabled.__jsExpr, "process.platform === 'win32'");
  assert.equal(byId['tool-pwsh'].disabled.__jsExpr, "process.platform !== 'win32'");
  for (const name of ['@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search', '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-plan-mode',
    '@deepseek-ai/dsh-workflow-ptc', '@deepseek-ai/dsh-tool-workflow', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-tool-todo'])
    assert.ok(study.some(row => row.name === name && row.disabled == null), `${name} is composed and enabled`);
});

test('exception: delegation keeps the DSH 0.2.0-rc.2 continuable background mode', async () => {
  const study = rows((await preset()).config.plugins), old = rows(await standardRows('0.2.0-rc.2')), current = rows(await standardRows('0.2.1-rc.2'));
  for (const id of CONTINUABLE) {
    assert.equal(study.find(row => row.id === id).config.backgroundMode, 'continuable', id);
    assert.equal(old.find(row => row.id === id).config.backgroundMode, 'continuable', `${id} as in the 0.2.0-rc.2 standard preset`);
    assert.equal(current.find(row => row.id === id).config.backgroundMode, undefined, `${id}: 0.2.1-rc.2 has no such option`);
  }
});

/* The Loader evaluates `disabled: !!js` with the preset's context in scope (`with (ctx) eval(expr)`,
   @deepseek-ai/cordis-plugin-loader 1.0.6), where `baseUrl` is the profile folder the rows resolve from. */
const evaluateDisabled = (expression, scope) => new Function('scope', `with (scope) { return eval(${JSON.stringify(expression)}) }`)(scope);

test('exception: the schedule row is enabled exactly where its package resolves', async () => {
  const schedule = rows((await preset()).config.plugins).find(row => row.id === SCHEDULE);
  assert.equal(schedule.name, '@deepseek-ai/dsh-tool-schedule');
  const expression = schedule.disabled.__jsExpr;
  const host = await mkdtemp(join(tmpdir(), 'studyhub-schedule-'));
  try {
    const baseUrl = pathToFileURL(host + sep).href;
    assert.equal(evaluateDisabled(expression, { baseUrl }), true, 'a host without the package (DSH 0.2.0-rc.2)');
    const folder = join(host, 'node_modules', '@deepseek-ai', 'dsh-tool-schedule');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-tool-schedule', version: '0.2.1-rc.2' }));
    assert.equal(evaluateDisabled(expression, { baseUrl }), false, 'a host that ships it (DSH 0.2.1-rc.2)');
    assert.equal(evaluateDisabled(expression, {}), true, 'no baseUrl in scope: disabled, never a broken preset');
  } finally { await rm(host, { recursive: true, force: true }); }
});

test('rows the DSH 0.2.0-rc.2 host does not ship are never enabled there', async () => {
  const study = rows((await preset()).config.plugins), old = new Set(rows(await standardRows('0.2.0-rc.2')).map(row => row.name));
  // dsh-time-context ships in 0.2.0-rc.2 (only its standard preset does not compose it); the other two packages do not exist there
  const added = study.filter(row => !old.has(row.name)).map(row => [row.id, row.disabled === true ? 'disabled' : row.disabled?.__jsExpr ? 'guarded' : 'enabled']);
  assert.deepEqual(added, [['time-context', 'enabled'], [SCHEDULE, 'guarded'], ['tool-plugin-market', 'disabled']]);
});

test('the study persona makes the library the default meaning and asks once when ambiguous', async () => {
  const text = (await persona()).prefix;
  for (const word of ['资料', '我的笔记', '这节课', '课件', '讲义', '题库', '题组', '错题'])
    assert.ok(text.includes(word), `persona must claim "${word}" for the StudyHub library`);
  assert.match(text, /StudyHub library/);
  assert.match(text, /@path/);
  assert.match(text, /study_materials[^.]*document\.import/);
  assert.match(text, /ask_user_question/);
  assert.match(text, /ONE/);
  assert.match(text, /\bcite\b/i);
  assert.match(text, /never invent\s+citations/);
  assert.match(text, /subagent/);
  assert.match(text, /student's\s+language/);
  assert.doesNotMatch(text, /coding agent/);
});

test('the study persona may convert material with commands and files, within the promised limits', async () => {
  const { prefix: text, suffix } = await persona();
  assert.doesNotMatch(text, /cannot run commands|do not offer to/i, 'the old "no shell" rule is gone');
  assert.match(text, /run commands and read, write and edit files to convert, split, OCR or export/);
  assert.match(text, /studyhub-work\//);
  assert.match(text, /never\s+delete or overwrite the student's originals/);
  assert.match(text, /Ask before installing anything or writing\s+outside the workspace/);
  assert.match(text, /MinerU\/Marker installation and StudyHub settings belong to the\s+Settings page/);
  assert.match(text, /「发给主会话」 message names it/);
  assert.match(text, /「发给主会话」 message the student sends from\s+StudyHub is their own request: do it, then report what changed, where, and what did\s+not work/);
  assert.match(text, /otherwise\s+convert it first\s+with the shell and file tools, then import the result/);
  assert.match(text, /New questions come only from generate or supplement/);
  assert.match(text, /entered as they are with ingest or deck\.import/);
  assert.match(text, /add no new questions on that\s+path/);
  assert.equal(suffix, 'The session working directory (the workspace folder) is not the StudyHub library.', 'the suffix stays static');
});

test('the background worker preset composes a persona and nothing else', async () => {
  const row = await preset('presets/study-worker.patch.yml');
  assert.equal(row.id, 'preset-study-worker');
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row.config.id, 'study-worker', 'lib/subagent-api.js selects it by this id');
  assert.match(row.config.name, /StudyHub/);
  assert.match(row.config.description, /not for chatting/);
  const plugins = rows(row.config.plugins);
  assert.deepEqual(plugins.map(plugin => plugin.name), ['@deepseek-ai/dsh-persona'],
    'no tool rows: the worker gets no shell, files, web, delegation or questions');
  const worker = plugins[0].config;
  assert.equal(worker.complete, true, 'the worker prompt is its own persona only, not the tutor usage notes');
  assert.match(worker.prefix, /untrusted/);
  assert.match(worker.prefix, /no\s+tools/);
});

/* DSH has no way to keep a preset out of its picker: the registry lists every registered definition
   (@deepseek-ai/dsh-agent-preset-registry 0.2.0-rc.2 / 0.2.1-rc.2 `list()`), and the picker drops only broken
   ones (@deepseek-ai/dsh-client-ui-agent-preset `presetOptions`), which cannot be started either. So the worker
   sorts after every preset that sets an order (shipped ones use 0-4), with a short name that says not to pick it. */
test('the worker preset is listed last among ordered presets, with a short name that says not to pick it', async () => {
  const worker = (await preset('presets/study-worker.patch.yml')).config;
  const study = (await preset('presets/study.patch.yml')).config;
  assert.ok(Number.isSafeInteger(worker.order) && worker.order >= 1000 && worker.order > study.order, `order ${worker.order}`);
  assert.ok([...worker.name].length <= 16, worker.name);
  assert.match(worker.name, /StudyHub/);
  assert.match(worker.name, /勿选/);
});
