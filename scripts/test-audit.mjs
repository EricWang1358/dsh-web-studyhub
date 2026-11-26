#!/usr/bin/env node
/* Test quality audit (#1468): finds the tests that pass without protecting a behaviour, so that they can be cleaned up in batches instead of
   being counted as coverage. It only reads files and writes a report; it never edits tests and is not part of `npm test` or blocking CI.

   node scripts/test-audit.mjs                       console summary, the hit files ranked by suspicion
   node scripts/test-audit.mjs --write               also writes docs/test-audit.md
   node scripts/test-audit.mjs --write-baseline      writes machine-readable baseline to docs/test-audit-baseline.json
   node scripts/test-audit.mjs --compare-baseline    advisory diff against docs/test-audit-baseline.json (reports only new/increased hits, always exits 0)
   node scripts/test-audit.mjs --compare-baseline=docs/test-audit-baseline.json --annotations
   node scripts/test-audit.mjs --top=5               how many files the ranking lists (default 25)
   node scripts/test-audit.mjs --only=1,2            only these categories (1-7)
   node scripts/test-audit.mjs --json                the whole result as JSON on stdout
   node scripts/test-audit.mjs --root=<dir>          audit another checkout (the tests use it)

   Categories, worst first:
     1 read-a-source-and-match-strings   readFileSync/readFile + `assert(...includes('...'))`: asserts an implementation detail, so it goes
                                         red on any refactor and green when the behaviour breaks.
     2 invented-backend-shape           a fake/mock/stub returns fields that no real module (lib/, ui/, packages/, locale/) has, so the test can
                                         never fail the way the product would; flagged for review, not proven wrong.
     3 tautology                        assert.ok(true), assert.equal(x, x), or only "it was called" without what it was called with.
     4 duplicate-coverage               the same normalised test title in several files, or titles whose words nearly coincide.
     5 no-assertion                     a test block with no assert at all (a container of subtests is not one).
     6 constant-only                    asserting a constant equals the literal it is declared with in lib/.
     7 skipped                          test.skip / test.todo / { skip: true }: counted, because they inflate a pass count.

   A hit is a candidate for review, not a verdict: the report says where to look, a person decides.  */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CATEGORIES = {
  1: { name: 'read-a-source-and-match-strings', weight: 10, fix: '断言行为或公开输出，不读源码' },
  2: { name: 'invented-backend-shape', weight: 9, fix: '让 fake 的字段与真实后端一致，或直接从真实模块取形状' },
  3: { name: 'tautology', weight: 6, fix: '断言具体返回值、参数与副作用' },
  4: { name: 'duplicate-coverage', weight: 5, fix: '保留一份，删除或合并其余' },
  5: { name: 'no-assertion', weight: 8, fix: '补上断言，或删除' },
  6: { name: 'constant-only', weight: 4, fix: '测使用常量的行为，不测常量等于自己' },
  7: { name: 'skipped', weight: 1, fix: '修好并启用，或删除；不要留在通过率里' },
};
const CATEGORY_IDS = Object.keys(CATEGORIES).map(Number);
const IGNORED_FAKE_KEYS = new Set(['id', 'ok', 'error', 'message', 'data', 'value', 'status', 'type', 'name', 'items', 'kind', 'at', 'index', 'length', 'constructor']);

// --------------------------------------------------------------------------------------------- text structure

/** The source with comments, string/template/regex bodies blanked out (newlines kept), so that braces and parentheses can be matched
 *  without a parser and without being fooled by text inside a literal. Indices are the same as in the source. */
export function maskSource(source) {
  const chars = source.split('');
  const n = chars.length;
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (chars[k] !== '\n' && chars[k] !== '\r') chars[k] = ' '; };
  const regexAllowedAfter = char => char === '' || '=(,:;[!&|?{}>+-*%^~'.includes(char);
  let i = 0;
  let previous = '';
  while (i < n) {
    const char = chars[i];
    if (char === '/' && chars[i + 1] === '/') {
      let end = i;
      while (end < n && chars[end] !== '\n') end += 1;
      blank(i, end);
      i = end;
      continue;
    }
    if (char === '/' && chars[i + 1] === '*') {
      let end = i + 2;
      while (end < n && !(chars[end] === '*' && chars[end + 1] === '/')) end += 1;
      end = Math.min(n, end + 2);
      blank(i, end);
      i = end;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = i + 1;
      while (end < n && chars[end] !== char && chars[end] !== '\n') end += chars[end] === '\\' ? 2 : 1;
      if (end < n && chars[end] === char) end += 1;
      blank(i, end);
      i = end;
      previous = char;
      continue;
    }
    if (char === '`') {
      let end = i + 1;
      while (end < n) {
        if (chars[end] === '\\') { end += 2; continue; }
        if (chars[end] === '`') { end += 1; break; }
        end += 1;
      }
      blank(i, end);
      i = end;
      previous = '`';
      continue;
    }
    if (char === '/' && regexAllowedAfter(previous)) {
      let end = i + 1;
      while (end < n && chars[end] !== '/' && chars[end] !== '\n') end += chars[end] === '\\' ? 2 : 1;
      if (end < n && chars[end] === '/') { blank(i + 1, end); i = end + 1; previous = '/'; continue; }
      i += 1;
      continue;
    }
    if (!/\s/.test(char)) previous = char;
    i += 1;
  }
  return chars.join('');
}

/** The call spans of `test(` / `t.test(` / `test.skip(`, with the first argument as a title. */
function testCalls(masked) {
  const calls = [];
  const found = /\b(test|it)\b((?:\s*\.\s*[A-Za-z]+)*)/g;
  let match;
  while ((match = found.exec(masked))) {
    // `pattern.test(text)` is a regex method, not a test: only a subtest context (`t.test(`) is a call.
    let before = match.index - 1;
    while (before >= 0 && /\s/.test(masked[before])) before -= 1;
    if (before >= 0 && masked[before] === '.') {
      let receiver = before - 1;
      while (receiver >= 0 && /[\w$]/.test(masked[receiver])) receiver -= 1;
      const name = masked.slice(receiver + 1, before);
      if (!['t', 'ctx', 'context'].includes(name)) continue;
    }
    let open = match.index + match[0].length;
    while (open < masked.length && /\s/.test(masked[open])) open += 1;
    if (masked[open] !== '(') continue;
    let depth = 0;
    let close = open;
    for (; close < masked.length; close += 1) {
      if (masked[close] === '(') depth += 1;
      else if (masked[close] === ')') { depth -= 1; if (depth === 0) break; }
    }
    if (depth !== 0) continue;
    const modifiers = match[2].split('.').map(part => part.trim()).filter(Boolean);
    // test.after/before/describe are hooks and suites, not tests.
    if (modifiers.some(modifier => ['after', 'before', 'afterEach', 'beforeEach', 'describe', 'mock', 'fn'].includes(modifier))) continue;
    const body = bodyOf(masked, open, close);
    calls.push({ open, close, modifiers, title: null, bodyStart: body.start, bodyEnd: body.end });
  }
  return calls;
}

