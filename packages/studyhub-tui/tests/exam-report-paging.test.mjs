import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';
import { oralReport } from '../../../lib/oral-exam.js';
import { createVirtualTty, disposeTerminalPool } from './helpers/virtual-tty.mjs';

const unregister = register();
const { ExamReportView } = await import('../src/views/exam/ExamReportView.tsx');
after(() => { unregister(); disposeTerminalPool(); });

function openReport(t, width, topics) {
  const entries = topics.map((topic, i) => ({
    deckId: 'deck', card: { id: `card-${i}`, topic, prompt: `Oral question ${i + 1}` },
    answer: 'An answer', assessment: { band: 'weak', grade: 1 },
  }));
  const report = oralReport({ id: 'practice', submittedAt: '2026-11-26T08:00:00Z', entries, language: 'en' });
  const tty = createVirtualTty(width, 24);
  const instance = render(React.createElement(ExamReportView, {
    width, height: 24, state: { kind: 'oral', report }, lang: 'en', isActive: true, busy: false,
    onPracticeWeak() {}, onBack() {},
  }), { stdin: tty.stdin, stdout: tty.stdout, stderr: tty.stderr, interactive: true, exitOnCtrlC: false, patchConsole: false });
  t.after(() => { instance.unmount(); tty.dispose(); });
  return tty;
}

test('the oral report wraps three weak topics at 200×24 and at its wider reading measure', async t => {
  const topics = [
    'Replication safety ' + 'read write overlap '.repeat(6),
    'Recovery ' + 'replay evidence '.repeat(8),
    'Final ' + 'state reconstruction '.repeat(6) + 'TOPIC_TAIL',
  ];
  for (const width of [200, 240]) {
    const tty = openReport(t, width, topics);
    const frame = await tty.waitFor(/TOPIC_TAIL/);
    tty.assertHealthyScreen(frame, width, 24);
    // The last topic is visible in the overview even while the first question is selected in the detail pane.
    assert.match(frame, /Oral question 1/);
    tty.send('\x1b[B');
    await tty.waitFor(/Oral question 2/);
  }
});

test('an oversized imported topic leaves room for the question list and can be read to its end', async t => {
  const topic = 'Imported topic ' + 'recovery protocol '.repeat(250) + 'IMPORTED_TAIL';
  const tty = openReport(t, 200, ['First topic', topic]);
  await tty.waitFor(/Full topics in question details/);
  tty.send('\x1b[B');
  await tty.waitFor(() => tty.readLines().some(line => line.slice(97).includes('Imported topic')));
  assert.doesNotMatch(tty.readScreen(), /IMPORTED_TAIL/, 'the end starts below the fold');
  tty.send('l');
  await tty.flush();
  for (let page = 0; page < 12 && !tty.readScreen().includes('IMPORTED_TAIL'); page++) {
    const before = tty.readScreen();
    tty.send('\x1b[6~');
    await tty.waitFor(frame => frame !== before, { label: 'advance the selected question detail' });
  }
  assert.match(tty.readScreen(), /IMPORTED_TAIL/);
});
