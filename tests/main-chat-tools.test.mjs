/* What the main session needs to find before a 「发给主会话」 hand-off can succeed (3.6 S1): the question-deck format (library.context area decks),
   the import limits written from the constants that enforce them, a study_capabilities index small enough to read, the study_materials parameters
   the materials contracts declare, the study_bank append boundary, the job/course/book/MinerU operations, and the study-import skill.
   No model, no network. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { Context } from '@deepseek-ai/cordis';
import { libraryContracts, studyToolDescription } from '../lib/study-contracts.js';
import { CARD_KINDS, REQUIRED_CARD_FIELDS, validateDeck } from '../lib/domain.js';
import { IMPORT_CARD_FIELDS, MAX_JSON_IMPORT_CHARS, prepareJsonImport } from '../lib/json-import.js';
import { MAX_IMPORT_FILES } from '../lib/bulk-import.js';
import { MAX_INGEST_CHARS } from '../lib/ingest.js';
import { LARGE_DOCUMENT_LIMITS } from '../lib/large-documents.js';
import { MAX_OFFICE_BYTES, MAX_TEXT_DOCUMENT_BYTES, megabytes } from '../lib/office/limits.js';
import { PAGE_LIMIT_MAX } from '../lib/book-settings.js';
import { EXAM_FORMATS } from '../lib/courses.js';
import { ACTIONS as JOB_ACTIONS } from '../lib/jobs/contract-schema.js';
import { importExample } from '../lib/deck-format.js';
import { importExample as uiImportExample } from '../ui/json-prompts.js';
import { SELECTION_CHARS } from '../lib/limits.js';
import { extractPdf } from '../lib/documents.js';
import { projectDocument } from '../lib/contexts/materials/files.js';
import { IMPORT_ERROR } from '../lib/import-errors.js';
import { normalizeImportText } from '../lib/bulk-import.js';
import { materialsSchemas } from '../lib/contexts/materials/contracts.js';
import { capabilityIndex, discoveryTool, domainTool, filterCapabilities } from '../lib/runtime/tools.js';
import { parseSkill, studySkills } from '../lib/study-skills.js';

const INDEX_CAP = 8192;
// The host SDK (when installed) turns a tool's parameters into a JSON schema object; without it they stay as written.
const parametersOf = tool => tool.parameters.properties ?? tool.parameters;

async function bundle(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-main-chat-tools-'));
  const ctx = new Context();
  t.after(async () => { await ctx.fiber.dispose(); await rm(root, { recursive: true, force: true }); });
  const patch = parseYaml(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'));
  for (const row of patch.flatMap(layer => layer.insert)) await ctx.plugin(await import(row.name), row.config);
  const api = ctx.studyRuntime;
  const core = { ...api, resolveWorkspace: async () => root, requestServices: async () => ({}) };
  return { root, api, core, runtime: api.runtimeForLibrary(root) };
}

test('area decks: the card format comes from the constants validateDeck and the importer use, with the import page\'s own example', () => {
  const decks = libraryContracts.decks;
  assert.ok(studyToolDescription.includes('decks'), 'decks is listed among the areas');
  assert.ok(decks.includes(REQUIRED_CARD_FIELDS.join(', ')), 'every required field is named');
  assert.ok(decks.includes(CARD_KINDS.join('|')));
  assert.ok(decks.includes(IMPORT_CARD_FIELDS.join(', ')), 'the import whitelist is named');
  for (const rule of [/3-6 options \[\{id,text,correct:boolean,explanation\}\]/, /a quiz has exactly one correct option, a multi at least one and not all/,
    /open: rubric/, /\{\{id\}\} marker per blank/, /no two cards share an objective or a prompt/, /at least 12 characters/, /imported cards may have none/, /any other key is dropped/])
    assert.match(decks, rule);
  assert.match(libraryContracts.imports, /the card format is area decks/, 'the imports area points at it');
  // One example: the same function behind the UI and the contract, and the contract carries it verbatim.
  assert.equal(uiImportExample, importExample);
  const example = JSON.stringify(JSON.parse(importExample('quiz', 'en')));
  assert.ok(decks.endsWith(`Example: ${example}`));
  const { deck } = prepareJsonImport(example);
  assert.deepEqual(deck.quality.errors, [], 'the example imports without errors');
  // Only deck.import takes a bare card array (titled by its file name); draft.import parses the object directly.
  assert.match(decks, /deck\.import also takes a bare card array \(titled by its file name\); draft\.import needs the \{title,cards\} object/);
  assert.doesNotMatch(decks, /^The question-deck format of deck\.import, draft\.import and study_bank append\. A file is \{title,folder\?,course\?,cards:\[\.\.\.\]\} or a bare card array/);
  const bare = JSON.stringify(JSON.parse(importExample('quiz', 'en')).cards);
  assert.throws(() => prepareJsonImport(bare), /JSON 顶层必须是包含 title 和 cards 的对象/);
  assert.equal(JSON.parse(normalizeImportText(bare, 'chapter-3.json')).title, 'chapter-3');
});

test('validateDeck requires exactly REQUIRED_CARD_FIELDS', () => {
  const { source, deck } = prepareJsonImport(importExample('flashcard'));
  assert.deepEqual(validateDeck(deck, [source]).errors, []);
  for (const key of REQUIRED_CARD_FIELDS) {
    const broken = structuredClone(deck);
    delete broken.cards[0][key];
    assert.ok(validateDeck(broken, [source]).errors.includes(`Card 1: ${key} is required`), key);
  }
});

test('area imports: every limit is written from the constant that enforces it', () => {
  const imports = libraryContracts.imports;
  const expected = [`${megabytes(MAX_TEXT_DOCUMENT_BYTES)} MB`, `${megabytes(MAX_OFFICE_BYTES)} MB`, `${LARGE_DOCUMENT_LIMITS.pdfPages} pages`,
    `${SELECTION_CHARS} characters per import`, `up to ${MAX_IMPORT_FILES} files`, `${MAX_JSON_IMPORT_CHARS} characters each`, `(${MAX_INGEST_CHARS} chars)`];
  for (const phrase of expected) assert.ok(imports.includes(phrase), phrase);
  const allowed = new Set([megabytes(MAX_TEXT_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES), LARGE_DOCUMENT_LIMITS.pdfPages, SELECTION_CHARS, MAX_IMPORT_FILES,
    MAX_JSON_IMPORT_CHARS, MAX_INGEST_CHARS].map(String));
  const numbers = [...imports.matchAll(/(\d[\d,]*)\s*(?:MB|pages|files|characters|chars)\b/g)].map(match => match[1]);
  assert.ok(numbers.length >= expected.length);
  for (const number of numbers) assert.ok(allowed.has(number), `${number} in area imports comes from a constant`);
  assert.doesNotMatch(imports, /8 MB\/200 pages/, 'the old hand-copied PDF limit is gone');
  assert.match(imports, /text documents must be UTF-8/);
  // pages cannot import part of a PDF over the page limit: it is checked before pages is read.
  assert.match(imports, /a longer PDF is refused whatever pages says: split it into files first or use MinerU/);
});

test('a PDF over the page limit is refused even when pages picks one page, and the character cap is the one the importers enforce', async () => {
  const count = LARGE_DOCUMENT_LIMITS.pdfPages + 1;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', ''];
  for (let i = 0; i < count; i++) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] >>');
  objects[1] = `<< /Type /Pages /Count ${count} /Kids [${objects.slice(2).map((_, i) => `${i + 3} 0 R`).join(' ')}] >>`;
  let body = '%PDF-1.7\n';
  const offsets = objects.map((object, i) => { const at = Buffer.byteLength(body); body += `${i + 1} 0 obj\n${object}\nendobj\n`; return at; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map(at => `${String(at).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  await assert.rejects(extractPdf({ dataBase64: Buffer.from(body).toString('base64'), pages: [1] }),
    error => error.code === IMPORT_ERROR.TOO_MANY_PAGES && error.limit === LARGE_DOCUMENT_LIMITS.pdfPages);
  assert.equal(SELECTION_CHARS, LARGE_DOCUMENT_LIMITS.selectionChars);
  await assert.rejects(projectDocument(Buffer.from('x'.repeat(SELECTION_CHARS + 1)), { format: 'txt', filename: 'a.txt' }),
    error => error.code === IMPORT_ERROR.TEXT_TOO_LONG && error.limit === SELECTION_CHARS);
  await assert.rejects(projectDocument(Buffer.from([0xff, 0xfe, 0x41]), { format: 'txt', filename: 'a.txt' }), error => error.code === IMPORT_ERROR.NOT_UTF8);
});

test('the operations hand-offs rely on are written down, and every one of them exists', async t => {
  const { organization, learning, book, imports } = libraryContracts;
  assert.ok(organization.includes(`job.control {jobId,action:${JOB_ACTIONS.join('|')},patch?}`));
  assert.match(organization, /job\.output \{jobId,callId,cursor\?\}/);
  assert.match(learning, /course\.get \{id\|name\}/);
  assert.ok(learning.includes(`exam {format:${EXAM_FORMATS.join('|')},`));
  assert.match(learning, /the whole exam object is replaced \(exam:null removes it\), so course\.get first/);
  assert.ok(book.includes(`settings.book.set {patch:{pageLimit:1-${PAGE_LIMIT_MAX}|null}}`));
  for (const action of ['mineru.plan {path}', 'mineru.import {path', 'mineru.retry {jobId}', 'mineru.history.list']) assert.ok(imports.includes(action), action);
  assert.match(imports, /Installing or removing MinerU\/Marker and their settings belong to the Settings page/);
  for (const area of Object.keys(libraryContracts)) assert.ok(libraryContracts[area].length < 6000, `${area} stays under its cap`);
  const { runtime } = await bundle(t);
  for (const action of ['job.control', 'job.output', 'course.get', 'course.save', 'settings.book.set', 'mineru.plan', 'mineru.import', 'mineru.retry',
    'mineru.history.list', 'deck.import', 'draft.import', 'ingest', 'materials.document.import']) assert.equal(runtime.hasAction(action), true, action);
});

test('study_capabilities: a compact index without arguments, exact schemas for a context or an operation', async t => {
  const { core } = await bundle(t);
  const tool = discoveryTool(core);
  assert.deepEqual(Object.keys(parametersOf(tool)).sort(), ['context', 'operation']);
  const index = await tool.execute({}, {});
  const text = JSON.stringify(index);
  assert.ok(text.length < INDEX_CAP, `the index is ${text.length} characters`);
  assert.ok(index.contexts.every(domain => typeof domain.operations === 'string'), 'names only, no schemas');
  assert.doesNotMatch(text, /"input"|state\.read/);
  const materials = index.contexts.find(domain => domain.id === 'materials');
  assert.match(materials.operations, /document\.import\/get/);
  assert.match(index.contexts.find(domain => domain.id === 'jobs').operations, /job\..*control.*output/);
  assert.match(materials.operations, /selection\.resolve\/ask\*/, 'an operation that needs a model it does not have is starred');

  const byContext = await tool.execute({ context: 'materials' }, {});
  assert.deepEqual(byContext.contexts.map(domain => domain.id), ['materials']);
  assert.ok(byContext.contexts[0].operations.find(item => item.name === 'document.import').input, 'a context comes with its schemas');
  const asking = byContext.contexts[0].operations.find(item => item.name === 'selection.ask');
  assert.deepEqual([asking.requiresModel, asking.available, asking.reason], [true, false, 'model_unavailable'], 'a real operation without its model still says so');
  const byApi = await tool.execute({ context: 'materials.v1', operation: 'document.import' }, {});
  assert.deepEqual(byApi.contexts.map(domain => [domain.id, domain.operations.map(item => item.name)]), [['materials', ['document.import']]]);
  assert.ok(JSON.stringify(await tool.execute({ operation: 'document.import' }, {})).length < INDEX_CAP, 'the schema study_materials points at is small');
  const byOperation = await tool.execute({ operation: 'job.control' }, {});
  assert.deepEqual(byOperation.contexts.map(domain => domain.id), ['jobs']);
  assert.equal(byOperation.contexts[0].operations[0].available, undefined, 'available is only written when it is false');
  const near = await tool.execute({ operation: 'mineru' }, {});
  assert.deepEqual(near.contexts, []);
  assert.ok(near.matches.includes('mineru.import') && near.matches.includes('mineru.plan'));
  await assert.rejects(tool.execute({ context: 'nope' }, {}), /Unknown study context: nope\. Known: .*materials/);

  // Without a workspace the tool still says which contexts are installed.
  const bare = discoveryTool({ ...core, resolveWorkspace: async () => undefined });
  assert.deepEqual((await bare.execute({}, {})).contexts, core.contextIds());
  // The helpers on their own.
  const fake = [{ id: 'a', api: 'a.v1', operations: [{ name: 'state.read', available: true }, { name: 'x.get', available: true }, { name: 'x.set', available: false }, { name: 'y', available: true }] }];
  assert.deepEqual(capabilityIndex(fake).contexts, [{ id: 'a', operations: 'x.get/set* y' }]);
  assert.deepEqual(filterCapabilities(fake, { operation: 'x.get' }).contexts[0].operations.map(item => item.name), ['x.get']);
});

