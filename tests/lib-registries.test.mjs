import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as jobStatus from '../lib/job-status.js';
import * as providers from '../lib/audio-providers.js';
import * as formats from '../lib/audio-formats.js';
import * as limits from '../lib/limits.js';
import { KEY_FIELDS, AUDIO_DEFAULTS, publicAudioSettings } from '../lib/audio-settings.js';
import { TRANSCRIPTION_TIERS } from '../lib/audio-preflight.js';
import { addUsage, requestsOf } from '../lib/audio-usage.js';
import { AUDIO_EXTENSIONS, MAX_AUDIO_BYTES } from '../lib/audio-file.js';
import { LARGE_DOCUMENT_LIMITS } from '../lib/large-documents.js';
import { loadUi } from './helpers/ui-module.mjs';

// #128 #119 #120 #121: constants that used to be written out in several places live in one pure module that both
// the browser and the host import.
const source = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const BROWSER_SAFE = ['lib/job-status.js', 'lib/audio-providers.js', 'lib/audio-formats.js', 'lib/limits.js'];

test('the registries are pure data: no Node imports, so the browser can bundle them', async () => {
  for (const path of BROWSER_SAFE) assert.doesNotMatch(await source(path), /from\s+['"]node:|require\(/, path);
});

test('job status: what is active, what can be stopped, and the job types', async () => {
  const { JOB_STATUS, JOB_TYPES, isActiveJob, isCancellable } = jobStatus;
  assert.deepEqual(Object.values(JOB_STATUS).sort(), ['cancelled', 'cancelling', 'complete', 'failed', 'interrupted', 'queued', 'running']);
  for (const status of ['queued', 'running', 'cancelling']) assert.equal(isActiveJob({ status }), true, status);
  for (const status of ['complete', 'failed', 'cancelled', 'interrupted', 'done', undefined]) assert.equal(isActiveJob({ status }), false, String(status));
  assert.equal(isActiveJob(undefined), false);
  assert.equal(isCancellable({ status: 'queued' }), true);
  assert.equal(isCancellable({ status: 'running' }), true);
  assert.equal(isCancellable({ status: 'cancelling' }), false, 'already stopping');
  assert.equal(isCancellable({ status: 'complete' }), false);
  assert.deepEqual(JOB_TYPES, { AUDIO_IMPORT: 'audio-import', AUDIO_BATCH: 'audio-batch', AUDIO_SUBTITLES: 'audio-subtitles', AUDIO_REVIEW: 'audio-review', AUDIO_LIVE_SAVE: 'audio-live-save', AUDIO_LIVE_CORRECTION: 'audio-live-correction', PDF_CONVERT: 'pdf-convert', TRANSLATION: 'translation', SUPPLEMENT: 'supplement', DRAFT_REPAIR: 'draft-repair', DRAFT_PUBLISH: 'draft-publish', COACH_DAILY: 'coach-daily' });
  assert.ok(Object.isFrozen(JOB_STATUS) && Object.isFrozen(JOB_TYPES));
  const visibility = await loadUi(`export * from './ui/job-visibility.js';`);
  assert.equal(visibility.isActiveJob({ status: 'cancelling' }), true, 'job-visibility keeps its export');
  assert.equal(visibility.isCancellable({ status: 'cancelling' }), false, 'and the new predicate is available there too');
  assert.match(await source('ui/job-visibility.js'), /from '\.\.\/lib\/job-status\.js'/, 'it re-exports the registry, it does not copy it');
  assert.doesNotMatch(await source('ui/job-visibility.js'), /const ACTIVE/);
  assert.deepEqual(visibility.visibleGenerationJobs([{ id: 'a', status: 'running' }, { id: 'b', status: 'complete' }]).map(job => job.id), ['a', 'b']);
});

test('audio providers: one row per tier, in request order, with every link once', () => {
  const { AUDIO_PROVIDERS, AUDIO_TIERS, providerOf, providersFor } = providers;
  assert.deepEqual(AUDIO_PROVIDERS.map(provider => provider.tier), ['free', 'siliconflow', 'groq', 'paid']);
  assert.deepEqual(AUDIO_TIERS, ['free', 'siliconflow', 'groq', 'paid']);
  for (const provider of AUDIO_PROVIDERS) {
    assert.equal(provider.keyField, `${provider.tier}Key`);
    for (const field of ['name', 'shortName', 'badge', 'consoleUrl', 'keyUrl', 'usageUrl']) assert.ok(typeof provider[field] === 'string' && provider[field], `${provider.tier}.${field}`);
    for (const field of ['consoleUrl', 'keyUrl', 'usageUrl']) assert.match(provider[field], /^https:\/\//);
    assert.match(provider.name + provider.shortName + provider.badge, /[㐀-鿿]|Groq|Gemini/);
  }
  assert.deepEqual(AUDIO_PROVIDERS.map(provider => provider.requestOrder), [0, 1, 2, 3]);
  assert.equal(providerOf('groq').keyField, 'groqKey');
  assert.equal(providerOf('nope'), undefined);
  assert.deepEqual(providersFor('zh').map(provider => provider.tier), ['siliconflow', 'groq', 'free'], 'mainland first; paid is not a card');
  assert.deepEqual(providersFor('en').map(provider => provider.tier), ['groq', 'free', 'siliconflow']);
  assert.ok(Object.isFrozen(AUDIO_PROVIDERS) && Object.isFrozen(AUDIO_PROVIDERS[0]));
});

test('the backend derives its key fields, tiers and tallies from the registry', () => {
  assert.deepEqual([...KEY_FIELDS], providers.AUDIO_PROVIDERS.map(provider => provider.keyField));
  assert.deepEqual([...TRANSCRIPTION_TIERS], providers.AUDIO_TIERS);
  for (const field of KEY_FIELDS) assert.equal(AUDIO_DEFAULTS[field], '');
  const shown = publicAudioSettings({ ...AUDIO_DEFAULTS, groqKey: 'gsk_abcdefghijklmnopqrstuvwxyz1234', siliconflowKey: '' });
  assert.deepEqual(shown.groqKey, { set: true, hint: '••••1234' });
  for (const field of KEY_FIELDS) assert.deepEqual(Object.keys(shown[field]).sort(), ['hint', 'set']);
  const total = addUsage({ free: { requests: 2 }, groq: { requests: 1 } }, { siliconflow: { requests: 4 }, paid: { requests: 1, audioSeconds: 600 } });
  assert.deepEqual(Object.keys(total).filter(key => key !== 'estimatedPaidTranscribeUsd'), providers.AUDIO_TIERS);
  assert.equal(requestsOf(total), 8);
});

test('audio formats: one list of extensions, types and limits, shared with the file reader', () => {
  const { AUDIO_MIME, SUBTITLE_EXTENSIONS, SUBTITLE_TIMED_EXTENSIONS } = formats;
  assert.deepEqual([...formats.AUDIO_EXTENSIONS], ['.mp3', '.wav', '.m4a', '.aac', '.ogg', '.flac', '.opus', '.webm', '.aiff', '.aif']);
  assert.equal(AUDIO_MIME['.m4a'], 'audio/m4a');
  assert.equal(AUDIO_MIME['.aif'], 'audio/aiff');
  assert.equal(formats.MAX_AUDIO_BYTES, 512 * 1024 * 1024);
  assert.equal(formats.MAX_SUBTITLE_BYTES, 8 * 1024 * 1024);
  assert.deepEqual([...SUBTITLE_EXTENSIONS], ['.srt', '.vtt', '.json', '.txt']);
  assert.deepEqual([...SUBTITLE_TIMED_EXTENSIONS], ['.srt', '.vtt']);
  assert.equal(AUDIO_EXTENSIONS, formats.AUDIO_EXTENSIONS, 'lib/audio-file.js re-exports the registry');
  assert.equal(MAX_AUDIO_BYTES, formats.MAX_AUDIO_BYTES);
});

test('question counts and the selection size have one definition each', async () => {
  assert.deepEqual({ ...limits.QUESTION_COUNT }, { min: 1, max: 50 });
  assert.ok(Object.isFrozen(limits.QUESTION_COUNT));
  assert.equal(limits.SELECTION_CHARS, LARGE_DOCUMENT_LIMITS.selectionChars);
  assert.equal(limits.isQuestionCount(1), true);
  assert.equal(limits.isQuestionCount(50), true);
  assert.equal(limits.isQuestionCount(51), false);
  assert.equal(limits.isQuestionCount(0), false);
  assert.equal(limits.isQuestionCount(2.5), false);
  assert.equal(limits.isQuestionCount('10'), false);
  for (const path of ['lib/workflows.js', 'lib/study-state.js', 'lib/contexts/study/operations.js'])
    assert.doesNotMatch(await source(path), /count\s*>\s*50/, `${path} reads the constant`);
  for (const path of ['lib/batch.js', 'lib/documents.js', 'lib/contexts/materials/files.js', 'lib/office/index.js'])
    assert.doesNotMatch(await source(path), /\b600_?000\b(?!\s*字符)/, `${path} reads the constant`);
});

test('a workflow step takes the largest question count and refuses one more, with the limit in the message', async () => {
  const { validateWorkflow } = await import('../lib/workflows.js');
  const step = (count) => ({ title: '流程', description: '', steps: [{ id: 'a', kind: 'quiz', title: '步骤', count }] });
  const { kind } = (await import('../lib/workflow-contract.js')).WORKFLOW_COMPONENTS[0];
  const input = (count) => ({ ...step(count), steps: [{ ...step(count).steps[0], kind }] });
  assert.equal(validateWorkflow(input(limits.QUESTION_COUNT.max)).steps[0].count, limits.QUESTION_COUNT.max);
  assert.equal(validateWorkflow(input(limits.QUESTION_COUNT.min)).steps[0].count, limits.QUESTION_COUNT.min);
  assert.throws(() => validateWorkflow(input(limits.QUESTION_COUNT.max + 1)), new RegExp(`${limits.QUESTION_COUNT.min}–${limits.QUESTION_COUNT.max}`));
  assert.throws(() => validateWorkflow(input(limits.QUESTION_COUNT.min - 1)), /练习题数/);
});
