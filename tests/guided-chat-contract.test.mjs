import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { parseSkill, SHIPPED_SKILLS } from '../lib/study-skills.js';
import { StudyService } from '../lib/service.js';

/* #548: the main chat is told how AI 带学 works. Every guided action is named in the tool description and spelled out in library.context
   {area:'guided'}; the study-tutor skill takes 「带我学 X」 and walks the loop with real action names; study-guide hands over and carries no
   section numbers of a plan document the model never sees. */

const GUIDED = ['study.session.start', 'study.session.get', 'study.session.update', 'study.session.pause', 'study.session.resume', 'study.session.end',
  'study.session.artifact.save', 'study.scene.get', 'study.branch.open', 'study.branch.return', 'study.question.prepare', 'study.question.result',
  'study.question.cancel', 'study.qa.organize'];
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('the tool description names every guided action and points at the guided area, which spells out each one', () => {
  assert.match(studyToolDescription, /Guided study \(AI 带学\): [^\n]*\(details: guided\)/);
  for (const action of GUIDED) assert.ok(libraryContracts.guided.includes(action.replace(/^study\./, 'study.')), `the guided contract names ${action}`);
  assert.match(libraryContracts.guided, /courseId is required/);
  assert.match(libraryContracts.guided, /scope:\[\{kind:source\|deck\|card,id\}\]/);
  assert.match(libraryContracts.guided, /the question text is never passed in/);
  assert.match(libraryContracts.guided, /review\.answer is theirs, never the assistant's/);
  assert.match(libraryContracts.guided, /visible_in_sidebar/);
});

test('the study-tutor skill is shipped, takes 「带我学」, and every action it names exists', async t => {
  assert.ok(SHIPPED_SKILLS.includes('study-tutor'));
  const skill = parseSkill(await read('skills/study-tutor/SKILL.md'));
  assert.equal(skill.name, 'study-tutor');
  assert.match(skill.whenToUse, /带我学/);
  assert.match(skill.whenToUse, /边学边测/);
  assert.match(skill.content, /你不写题目内容/);
  assert.match(skill.content, /学习者同意/);
  const root = await mkdtemp(join(tmpdir(), 'study-tutor-skill-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const study = new StudyService(root);
  const named = [...new Set([...skill.content.matchAll(/`((?:study|card|job|library|review)\.[a-z]+(?:\.[a-z]+)*)\b/g)].map((match) => match[1]))];
  for (const action of ['study.session.start', 'study.question.prepare', 'study.question.result', 'study.scene.get', 'job.wait', 'card.search']) assert.ok(named.includes(action), `the skill names ${action}`);
  for (const action of named) assert.ok(study.runtime.hasAction(action), `${action} is an action of the study workspace`);
});

test('study-guide stays the front door: no plan-document section numbers, and 带学 goes to study-tutor', async () => {
  const guide = parseSkill(await read('skills/study-guide/SKILL.md'));
  assert.doesNotMatch(guide.content, /Section \d/);
  assert.match(guide.content, /交给 skill `study-tutor`/);
  assert.match(guide.content, /这一步不生成任何内容/);
  for (const name of SHIPPED_SKILLS) assert.doesNotMatch(parseSkill(await read(`skills/${name}/SKILL.md`)).content, /Section \d+\.\d+/, name);
});
