/* The skills StudyHub ships (lib/study-skills.js, docs/review-book-agent.md): skills/study-book/SKILL.md is in the package, parses as the host's
   filesystem provider reads it (name, description, whenToUse), is registered with the host's skill registry when there is one, and every action it
   names is an action of the study workspace. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSkill, registerStudySkills, SHIPPED_SKILLS, studySkills } from '../lib/study-skills.js';
import { StudyService } from '../lib/service.js';

const text = await readFile(new URL('../skills/study-book/SKILL.md', import.meta.url), 'utf8');

test('the study-book skill parses: name, description and whenToUse in the frontmatter, the rules in the body', () => {
  const skill = parseSkill(text);
  assert.equal(skill.name, 'study-book');
  assert.match(skill.description, /复习全书/);
  assert.match(skill.whenToUse, /发给主会话/);
  for (const part of ['## Authority', '## The one hard rule: respect the materials', '## Style', '## Working loop', '## Limits', '## Report to the learner']) assert.ok(skill.content.includes(part), part);
  assert.match(skill.content, /IS the authorisation\. Do not ask again before saving/);
  assert.match(skill.content, /（资料以外）/);
  assert.match(skill.content, /\[\^1\]: 「exact words from the page」 \(sourceId\)/);
  assert.match(skill.content, /Never `course\.book\.open` or `course\.book\.save`/);
  assert.match(skill.content, /never inside `run_code`/);
  assert.match(skill.content, /结束时用中文简短汇报/);
  assert.throws(() => parseSkill('no frontmatter'), /frontmatter/);
  assert.throws(() => parseSkill('---\nname: x\n---\nbody'), /description/);
});

test('every action the skill names is an action of the study workspace', async t => {
  const root = await mkdtemp(join(tmpdir(), 'study-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  const named = [...new Set([...text.matchAll(/`((?:book|source|course\.book|library)\.[a-z]+(?:\.[a-z]+)*)\b/g)].map(match => match[1]))];
  for (const action of ['book.toc', 'book.read', 'source.pages', 'book.write', 'book.coverage', 'course.book.revert', 'library.context']) assert.ok(named.includes(action), `the skill names ${action}`);
  for (const action of named) assert.ok(study.runtime.hasAction(action), `${action} is registered`);
});

test('the shipped skills are registered with the host\'s registry as bundled, model- and user-invocable skills', () => {
  const registered = [], ctx = { skills: { register: skill => { registered.push(skill); return () => {}; } } };
  assert.equal(registerStudySkills(ctx).length, SHIPPED_SKILLS.length);
  assert.deepEqual(registered.map(skill => skill.name), ['study-book', 'study-import', 'study-guide', 'study-tutor']);
  const [skill] = registered;
  assert.equal(skill.source, 'bundled');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.ok(skill.path.endsWith(join('skills', 'study-book', 'SKILL.md')));
  assert.equal(skill.content, studySkills()[0].content);
  assert.throws(() => registerStudySkills({ skills: { register: () => { throw new Error('refused'); } } }), /refused/, 'a registry that refuses is the host\'s error, not hidden');
  assert.deepEqual(registerStudySkills({}), [], 'no registry: nothing registered');
});

test('the skill ships in the package and the plugin registers it when the host has a skill registry', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('skills'), 'package.json files lists skills');
  const index = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(index, /ctx\.inject\(\['skills'\], skillCtx => \{ registerStudySkills\(skillCtx\); \}\)/);
});
