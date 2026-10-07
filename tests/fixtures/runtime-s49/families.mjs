import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { managedRuntimeOptions } from '../../helpers/runtime-switch.mjs';
import { until } from '../../helpers/wait.mjs';

/* The model families of the S4-9 rollback drill. Every family says how its library is seeded (`seed`), how a run is started (`start`, also how it is started AGAIN after a rollback),
   when it has ended (`ended`) and what the library shows of it (`view`: public actions only, so the older version answers the same questions). The fake model knows nothing of the
   library code and nothing leaves the machine. */

const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0, 16);
const never = () => new Promise(() => {}); // a model that is still thinking when the process ends
const WAIT = { timeoutMs: 120_000 };

const WRITING = `# 今日学习总结\n\n${'围绕已练习的知识点整理正确思路，核对条件与推理步骤。'.repeat(8)}`;
const QUOTE = '缓存命中要求请求可以使用已保存的结果，且结果没有过期。';
const ARTICLE = ['## 从一次请求开始', '## 一步一步推演', '## 边界与易错点'].map(heading => `${heading}\n\n${'这是为说明机制而设定的演示条件，先检查请求，再检查有效期，两项都满足才能复用。'.repeat(6)}`).join('\n\n');
const APPROVED = JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });
const body = prefix => `# ${prefix}\n\n${Array.from({ length: 8 }, (_, i) => `${prefix} paragraph ${i} explains one more consequence of the architecture in some detail.`).join('\n\n')}\n`;
const translated = text => `译文：${'字'.repeat(Math.ceil(text.replace(/\s/g, '').length * 0.5))}`;
const PATHS = { recap: ['dailyRecap'], note: ['noteGenerate'], translation: ['translation'], workflow: ['workflow'], assist: ['assist'] };

/** `mode`: 'finish' answers every call; 'hold' never answers (the run is under way when the process ends). `reached` resolves at the first call. */
export function fakeModel(family, mode) {
  let reach; const reached = new Promise(resolve => { reach = resolve; });
  const complete = async (system, prompt) => {
    reach();
    if (mode === 'hold') return never();
    if (family === 'translation') return JSON.stringify({ translations: JSON.parse(prompt).passages.map(item => ({ id: item.id, text: translated(item.text) })) });
    if (family === 'workflow') return system.startsWith('Independently') ? APPROVED : JSON.stringify({ markdown: ARTICLE, citations: [{ sourceId: 'source', quote: QUOTE }] });
    if (family === 'assist') return '{"answer":"Two independent dimensions."}';
    return WRITING;
  };
  return { complete, reached };
}

/** The service options of one family: the fake model, and, with `on`, the family's migration switch on a controlled executor (the current code only). */
export const optionsFor = (family, complete, on) => ({ complete, coach: false, ...(on ? (({ starts: _starts, ...rest }) => rest)(managedRuntimeOptions({ complete, paths: PATHS[family] })) : {}) });

const firstNote = async service => (await service.call('note.list')).notes[0];
const noteView = async service => {
  const rows = [];
  for (const item of (await service.call('note.list')).notes) {
    const note = await service.call('note.get', { id: item.id });
    rows.push({ kind: note.kind, status: note.status, markdown: hash(note.markdown), generation: note.generation?.status ?? null, revision: note.revision, dated: Boolean(note.daily?.day) });
  }
  return { notes: rows };
};
const noteEnded = service => until(async () => { const note = await firstNote(service); return note && (await service.call('note.get', { id: note.id })).generation?.status !== 'running'; }, 'the note to settle', WAIT);

