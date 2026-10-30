import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StudyService } from '../lib/service.js';
import { parse as parseYaml } from 'yaml';
import { ASK_BEFORE_REMOVING, ASK_BEFORE_REMOVING_ZH, contractOf, libraryContracts, studyToolDescription, studyUsagePrompt } from '../lib/study-contracts.js';
import { SHIPPED_SKILLS, parseSkill } from '../lib/study-skills.js';
import { loadUi } from './helpers/ui-module.mjs';

// 3.7.x delete track, D5: wherever StudyHub instructs the main chat, one rule is written down: before any permanent delete or archive, ask the learner first, in ONE
// sentence that says what goes and what stays. The chat boundary itself does not change (the panel adds no confirmation); the instruction is what these tests pin, so a
// text that loses the rule fails here. The English rule is one constant (lib/study-contracts.js); the Chinese skill and the learner's own hand-off say it in Chinese.
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const flat = (text) => String(text).replace(/\s+/g, ' ');
const m = await loadUi(`export { situationPrompt } from './ui/agent-prompts/situation.js';`);

test('the rule says who asks, when, in how many sentences, what the sentence holds and when to act', () => {
  assert.match(ASK_BEFORE_REMOVING, /Before any permanent delete or archive/);
  assert.match(ASK_BEFORE_REMOVING, /ask the learner first/);
  assert.match(ASK_BEFORE_REMOVING, /ONE sentence/);
  assert.match(ASK_BEFORE_REMOVING, /what goes and what stays/);
  assert.match(ASK_BEFORE_REMOVING, /only on a clear yes/);
  assert.match(ASK_BEFORE_REMOVING_ZH, /永久删除或归档/);
  assert.match(ASK_BEFORE_REMOVING_ZH, /一句话/);
  assert.match(ASK_BEFORE_REMOVING_ZH, /什么会没有，什么会留下/);
});

test('the study_workspace tool description and the usage prompt carry the rule', () => {
  assert.ok(studyToolDescription.includes(ASK_BEFORE_REMOVING), 'tool description');
  assert.ok(studyUsagePrompt.includes(ASK_BEFORE_REMOVING), 'usage prompt');
});

test('every action area that archives or deletes something carries the rule where the chat reads it (library.context { area })', async t => {
  const removing = /\b[a-z]+(?:\.[a-z]+)*\.(?:archive|remove|delete)\b/;
  const areas = Object.entries(libraryContracts).filter(([, text]) => removing.test(text)).map(([area]) => area);
  // the areas that today hold such an action: if one of them stops matching, this test is out of date, not the rule
  for (const area of ['sources', 'organization', 'notes', 'board', 'book', 'generation']) assert.ok(areas.includes(area), `${area} still names a delete/archive action`);
  for (const area of areas) assert.ok(contractOf(area).includes(ASK_BEFORE_REMOVING), `area ${area} names a delete/archive action without the rule`);
  for (const area of Object.keys(libraryContracts).filter(name => !areas.includes(name))) assert.equal(contractOf(area), libraryContracts[area], `area ${area} names none, so it gets no rule`);
  // and it is what the host really answers
  const root = await mkdtemp(join(tmpdir(), 'chat-ask-first-'));
  const service = new StudyService(root);
  t.after(async () => { await service.dispose(); await rm(root, { recursive: true, force: true }); });
  for (const area of areas) assert.ok((await service.call('library.context', { area })).contract.includes(ASK_BEFORE_REMOVING), `library.context { area: ${area} }`);
});

test('no study_* domain tool can delete or archive without its own description carrying the rule', () => {
  const source = read('lib/runtime/tools.js');
  assert.doesNotMatch(source, /operations: \[[^\]]*(?:delete|remove|archive)/, 'a tool with such an operation must carry the rule in its description (and this test must name it)');
});

test('the StudyHub study preset tells the chat the rule', () => {
  const strings = [];
  const walk = (value) => { if (typeof value === 'string') strings.push(flat(value)); else if (value && typeof value === 'object') Object.values(value).forEach(walk); };
  walk(parseYaml(read('presets/study.patch.yml')));
  assert.ok(strings.some((text) => text.includes(ASK_BEFORE_REMOVING)), 'the study preset persona holds the rule word for word');
});

test('every shipped skill, and every skill folder on disk, carries the rule', () => {
  const onDisk = readdirSync(new URL('../skills/', import.meta.url), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual([...SHIPPED_SKILLS].sort(), onDisk, 'a skill folder that is not shipped (or the other way round)');
  for (const name of onDisk) {
    const { content } = parseSkill(read(`skills/${name}/SKILL.md`));
    assert.ok(flat(content).includes(['study-guide', 'study-tutor'].includes(name) ? ASK_BEFORE_REMOVING_ZH : ASK_BEFORE_REMOVING), `skills/${name}/SKILL.md lost the rule`);
  }
});

test('a hand-off that gives the work to the main chat asks it to ask first, in both languages', () => {
  const zh = m.situationPrompt({ area: '添加资料', goal: '导入一本题册', facts: ['a'], skill: 'study-import' }, 'zh');
  assert.match(zh, /- 先问：永久删除或归档任何东西之前，先用一句话问我：什么会没有，什么会留下；我说好再动手。/);
  const en = m.situationPrompt({ area: 'a', goal: 'b', facts: ['a'], skill: 'study-import' }, 'en');
  assert.match(en, /- Ask first: before any permanent delete or archive, ask me in one sentence what goes and what stays, and act only when I say yes\./);
});

test('the rule is not a new panel confirmation: the library still deletes on the call the chat makes, as before', () => {
  // the boundary is unchanged on purpose (the learner answers in the chat); a deck is still removed only when archived and confirm:true is sent
  assert.match(libraryContracts.organization, /deck\.remove \{id,confirm:true\} permanently deletes only an archived ordinary deck/);
});
