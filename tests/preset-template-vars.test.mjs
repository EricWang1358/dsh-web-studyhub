import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { parse } from 'yaml';
import { studyUsagePrompt } from '../lib/study-contracts.js';

/*
 * DSH interpolates `{{name}}` in every system-prompt section strictly: a name it
 * has not registered fails the whole turn ("unknown prompt variable ... registered
 * variables: provider, model"). DSH 0.2.1-rc.2 dropped `cwd`, and a `{{cwd}}` in the
 * 学习模式 persona suffix broke every study-mode message (3.5.0-3.5.5).
 *
 * The variables each host release registers (the variables are global, so every
 * section sees the same set):
 *   0.2.0-rc.2  provider, model, cwd  (@deepseek-ai/dsh-agent-loop lib/index.js:1564-1566)
 *   0.2.1-rc.2  provider, model       (@deepseek-ai/dsh-agent-loop lib/index.js:1591-1592)
 * StudyHub supports both, so only the names every supported release registers are allowed.
 * The scan mirrors interpolate() in @deepseek-ai/dsh-system-prompt 0.2.1-rc.2 (lib/index.js:158-181).
 */
const REGISTERED = {
  '0.2.0-rc.2': ['provider', 'model', 'cwd'],
  '0.2.1-rc.2': ['provider', 'model'],
};
const ALLOWED = new Set(Object.values(REGISTERED).reduce((common, names) => common.filter(name => names.includes(name))));
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/;
const GROUP_AT = /^\{\{([^{}]*)\}\}/;

/** Every problem DSH's strict interpolation would throw on, as readable lines. */
function templateProblems(text, where, allowed = ALLOWED) {
  const problems = [];
  for (let open = text.indexOf('{{'), last = 0; open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open));
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) problems.push(`${where}: malformed reference at "${text.slice(open, open + 16)}"`);
      last = open + 2;
      continue;
    }
    const name = group[1];
    if (!VARIABLE_NAME.test(name)) problems.push(`${where}: malformed variable "{{${name}}}"`);
    else if (!allowed.has(name)) problems.push(`${where}: "{{${name}}}" is not registered by every supported DSH (allowed: ${[...allowed].join(', ')})`);
    last = open + group[0].length;
  }
  return problems;
}

/** The persona texts a patch file feeds into system-prompt sections, with where they come from. */
function personaTexts(rows, at, out = []) {
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue;
    if (Array.isArray(row.insert)) personaTexts(row.insert, at, out);
    const here = `${at} > ${row.id || row.name}`;
    if (row.name === '@deepseek-ai/dsh-persona')
      for (const key of ['prefix', 'suffix']) if (typeof row.config?.[key] === 'string') out.push([`${here}.${key}`, row.config[key]]);
    if (row.name === '@deepseek-ai/dsh-agent-preset') personaTexts(row.config?.plugins, here, out);
    if (row.group) personaTexts(row.config, here, out);
  }
  return out;
}

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
async function shippedPatches() {
  const manifest = JSON.parse(await read('package.json'));
  const files = manifest.dsh.bundle.patch.map(file => file.replace(/^\.\//, ''));
  for (const name of await readdir(new URL('../packages/', import.meta.url)).catch(() => []))
    if (await read(`packages/${name}/cordis.patch.yml`).then(() => true, () => false)) files.push(`packages/${name}/cordis.patch.yml`);
  return files;
}

test('the scan matches DSH strict interpolation', () => {
  assert.deepEqual([...ALLOWED].sort(), ['model', 'provider']);
  assert.deepEqual(templateProblems('powered by {{model}} via {{provider}}', 'x'), []);
  assert.match(templateProblems('folder {{cwd}}', 'x')[0], /"\{\{cwd\}\}" is not registered/);
  assert.match(templateProblems('{{ model }}', 'x')[0], /malformed variable/);
  assert.match(templateProblems('{{a{b}} }}', 'x')[0], /malformed reference/);
  assert.deepEqual(templateProblems('a lone {{ is prose', 'x'), [], 'a {{ with no later }} stays literal in DSH');
});

test('every shipped preset and patch uses only prompt variables every supported DSH registers', async () => {
  const files = await shippedPatches();
  assert.ok(files.includes('presets/study.patch.yml'));
  const texts = [];
  // `!!js` scalars (the host Loader's dialect, as in the standard preset's shell rows) are expressions, not prompt text.
  const customTags = [{ tag: 'tag:yaml.org,2002:js', resolve: source => ({ __jsExpr: source }) }];
  for (const file of files) texts.push(...personaTexts(parse(await read(file), { customTags }), file));
  assert.ok(texts.some(([where]) => /preset-study > persona\.suffix$/.test(where)), 'the study persona suffix is scanned');
  assert.deepEqual(texts.flatMap(([where, text]) => templateProblems(text, where)), []);
});

test('the system-prompt section the plugin registers itself is free of unknown variables', () => {
  // lib/index.js registers studyUsagePrompt as the "daily-flashcard:usage" section.
  assert.deepEqual(templateProblems(studyUsagePrompt, 'daily-flashcard:usage'), []);
});
