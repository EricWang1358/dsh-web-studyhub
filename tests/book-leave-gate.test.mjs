import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createLeaveGate } from '../ui/app/navigator.js';

/* #489 item 1: the one gate every page change passes. While a page holds it (unsaved edits in the book's editor), leaving asks that page and nothing happens until it says go.
   The real clicks (the sidebar, 回到总纲, a task link) are in tests/course-book-frame-browser.test.mjs. */

test('nothing held goes at once; held, another page asks and goes only on the answer', () => {
  const gate = createLeaveGate(() => 'book'), went = [], asked = [];
  gate.leave('notes', () => went.push('free'));
  assert.deepEqual(went, ['free'], 'nothing holds it: at once');
  gate.hold(go => asked.push(go));
  gate.leave('notes', () => went.push('notes'));
  assert.equal(asked.length, 1, 'the page that holds it is asked');
  assert.deepEqual(went, ['free'], 'nothing happened yet');
  gate.leave('book', () => went.push('same page'));
  assert.deepEqual(went, ['free', 'same page'], 'staying on the page leaves nothing behind');
  gate.leave(null, () => went.push('another course'));
  assert.equal(asked.length, 2, 'a change that is not a page (another course) asks too');
  asked[0]();
  assert.equal(went.at(-1), 'notes');
  // The answer released it: what the go does next (a verb that navigates again, later) is not asked a second time.
  gate.leave('tasks', () => went.push('tasks'));
  assert.equal(went.at(-1), 'tasks');
});

test('the release of an older holder does not free a newer one', () => {
  const gate = createLeaveGate(() => 'book'), asked = [];
  const first = gate.hold(() => asked.push('first'));
  gate.hold(() => asked.push('second'));
  first();
  gate.leave('notes', () => asked.push('went'));
  assert.deepEqual(asked, ['second']);
});

test('no page change goes around the gate: the hook hands out only gated ways, the raw setter stays inside it', async () => {
  const source = await readFile('ui/app/use-navigation.js', 'utf8');
  assert.match(source, /\[page, rawSetPage\] = useState/);
  // show.* and setPage go through `to`; navigate through the gate; only forcePage (a library that is already gone) and the navigator's own arrival use the raw one.
  const raw = source.split('\n').filter(line => /rawSetPage\(/.test(line));
  assert.equal(raw.length, 2, raw.join('\n'));
  assert.ok(raw.some(line => /const to = /.test(line)) && raw.some(line => /forcePage/.test(line)));
  assert.match(await readFile('ui/app/library-state.js', 'utf8'), /nav\.forcePage\(value\)/);
});
