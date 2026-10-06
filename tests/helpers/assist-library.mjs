/* The library, the host and the requests the assistant tests share (the S4-0 baseline and the runtime tests). Fakes only: no model, no network. */
import { StudyService } from '../../lib/service.js';
import { until } from './wait.mjs';
import { privateRoot } from './model-family-baseline.mjs';
import { SWITCH_MODE, switchOptions } from './runtime-switch.mjs';

export const evidence = 'Bridge separates an abstraction from its implementation so the two can vary independently.';
export const card = { id: 'c', kind: 'flashcard', topic: 'Bridge', objective: 'Explain Bridge', prompt: 'What does Bridge separate?', answer: 'Abstraction and implementation.', hint: 'Two dimensions.',
  explanation: 'Both vary independently.', misconception: 'It adapts interfaces.', citations: [{ sourceId: 's', quote: evidence }] };
export const reply = '{"answer":"Two independent dimensions."}';

export async function library(t, options = {}, mode = SWITCH_MODE) {
  const root = await privateRoot(t, 'model-baseline-assist-');
  const service = new StudyService(root, { ...options, ...switchOptions(mode, { complete: options.complete, paths: ['assist'] }) });
  t.after(() => service.dispose());
  await service.store.update(state => { state.sources.push({ id: 's', title: 'Lecture', text: evidence }); state.decks.push({ id: 'd', title: 'Patterns', course: 'Software', cards: [structuredClone(card)] }); });
  return { root, service };
}
/** A host with a running parent session whose sub-agent service answers with `output` once released. */
export function nativeHost(output = reply, release = Promise.resolve()) {
  const calls = { started: [], disposed: [] };
  const subagents = { getProvider: () => ({ capabilities: { toolFilter: true, agentOptions: true } }), start: async (_kind, request) => {
    calls.started.push(request);
    return { id: `child-${calls.started.length}`, result: release.then(() => ({ stopReason: 'completed', output: [{ type: 'text', text: output }] })), dispose: async () => calls.disposed.push(`child-${calls.started.length}`) };
  } };
  return { calls, ctx: { sessions: { get: () => undefined }, get: key => (key === 'agents' ? { get: () => ({ id: 'parent' }) } : key === 'subagents' ? subagents : undefined) } };
}
export const request = (service, root, extra = {}) => ({ root, service, sessionId: 'parent', mode: 'ask', ref: { deckId: 'd', cardId: 'c' }, text: 'Explain it', helpChoices: ['example'], card, deckTitle: 'Patterns', route: { provider: 'p', model: 'm' }, ...extra });
export const ended = (assist, root) => until(() => assist.assistView(root).tasks.every(task => task.status !== 'running'), 'the assist task to end');