test('study_capabilities leaves out a field at its default and keeps every other value, so an unavailable or model-needing operation still says so', () => {
  const plain = { name: 'x.get', description: '', input: { type: 'object' }, output: {}, requiresModel: false, available: true };
  const rich = { name: 'x.ask', description: 'Asks.', input: { type: 'object' }, output: { type: 'object' }, requiresModel: true, available: false, reason: 'model_unavailable' };
  const needsModel = { name: 'x.mark', description: '', input: { type: 'object' }, output: {}, requiresModel: true, available: true };
  const fake = [{ id: 'a', api: 'a.v1', dependencies: [], available: true, operations: [plain, rich, needsModel] }];
  const { contexts: [domain] } = filterCapabilities(fake, { context: 'a' });
  assert.deepEqual(domain, { id: 'a', api: 'a.v1', dependencies: [], operations: [
    { name: 'x.get', input: { type: 'object' } },
    { name: 'x.ask', description: 'Asks.', input: { type: 'object' }, output: { type: 'object' }, requiresModel: true, available: false, reason: 'model_unavailable' },
    { name: 'x.mark', input: { type: 'object' }, requiresModel: true } ] });
  assert.deepEqual(filterCapabilities(fake, { operation: 'x.ask' }).contexts[0].operations, [domain.operations[1]], 'the same by operation name');
  assert.equal(plain.available, true, 'the runtime\'s own answer is not changed');
  assert.ok(JSON.stringify(domain).length < JSON.stringify(fake[0]).length);
});

