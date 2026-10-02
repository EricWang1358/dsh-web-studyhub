let defineTool = definition => definition;
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const object = { type: 'object', additionalProperties: true };
const string = { type: 'string' }, integer = { type: 'integer' };
const specs = {
  bank: { name: 'study_bank', description: 'Read JSON question decks and append accepted questions once. Existing cards and progress are retained.',
    operations: ['list', 'get', 'cards', 'append'], parameters: { deckId: string, cardId: string, sourceId: string,
      documentId: string, cards: { type: 'array', items: object }, operationId: string, expectedVersion: integer, selection: object } },
  materials: { name: 'study_materials', description: 'Import original documents, resolve visible selected text, ask grounded questions and follow durable question links. runtime.describe gives operation schemas.',
    operations: ['document.import', 'document.get', 'document.list', 'document.attach', 'selection.resolve', 'selection.ask', 'outline.suggest', 'outline.save', 'outline.clear', 'links.list', 'enrich'],
    parameters: { path: string, dataBase64: string, filename: string, format: { type: 'string', enum: ['pdf', 'docx', 'pptx', 'md', 'markdown', 'html', 'txt', 'json'] },
      title: string, documentId: string, sourceId: string, revision: string, quote: string, prefix: string, suffix: string,
      start: integer, end: integer, page: integer, selection: object, question: string, cardId: string, query: string,
      estimate: { type: 'boolean' }, entries: { type: 'array', items: object } } },
  generation: { name: 'study_generate_selection', description: 'Generate reviewed questions from a validated material selection into an existing deck. Persisted candidates can be read or retried. Requires a model for supplement/review.',
    operations: ['selection.supplement', 'selection.get', 'selection.commit', 'selection.review'], parameters: {
      selection: object, deckId: string, operationId: string, expectedVersion: integer, count: integer,
      kind: { type: 'string', enum: ['quiz', 'multi', 'open', 'flashcard', 'cloze'] }, focus: string } },
  study: { name: 'study_practice', description: 'Start, continue and grade practice through the independent study policy API. Keep answers hidden before reveal.',
    operations: ['review.start', 'review.get', 'review.reveal', 'review.answer', 'review.move', 'review.end', 'exam.report'], parameters: {
      deckId: string, runId: string, cardId: string, mode: string, grade: integer,
      selected: { type: 'array', items: string }, answers: object, index: integer, fresh: { type: 'boolean' } } },
  audio: { name: 'study_audio', description: 'Manage independent transcription, timestamped subtitle imports, correction review and live recordings; content publishing uses installed material and question APIs.',
    operations: ['results', 'result.get', 'jobs', 'job.wait', 'job.cancel', 'audio.settings.get', 'audio.import', 'audio.retry', 'audio.subtitles.import', 'audio.corrections.review', 'live.list', 'live.get', 'live.save'],
    parameters: { path: string, paths: { type: 'array', items: string }, id: string, jobId: string, title: string, course: string,
      filename: string, text: string, sourceId: string, subject: string, terms: string, courses: { type: 'array', items: string }, paidOnly: { type: 'boolean' },
      timeoutSeconds: { type: 'number' }, all: { type: 'boolean' }, proofread: { type: 'boolean' } } },
};

/** One compact typed domain tool; no serialized argument string or duplicated long prompt. */
export function domainTool(id, core) {
  const spec = specs[id];
  if (!spec) return null;
  return defineTool({ name: spec.name, description: spec.description,
    parameters: { operation: { type: 'string', enum: spec.operations, required: true }, ...spec.parameters },
    output: { schema: object, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async ({ operation, ...args }, execution) => {
      const root = await core.resolveWorkspace(execution);
      if (!root) throw new Error('A session workspace is required');
      const services = await core.requestServices(execution) || {};
      const runtime = core.forLibrary(root);
      const value = id === 'materials' && operation === 'links.list'
        ? await runtime.call('materials.links.list', args, services) : await runtime.invoke(`${id}.v1`, operation, args, services);
      return JSON.parse(JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value ?? null }));
    },
  });
}

export function discoveryTool(core) {
  return defineTool({ name: 'study_capabilities', description: 'Discover installed study APIs, exact operation schemas and current model capability states.',
    parameters: {}, output: { schema: object, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async (_args, execution) => {
      const root = await core.resolveWorkspace(execution);
      return { contexts: root ? core.forLibrary(root).capabilities(await core.requestServices(execution) || {}) : core.contextIds() };
    },
  });
}
