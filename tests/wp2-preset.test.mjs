import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(await read('package.json'));

/* Plugin rows the official DSH `standard` preset composes
   (@deepseek-ai/dsh-web-app/presets/standard.patch.yml) in both host releases
   StudyHub supports. The study preset is derived from it, so every row it names
   must be one DSH ships there in BOTH: users upgrade the host at their own pace. */
const STANDARD_COMMON = [
  '@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-agent-instructions', '@deepseek-ai/dsh-tool-bash',
  '@deepseek-ai/dsh-tool-pwsh', '@deepseek-ai/dsh-tool-fs', '@deepseek-ai/dsh-tool-fs-search',
  '@deepseek-ai/dsh-tool-jobs', '@deepseek-ai/dsh-skill-filesystem', '@deepseek-ai/dsh-tool-skill',
  '@deepseek-ai/dsh-command-goal', '@deepseek-ai/dsh-tool-goal', 'cordis:group', '@deepseek-ai/dsh-plan-mode',
  '@deepseek-ai/dsh-compaction-basic', '@deepseek-ai/dsh-command-compact',
  '@deepseek-ai/dsh-compaction-tool-result-pruner', '@deepseek-ai/dsh-tool-subagent-control',
  '@deepseek-ai/dsh-tool-subagent-control/list-agents', '@deepseek-ai/dsh-tool-subagent',
  '@deepseek-ai/dsh-workflow-ptc', '@deepseek-ai/dsh-tool-workflow',
  '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-todo', '@deepseek-ai/dsh-tool-web',
  '@deepseek-ai/dsh-tool-present', '@deepseek-ai/dsh-plugin-manager/tools',
];
const STANDARD_ROWS = {
  '0.2.0-rc.2': new Set([...STANDARD_COMMON, '@deepseek-ai/dsh-tool-ralph']),
  // 0.2.1-rc.2 drops ralph and adds the time context, schedules and the plugin market's tools.
  '0.2.1-rc.2': new Set([...STANDARD_COMMON, '@deepseek-ai/dsh-time-context', '@deepseek-ai/dsh-tool-schedule',
    '@deepseek-ai/dsh-plugin-market/tools']),
};
// Shell, filesystem read/write/edit, background shell jobs, PTC workflows and
// coding-only plan mode: none of these belong to a study tutor.
const FORBIDDEN = /dsh-tool-(bash|pwsh)|dsh-tool-fs|dsh-tool-str-replace-editor|dsh-tool-jobs|dsh-ptc|dsh-workflow-ptc|dsh-tool-workflow|dsh-tool-ralph|dsh-plan-mode|dsh-tool-present|dsh-plugin-manager|dsh-agent-instructions/;

function rows(list, out = []) {
  for (const row of list || []) {
    out.push(row);
    if (row.group) rows(row.config, out);
  }
  return out;
}
async function preset(file = 'presets/study.patch.yml') {
  const document = parse(await read(file));
  assert.ok(Array.isArray(document), 'a bundle patch is a top-level YAML array');
  assert.equal(document.length, 1, 'the preset file only inserts its own row');
  const inserted = document[0].insert;
  assert.ok(Array.isArray(inserted) && inserted.length === 1);
  return inserted[0];
}

test('the plugin bundle ships the study preset next to its component patch', () => {
  assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml', './presets/study.patch.yml', './presets/study-worker.patch.yml']);
  assert.ok(manifest.files.includes('presets'), 'the preset must be published with the package');
});

test('DSH peer packages follow the 0.2 line the preset and client store need', () => {
  for (const name of ['@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-tools'])
    assert.equal(manifest.peerDependencies[name], '>=0.2.0-rc.2 <0.3', name);
});

test('the study preset row is a valid agent preset based on the standard composition', async () => {
  const row = await preset();
  assert.equal(row.id, 'preset-study');
  assert.equal(row.name, '@deepseek-ai/dsh-agent-preset');
  assert.equal(row.config.id, 'study');
  assert.equal(typeof row.config.order, 'number');
  assert.match(row.config.name, /StudyHub/);
  assert.match(row.config.description, /StudyHub/);
  const plugins = rows(row.config.plugins);
  const ids = plugins.map(plugin => plugin.id);
  assert.equal(new Set(ids).size, ids.length, 'row ids are unique inside the composition');
  for (const plugin of plugins) {
    assert.equal(typeof plugin.id, 'string');
    for (const [host, standard] of Object.entries(STANDARD_ROWS))
      assert.ok(standard.has(plugin.name), `${plugin.name} is not a row of the DSH ${host} standard preset`);
    if (plugin.group) assert.ok(Array.isArray(plugin.config), `${plugin.id} group lists its rows`);
  }
  for (const required of ['@deepseek-ai/dsh-persona', '@deepseek-ai/dsh-tool-ask-user', '@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-compaction-basic'])
    assert.ok(plugins.some(plugin => plugin.name === required), `missing ${required}`);
  const subagent = plugins.find(plugin => plugin.name === '@deepseek-ai/dsh-tool-subagent');
  assert.equal(subagent.config.provider, 'spawn', 'delegated children join this same tool-limited composition');
});

test('the study preset never composes shell, file or edit tools', async () => {
  const names = rows((await preset()).config.plugins).map(plugin => plugin.name);
  assert.deepEqual(names.filter(name => FORBIDDEN.test(name)), []);
});

test('the study persona makes the library the default meaning and asks once when ambiguous', async () => {
  const persona = rows((await preset()).config.plugins).find(plugin => plugin.name === '@deepseek-ai/dsh-persona');
  const text = persona.config.prefix;
  for (const word of ['资料', '我的笔记', '这节课', '课件', '题库', '错题'])
    assert.ok(text.includes(word), `persona must claim "${word}" for the StudyHub library`);
  assert.match(text, /StudyHub library/);
  assert.match(text, /@path/);
  assert.match(text, /study_materials[^.]*document\.import/);
  assert.match(text, /ask_user_question/);
  assert.match(text, /ONE/);
  assert.match(text, /cite/i);
  assert.match(text, /subagent/);
  assert.match(text, /student's language/);
  assert.doesNotMatch(text, /coding agent/);
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
  const persona = plugins[0].config;
  assert.equal(persona.complete, true, 'the worker prompt is its own persona only, not the tutor usage notes');
  assert.match(persona.prefix, /untrusted/);
  assert.match(persona.prefix, /no\s+tools/);

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
