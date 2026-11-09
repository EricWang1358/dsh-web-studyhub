import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticText } from '../ui/diagnostics.js';
import { plainReason } from '../lib/plain-reason.js';

/* The copyable diagnostic text (#893 S2, S5): built from a short whitelist of fields, and everything free-form that goes in
   (the error) is redacted. The privacy scan follows tests/usage-privacy.test.mjs: put every kind of private content where it
   could leak, build the text, search the text for each piece. */

const WINDOWS = 'C:\\Users\\student\\Documents\\notes\\midterm.docx';
const POSIX = '/home/student/courses/db/lecture-07.pdf';
const BEARER = 'Bearer abc123SECRETtoken987';
const KEY = 'sk-proj-AbCdEf0123456789XyZ0123456789';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzdHVkZW50In0.c2lnbmF0dXJlMTIzNDU';
const MATERIAL_EN = 'The mitochondria is the powerhouse of the cell and it produces most of the ATP';
const MATERIAL_ZH = '线粒体是细胞进行有氧呼吸的主要场所';
const QUERY = 'https://school.example/api/file?signature=SECRET-SIG-99';
const PRIVATE = [WINDOWS, POSIX, BEARER, 'abc123SECRETtoken987', KEY, JWT, MATERIAL_EN, MATERIAL_ZH, 'SECRET-SIG-99', 'student',
  'midterm.docx', 'lecture-07.pdf', 'ZZ-Deck 期中冲刺卷', 'ZZ-Source 数据库系统概论.pdf', 'ZZ-Question what is a transaction', 'ZZ-job-title 私人笔记转写'];

function leakyError() {
  const error = new TypeError(`Cannot read properties of undefined (reading 'map') at ${WINDOWS} while opening ${POSIX} with ${BEARER} and ${KEY} ${JWT} ${QUERY}: "${MATERIAL_EN}" 内容：${MATERIAL_ZH}`);
  error.stack = `TypeError: ${error.message}\n    at render (${WINDOWS}:10:5)\n    at Object.run (${POSIX}:3:9)\n    at Page (https://localhost/client.js?token=SECRET-SIG-99:1:2)\n    ${MATERIAL_EN}`;
  return error;
}
const snapshot = () => ({
  root: WINDOWS,
  sources: [{ id: 's1', title: 'ZZ-Source 数据库系统概论.pdf', name: 'lecture-07.pdf', text: MATERIAL_EN }, { id: 's2', title: 'second', text: MATERIAL_ZH }],
  decks: [{ id: 'd1', title: 'ZZ-Deck 期中冲刺卷', count: 12, cards: [{ prompt: 'ZZ-Question what is a transaction' }] }, { id: 'd2', title: 'other', count: 30 }],
  attempts: [{ answer: MATERIAL_ZH }],
  jobs: [{ id: 'j1', type: 'generation', status: 'complete', title: 'ZZ-job-title 私人笔记转写', error: MATERIAL_EN, path: POSIX }],
  experimental: true,
});

test('the diagnostic text of a crash holds none of the private content that was put around it', () => {
  const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', error: leakyError(), data: snapshot() });
  for (const piece of PRIVATE) assert.ok(!text.includes(piece), `"${piece}" leaked into:\n${text}`);
  assert.ok(!/sk-[A-Za-z0-9]/.test(text) && !/eyJ/.test(text) && !/[A-Za-z]:\\/.test(text) && !/\/home\//.test(text), text);
});

test('what a bug report needs is still there: version, language, page, the kind of error and where it broke', () => {
  const text = diagnosticText({ version: '4.6.2', language: 'en', page: 'wrongbook', error: leakyError(), data: snapshot() });
  assert.match(text, /StudyHub version: 4\.6\.2/);
  assert.match(text, /Interface language: en/);
  assert.match(text, /Page: wrongbook/);
  assert.match(text, /TypeError/);
  assert.match(text, /Cannot read properties of undefined \(reading 'map'\)/);
  assert.match(text, /at render \(\[path\]/, 'a frame keeps the function that broke; its file path is hidden');
  assert.match(text, /DSH version: .*手动|DSH version: .*by hand/, 'the one thing the page cannot know is left to be filled in by hand');
});

test('the library is described by counts, the jobs by kind and status, the switches by name, and nothing else', () => {
  const text = diagnosticText({ version: '4.6.2', language: 'zh', page: 'library', data: snapshot() });
  assert.match(text, /sources 2, decks 2, questions 42/);
  assert.match(text, /generation\/complete/);
  assert.match(text, /Experimental features: on/);
  assert.doesNotMatch(text, /Error:/, 'with no error (copied from Settings) there is no error section');
});

test('only the last 20 jobs are listed', () => {
  const jobs = Array.from({ length: 30 }, (_, index) => ({ type: `kind${index}`, status: 'done' }));
  const text = diagnosticText({ version: '1', language: 'zh', page: 'tasks', data: { jobs } });
  assert.ok(!text.includes('kind9/'), 'the 10th is older than the last 20');
  assert.ok(text.includes('kind10/done') && text.includes('kind29/done'));
});

test('a snapshot that is missing, or has strange fields, gives a short text and does not throw', () => {
  for (const data of [undefined, null, {}, { sources: 'x', decks: [null, { count: -3 }, { count: 'many' }], jobs: [null, { type: 'a b c <script>', status: {} }] }]) {
    const text = diagnosticText({ version: undefined, language: 'fr', page: '../../etc/passwd', error: 'plain string', data });
    assert.match(text, /StudyHub version: unknown/);
    assert.match(text, /Page: unknown/);
    assert.ok(!text.includes('<script>') && !text.includes('passwd'), text);
  }
});

test('plainReason also removes an API key, so every caller of it gains the same cover', () => {
  assert.equal(plainReason(`key ${KEY} end`), 'key end');
  assert.equal(plainReason('model gpt-4 is not sk-ill, nor a task-list'), 'model gpt-4 is not sk-ill, nor a task-list');
});