test('study_materials takes every parameter document.import declares, typed the same', () => {
  const tool = domainTool('materials', {});
  const declared = materialsSchemas['materials.document.import'].input.oneOf[0].properties;
  for (const [name, schema] of Object.entries(declared)) assert.deepEqual(parametersOf(tool)[name], schema, name);
  assert.deepEqual(parametersOf(tool).pages, { type: 'array', items: { type: 'integer' } });
  // The pointer asks for the one schema it needs, not the whole materials context (several times the index cap).
  assert.match(tool.description, /study_capabilities \{operation:"document\.import"\}/);
  assert.doesNotMatch(tool.description, /\{context:"materials"\}/);
});

test('the user docs list every library.context area', async () => {
  for (const [file, lead] of [['main-session-queries.md', 'The areas are '], ['main-session-queries.zh-CN.md', '分区有']]) {
    const line = (await readFile(new URL(`../docs/${file}`, import.meta.url), 'utf8')).split(/\r?\n/).find(row => row.includes(lead));
    const listed = [...line.slice(line.indexOf(lead)).matchAll(/`([a-zA-Z]+)`/g)].map(match => match[1]);
    assert.deepEqual(listed.sort(), Object.keys(libraryContracts).sort(), file);
  }
});

test('study_bank append says it only adds to an existing deck and checks citations; new decks go through deck.import', () => {
  const { description } = domainTool('bank', {});
  assert.match(description, /append only adds to an existing active ordinary deck/);
  assert.match(description, /verbatim citations that match library materials/);
  assert.match(description, /library\.context area decks/);
  assert.match(description, /A new deck goes through study_workspace deck\.import/);
});

