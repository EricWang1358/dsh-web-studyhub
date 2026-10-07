/* The library and the model the translation tests share (the S4-0 baseline and the runtime tests). Fakes only: no model, no network. */
import { createStudyRuntime } from '../../lib/runtime/builtins.js';
import { privateRoot } from './model-family-baseline.mjs';
import { SWITCH_MODE, switchOptions } from './runtime-switch.mjs';

export const lines = prefix => Array.from({ length: 8 }, (_, index) => `${prefix} paragraph ${index} explains one more consequence of the architecture in some detail.`);
export const body = (prefix, extra = []) => `# ${prefix}\n\n${[...lines(prefix), ...extra].join('\n\n')}\n`;
export const zh = text => `译文：${'字'.repeat(Math.ceil(text.replace(/\s/g, '').length * 0.5))}`;
export const upload = (name, text, documentId) => ({ filename: name, ...(documentId ? { documentId } : {}), dataBase64: Buffer.from(text).toString('base64') });

/** Answers every batch like a careful translator; `gates` holds the n-th call until released. */
export function model() {
  const control = { calls: [], gates: new Map(), signals: [] };
  control.complete = async (_system, prompt, options = {}) => {
    const data = JSON.parse(prompt), number = control.calls.length;
    control.calls.push(data); control.signals.push(options.signal);
    const held = control.gates.get(number);
    if (held) await new Promise((resolve, reject) => { held.promise.then(resolve); options.signal?.addEventListener('abort', () => reject(options.signal.reason), { once: true }); });
    options.signal?.throwIfAborted();
    return JSON.stringify({ translations: data.passages.map(passage => ({ id: passage.id, text: zh(passage.text) })) });
  };
  return control;
}

export async function library(t, fake = model(), mode = SWITCH_MODE, { notify = () => {} } = {}) {
  const root = await privateRoot(t, 'model-baseline-translation-');
  const runtime = createStudyRuntime(root, { complete: fake.complete, notify, language: 'zh', ...switchOptions(mode, { complete: fake.complete, paths: ['translation'] }) });
  t.after(() => runtime.dispose());
  const one = async (prefix, extra) => {
    const imported = await runtime.call('materials.document.import', upload(`${prefix}.md`, body(prefix, extra)));
    return { documentId: imported.documentId, revision: imported.revision, sourceId: imported.document.sources[0].id, scope: { sourceIds: [imported.document.sources[0].id] } };
  };
  const items = (documentId, extra = {}) => runtime.call('materials.translation.list', { documentId, ...extra });
  return { root, runtime, fake, one, items };
}
export const row = (runtime, jobId) => runtime.call('snapshot').then(snapshot => snapshot.jobs.find(job => job.id === jobId));

