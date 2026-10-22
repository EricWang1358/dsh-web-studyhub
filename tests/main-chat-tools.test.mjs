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
    `up to ${MAX_IMPORT_FILES} files`, `${MAX_JSON_IMPORT_CHARS} characters each`, `(${MAX_INGEST_CHARS} chars)`];
  for (const phrase of expected) assert.ok(imports.includes(phrase), phrase);
  const allowed = new Set([megabytes(MAX_TEXT_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES), LARGE_DOCUMENT_LIMITS.pdfPages, MAX_IMPORT_FILES,
    MAX_JSON_IMPORT_CHARS, MAX_INGEST_CHARS].map(String));
  const numbers = [...imports.matchAll(/(\d[\d,]*)\s*(?:MB|pages|files|characters|chars)\b/g)].map(match => match[1]);
  assert.ok(numbers.length >= expected.length);
  for (const number of numbers) assert.ok(allowed.has(number), `${number} in area imports comes from a constant`);
  assert.doesNotMatch(imports, /8 MB\/200 pages/, 'the old hand-copied PDF limit is gone');
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
  const byApi = await tool.execute({ context: 'materials.v1', operation: 'document.import' }, {});
  assert.deepEqual(byApi.contexts.map(domain => [domain.id, domain.operations.map(item => item.name)]), [['materials', ['document.import']]]);
  const byOperation = await tool.execute({ operation: 'job.control' }, {});
  assert.deepEqual(byOperation.contexts.map(domain => domain.id), ['jobs']);
  assert.equal(byOperation.contexts[0].operations[0].available, true);
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

test('study_materials takes every parameter document.import declares, typed the same', () => {
  const tool = domainTool('materials', {});
  const declared = materialsSchemas['materials.document.import'].input.oneOf[0].properties;
  for (const [name, schema] of Object.entries(declared)) assert.deepEqual(parametersOf(tool)[name], schema, name);
  assert.deepEqual(parametersOf(tool).pages, { type: 'array', items: { type: 'integer' } });
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
  for (const limit of [MAX_IMPORT_FILES, MAX_JSON_IMPORT_CHARS, MAX_INGEST_CHARS, LARGE_DOCUMENT_LIMITS.pdfPages, megabytes(MAX_TEXT_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES)])
    assert.doesNotMatch(skill.content, new RegExp(`(?<![\\d.])${limit}(?![\\d])`), `${limit} is not written in the skill`);
  const { runtime } = await bundle(t);
  for (const action of ['library.context', 'materials.document.import', 'mineru.plan', 'mineru.import', 'ingest', 'deck.import', 'generate', 'supplement',
    'audio.import', 'audio.settings.get', 'job.status', 'job.wait']) assert.equal(runtime.hasAction(action), true, action);
  for (const named of [...skill.content.matchAll(/`([a-z]+(?:\.[a-z]+)+) \{/g)].map(match => match[1]))
    assert.ok(runtime.hasAction(named) || runtime.hasAction(`materials.${named}`), `${named} is an action`);
});