test('the study-import skill is registered, parses as YAML, names real actions and copies no limit', async t => {
  const text = await readFile(new URL('../skills/study-import/SKILL.md', import.meta.url), 'utf8');
  const skill = parseSkill(text);
  assert.equal(skill.name, 'study-import');
  assert.match(skill.whenToUse, /发给主会话/);
  assert.match(libraryContracts.imports, /skill study-import/, 'area imports names the skill');
  assert.ok(studySkills().some(item => item.name === 'study-import' && item.content === skill.content));
  // The host's own filesystem provider reads the frontmatter as YAML (study-book too).
  for (const name of ['study-book', 'study-import']) {
    const file = await readFile(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
    const front = parseYaml(/^---\r?\n([\s\S]*?)\r?\n---/.exec(file)[1]);
    assert.equal(front.name, name);
    assert.equal(front.description, parseSkill(file).description);
  }
  for (const rule of [/library\.context \{"area":"imports"\}/, /library\.context \{"area":"decks"\}/, /never quote a limit from memory/,
    /StudyHub's own import first/, /Prefer Node/, /Ask before installing anything/, /only in StudyHub's Settings page/,
    /title carries the original page numbers/, /Never delete, move or overwrite the learner's originals/, /Never pretend to have read an image/,
    /Questions the learner already has/, /Add no questions/, /A recording/, /结束时用中文简短汇报/])
    assert.match(skill.content, rule);
  assert.doesNotMatch(skill.content, /\d[\d,]*\s*(?:MB|KB|GB|pages?|页|characters?|chars?|字符?|files?|个文件)\b/i, 'no hand-copied limit');
  // pages only narrows a PDF within the page limit; a longer one is split into files first (the importer checks the page count before pages).
  assert.doesNotMatch(skill.content, /import it in parts with `pages`/);
  assert.match(skill.content, /A PDF over the page limit .* is refused whatever `pages` says: split it into files first/);
  assert.match(skill.content, /`pages` only narrows a PDF within that limit/);
  for (const limit of [MAX_IMPORT_FILES, MAX_JSON_IMPORT_CHARS, MAX_INGEST_CHARS, LARGE_DOCUMENT_LIMITS.pdfPages, SELECTION_CHARS, megabytes(MAX_TEXT_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES)])
    assert.doesNotMatch(skill.content, new RegExp(`(?<![\\d.]|UTF-)${limit}(?![\\d])`), `${limit} is not written in the skill`);
  const { runtime } = await bundle(t);
  for (const action of ['library.context', 'materials.document.import', 'mineru.plan', 'mineru.import', 'ingest', 'deck.import', 'generate', 'supplement',
    'audio.import', 'audio.settings.get', 'job.status', 'job.wait']) assert.equal(runtime.hasAction(action), true, action);
  for (const named of [...skill.content.matchAll(/`([a-z]+(?:\.[a-z]+)+) \{/g)].map(match => match[1]))
    assert.ok(runtime.hasAction(named) || runtime.hasAction(`materials.${named}`), `${named} is an action`);
});
