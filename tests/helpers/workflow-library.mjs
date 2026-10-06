/* The library and the model the learning-workflow tests share (the S4-0 baseline and the runtime tests). Fakes only: no model, no network. */
import { StudyService } from '../../lib/service.js';
import { until } from './wait.mjs';
import { privateRoot } from './model-family-baseline.mjs';
import { SWITCH_MODE, switchOptions } from './runtime-switch.mjs';

export const quote = '缓存命中要求请求可以使用已保存的结果，且结果没有过期。';
export const article = ['## 从一次请求开始', '## 一步一步推演', '## 边界与易错点'].map(heading => `${heading}\n\n${'这是为说明机制而设定的演示条件，资料本身仅给出复用和有效性的条件。先检查请求，再检查有效期，两项都满足才能复用，否则回源。'.repeat(4)}`).join('\n\n');
export const approved = JSON.stringify({ grounded: true, coherent: true, explained: true, example: true, boundaries: true, issues: [] });

/** A model that tells a lesson from its review, records what each was given, and can hold the n-th teaching call. */
export function model() {
  const control = { lessons: [], reviews: [], gates: new Map() };
  control.complete = async (system, prompt) => {
    if (system.startsWith('Independently')) { control.reviews.push(JSON.parse(prompt)); return approved; }
    const number = control.lessons.length;
    control.lessons.push(JSON.parse(prompt));
    await control.gates.get(number)?.promise;
    return JSON.stringify({ markdown: article, citations: [{ sourceId: 'source', quote }] });
  };
  return control;
}
export async function library(t, options = {}, sessions = 1, mode = SWITCH_MODE) {
  const root = await privateRoot(t, 'model-baseline-workflow-');
  const service = new StudyService(root, { ...options, ...switchOptions(mode, { complete: options.complete, paths: ['workflow'] }) });
  t.after(() => service.dispose());
  await service.store.update(state => {
    state.sources.push({ id: 'source', title: '缓存资料', text: `${quote}未命中时仍需访问原始服务。` });
    state.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
  });
  const template = await service.call('workflow.save', { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
  const started = [];
  for (let i = 0; i < sessions; i++) started.push(await service.call('workflow.session.start', { templateId: template.id, topic: `缓存 ${i}`, scope: [{ deckId: 'deck' }], requestId: `start-${i}` }));
  return { root, service, session: started[0], sessions: started };
}
export const teach = (call, session, extra = {}) => call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson', ...extra });
export const finished = (call, id) => until(async () => { const { session } = await call('workflow.session.get', { id }); return session.records.lesson?.teaching?.status !== 'running' && session; }, 'the teaching to end');

