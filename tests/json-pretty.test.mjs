import test from 'node:test';
import assert from 'node:assert/strict';
import { prettyOutput, prettyParts } from '../ui/tasks/json-pretty.js';

// 2.6.1: the 实时输出 panel showed model JSON (reviews, plans, blueprints, corrections) as one dense wrapped line. prettyOutput indents it, also while it is
// still being written (a prefix of a JSON text), without ever changing what was written, and leaves everything that is not JSON as it was.

const review = {
  verdict: 'needs-repair',
  issues: [
    { id: 'q1', severity: 'major', problem: '题干没有说明"哪一个"系统；learners may read it as the whole architecture.', fix: 'Name the system: “the sampled order service”.' },
    { id: 'q2', severity: 'minor', problem: 'Citation quote is a paraphrase, not a quote.', fix: null },
  ],
  coverage: { targets: ['t1', 't2'], missing: [], ratio: 0.75, empty: {}, none: [] },
  ok: false,
  note: 'Escapes: \\ backslash, \" quote, \n newline, \u4e2d unicode.',
};
const compact = JSON.stringify(review), indented = JSON.stringify(review, null, 2);
const strip = (value) => value.replace(/\s+/g, '');

test('complete JSON is indented by two spaces, exactly like JSON.stringify(…, null, 2)', () => {
  assert.equal(prettyOutput(compact), indented);
  assert.equal(prettyOutput(indented), indented, 'already indented text is left as it is');
  assert.equal(prettyOutput('[]'), '[]');
  assert.equal(prettyOutput('{}'), '{}');
  assert.equal(prettyOutput('[{"a":[]},2,"x",null]'), JSON.stringify([{ a: [] }, 2, 'x', null], null, 2));
  assert.equal(prettyOutput('[1,2]'), '[1,2]', 'an array that opens with a number is more likely a reference in prose than a document');
});

test('JSON in a ``` fence, after a line of prose, or before some, keeps its surroundings', () => {
  assert.equal(prettyOutput('```json\n' + compact + '\n```'), '```json\n' + indented + '\n```');
  assert.equal(prettyOutput('```\n' + compact + '```'), '```\n' + indented + '\n```');
  assert.equal(prettyOutput('Here is the review:\n' + compact), 'Here is the review:\n' + indented);
  assert.equal(prettyOutput('Here is the review: ' + compact), 'Here is the review: ' + compact, 'JSON in the middle of a line is prose, not a document');
  assert.equal(prettyOutput(compact + '\nHope that helps.'), indented + '\nHope that helps.');
  assert.equal(prettyOutput('  \n' + compact), indented, 'leading blank space goes');
});

test('text that is not JSON is returned untouched', () => {
  for (const text of ['', 'Hello world', '很长的一段说明文字，没有 JSON。\n第二行 [1] 和 {x} 都不是。', 'see [1] for details', '{x: 1}', '[ref]',
    '# Title\n\n- a\n- b\n\n```js\nconst a = 1;\n```', 'The set {1, 2, 3} has three members.', '   spaces   ']) {
    assert.equal(prettyOutput(text), text, JSON.stringify(text));
    assert.deepEqual(prettyParts(text), text ? [{ kind: 'plain', text }] : [], 'one plain part');
  }
  assert.equal(prettyOutput(undefined), '');
  assert.equal(prettyOutput(null), '');
  assert.equal(prettyOutput(42), '');
});

test('PARTIAL JSON: every prefix of a text being written never throws, and indenting a longer prefix only ever ADDS to the indented shorter one', () => {
  const samples = [compact, '```json\n' + compact + '\n```\nDone.', 'Here is the review:\n' + indented, '[' + compact + ',' + compact + ']'];
  for (const sample of samples) {
    let before = '';
    for (let cut = 0; cut <= sample.length; cut++) {
      const out = prettyOutput(sample.slice(0, cut));
      assert.ok(out.startsWith(before), `stable at ${cut}: ${JSON.stringify(sample.slice(Math.max(0, cut - 12), cut))}`);
      before = out;
    }
  }
});

test('a partial text is cut at a string, a number, a key and an escape without altering what is there', () => {
  assert.equal(prettyOutput('{"issues": [{"id": "q1", "problem": "The qu'), '{\n  "issues": [\n    {\n      "id": "q1",\n      "problem": "The qu');
  assert.equal(prettyOutput('{"a": 12'), '{\n  "a": 12');
  assert.equal(prettyOutput('{"a": tr'), '{\n  "a": tr');
  assert.equal(prettyOutput('{"a": "x\\'), '{\n  "a": "x\\');
  assert.equal(prettyOutput('{"a": "x\\"'), '{\n  "a": "x\\"', 'an escaped quote does not end the string');
  assert.equal(prettyOutput('{'), '{');
  assert.equal(prettyOutput('[{'), '[\n  {');
  assert.equal(prettyOutput('{"a": [],'), '{\n  "a": [],');
});

