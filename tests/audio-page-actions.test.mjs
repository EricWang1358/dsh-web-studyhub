import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadUi } from './helpers/ui-module.mjs';

/* #678: on the audio page a finished job has ONE primary button (the transcript) and every other action in its row is the same quiet button;
   「用它出题」 is inside the row it belongs to, and the page is not a card inside a card. */

const h = React.createElement;
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const finished = { type: 'audio-import', id: 'c', status: 'complete', filename: 'lecture.mp3', phase: 'done', sourceIds: ['s1'], finishedAt: new Date().toISOString(),
  startedAt: new Date(Date.now() - 5000).toISOString(), steps: {}, warnings: [] };

async function draw(job, props = {}) {
  const audio = await loadUi(`export { AudioJobs } from './ui/audio/AudioJobs.jsx'; export { setUiLanguage } from './ui/i18n.js';`);
  audio.setUiLanguage('zh');
  return renderToStaticMarkup(h(audio.AudioJobs, { data: { jobs: [job] }, busy: false, act() {}, onOpenSources() {}, onGenerate() {}, ...props }));
}

test('「用它出题」 is inside the finished job\'s card, with the other quiet actions, not under it', async () => {
  const out = await draw(finished);
  const card = /<article class="cjc[\s\S]*?<\/article>/.exec(out)?.[0] || '';
  assert.match(card, /用它出题/, 'inside the card');
  assert.doesNotMatch(out, /job-follow/, 'no wrapper that holds it outside');
  assert.match(/<div class="cjc__links"[\s\S]*?<\/div>/.exec(card)?.[0] || '', /用它出题/, 'in the row of the card\'s other actions');
});

test('one primary button and one kind of secondary: no accent link styles on the audio card', async () => {
  const out = await draw(finished);
  assert.equal((out.match(/cjc__go/g) || []).length, 1, 'one primary button');
  assert.doesNotMatch(out, /sh-btn--link/, 'no underlined accent links');
  for (const label of ['查看详情', '用它出题', '归档']) assert.match(out, new RegExp(`sh-btn--quiet[^>]*>${label}<`), `${label} is the quiet button`);
});

test('a page that cannot make questions does not offer 用它出题, and a running job does not either', async () => {
  assert.doesNotMatch(await draw(finished, { onGenerate: undefined }), /用它出题/);
  assert.doesNotMatch(await draw({ ...finished, status: 'running', phase: 'transcribe' }), /用它出题/);
});

test('the audio page draws no accent link: its own buttons are primary, secondary or quiet', async () => {
  for (const file of ['ui/AudioImport.jsx', 'ui/audio/AudioMoreSettings.jsx', 'ui/audio/AudioJobs.jsx']) assert.doesNotMatch(await read(file), /variant="link"/, file);
  const source = await read('ui/AudioImport.jsx');
  for (const line of source.split(/\r?\n/).filter((text) => /<HandOff /.test(text))) assert.match(line, /shape="quiet"/, line.trim().slice(0, 60));
});

test('the audio page is not a card inside a card: the import form drops its frame', async () => {
  const css = await read('ui/audio-settings.css');
  const rule = /\.audio-import\s*\{([^}]*)\}/.exec(css)?.[1] || '';
  assert.match(rule, /border:\s*0/);
  assert.match(rule, /padding:\s*0/);
});
