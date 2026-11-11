/* The skills StudyHub ships (lib/study-skills.js, docs/review-book-agent.md): skills/study-book/SKILL.md is in the package, parses as the host's
   filesystem provider reads it (name, description, whenToUse), is registered with the host's skill registry when there is one, and every action it
   names is an action of the study workspace. No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BUNDLED_SKILL_RANK, parseSkill, registerStudySkills, SHIPPED_SKILLS, STUDY_SKILL_PROVIDER, studySkills } from '../lib/study-skills.js';
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
  assert.deepEqual(registered.map(skill => skill.name), ['study-book', 'study-import', 'study-guide', 'study-tutor', 'study-custom', 'study-self']);
  const [skill] = registered;
  assert.equal(skill.source, 'bundled');
  assert.deepEqual(skill.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(skill.resourceBase.kind, 'directory');
  assert.ok(skill.path.endsWith(join('skills', 'study-book', 'SKILL.md')));
  assert.equal(skill.content, studySkills()[0].content);
  assert.throws(() => registerStudySkills({ skills: { register: () => { throw new Error('refused'); } } }), /refused/, 'a registry that refuses is the host\'s error, not hidden');
  assert.deepEqual(registerStudySkills({}), [], 'no registry: nothing registered');
});

test('when the host exposes registerProvider, bundled skills register at BUNDLED_SKILL_RANK (600) so user skills (400) outrank them and edits reload from disk', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'study-skills-provider-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(new URL('../skills/', import.meta.url), dir, { recursive: true });
  let provider;
  const disposers = registerStudySkills({
    skills: {
      registerProvider: create => { provider = create({ signal: new AbortController().signal, invalidate() {} }); return () => {}; },
      register: () => { throw new Error('registerProvider must win over runtime register (rank 250)'); },
    },
  }, { root: dir });
  assert.equal(disposers.length, 1);
  assert.equal(provider.name, STUDY_SKILL_PROVIDER);
  const candidates = await provider.list({});
  assert.deepEqual(candidates.map(c => c.name), SHIPPED_SKILLS);
  const guide = candidates.find(c => c.name === 'study-guide');
  assert.equal(guide.rank, BUNDLED_SKILL_RANK);
  assert.ok(guide.rank > 400, 'user ~/.dsh/skills (rank 400) outranks bundled StudyHub skills (rank 600)');
  assert.equal(guide.source, 'bundled');
  assert.equal(guide.provider, STUDY_SKILL_PROVIDER);
  const guidePath = join(dir, 'study-guide', 'SKILL.md');
  const original = await readFile(guidePath, 'utf8');
  await writeFile(guidePath, original.replace('# StudyHub 的门口', '# StudyHub 门口（热更新验证）'), 'utf8');
  const loaded = await provider.get(guide, {});
  assert.match(loaded.content, /热更新验证/, 'get() reads current SKILL.md from disk rather than freezing startup memory');
});

test('the skill ships in the package and the plugin registers it when the host has a skill registry', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('skills'), 'package.json files lists skills');
  const index = await readFile(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.match(index, /ctx\.inject\(\['skills'\], skillCtx => \{ registerStudySkills\(skillCtx\); \}\)/);
});

test('the study-self skill parses, keeps the interview short, and names only actions the workspace has', async t => {
  const skillText = await readFile(new URL('../skills/study-self/SKILL.md', import.meta.url), 'utf8');
  const skill = parseSkill(skillText);
  assert.equal(skill.name, 'study-self');
  assert.match(skill.description, /自学课/);
  assert.match(skill.whenToUse, /自学目标|self\.start/);
  for (const part of ['## 先读一次，再问', '## 怎么问：最多五问，一次一个', '## 学法草稿：先给他看，再存', '## 资料', '## 第一批题', '## 收尾', '## 边界']) {
    assert.ok(skill.content.includes(part), part);
  }
  assert.match(skill.content, /最多五问/, 'the interview is bounded');
  assert.match(skill.content, /没确认之前不生成、不存/, 'nothing is made before the learner agrees');
  assert.match(skill.content, /AI 撰写 · 未核对/, 'drafted material says what it is');
  assert.match(skill.content, /不做无资料生成/);
  const root = await mkdtemp(join(tmpdir(), 'study-skills-self-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  const named = [...new Set([...skillText.matchAll(/`((?:library|course|source|materials)\.[a-z]+(?:\.[a-z]+)*)\b/g)].map(match => match[1]))];
  for (const action of ['library.context', 'course.save', 'course.outline', 'source.add']) assert.ok(named.includes(action), `the skill names ${action}`);
  for (const action of named) assert.ok(study.runtime.hasAction(action), `${action} is registered`);
});
