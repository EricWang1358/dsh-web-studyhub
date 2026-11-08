/* One library, one model and one host for the P4 mixed run (S4-9): a translation, a generation and a daily recap, each started
   the way its own door starts it, on one service (learning workflows are retired in S5 and verified read-only separately). Fakes only: no model, no network. */
import { stagedModel } from './generation-baseline.mjs';
import { seeded, answer, writing } from './recap-library.mjs';
import { quote, article, approved } from './workflow-library.mjs';
import { zh, body, upload } from './translation-library.mjs';
import { saveWorkflow, startSession } from '../../lib/workflows.js';
import { reportUsage } from '../../lib/usage-scope.js';
import { stageSystem } from '../../lib/prompt-order.js';

/** Every active switch of the model families. */
export const ALL_FAMILIES = Object.freeze(['translation', 'generation', 'dailyRecap']);
export const ALL_POLICIES = Object.freeze(['translationParallel', 'dailyRecapAgent']);
const TRANSLATOR = 'You are a careful translator';
const GENERATION = ['Plan a source-grounded', 'Prepare supported answers', 'You author rigorous', 'Act as a strict'];

/** A host with a parent session and a sub-agent service; `replyFor(text)` answers what the child is given. */
export function childHost({ replyFor }) {
  const started = [], disposed = [];
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async (_kind, request) => {
    started.push(request);
    const id = `child-${started.length}`, text = replyFor(request.prompt.map(block => block.text).join('\n'));
    return { id, result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text }] }), dispose: async () => { disposed.push(id); } };
  } };
  return { started, disposed, ctx: { sessions: { get: () => undefined }, get: key => (key === 'agents' ? { get: () => ({ id: 'parent' }) } : key === 'subagents' ? subagents : undefined) } };
}

/** What one family answers. `held` maps a family to a gate its first call waits for. */
export function mixedModel({ held = {}, usage = true } = {}) {
  const staged = stagedModel({ holdAt: 'plan', hold: held.generation });
  const live = { translation: 0, generation: 0, recap: 0 }, peak = { translation: 0, generation: 0, recap: 0, all: 0 }, calls = [];
  const familyOf = (system, prompt) => {
    if (system.startsWith(TRANSLATOR)) return 'translation';
    if (GENERATION.some(start => stageSystem(system, prompt).startsWith(start))) return 'generation';
    return 'recap';
  };
  const complete = async (system, prompt, options = {}) => {
    const family = familyOf(system, prompt);
    calls.push(family);
    live[family] += 1; peak[family] = Math.max(peak[family], live[family]); peak.all = Math.max(peak.all, Object.values(live).reduce((a, b) => a + b, 0));
    try {
      if (usage) reportUsage({ uncachedInputTokens: 40, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 });
      if (held[family] && !held[family].taken) { held[family].taken = true; held[family].entered = true; await held[family].promise; }
      options.signal?.throwIfAborted();
      if (family === 'translation') return JSON.stringify({ translations: JSON.parse(prompt).passages.map(passage => ({ id: passage.id, text: zh(passage.text) })) });
      if (family === 'generation') return staged.complete(system, prompt, options);
      return writing;
    } finally { live[family] -= 1; }
  };
  return { complete, live, peak, calls, staged };
}

/** The reply a sub-agent gives, by what the family asks it. */
export const childReply = text => {
  if (text.startsWith(TRANSLATOR)) return JSON.stringify({ translations: JSON.parse(text.split('\n\n').at(-1)).passages.map(passage => ({ id: passage.id, text: zh(passage.text) })) });
  if (text.startsWith('Independently')) return approved;
  return text.includes('"stage"') ? writing : JSON.stringify({ markdown: article, citations: [{ sourceId: 'source', quote }] });
};

/** The service with `on` switched on, seeded for the active families and a read-only historical workflow session; returns the doors of each. */
export async function mixedLibrary(t, { on = [...ALL_FAMILIES, ...ALL_POLICIES], model = mixedModel(), host } = {}) {
  const service = await seeded(t, { complete: model.complete, paths: on, nativeHost: host }, 'runtime');
  await answer(service, 40);
  let session;
  await service.store.update(state => {
    state.sources.push({ id: 'source', title: '缓存资料', text: `${quote}未命中时仍需访问原始服务。` }, { id: 's', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' });
    state.decks.push({ id: 'deck', title: '缓存', cards: [{ id: 'card', topic: '缓存', kind: 'flashcard', prompt: '如何判断可复用？', answer: '检查请求和有效期', explanation: quote, citations: [{ sourceId: 'source', quote }] }] });
    const template = saveWorkflow(state, { title: '讲解与复述', steps: [{ id: 'lesson', kind: 'lesson', title: '概念与例子' }, { id: 'recall', kind: 'recall', title: '复述' }] });
    session = startSession(state, { templateId: template.id, topic: '缓存', scope: [{ deckId: 'deck' }], requestId: 'start-1' });
  });
  const imported = await service.call('materials.document.import', upload('Alpha.md', body('Alpha')));
  const doc = { documentId: imported.documentId, scope: { sourceIds: [imported.document.sources[0].id] } };
  return {
    service, model, doc, session, host,
    translate: (extra = {}) => service.call('generation.translation.start', { ...doc, ...extra }),
    generate: () => service.call('generate', { sourceIds: ['s'], count: 1, kind: 'flashcard' }),
    recap: () => service.call('note.daily.generate', { course: '数学 / 第一章' }),
    teach: () => service.call('workflow.teaching.start', { id: session.id, version: session.version, stepId: 'lesson', mode: 'lesson' }),
  };
}