test('what was written is never changed: all characters are kept in order, strings are not shortened or wrapped, escapes stay as written', () => {
  const long = 'word '.repeat(2000).trim();
  const text = JSON.stringify({ long, quote: '他说"你好"', path: 'C:\\x\\y', zh: '中文，标点；“引号”' });
  const out = prettyOutput(text);
  assert.ok(out.includes(`"${long}"`), 'a 10 KB string value stays on one line, whole');
  assert.ok(out.includes('\\"你好\\"'), 'escaped quotes stay escaped');
  assert.ok(out.includes('C:\\\\x\\\\y'));
  assert.equal(strip(out), strip(text));
  assert.deepEqual(JSON.parse(out), JSON.parse(text));
  assert.deepEqual(JSON.parse(prettyOutput(compact)), review);
  // even when it is not valid JSON: nothing is dropped or reordered
  const broken = '{"a": ]]] , :: "b" "c": {{ 1 2 3 ,, }';
  assert.equal(strip(prettyOutput(broken)), strip(broken));
  assert.equal(strip(prettyOutput('{"a": 1} trailing words')), strip('{"a": 1} trailing words'));
});

test('keys, strings and the rest are told apart for colouring; adjacent parts of one kind are merged', () => {
  const parts = prettyParts('{"id": "q1", "n": 2, "ok": true, "list": ["a"]}');
  assert.equal(parts.map((part) => part.text).join(''), prettyOutput('{"id": "q1", "n": 2, "ok": true, "list": ["a"]}'));
  const kinds = (kind) => parts.filter((part) => part.kind === kind).map((part) => part.text);
  assert.deepEqual(kinds('key'), ['"id"', '"n"', '"ok"', '"list"']);
  assert.deepEqual(kinds('string'), ['"q1"', '"a"']);
  assert.deepEqual(kinds('literal'), ['2', 'true']);
  for (let index = 1; index < parts.length; index++) assert.notEqual(parts[index].kind, parts[index - 1].kind, 'no two neighbours of one kind');
  // a partial key is a key, a partial value is a value
  assert.deepEqual(prettyParts('{"abc').at(-1), { kind: 'key', text: '"abc' });
  assert.deepEqual(prettyParts('{"a": "xy').at(-1), { kind: 'string', text: '"xy' });
});

test('absurd nesting is bounded: the indentation stops growing, the content stays', () => {
  const deep = '['.repeat(5000) + '1' + ']'.repeat(5000);
  const out = prettyOutput(deep);
  assert.ok(out.length < 10000 * 30, `bounded (${out.length})`);
  assert.equal(strip(out), deep);
  assert.doesNotThrow(() => prettyOutput('{"a":'.repeat(3000)));
});

test('FRAGMENT: the tail of a longer JSON (the host keeps the last ~8 KB, so a late panel starts mid-document) is indented from its first key; without the flag it is left alone', () => {
  const cut = compact.indexOf('major"') + 3;            // inside a string value, in the middle of the document
  const tail = compact.slice(cut);
  assert.equal(prettyOutput(tail), tail, 'not told it is a fragment: untouched, like any text that is not JSON');
  const out = prettyOutput(tail, { fragment: true });
  assert.ok(out.includes('\n  "problem": '), out);
  assert.ok(out.split('\n').length > 8, 'it is laid out by structure');
  assert.ok(out.startsWith(compact.slice(cut, compact.indexOf(',"problem"', cut))), 'what comes before the first key is kept as it was');
  assert.equal(strip(out), strip(tail), 'nothing is dropped or reordered');
  assert.equal(prettyOutput('no json here at all', { fragment: true }), 'no json here at all');
  // growing tail: stable once the first key is in
  let before = '';
  for (let end = tail.indexOf('"problem"') + 20; end <= tail.length; end++) {
    const text = prettyOutput(tail.slice(0, end), { fragment: true });
    assert.ok(text.startsWith(before), `stable at ${end}`);
    before = text;
  }
  // a complete document in the text is found as usual, flag or not
  assert.equal(prettyOutput(compact, { fragment: true }), indented);
  // closers past the guessed depth never throw nor lose content
  const odd = '", "c": 1}}}]]  , "d": [1, 2]}';
  assert.doesNotThrow(() => prettyOutput(odd, { fragment: true }));
  assert.equal(strip(prettyOutput(odd, { fragment: true })), strip(odd));
});
