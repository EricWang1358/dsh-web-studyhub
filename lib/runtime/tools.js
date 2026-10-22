let defineTool = definition => definition;
try { ({ defineTool } = await import('@deepseek-ai/dsh-tools')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const object = { type: 'object', additionalProperties: true };
const string = { type: 'string' }, integer = { type: 'integer' };
const specs = {
  bank: { name: 'study_bank', description: 'Read JSON question decks (list, get, cards) and append accepted questions once. append only adds to an existing active ordinary deck: {deckId, operationId, expectedVersion (the version get returned), cards}; every card needs the full card format (study_workspace library.context area decks) with verbatim citations that match library materials, and may not repeat a prompt or objective of that deck. A new deck goes through study_workspace deck.import. Existing cards and progress are retained.',
    operations: ['list', 'get', 'cards', 'append'], parameters: { deckId: string, cardId: string, sourceId: string,
      documentId: string, cards: { type: 'array', items: object }, operationId: string, expectedVersion: integer, selection: object } },
  materials: { name: 'study_materials', description: 'Import original documents, resolve visible selected text, ask grounded questions and follow durable question links. study_capabilities {context:"materials"} gives operation schemas.',
    operations: ['document.import', 'document.get', 'document.list', 'document.attach', 'original.status', 'original.probe', 'original.attach', 'original.detach', 'selection.resolve', 'selection.ask', 'outline.suggest', 'outline.save', 'outline.segment', 'outline.clear', 'links.list', 'pages.cards', 'enrich'],
    parameters: { path: string, dataBase64: string, filename: string, format: { type: 'string', enum: ['pdf', 'docx', 'pptx', 'ppt', 'md', 'markdown', 'html', 'txt', 'json'] },
      title: string, pages: { type: 'array', items: integer }, course: string, courses: { type: 'array', items: string },
      documentId: string, sourceId: string, revision: string, quote: string, prefix: string, suffix: string,
      start: integer, end: integer, page: integer, selection: object, question: string, cardId: string, query: string, sourceIds: { type: 'array', items: string },
      mode: { type: 'string', enum: ['reference', 'copy', 'outline', 'chapters'] }, confirm: { type: 'boolean' },
      estimate: { type: 'boolean' }, preview: { type: 'boolean' }, level: integer, segmentLevel: integer, entries: { type: 'array', items: object } } },
  generation: { name: 'study_generate_selection', description: 'Generate reviewed questions from a validated material selection into an existing deck. Persisted candidates can be read or retried. Requires a model for supplement/review.',
    operations: ['selection.supplement', 'selection.get', 'selection.commit', 'selection.review'], parameters: {
      selection: object, deckId: string, operationId: string, expectedVersion: integer, count: integer,
      kind: { type: 'string', enum: ['quiz', 'multi', 'open', 'flashcard', 'cloze'] }, focus: string } },
  study: { name: 'study_practice', description: 'Start, continue and grade practice through the independent study policy API. Keep answers hidden before reveal. After the learner answers, teach.start explicitly selects mode understanding or calculation; teach.answer submits only their current-step answer with stepIndex. Never answer or advance on their behalf.',
    operations: ['review.start', 'review.get', 'review.reveal', 'review.answer', 'review.move', 'review.end', 'exam.report', 'teach.start', 'teach.get', 'teach.answer'], parameters: {
      deckId: string, runId: string, cardId: string, mode: string, grade: integer,
      selected: { type: 'array', items: string }, answers: object, index: integer, fresh: { type: 'boolean' },
      id: string, answer: string, stepIndex: integer, queueVersion: integer, language: { type: 'string', enum: ['zh', 'en'] } } },
  audio: { name: 'study_audio', description: 'Manage independent transcription, timestamped subtitle imports, correction review and live recordings; content publishing uses installed material and question APIs.',
    operations: ['results', 'result.get', 'jobs', 'job.wait', 'job.cancel', 'audio.settings.get', 'audio.import', 'audio.retry', 'audio.subtitles.import', 'audio.corrections.review', 'live.list', 'live.get', 'live.save'],
    parameters: { path: string, uploadId: string, files: { type: 'array', items: { type: 'object', properties: { path: string, uploadId: string }, additionalProperties: false } },
      id: string, jobId: string, title: string, course: string,
      filename: string, text: string, sourceId: string, subject: string, terms: { oneOf: [string, { type: 'array', items: string }] }, courses: { type: 'array', items: string }, paidOnly: { type: 'boolean' },
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
      const value = id === 'materials' && (operation === 'links.list' || operation === 'pages.cards')
        ? await runtime.call(`materials.${operation}`, args, services) : await runtime.invoke(`${id}.v1`, operation, args, services);
      return JSON.parse(JSON.stringify(value && typeof value === 'object' && !Array.isArray(value) ? value : { result: value ?? null }));
    },
  });
}

/* study_capabilities without arguments is an index the model can afford to read (every schema at once was about 106 000 characters with every StudyHub part installed):
   per context its id and operation names, one prefix written once (audio.settings.get/set), * after a name that needs a model it does not
   have now. state.read is the contexts' own read of each other and is left out. {context} and/or {operation} return the exact schemas. */
const INTERNAL = new Set(['state.read']);
const compactNames = operations => {
  const groups = [];
  for (const { name, available } of operations) {
    if (INTERNAL.has(name)) continue;
    const cut = name.lastIndexOf('.'), prefix = cut > 0 ? name.slice(0, cut) : '', label = `${cut > 0 ? name.slice(cut + 1) : name}${available ? '' : '*'}`;
    const last = groups.at(-1);
    if (prefix && last?.prefix === prefix) last.labels.push(label); else groups.push({ prefix, labels: [label] });
  }
  return groups.map(({ prefix, labels }) => (prefix ? `${prefix}.` : '') + labels.join('/')).join(' ');
};

/** The no-argument answer: { contexts: [{ id, operations: 'a.b/c d' }] } plus how to ask for schemas. */
export function capabilityIndex(contexts) {
  return { contexts: contexts.map(domain => ({ id: domain.id, operations: compactNames(domain.operations) })),
    note: 'Operation names only; * needs a model that is not available now. Call study_capabilities {context} or {operation} (e.g. document.import) for exact input schemas.' };
}

/** {context} (an id like materials or its api materials.v1) and/or {operation} (an exact name): those contexts and operations with their schemas. */
export function filterCapabilities(contexts, { context, operation } = {}) {
  const known = contexts.filter(domain => !context || domain.id === context || domain.api === context);
  if (context && !known.length) throw new Error(`Unknown study context: ${context}. Known: ${contexts.map(domain => domain.id).join(', ')}`);
  if (!operation) return { contexts: known };
  const found = known.map(domain => ({ ...domain, operations: domain.operations.filter(item => item.name === operation) })).filter(domain => domain.operations.length);
  if (found.length) return { contexts: found };
  const near = [...new Set(known.flatMap(domain => domain.operations.map(item => item.name)).filter(name => !INTERNAL.has(name) && name.includes(operation)))].slice(0, 40);
  return { contexts: [], matches: near, note: near.length ? 'No operation has exactly this name; these contain it.' : 'No operation has this name.' };
}

export function discoveryTool(core) {
  return defineTool({ name: 'study_capabilities', description: 'Discover installed study APIs. Without arguments: a compact index of context ids and operation names. {context} and/or {operation} return exact input schemas and current model capability states.',
    parameters: { context: string, operation: string }, output: { schema: object, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    execute: async ({ context, operation } = {}, execution) => {
      const root = await core.resolveWorkspace(execution);
      if (!root) return { contexts: core.contextIds() };
      const contexts = core.forLibrary(root).capabilities(await core.requestServices(execution) || {});
      return context || operation ? filterCapabilities(contexts, { context, operation }) : capabilityIndex(contexts);
    },
  });
}
