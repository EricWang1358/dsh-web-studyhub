import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadUi } from './helpers/ui-module.mjs';
import { jobContract } from '../lib/job-contract.js';

/* The 任务 console names the kind of a task under its title. Every kind of the audio family has its own name (S6-7: the real host showed a subtitle import as 「音频批量转写」). */

const { taskSummary } = await loadUi(`export { taskSummary } from './ui/tasks/task-summary.js'; export { setUiLanguage } from './ui/i18n.js';`);
const card = (kind, extra = {}) => ({ contract: { ...jobContract({ type: 'audio-import', id: 'job-1', status: 'running', filename: 'x', startedAt: new Date().toISOString() }), kind, ...extra } });

test('each kind of audio job has its own name in the console, not the name of the batch import', () => {
  const names = {
    'audio-import': '音频转写', 'audio-batch': '音频批量转写', 'audio-subtitles': '字幕导入', 'audio-review': '转写复核', 'audio-live-save': '课堂保存', 'audio-live-correction': '课堂校正',
  };
  for (const [kind, name] of Object.entries(names)) assert.equal(taskSummary(card(kind)).kindLabel, name, kind);
});

test('an original-path batch (a single kind of record for one file or many) is named by what it holds', () => {
  assert.equal(taskSummary(card('audio-import', { detail: { files: [{}, {}] } })).kindLabel, '音频批量转写');
  assert.equal(taskSummary(card('audio-import', { detail: { files: [{}] } })).kindLabel, '音频转写');
});

test('every name has its English, and the other families keep theirs', async () => {
  const english = JSON.parse(await readFile(new URL('../ui/locales/en.task-console.json', import.meta.url), 'utf8'));
  for (const name of ['音频转写', '音频批量转写', '字幕导入', '转写复核', '课堂保存', '课堂校正']) assert.ok(english[name], `${name} has an English name`);
  assert.equal(taskSummary({ contract: { ...card('audio-import').contract, kind: 'pdf-convert' } }).kindLabel, 'PDF 转换');
});