const recap = {
  async seed(service) {
    await service.store.update(state => {
      state.decks.push({ id: 'd', title: '数学 / 第一章', course: '数学 / 第一章', cards: Array.from({ length: 40 }, (_, i) => ({ id: `d-${i}`, kind: 'quiz', topic: `知识点 ${i % 3}`, prompt: `题目 ${i}`,
        answer: '正确答案', explanation: '先核对条件。', options: [{ id: 'a', text: '正确选项', correct: true }, { id: 'b', text: '干扰选项' }] })) });
      for (let i = 0; i < 40; i++) state.attempts.push({ id: `a-${i}`, runId: 'seed', deckId: 'd', quiz_id: `d-${i}`, timestamp: new Date().toISOString(), grade: 4, assessment: 'graded' });
    });
  },
  start: service => service.call('note.daily.generate', { course: '数学 / 第一章' }),
  ended: noteEnded,
  view: noteView,
};
const note = {
  async seed(service) {
    await service.store.update(state => { state.decks.push({ id: 'deck', title: 'Course', cards: [{ id: 'card', topic: 'Capacity planning', prompt: 'Question', answer: 'Answer', explanation: 'Explanation', misconception: 'Misconception' }] }); });
    await service.call('note.create', { title: 'Capacity planning', cards: [{ deckId: 'deck', cardId: 'card' }] });
  },
  start: async service => service.call('note.generate', { id: (await firstNote(service)).id }),
  ended: noteEnded,
  view: noteView,
};
const translation = {
  async seed() {},
  async start(service, context) {
    const known = (await service.call('export')).documents?.[0];
    const imported = known ? { documentId: known.id, document: { sources: [{ id: known.sourceIds?.[0] ?? (await service.call('export')).sources[0].id }] } }
      : await service.call('materials.document.import', { filename: 'Alpha.md', dataBase64: Buffer.from(body('Alpha')).toString('base64') });
    context.last = await service.call('generation.translation.start', { documentId: imported.documentId, scope: { sourceIds: [imported.document.sources[0].id] } });
    return context.last;
  },
  // A start that finds nothing left to translate answers without a job; otherwise the job is waited for until it has really ended.
  ended: (service, context) => context.last?.jobId ? until(async () => !['queued', 'running', 'cancelling'].includes((await service.call('job.wait', { jobId: context.last.jobId, timeoutSeconds: 5 })).status), 'the translation', WAIT) : Promise.resolve(),
  async view(service) {
    const id = (await service.call('export')).documents?.[0]?.id, list = id ? await service.call('materials.translation.list', { documentId: id }) : { items: [] };
    return { items: list.items.length, text: hash(list.items.map(item => [item.key, item.text, item.version])) };
  },
};
const workflow = {
  async seed(service) {
    await service.store.update(state => {
      state.sources.push({ id: 'source', title: '缓存资料', text: `${QUOTE}未命中时仍需访问原始服务。` });
      state.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: QUOTE, citations: [{ sourceId: 'source', quote: QUOTE }] }] });
    });
    const template = await service.call('workflow.save', { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
    await service.call('workflow.session.start', { templateId: template.id, topic: '缓存', scope: [{ deckId: 'deck' }], requestId: 'start-0' });
  },
  async start(service) {
    const session = (await service.call('export')).workflowSessions[0];
    return service.call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson' });
  },
  ended: service => until(async () => (await service.call('export')).workflowSessions[0].records.lesson?.teaching?.status !== 'running', 'the teaching', WAIT),
  async view(service) {
    const session = (await service.call('export')).workflowSessions[0], teaching = session?.records?.lesson?.teaching;
    return { status: teaching?.status ?? null, text: hash(teaching?.markdown ?? teaching?.text ?? teaching?.article ?? null) };
  },
};
const assist = {
  async seed(service) {
    await service.store.update(state => {
      state.sources.push({ id: 's', title: 'Lecture', text: 'Bridge separates an abstraction from its implementation so the two can vary independently.' });
      state.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [{ id: 'c', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Two dimensions.',
        explanation: 'Both vary independently.', misconception: 'It adapts interfaces.', citations: [{ sourceId: 's', quote: 'Bridge separates an abstraction from its implementation so the two can vary independently.' }] }] });
    });
  },
  async start(service, context) {
    const { createAssistService } = await import(pathToFileURL(join(context.lib, 'lib/assist.js')).href), { createAssistChildren } = await import(pathToFileURL(join(context.lib, 'lib/assist-child.js')).href);
    context.assist = createAssistService({ children: createAssistChildren() });
    const card = (await service.store.read()).decks[0].cards[0];
    return context.assist.startAssist({}, { root: context.root, service, sessionId: 'parent', mode: 'ask', ref: { deckId: 'd', cardId: 'c' }, text: 'Explain it', helpChoices: [], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' } });
  },
  ended: (_service, context) => until(() => context.assist.assistView(context.root).tasks.every(task => task.status !== 'running'), 'the assist task', WAIT),
  async view(service) {
    const card = (await service.call('export')).decks[0].cards[0];
    return { followups: (card.followups ?? []).length, text: hash((card.followups ?? []).map(item => [item.question, item.answer, item.source])) };
  },
};

export const FAMILIES = { recap, note, translation, workflow, assist };