/** Where the body of a call is: after `=>` (block or expression) or after a `function (...) {`. */
function bodyOf(masked, open, close) {
  let cursor = open + 1;
  let depth = 0;
  for (; cursor < close; cursor += 1) {
    const char = masked[cursor];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (depth === 0 && char === ',') break;
  }
  const afterTitle = cursor;
  const arrow = masked.indexOf('=>', afterTitle);
  let start = -1;
  if (arrow !== -1 && arrow < close) {
    start = arrow + 2;
    while (start < close && /\s/.test(masked[start])) start += 1;
    if (masked[start] !== '{') return { start, end: close };
  } else {
    const fn = /\bfunction\b/g;
    fn.lastIndex = afterTitle;
    const found = fn.exec(masked);
    if (!found || found.index > close) return { start: close, end: close };
    start = masked.indexOf('{', found.index);
    if (start === -1 || start > close) return { start: close, end: close };
  }
  const end = matchingBrace(masked, start);
  return { start: start + 1, end: end === -1 ? close : end };
}

function matchingBrace(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i += 1) {
    if (masked[i] === '{') depth += 1;
    else if (masked[i] === '}') { depth -= 1; if (depth === 0) return i; }
  }
  return -1;
}

function firstArgument(source, masked, open, close) {
  let depth = 0;
  for (let i = open + 1; i < close; i += 1) {
    const char = masked[i];
    if (char === '(' || char === '[' || char === '{') depth += 1;
    else if (char === ')' || char === ']' || char === '}') depth -= 1;
    else if (char === ',' && depth === 0) return { text: source.slice(open + 1, i), end: i };
  }
  return { text: source.slice(open + 1, close), end: close };
}

