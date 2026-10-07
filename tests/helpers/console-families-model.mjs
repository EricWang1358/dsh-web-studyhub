import { createAssistService } from '../../lib/assist.js';
import { createAssistChildren } from '../../lib/assist-child.js';
import { reportUsage } from '../../lib/usage-scope.js';
import { openWorld, settled, soon } from './console-families.mjs';
import { model as translator, body, upload } from './translation-library.mjs';
import { writing, course as recapCourse, model as recapModel } from './recap-library.mjs';
import { model as teacher, quote } from './workflow-library.mjs';
import { card as assistCard, evidence as assistEvidence, reply as assistReply, request as assistRequest } from './assist-library.mjs';
import { lightModel, miss, seed as coachSeed } from './coach-library.mjs';
import { dayOf } from '../../lib/coach-daily.js';

/* The model families of the 任务 console other than generation (console-families.mjs): translation, the daily recap, the learning workflow (teaching, skeleton), the assistant, the note draft and
   为你定制. Each driver flips its own switches; the matrix separately verifies families whose legacy work has no console row. */

const usage = () => reportUsage({ uncachedInputTokens: 30, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
const SKELETON = JSON.stringify({ title: '缓存的主线', overview: '先命中，再过期。', nodes: [{ id: 'hit', term: '缓存命中', meaning: '请求可以使用已保存的结果。', cards: ['card'] }], relations: [] });
const until = soon;

/* ---------- translation ---------- */
const translationDriver = {
  id: 'translation', title: '翻译', kinds: ['translation'], switches: ['translation'], message: false,
  async open(t) {
    const fake = translator();
    const world = await openWorld(t, { prefix: 'console-translation-', complete: async (...args) => { usage(); return fake.complete(...args); } });
    world.docs = 0;
    return world;
  },
  async start(world) {
    const name = `Doc${++world.docs}`, imported = await world.service.call('materials.document.import', upload(`${name}.md`, body(name)));
    return world.service.call('generation.translation.start', { documentId: imported.documentId, scope: { sourceIds: [imported.document.sources[0].id] } });
  },
  async done(world) { const started = await this.start(world); await settled(world.service, started); return started; },
};

/* ---------- the daily recap ---------- */
const recapDriver = {
  id: 'recap', title: '每日总结', kinds: ['daily-recap'], switches: ['dailyRecap'], message: false,
  async open(t) {
    const fake = recapModel();
    const world = await openWorld(t, { prefix: 'console-recap-', complete: async (...args) => { usage(); return fake.complete(...args); }, setup: async w => {
      await w.service.store.update(state => {
        state.decks.push({ id: 'd', title: recapCourse, course: recapCourse, cards: Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`,
          answer: '正确答案', explanation: '先核对条件。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
        for (let i = 0; i < 10; i++) state.attempts.push({ id: `a-${i}`, runId: 'seed', deckId: 'd', quiz_id: `d-${i}`, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded' });
      });
    } });
    return world;
  },
  async start(world) { world.last = await world.service.call('note.daily.generate', { course: recapCourse, force: true }); return world.last; },
  async finish(world, started = world.last) {
    await until(async () => {
      const { generation } = await world.service.call('note.get', { id: started.id });
      return generation?.id === started.jobId && generation.status !== 'running';
    }, 'the recap to end');
  },
  async done(world) { const started = await this.start(world); await this.finish(world, started); return started; },
};

/* ---------- the learning workflow: a teaching and a skeleton ---------- */
async function workflowWorld(t) {
  const fake = teacher();
  const complete = async (system, prompt) => { usage(); return /skeleton|knowledge outline|知识骨架/i.test(system) ? SKELETON : fake.complete(system, prompt); };
  return openWorld(t, { prefix: 'console-workflow-', complete, setup: async w => {
    await w.service.store.update(state => {
      state.sources.push({ id: 'source', title: '缓存资料', text: `${quote}未命中时仍需访问原始服务。` });
      state.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
    });
    const template = await w.service.call('workflow.save', { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
    w.template = template; w.sessions = 0;
  } });
}
const sessionOf = async world => {
  const started = await world.service.call('workflow.session.start', { templateId: world.template.id, topic: `缓存 ${world.sessions}`, scope: [{ deckId: 'deck' }], requestId: `start-${++world.sessions}` });
  return started.session ?? started;
};
const teachingDriver = {
  id: 'workflow:teaching', title: '学习流 · 讲解', kinds: ['workflow-teaching'], switches: ['workflow'], message: false, open: workflowWorld,
  async start(world) { const session = await sessionOf(world); world.last = session; return world.service.call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson' }); },
  async finish(world) { await until(async () => (await world.service.call('workflow.session.get', { id: world.last.id })).session.records.lesson?.teaching?.status !== 'running', 'the teaching to end'); },
  async done(world) { const started = await this.start(world); await this.finish(world); return { ...started, kindKey: 'workflow-teaching' }; },
};
const skeletonDriver = {
  id: 'workflow:skeleton', title: '学习流 · 骨架', kinds: ['workflow-skeleton'], switches: ['workflow'], message: false, open: workflowWorld,
  async start(world) { const session = await sessionOf(world); world.last = session; return world.service.call('workflow.skeleton.generate', { id: session.id }); },
  async finish(world) { await until(async () => (await world.service.call('workflow.session.get', { id: world.last.id })).session.skeletonJob?.status !== 'running', 'the skeleton to end'); },
  async done(world) { const started = await this.start(world); await this.finish(world); return started; },
};

/* ---------- the assistant ---------- */
const assistDriver = {
  id: 'assist', title: '助教', kinds: ['assist'], switches: ['assist'], message: false,
  async open(t) {
    const world = await openWorld(t, { prefix: 'console-assist-', complete: async () => { usage(); return assistReply; }, setup: async w => {
      await w.service.store.update(state => { state.sources.push({ id: 's', title: 'Lecture', text: assistEvidence }); state.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(assistCard)] }); });
    } });
    world.assist = createAssistService({ children: createAssistChildren() });
    t.after(() => world.assist.dispose());
    return world;
  },
  async start(world) { return world.assist.startAssist({}, assistRequest(world.service, world.root, { helpChoices: [] })); },
  async finish(world) { await until(() => world.assist.assistView(world.root).tasks.every(task => task.status !== 'running'), 'the assist task to end'); },
  async done(world) { const started = await this.start(world); await this.finish(world); return started; },
};

/* ---------- the note draft ---------- */
const noteDriver = {
  id: 'note', title: '笔记起草', kinds: ['note-generate'], switches: ['noteGenerate'], message: false,
  async open(t) {
    const world = await openWorld(t, { prefix: 'console-note-', complete: async () => { usage(); return writing; }, setup: async w => {
      await w.service.store.update(state => { state.decks.push({ id: 'deck', title: 'Course', cards: [{ id: 'card', topic: 'Capacity planning', prompt: 'Question', answer: 'Answer', explanation: 'Explanation', misconception: 'Misconception' }] }); });
    } });
    world.notes = 0;
    return world;
  },
  async start(world) {
    const note = await world.service.call('note.create', { title: `Note ${++world.notes}`, cards: [{ deckId: 'deck', cardId: 'card' }] });
    world.last = note;
    return world.service.call('note.generate', { id: note.id });
  },
  async finish(world) { await until(async () => (await world.service.call('note.get', { id: world.last.id })).generation?.status !== 'running', 'the draft to end'); },
  async done(world) { const started = await this.start(world); await this.finish(world); return started; },
};

/* ---------- 为你定制 (the day's row) ---------- */
const coachDriver = {
  id: 'coach', title: '为你定制', kinds: ['coach-daily'], switches: ['coach'], message: false,
  async open(t) {
    const light = lightModel();
    const world = await openWorld(t, { prefix: 'console-coach-', complete: light.complete, options: { completeLight: light.complete, coach: true } });
    await coachSeed((action, args) => world.service.call(action, args));
    world.refs = await miss((action, args) => world.service.call(action, args), 6);
    world.used = 0;
    return world;
  },
  async start(world) { const refs = world.refs.slice(world.used, world.used + 3); world.used += 3; return world.service.call('coach.variants', { cards: refs, consent: true }); },
  async finish(world) { await until(async () => (await world.service.call('coach.status')).preparing === false, 'the preparation to end'); },
  async done(world) { await this.start(world); await this.finish(world); return { jobId: `coach:${dayOf(Date.now())}` }; },
};

export const MODEL_DRIVERS = [translationDriver, recapDriver, teachingDriver, skeletonDriver, assistDriver, noteDriver, coachDriver];
