import test from 'node:test';
import assert from 'node:assert/strict';
import { recapGroups } from '../lib/daily-recap.js';

test('large older history avoids local-date formatting and still groups extreme-offset midnight answers correctly', t => {
  const state = { decks: [], sources: [], drafts: [], courses: [], notes: [], attempts: [], runs: [], oralRuns: [] };
  for (let d = 0; d < 100; d++) {
    state.decks.push({ id: `d${d}`, course: `Course ${d}`, cards: Array.from({ length: 10 }, (_, c) => ({ id: `q${d}-${c}`, prompt: `Question ${c}` })) });
    for (let i = 0; i < 100; i++) state.attempts.push({ id: `${d}-${i}`, deckId: `d${d}`, quiz_id: `q${d}-${i % 10}`, grade: 4, timestamp: '2020-01-01T04:00:00Z' });
  }
  for (let c = 0; c < 10; c++) state.attempts.push({ id: `today-${c}`, deckId: 'd0', quiz_id: `q0-${c}`, grade: 4, timestamp: '2026-10-03T10:00:00Z' });
  const format = Intl.DateTimeFormat.prototype.formatToParts;
  let dateCalls = 0;
  t.mock.method(Intl.DateTimeFormat.prototype, 'formatToParts', function (...args) { dateCalls++; return format.apply(this, args); });
  const east = recapGroups(state, { day: '2026-10-04', timeZone: 'Pacific/Kiritimati' });
  assert.equal(east.groups.length, 1);
  assert.equal(east.groups[0].answeredCount, 10);
  assert.ok(dateCalls < 20, 'historical attempts must not each trigger expensive local-date formatting');
  for (const attempt of state.attempts.slice(-10)) attempt.timestamp = '2026-10-05T11:59:59Z';
  const west = recapGroups(state, { day: '2026-10-04', timeZone: 'Etc/GMT+12' });
  assert.equal(west.groups.length, 1);
  assert.equal(west.groups[0].answeredCount, 10);
  state.attempts.at(-1).timestamp = '2026-10-05T12:00:00Z';
  assert.equal(recapGroups(state, { day: '2026-10-04', timeZone: 'Etc/GMT+12' }).groups[0].answeredCount, 9);
});