const unquote = text => {
  const value = text.trim();
  const literal = /^(['"`])([\s\S]*)\1$/.exec(value);
  if (!literal) return null;
  return literal[2].replace(/\\(['"`\\])/g, '$1').replace(/\s+/g, ' ').trim();
};

/** Lower-case letters and digits only, so that "Adds a card." and "adds a card" are one title. */
export const normalizeTitle = title => title.toLowerCase().normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// --------------------------------------------------------------------------------------------- knowledge of the real backend

const walkFiles = (directory, extensions, out = []) => {
  let entries;
  try { entries = readdirSync(directory, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) walkFiles(path, extensions, out);
    else if (extensions.some(extension => entry.name.endsWith(extension))) out.push(path);
  }
  return out;
};

/** Field names the real backend uses, and its module-level literal constants: what a fake shape and a constant assertion are compared with. */
export function buildSourceIndex(root) {
  const fields = new Set();
  const constants = new Map();
  const files = [...walkFiles(join(root, 'lib'), ['.js']), ...walkFiles(join(root, 'ui'), ['.js', '.jsx']),
    ...walkFiles(join(root, 'packages'), ['.ts', '.tsx', '.js', '.mjs']), ...walkFiles(join(root, 'locale'), ['.json'])];
  for (const file of files) {
    if (/[\\/](node_modules|dist|tests|src-tauri)[\\/]/.test(file)) continue;
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of source.matchAll(/[{,]\s*(?:"([^"\n]+)"|'([^'\n]+)'|([A-Za-z_$][\w$]*))\s*:/g)) fields.add(match[1] ?? match[2] ?? match[3]);
    // Any property read or call is a name the real code already uses: `buffer.numberOfChannels`, `store.get(...)`.
    for (const match of source.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)) fields.add(match[1]);
    for (const match of source.matchAll(/(?:export\s+)?const\s+([A-Z][A-Z0-9_]{2,})\s*=\s*(?:'([^'\n]*)'|"([^"\n]*)"|(-?\d+(?:\.\d+)?)|(true|false))\s*[;\n]/g)) {
      const literal = match[2] ?? match[3] ?? match[4] ?? match[5];
      if (literal !== undefined) constants.set(match[1], literal);
    }
  }
  return { fields, constants };
}

const EMPTY_INDEX = { fields: new Set(), constants: new Map() };

// --------------------------------------------------------------------------------------------- per-file audit

const lineIndex = source => {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') starts.push(i + 1);
  return offset => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (starts[mid] <= offset) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
};

const SOURCE_READ = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?(?:[\w$.]*\.)?(?:readFileSync|readFile)\s*\(/g;
// A file whose bytes are checked for a snippet must be program source, not a fixture, a changelog or a generated document: reading those
// and matching text is a legitimate content test.
const PROGRAM_SOURCE = /\.(?:js|jsx|ts|tsx|mjs|cjs|css|scss)\b/;

/** Variables assigned from a source read, with the argument text, so category 1 can tell program source from other files. */
function sourceReads(source, masked) {
  const reads = new Map();
  for (const match of masked.matchAll(SOURCE_READ)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    let close = open;
    for (; close < masked.length; close += 1) {
      if (masked[close] === '(') depth += 1;
      else if (masked[close] === ')') { depth -= 1; if (depth === 0) break; }
    }
    const argument = source.slice(open + 1, close);
    if (PROGRAM_SOURCE.test(argument)) reads.set(match[1], argument.trim());
  }
  return reads;
}

/** Top-level keys of an object literal, from its raw text. */
export function objectKeys(text) {
  const masked = maskSource(text);
  const parts = [];
  let depth = 0;
  let start = 1;
  for (let i = 1; i < masked.length; i += 1) {
    const char = masked[i];
    if (char === '{' || char === '[' || char === '(') depth += 1;
    else if (char === '}' || char === ']' || char === ')') depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start, masked.length - 1));
  const keys = [];
  for (const part of parts) {
    const named = /^\s*(?:\.\.\.)?([A-Za-z_$][\w$]*)\s*(?::|$)/.exec(part);
    const quoted = /^\s*(?:\.\.\.)?(['"])([^'"]+)\1\s*:/.exec(part);
    const shorthandMethod = /^\s*(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/.exec(part);
    if (quoted) keys.push(quoted[2]);
    else if (named && !/^\s*\.\.\./.test(part)) keys.push(named[1]);
    else if (shorthandMethod) keys.push(shorthandMethod[1]);
  }
  return keys;
}

/** Object literals returned inside a value named *fake* / *mock* / *stub* (or handed to mock.method/mock.fn). */
function fakeShapes(source, masked) {
  const shapes = [];
  const bodies = [];
  const named = /(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\s*(?:=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*|\([^)]*\)\s*)?/g;
  for (const match of masked.matchAll(named)) {
    if (!/(?:fake|mock|stub)/i.test(match[1])) continue;
    const after = match.index + match[0].length;
    // The body must start right here (`= {`, `=> {`, `=> ({`); a `{` further away is an argument of some other call.
    const head = /^\s*(?:\(\s*)?\{/.exec(masked.slice(after, after + 12));
    if (!head) continue;
    const open = after + head[0].length - 1;
    if (open === -1) continue;
    const close = matchingBrace(masked, open);
    if (close !== -1) bodies.push([open, close]);
  }
  for (const match of masked.matchAll(/\bmock\s*\.\s*(?:method|fn)\s*\(/g)) {
    const open = masked.indexOf('(', match.index + 1);
    let depth = 0;
    let close = open;
    for (; close < masked.length; close += 1) {
      if (masked[close] === '(') depth += 1;
      else if (masked[close] === ')') { depth -= 1; if (depth === 0) break; }
    }
    bodies.push([open, close]);
  }
  for (const [start, end] of bodies) {
    for (let i = start; i < end; i += 1) {
      if (masked[i] !== '{') continue;
      const close = matchingBrace(masked, i);
      if (close === -1 || close > end) continue;
      const before = masked.slice(Math.max(0, i - 40), i);
      if (!/(?:return|=>|\()\s*$/.test(before)) continue;
      const keys = objectKeys(source.slice(i, close + 1));
      if (keys.length >= 2) shapes.push({ offset: i, keys });
    }
  }
  return shapes;
}

/** Names of functions declared in a module whose body asserts: a test that calls one of them does assert, even without the word. */
export function declaredAssertionHelpers(masked) {
  const names = new Set();
  for (const match of masked.matchAll(/(?:function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*)/g)) {
    const start = match.index + match[0].length - (/[{(]$/.test(match[0]) ? 1 : 0);
    let body = '';
    if (masked[start] === '{') {
      const close = matchingBrace(masked, start);
      if (close !== -1) body = masked.slice(start, close);
    } else {
      // An expression body (`const refuses = (promise, code) => assert.rejects(...)`) runs to the end of its statement.
      let end = start;
      let depth = 0;
      for (; end < masked.length && masked[end] !== '\n'; end += 1) {
        if ('([{'.includes(masked[end])) depth += 1;
        else if (')]}'.includes(masked[end])) depth -= 1;
        else if (masked[end] === ';' && depth === 0) break;
      }
      body = masked.slice(start, end);
    }
    if (/\bassert\s*[.(]/.test(body)) names.add(match[1] ?? match[2]);
  }
  return names;
}

export function auditSource(file, source, index = EMPTY_INDEX, externalHelpers = new Set()) {
  const masked = maskSource(source);
  const lineAt = lineIndex(source);
  const lines = source.split('\n');
  const hits = [];
  const add = (category, offset, message) => hits.push({ category, file, line: lineAt(offset), message });

  // 1. source text read and matched
  const sourceVars = sourceReads(source, masked);
  let offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!/\bassert\b/.test(line)) continue;
    const inline = /\breadFile(?:Sync)?\s*\([^;]*?\.\s*(includes|match|indexOf|startsWith|endsWith)\s*\(/.test(line) && PROGRAM_SOURCE.test(line);
    let variable = null;
    for (const name of sourceVars.keys()) {
      if (!new RegExp(`\\b${name}\\b`).test(line)) continue;
      if (new RegExp(`\\b${name}\\b[^;]*?\\.\\s*(includes|match|indexOf|startsWith|endsWith)\\s*\\(`).test(line) ||
        new RegExp(`assert\\s*\\.\\s*match\\s*\\(\\s*${name}\\b`).test(line)) variable = name;
    }
    if (inline) add(1, lineStart, '读取源码文件后对文本片段断言：重构会红，行为坏了却仍绿');
    else if (variable) add(1, lineStart, `读取源码变量 ${variable}（${sourceVars.get(variable)}）后对文本片段断言：重构会红，行为坏了却仍绿`);
  }

  // 2. fake backend shape
  for (const shape of fakeShapes(source, masked)) {
    const unknown = shape.keys.filter(key => !index.fields.has(key) && !IGNORED_FAKE_KEYS.has(key) && key.length > 3);
    if (unknown.length) add(2, shape.offset, `fake 返回对象的字段在 lib/ui/packages/locale 中都没有出现：${unknown.join(', ')}（人工复核：可能是 fake 自己的控制字段或外部 API 的形状）`);
  }

  // test blocks, for 3, 5 and 7
  const calls = testCalls(masked);
  // A test may assert through a local helper (`pinned(...)`, `assertRejected(...)`); calling one is an assertion even without the word.
  const assertionHelpers = new Set([...declaredAssertionHelpers(masked), ...externalHelpers]);
  const helperCall = /\b(?:assert|expect|verify|check)\w*\s*[.(]/;
  const container = new Set();
  for (const call of calls) {
    for (const other of calls) {
      if (other !== call && other.open !== call.open && other.open > call.bodyStart && other.open < call.bodyEnd) container.add(call.open);
    }
  }
  for (const call of calls) {
    const first = firstArgument(source, masked, call.open, call.close);
    const title = unquote(first.text.split('\n')[0]);
    call.title = title;
    call.line = lineAt(call.open);
    // node:test takes `{ skip: ... }` / `{ todo: ... }` as the options argument, not only the `test.skip` form.
    const options = masked.slice(first.end, call.bodyStart);
    const skipped = call.modifiers.includes('skip') || /\bskip\s*:/.test(options);
    const todo = call.modifiers.includes('todo') || /\btodo\s*:/.test(options);
    const body = masked.slice(call.bodyStart, call.bodyEnd);
    if (skipped || todo) {
      add(7, call.open, `${skipped ? 'skip' : 'todo'}：跳过或待办却计入测试总数`);
    }
    if (container.has(call.open)) continue;
    const assertions = [...body.matchAll(/\bassert\b[^;\n]*/g)].map(match => match[0]);
    // 3. tautology
    if (/\bassert\s*(?:\.\s*\w+\s*)?\(\s*(?:true|false\s*,\s*true)\s*\)/.test(body)) add(3, call.open, '断言恒真（assert.ok(true)）：删掉也不影响任何行为');
    const same = /\bassert\s*(?:\.\s*\w+\s*)?\(\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*,\s*\1\s*[,)]/.exec(body);
    if (same) add(3, call.open, `断言自己等于自己（${same[1]}）：同义反复`);
    if (assertions.length && assertions.every(text => /(calledTimes|callCount|callcount|calls\s*\.\s*length|calledOnce|calledTwice|called)\b/.test(text)) &&
      !assertions.some(text => /(calledWith|firstCall|lastCall|args|arguments)\b/.test(text))) {
      add(3, call.open, '只断言「被调用过」，不看参数与副作用');
    }
    // 5. no assertion
    if (!assertions.length && !/\bassert\b/.test(body) && !helperCall.test(body) &&
      ![...assertionHelpers].some(name => new RegExp(`\\b${name}\\s*\\(`).test(body))) {
      add(5, call.open, '测试块内没有任何 assert');
    }
  }

  // 4. duplicate titles are clustered across files later; here we keep each title with its line.
  // 6. constant equals the literal it is declared with
  offset = 0;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    const match = /\bassert\s*(?:\.\s*\w+\s*)?\(\s*(?:[A-Za-z_$][\w$]*\.)?([A-Za-z_$][\w$]*)\s*,\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)\s*[,)]/.exec(line);
    if (!match) continue;
    const declared = index.constants.get(match[1]);
    if (declared === undefined) continue;
    const asserted = match[2].replace(/^['"]|['"]$/g, '').replace(/_/g, '');
    if (declared === asserted) add(6, lineStart, `断言常量 ${match[1]} 等于它自己的定义值 ${match[2]}：没有行为含义`);
  }

  return { file, hits, titles: calls.filter(call => call.title).map(call => ({ title: call.title, line: call.line })), blocks: calls.length };
}

// --------------------------------------------------------------------------------------------- the whole tree

export const scanScope = root => ({
  // tests/fixtures holds deliberately broken or hanging "tests" that other tests run: they are inputs, not coverage.
  tests: [...walkFiles(join(root, 'tests'), ['.test.mjs']), ...walkFiles(join(root, 'packages'), ['.test.mjs'])
    .filter(file => /[\\/]tests[\\/]/.test(file))].filter(file => !/[\\/]fixtures[\\/]/.test(file)).sort(),
  fakes: [...walkFiles(join(root, 'tests', 'helpers'), ['.mjs']), ...walkFiles(join(root, 'scripts'), ['.mjs'])
    .filter(file => /[\\/]fake-[^\\/]*\.mjs$/.test(file))].sort(),
});

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'when', 'does', 'from', 'into', 'after', 'before', 'than', 'then', 'that', 'this',
  'its', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'will', 'would', 'should', 'not', 'same', 'only', 'just', 'also', 'more', 'most',
  'all', 'any', 'each', 'one', 'two', 'out', 'but', 'yet', 'still', 'per', 'via']);

const titleTokens = key => [...new Set(key.split(' ').filter(word => word.length > 1 && !STOPWORDS.has(word)))].sort();

/** FNV-1a over a string, so that similar titles land in the same bucket without a dependency. */
const hash32 = text => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
};

/** Four min-hashes of the word set (LSH bands of two): a pair that shares a band is worth an exact Jaccard check. */
const minHashes = tokens => [0, 1, 2, 3].map(seed => Math.min(...tokens.map(token => hash32(`${seed}:${token}`))));

/** Cross-file duplicate titles: identical after normalisation, or word sets whose Jaccard overlap is at least 0.8. */
function duplicates(files) {
  const hits = [];
  const byTitle = new Map();
  for (const entry of files) {
    for (const { title, line } of entry.titles) {
      const key = normalizeTitle(title);
      if (!key) continue;
      if (!byTitle.has(key)) byTitle.set(key, []);
      byTitle.get(key).push({ file: entry.file, line, title });
    }
  }
  const tokens = new Map();
  for (const key of byTitle.keys()) {
    const words = titleTokens(key);
    if (words.length >= 4) tokens.set(key, words);
  }
  const buckets = new Map();
  for (const [key, words] of tokens) {
    const [a, b, c, d] = minHashes(words);
    for (const band of [`${a}:${b}`, `${c}:${d}`]) {
      if (!buckets.has(band)) buckets.set(band, []);
      buckets.get(band).push(key);
    }
  }
  const similar = new Set();
  for (const members of buckets.values()) {
    if (members.length < 2 || members.length > 40) continue;
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const one = tokens.get(members[i]);
        const other = tokens.get(members[j]);
        const setOne = new Set(one);
        const shared = other.filter(word => setOne.has(word)).length;
        if (shared / (one.length + other.length - shared) < 0.8) continue;
        const pair = [members[i], members[j]].sort().join('\n');
        if (!similar.has(pair)) similar.add(pair);
      }
    }
  }
  for (const list of byTitle.values()) {
    const distinct = new Set(list.map(item => item.file));
    if (distinct.size < 2) continue;
    for (const item of list) hits.push({ category: 4, file: item.file, line: item.line, message: `与另外 ${distinct.size - 1} 个文件共用同一测试标题「${item.title}」` });
  }
  for (const pair of similar) {
    const [one, other] = pair.split('\n');
    if (!byTitle.has(one) || !byTitle.has(other)) continue;
    for (const item of byTitle.get(other)) {
      hits.push({ category: 4, file: item.file, line: item.line, message: `测试标题与「${byTitle.get(one)[0].title}」高度相似` });
    }
  }
  return hits;
}

export function auditTree(root, { only = CATEGORY_IDS } = {}) {
  const index = buildSourceIndex(root);
  const scope = scanScope(root);
  const norm = path => relative(root, path).split(sep).join('/');
  const helperCache = new Map();
  const assertionsDeclaredIn = path => {
    if (!helperCache.has(path)) helperCache.set(path, declaredAssertionHelpers(maskSource(readFileSync(path, 'utf8').replace(/\r\n/g, '\n'))));
    return helperCache.get(path);
  };
  /** Assertion helpers a test file imports from the repo's own modules (imported ones are not visible in its text). */
  const importedHelpers = (path, source) => {
    const names = new Set();
    for (const match of source.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = resolve(dirname(path), match[2]);
      const target = [base, `${base}.mjs`, `${base}.js`, join(base, 'index.mjs')].find(candidate => existsSync(candidate));
      if (!target || !target.startsWith(root)) continue;
      for (const name of assertionsDeclaredIn(target)) names.add(name);
    }
    return names;
  };
  const files = [];
  let blocks = 0;
  for (const path of scope.tests) {
    const source = readFileSync(path, 'utf8');
    const result = auditSource(norm(path), source, index, importedHelpers(path, source));
    blocks += result.blocks;
    files.push(result);
  }
  // Fakes often live in a helper module; category 2 looks there too, but only reports that category.
  const helperHits = [];
  for (const path of scope.fakes) {
    const result = auditSource(norm(path), readFileSync(path, 'utf8'), index);
    helperHits.push(...result.hits.filter(hit => hit.category === 2));
  }
  const all = [...files.flatMap(entry => entry.hits), ...helperHits, ...duplicates(files)];
  const selected = all.filter(hit => only.includes(hit.category));
  const byFile = new Map();
  for (const hit of selected) {
    if (!byFile.has(hit.file)) byFile.set(hit.file, { file: hit.file, score: 0, counts: {}, hits: [] });
    const entry = byFile.get(hit.file);
    entry.score += CATEGORIES[hit.category].weight;
    entry.counts[hit.category] = (entry.counts[hit.category] ?? 0) + 1;
    entry.hits.push(hit);
  }
  const ranked = [...byFile.values()]
    .map(entry => ({ ...entry, hits: entry.hits.sort((a, b) => a.line - b.line || a.category - b.category) }))
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const byCategory = Object.fromEntries(CATEGORY_IDS.map(id => [id, selected.filter(hit => hit.category === id).length]));
  return {
    root,
    scanned: { testFiles: scope.tests.length, helperFiles: scope.fakes.length, testBlocks: blocks },
    totals: { hits: selected.length, byCategory },
    files: ranked,
  };
}

// --------------------------------------------------------------------------------------------- output

const categoryHeader = id => `${id}. ${CATEGORIES[id].name}`;

export function renderMarkdown(result, { top = 25 } = {}) {
  const { scanned, totals, files } = result;
  const lines = [
    '# Test quality audit / 测试质量审计',
    '',
    '> Generated by `node scripts/test-audit.mjs --write` — do not edit by hand. A hit is a candidate for review, not a verdict.',
    '',
    `Scanned **${scanned.testFiles}** test files, **${scanned.testBlocks}** test blocks, plus **${scanned.helperFiles}** fake/helper modules for the shape check.`,
    '',
    `**${totals.hits} hits** in ${files.length} files.`,
    '',
    '| # | Category | Hits | Weight | What a fix does |',
    '| - | -------- | ---- | ------ | --------------- |',
    ...CATEGORY_IDS.map(id => `| ${id} | ${CATEGORIES[id].name} | ${totals.byCategory[id]} | ${CATEGORIES[id].weight} | ${CATEGORIES[id].fix} |`),
    '',
    'Category 2 compares the keys of fake/mock return objects with every property name in `lib/`, `ui/`, `packages/` and `locale/`:',
    'a shape that only stands in for an external API (Web Audio, a GitHub response) can be flagged here. Check before acting on one.',
    '',
    `## Most suspicious files (top ${Math.min(top, files.length)})`,
    '',
    '| File | Score | Categories hit |',
    '| ---- | ----- | -------------- |',
    ...files.slice(0, top).map(entry => `| \`${entry.file}\` | ${entry.score} | ${Object.entries(entry.counts).map(([id, count]) => `${id}×${count}`).join(', ')} |`),
    '',
  ];
  for (const id of CATEGORY_IDS) {
    const hits = files.flatMap(entry => entry.hits).filter(hit => hit.category === id);
    lines.push(`## ${categoryHeader(id)} — ${hits.length}`, '');
    if (!hits.length) { lines.push('No hits.', ''); continue; }
    lines.push(`${CATEGORIES[id].fix}.`, '');
    const byFile = new Map();
    for (const hit of hits) {
      if (!byFile.has(hit.file)) byFile.set(hit.file, []);
      byFile.get(hit.file).push(hit);
    }
    for (const [file, list] of byFile) {
      lines.push(`- \`${file}\``);
      for (const hit of list.slice(0, 20)) lines.push(`  - \`${hit.file}:${hit.line}\` — ${hit.message}`);
      if (list.length > 20) lines.push(`  - …and ${list.length - 20} more in this file (see \`--json\`)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

export function renderConsole(result, { top = 25 } = {}) {
  const { scanned, totals, files } = result;
  const width = Math.max(...CATEGORY_IDS.map(id => CATEGORIES[id].name.length));
  const lines = [
    `Test audit: ${scanned.testFiles} test files, ${scanned.testBlocks} test blocks (+${scanned.helperFiles} helper modules for shapes)`,
    '',
    ...CATEGORY_IDS.map(id => `  ${String(id)} ${CATEGORIES[id].name.padEnd(width)} ${String(totals.byCategory[id]).padStart(6)}  ×${CATEGORIES[id].weight}`),
    `  ${'total'.padEnd(width + 2)} ${String(totals.hits).padStart(6)}  in ${files.length} files`,
    '',
    `Most suspicious files (top ${Math.min(top, files.length)}):`,
    ...files.slice(0, top).map((entry, position) => `  ${String(position + 1).padStart(2)}. ${entry.file}  ${entry.score}  (${Object.entries(entry.counts).map(([id, count]) => `${id}×${count}`).join(', ')})`),
  ];
  return lines.join('\n');
}

// --------------------------------------------------------------------------------------------- baseline comparison

const DEFAULT_BASELINE_PATH = 'docs/test-audit-baseline.json';
const BASELINE_JSON_VERSION = 1;
const MAX_ANNOTATIONS = 20;

const isPlainObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Render a deterministic machine-readable JSON baseline (trailing newline). */
export function renderBaselineJson(result) {
  const byCategory = Object.fromEntries(CATEGORY_IDS.map(id => [String(id), 0]));
  const fileMap = new Map();
  for (const entry of result?.files ?? []) {
    const file = String(entry.file).replace(/\\/g, '/');
    const counts = {};
    let fileTotal = 0;
    for (const id of CATEGORY_IDS) {
      const count = Number(entry?.counts?.[id] ?? 0);
      if (count > 0) {
        counts[String(id)] = count;
        byCategory[String(id)] += count;
        fileTotal += count;
      }
    }
    if (fileTotal > 0) fileMap.set(file, counts);
  }
  const sortedFileNames = [...fileMap.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files = {};
  for (const file of sortedFileNames) files[file] = fileMap.get(file);
  const totalHits = CATEGORY_IDS.reduce((sum, id) => sum + byCategory[String(id)], 0);
  const payload = {
    version: BASELINE_JSON_VERSION,
    generatedBy: 'node scripts/test-audit.mjs --write-baseline',
    totals: {
      hits: totalHits,
      files: sortedFileNames.length,
      byCategory,
    },
    files,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

/** Parse and validate a JSON baseline written by `renderBaselineJson`. */
export function parseBaselineJson(text) {
  if (typeof text !== 'string') {
    throw new Error('Invalid baseline JSON: expected a JSON string');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid baseline JSON: ${error.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error('Invalid baseline JSON: root must be a JSON object');
  }
  if (parsed.version !== BASELINE_JSON_VERSION) {
    throw new Error(`Unsupported baseline JSON version: ${JSON.stringify(parsed.version)} (expected ${BASELINE_JSON_VERSION})`);
  }
  if (!isPlainObject(parsed.files)) {
    throw new Error('Invalid baseline JSON: "files" must be an object');
  }
  if (parsed.totals !== undefined && !isPlainObject(parsed.totals)) {
    throw new Error('Invalid baseline JSON: "totals" must be an object');
  }
  if (parsed.totals?.hits !== undefined && (!Number.isInteger(parsed.totals.hits) || parsed.totals.hits < 0)) {
    throw new Error('Invalid baseline JSON: "totals.hits" must be a non-negative integer');
  }
  if (parsed.totals?.byCategory !== undefined && !isPlainObject(parsed.totals.byCategory)) {
    throw new Error('Invalid baseline JSON: "totals.byCategory" must be an object');
  }

  const byCategory = Object.fromEntries(CATEGORY_IDS.map(id => [id, 0]));
  const counts = {};
  for (const [file, fileCounts] of Object.entries(parsed.files)) {
    if (!file || !isPlainObject(fileCounts)) {
      throw new Error(`Invalid baseline JSON: entry for "${file}" must be an object`);
    }
    for (const [rawId, count] of Object.entries(fileCounts)) {
      if (!/^[1-7]$/.test(rawId)) {
        throw new Error(`Invalid baseline JSON: unknown category "${rawId}" in "${file}"`);
      }
      if (!Number.isInteger(count) || count < 0) {
        throw new Error(`Invalid baseline JSON: invalid count for "${file}" category ${rawId}`);
      }
      if (count === 0) continue;
      const id = Number(rawId);
      if (!counts[file]) counts[file] = {};
      counts[file][id] = count;
      byCategory[id] += count;
    }
  }

  const totalHits = CATEGORY_IDS.reduce((sum, id) => sum + byCategory[id], 0);
  return {
    version: parsed.version,
    totals: { hits: totalHits, files: Object.keys(counts).length, byCategory },
    counts,
    hits: {},
  };
}

/** Auto-dispatch baseline parsing by file extension (.json vs .md). */
export function parseBaseline(text, filePath = DEFAULT_BASELINE_PATH) {
  const lower = String(filePath ?? '').toLowerCase();
  if (lower.endsWith('.json')) return parseBaselineJson(text);
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return parseBaselineMarkdown(text);
  return String(text ?? '').trimStart().startsWith('{') ? parseBaselineJson(text) : parseBaselineMarkdown(text);
}

/** Parse a Markdown report written by `renderMarkdown` as the single baseline source of truth. */
export function parseBaselineMarkdown(markdown) {
  const byCategory = Object.fromEntries(CATEGORY_IDS.map(id => [id, 0]));
  const counts = {};
  const hits = {};
  const lines = String(markdown ?? '').replace(/\r\n/g, '\n').split('\n');

  let currentCategory = null;
  let currentFile = null;
  let sawCategoryHeading = false;

  const ensureFileCategory = (file, category) => {
    if (!counts[file]) counts[file] = {};
    if (counts[file][category] == null) counts[file][category] = 0;
    if (!hits[file]) hits[file] = {};
    if (!hits[file][category]) hits[file][category] = [];
  };

  for (const line of lines) {
    // Summary table row: | 1 | read-a-source-and-match-strings | 417 | 10 | ... |
    if (currentCategory == null) {
      const tableMatch = /^\|\s*(\d+)\s*\|\s*[^|]+\|\s*(\d+)\s*\|/.exec(line);
      if (tableMatch) {
        const id = Number(tableMatch[1]);
        if (CATEGORY_IDS.includes(id)) byCategory[id] = Number(tableMatch[2]);
        continue;
      }
    }

    // Category section heading: ## 1. read-a-source-and-match-strings — 417
    const headingMatch = /^##\s+(\d+)\.\s+.+?\s+[—–-]\s+(\d+)\s*$/.exec(line);
    if (headingMatch) {
      const id = Number(headingMatch[1]);
      if (CATEGORY_IDS.includes(id)) {
        currentCategory = id;
        currentFile = null;
        sawCategoryHeading = true;
        byCategory[id] = Number(headingMatch[2]);
      } else {
        currentCategory = null;
        currentFile = null;
      }
      continue;
    }

    // Any other level-2 heading ends the active category section.
    if (/^##\s+/.test(line)) {
      currentCategory = null;
      currentFile = null;
      continue;
    }

    if (currentCategory == null) continue;
    if (line.trim() === 'No hits.') { currentFile = null; continue; }

    // File bullet: - `tests/foo.test.mjs`
    const fileMatch = /^- `([^`]+)`\s*$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[1];
      ensureFileCategory(currentFile, currentCategory);
      continue;
    }

    // Hit bullet:   - `tests/foo.test.mjs:12` — message
    const hitMatch = /^  - `(.+):(\d+)`\s+[—–-]\s+(.+)$/.exec(line);
    if (hitMatch) {
      const file = hitMatch[1] || currentFile;
      if (!file) continue;
      currentFile = file;
      ensureFileCategory(file, currentCategory);
      counts[file][currentCategory] += 1;
      hits[file][currentCategory].push({
        category: currentCategory,
        file,
        line: Number(hitMatch[2]),
        message: hitMatch[3],
      });
      continue;
    }

    // Overflow bullet:   - …and 10 more in this file (see `--json`)
    const overflowMatch = /^  - (?:…|\.\.\.)and\s+(\d+)\s+more in this file\b/.exec(line);
    if (overflowMatch && currentFile) {
      ensureFileCategory(currentFile, currentCategory);
      counts[currentFile][currentCategory] += Number(overflowMatch[1]);
    }
  }

  // If a minimal fixture omitted category headings and table rows, derive byCategory from per-file counts.
  if (!sawCategoryHeading) {
    for (const id of CATEGORY_IDS) {
      if (byCategory[id] === 0) {
        let sum = 0;
        for (const fileCounts of Object.values(counts)) sum += fileCounts[id] ?? 0;
        if (sum > 0) byCategory[id] = sum;
      }
    }
  }

  const totalHits = CATEGORY_IDS.reduce((sum, id) => sum + (byCategory[id] ?? 0), 0);
  return { totals: { hits: totalHits, byCategory }, counts, hits };
}

/** Pick up to `delta` representative newly introduced hits for one (file, category). */
function pickRepresentativeHits(currentHits, baselineHits, baselineCount, delta) {
  if (delta <= 0 || !currentHits.length) return [];
  const available = baselineHits.map((hit, idx) => ({ hit, idx, used: false }));
  const matched = new Set();

  // Pass 1: exact (line, message) match.
  for (let i = 0; i < currentHits.length; i += 1) {
    const cur = currentHits[i];
    const found = available.find(item => !item.used && item.hit.line === cur.line && item.hit.message === cur.message);
    if (found) { found.used = true; matched.add(i); }
  }

  // Pass 2: message-only match (handles line shifts when lines are inserted/removed above).
  for (let i = 0; i < currentHits.length; i += 1) {
    if (matched.has(i)) continue;
    const cur = currentHits[i];
    const found = available.find(item => !item.used && item.hit.message === cur.message);
    if (found) { found.used = true; matched.add(i); }
  }

  const unmatched = currentHits.filter((_, idx) => !matched.has(idx));
  if (unmatched.length <= delta) {
    if (unmatched.length === delta) return unmatched;
    const extra = currentHits.filter((_, idx) => matched.has(idx)).slice(-(delta - unmatched.length));
    return [...unmatched, ...extra].sort((a, b) => a.line - b.line);
  }

  // When baseline was truncated (>20 hits in one file/category) or messages changed, prioritize unseen messages,
  // then items within the listed baseline line window (if truncated), then newest lines from the tail.
  const baseMessages = new Set(baselineHits.map(item => item.message));
  const truncated = baselineCount > baselineHits.length;
  const maxListedLine = baselineHits.reduce((max, item) => Math.max(max, item.line), 0);

  const unseenMessage = [];
  const withinWindow = [];
  const tail = [];
  for (const hit of unmatched) {
    if (baseMessages.size > 0 && !baseMessages.has(hit.message)) unseenMessage.push(hit);
    else if (truncated && maxListedLine > 0 && hit.line <= maxListedLine) withinWindow.push(hit);
    else tail.push(hit);
  }

  const picked = [];
  const takeFrom = (list, fromEnd = false) => {
    const need = delta - picked.length;
    if (need <= 0 || !list.length) return;
    const slice = fromEnd ? list.slice(-need) : list.slice(0, need);
    picked.push(...slice);
  };
  takeFrom(unseenMessage, false);
  takeFrom(withinWindow, false);
  takeFrom(tail, true);
  return picked.sort((a, b) => a.line - b.line);
}

/** Compare current `auditTree` result against a parsed baseline. Reports ONLY increases (delta > 0). */
export function diffAgainstBaseline(currentResult, baseline, { only = CATEGORY_IDS } = {}) {
  const activeCategories = CATEGORY_IDS.filter(id => only.includes(id));
  const currentByFile = new Map((currentResult?.files ?? []).map(entry => [entry.file, entry]));
  const baselineCounts = baseline?.counts ?? {};
  const baselineHits = baseline?.hits ?? {};
  const allFiles = [...new Set([...currentByFile.keys(), ...Object.keys(baselineCounts)])].sort();

  const byCategory = Object.fromEntries(activeCategories.map(id => [id, {
    baseline: 0,
    current: 0,
    added: 0,
    removed: 0,
    delta: 0,
  }]));

  let newHits = 0;
  let removedHits = 0;
  let improvedFiles = 0;
  const regressedFiles = [];

  for (const file of allFiles) {
    const currentEntry = currentByFile.get(file);
    const fileRegressions = [];
    let fileAdded = 0;
    let fileAddedScore = 0;
    let fileRemoved = 0;

    for (const id of activeCategories) {
      const currentCount = currentEntry?.counts?.[id] ?? 0;
      const baseCount = baselineCounts[file]?.[id] ?? 0;
      const delta = currentCount - baseCount;
      byCategory[id].baseline += baseCount;
      byCategory[id].current += currentCount;
      if (delta > 0) {
        byCategory[id].added += delta;
        newHits += delta;
        fileAdded += delta;
        fileAddedScore += delta * CATEGORIES[id].weight;
        const currentCategoryHits = (currentEntry?.hits ?? []).filter(hit => hit.category === id);
        const baseCategoryHits = baselineHits[file]?.[id] ?? [];
        const representative = pickRepresentativeHits(currentCategoryHits, baseCategoryHits, baseCount, delta);
        fileRegressions.push({ category: id, baseline: baseCount, current: currentCount, delta, hits: representative });
      } else if (delta < 0) {
        const diff = -delta;
        byCategory[id].removed += diff;
        removedHits += diff;
        fileRemoved += diff;
      }
    }

    if (fileRemoved > 0 && fileAdded === 0) improvedFiles += 1;
    if (fileAdded > 0) {
      const hits = fileRegressions
        .flatMap(entry => entry.hits)
        .sort((a, b) => a.line - b.line || a.category - b.category);
      regressedFiles.push({
        file,
        added: fileAdded,
        addedScore: fileAddedScore,
        categories: fileRegressions,
        hits,
      });
    }
  }

  for (const id of activeCategories) {
    byCategory[id].delta = byCategory[id].current - byCategory[id].baseline;
  }

  regressedFiles.sort((a, b) => b.addedScore - a.addedScore || b.added - a.added || a.file.localeCompare(b.file));
  const baselineTotal = activeCategories.reduce((sum, id) => sum + byCategory[id].baseline, 0);
  const currentTotal = activeCategories.reduce((sum, id) => sum + byCategory[id].current, 0);
  const hits = regressedFiles.flatMap(entry => entry.hits);

  return {
    newHits,
    removedHits,
    netDelta: newHits - removedHits,
    improvedFiles,
    baselineTotal,
    currentTotal,
    byCategory,
    files: regressedFiles,
    hits,
  };
}

/** Render a concise console + Markdown advisory diff report. */
export function renderDiffReport(diff, { baselinePath = DEFAULT_BASELINE_PATH, maxHitsPerFile = 10 } = {}) {
  if (diff.newHits === 0) {
    const cleaned = diff.removedHits > 0 ? `${diff.removedHits} removed; ` : '';
    return `Test audit (advisory): 0 new low-value test hits vs ${baselinePath} (${cleaned}total ${diff.currentTotal}, baseline ${diff.baselineTotal}).`;
  }

  const cleanedSuffix = diff.removedHits > 0 ? `, cleaned up: -${diff.removedHits}` : '';
  const lines = [
    '## Test audit (advisory, non-blocking)',
    '',
    `Found **+${diff.newHits} new hit(s)** in **${diff.files.length} file(s)** compared to \`${baselinePath}\` (current total: ${diff.currentTotal}, baseline: ${diff.baselineTotal}${cleanedSuffix}).`,
    'This check is **advisory only** and never blocks merge. A hit is a candidate for review, not a verdict.',
    '',
    '| File | New hits | Categories |',
    '| ---- | -------- | ---------- |',
    ...diff.files.map(entry => {
      const breakdown = entry.categories
        .map(cat => `${cat.category}×${cat.delta} (${cat.baseline}→${cat.current})`)
        .join(', ');
      return `| \`${entry.file}\` | +${entry.added} | ${breakdown} |`;
    }),
    '',
    '### Category breakdown (new hits)',
    '',
    '| # | Category | Added | Baseline → Current | Fix hint |',
    '| - | -------- | ----- | ------------------ | -------- |',
    ...Object.entries(diff.byCategory)
      .filter(([, stats]) => stats.added > 0)
      .map(([id, stats]) => `| ${id} | ${CATEGORIES[id].name} | +${stats.added} | ${stats.baseline} → ${stats.current} | ${CATEGORIES[id].fix} |`),
    '',
    '### Newly added hits',
    '',
  ];

  for (const entry of diff.files) {
    lines.push(`- \`${entry.file}\``);
    for (const hit of entry.hits.slice(0, maxHitsPerFile)) {
      lines.push(`  - \`${hit.file}:${hit.line}\` [cat ${hit.category}] — ${hit.message}`);
    }
    if (entry.hits.length > maxHitsPerFile) {
      lines.push(`  - …and ${entry.hits.length - maxHitsPerFile} more in this file`);
    }
  }

  return lines.join('\n');
}

const escapeWorkflowData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeWorkflowProperty = value => escapeWorkflowData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** Format GitHub Actions `::warning` annotations for newly introduced hits (capped). */
export function formatAnnotations(diff, { max = MAX_ANNOTATIONS } = {}) {
  return (diff?.hits ?? []).slice(0, max).map(hit => {
    const file = escapeWorkflowProperty(hit.file);
    const title = escapeWorkflowProperty(`test-audit (cat ${hit.category})`);
    const message = escapeWorkflowData(`${CATEGORIES[hit.category].name}: ${hit.message}`);
    return `::warning file=${file},line=${hit.line},title=${title}::${message}`;
  });
}

export function parseArgs(argv) {
  const options = {
    write: false,
    writeBaseline: null,
    json: false,
    only: CATEGORY_IDS,
    top: 25,
    root: null,
    compareBaseline: null,
    annotations: false,
  };
  for (const arg of argv) {
    if (arg === '--write') options.write = true;
    else if (arg === '--write-baseline') options.writeBaseline = DEFAULT_BASELINE_PATH;
    else if (arg.startsWith('--write-baseline=')) {
      options.writeBaseline = arg.slice('--write-baseline='.length) || DEFAULT_BASELINE_PATH;
    } else if (arg === '--json') options.json = true;
    else if (arg === '--annotations') options.annotations = true;
    else if (arg === '--compare-baseline') options.compareBaseline = DEFAULT_BASELINE_PATH;
    else if (arg.startsWith('--compare-baseline=')) {
      options.compareBaseline = arg.slice('--compare-baseline='.length) || DEFAULT_BASELINE_PATH;
    } else if (arg.startsWith('--top=')) options.top = Math.max(1, Number(arg.slice(6)) || 25);
    else if (arg.startsWith('--only=')) {
      const ids = arg.slice(7).split(',').map(Number).filter(id => CATEGORY_IDS.includes(id));
      if (ids.length) options.only = [...new Set(ids)].sort();
      else throw new Error(`--only needs category numbers 1-7, got "${arg.slice(7)}"`);
    } else if (arg.startsWith('--root=')) options.root = resolve(arg.slice(7));
  }
  return options;
}

export function run(argv = process.argv.slice(2), { log = console.log, env = process.env } = {}) {
  const options = parseArgs(argv);
  const root = options.root ?? fileURLToPath(new URL('../', import.meta.url));
  const result = auditTree(root, { only: options.only });

  if (options.compareBaseline) {
    const baselineFile = resolve(root, options.compareBaseline);
    if (!existsSync(baselineFile)) {
      const notice = `Test audit (advisory): baseline file not found at ${options.compareBaseline}; skipping comparison (non-blocking).`;
      if (options.json) {
        log(JSON.stringify({ baselinePath: options.compareBaseline, baselineMissing: true, diff: null }, null, 2));
      } else {
        log(notice);
        if (env?.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${notice}\n`, 'utf8');
      }
      return { ...result, baselineMissing: true, diff: null };
    }

    let baseline;
    try {
      baseline = parseBaseline(readFileSync(baselineFile, 'utf8'), options.compareBaseline);
    } catch (error) {
      const notice = `Test audit (advisory): failed to load baseline at ${options.compareBaseline} (${error.message}); skipping comparison (non-blocking).`;
      if (options.json) {
        log(JSON.stringify({ baselinePath: options.compareBaseline, baselineInvalid: true, error: error.message, diff: null }, null, 2));
      } else {
        log(notice);
        if (env?.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${notice}\n`, 'utf8');
      }
      return { ...result, baselineInvalid: true, error: error.message, diff: null };
    }

    const diff = diffAgainstBaseline(result, baseline, { only: options.only });
    if (options.json) {
      log(JSON.stringify({ baselinePath: options.compareBaseline, diff }, null, 2));
      return { ...result, diff };
    }

    const report = renderDiffReport(diff, { baselinePath: options.compareBaseline });
    log(report);
    if (options.annotations && diff.hits.length > 0) {
      const annotations = formatAnnotations(diff, { max: MAX_ANNOTATIONS });
      for (const line of annotations) log(line);
      if (diff.hits.length > annotations.length) {
        log(`Test audit (advisory): omitted ${diff.hits.length - annotations.length} additional annotation(s) (cap ${MAX_ANNOTATIONS}).`);
      }
    }
    if (env?.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${report}\n`, 'utf8');
    return { ...result, diff };
  }

  if (options.json) {
    if (options.writeBaseline) {
      const file = resolve(root, options.writeBaseline);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, renderBaselineJson(result), 'utf8');
    }
    log(JSON.stringify(result, null, 2));
    return result;
  }
  log(renderConsole(result, { top: options.top }));
  if (options.write) {
    const file = join(root, 'docs', 'test-audit.md');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${renderMarkdown(result, { top: options.top })}\n`, 'utf8');
    log(`\nReport written to ${relative(root, file)}`);
  }
  if (options.writeBaseline) {
    const file = resolve(root, options.writeBaseline);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, renderBaselineJson(result), 'utf8');
    log(`\nBaseline written to ${relative(root, file)}`);
  }
  return result;
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
