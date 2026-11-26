// Guard: no test may open the machine's real browser. A test that calls `app.open` must hand every
// host it creates a recording `launchExternal` stub, so the host never spawns rundll32 / open / xdg-open
// (headless env tricks such as `DISPLAY: ''` only work on Linux). Run: node --test tests/no-real-browser-guard.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const SELF = path.basename(fileURLToPath(import.meta.url));

/** Every `.mjs` under tests/ (helpers included), except this guard. */
function testSources(dir = testsDir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      out.push(...testSources(full));
    } else if (entry.name.endsWith('.mjs') && entry.name !== SELF) {
      out.push(full);
    }
  }
  return out;
}

/** A call that reaches `app.open`: `host.call('app.open', …)` or `tryAction(host, 'app.open', …)`. */
const APP_OPEN_CALL_RE = /(?:\.call|tryAction)\(\s*(?:[\w.]+\s*,\s*)?['"`]app\.open['"`]/;

/** The text of each `createTuiHost({ … })` options object, found by brace matching. */
function hostOptionBlocks(source) {
  const blocks = [];
  const re = /createTuiHost\(\s*\{/g;
  let match;
  while ((match = re.exec(source))) {
    const start = match.index + match[0].length - 1;
    let depth = 0;
    let end = start;
    for (; end < source.length; end += 1) {
      const ch = source[end];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const line = source.slice(0, match.index).split('\n').length;
    blocks.push({ line, text: source.slice(start, end + 1) });
  }
  return blocks;
}

/** Files that call `app.open` with a host built without a `launchExternal` stub. */
function findUnstubbedOpeners(files) {
  const offenders = [];
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    if (!APP_OPEN_CALL_RE.test(source)) continue;
    for (const block of hostOptionBlocks(source)) {
      if (!/\blaunchExternal\s*:/.test(block.text)) offenders.push(`${path.relative(testsDir, file)}:${block.line}`);
    }
  }
  return offenders;
}

describe('no test opens a real browser', () => {
  test('the scan recognises app.open calls and stubbed / unstubbed hosts', () => {
    assert.match("await host.call('app.open', { url })", APP_OPEN_CALL_RE);
    assert.match("tryAction(host, 'app.open', { url: openTarget })", APP_OPEN_CALL_RE);
    assert.doesNotMatch("// app.open is documented here", APP_OPEN_CALL_RE);
    const blocks = hostOptionBlocks(
      "const a = await createTuiHost({ env: { A: '1' }, launchExternal: (u) => seen.push(u) });\n" +
      'const b = await createTuiHost({ env: {}, onOpenExternal: () => {} });',
    );
    assert.equal(blocks.length, 2);
    assert.match(blocks[0].text, /launchExternal/);
    assert.doesNotMatch(blocks[1].text, /launchExternal/);
  });

  test('every host in a file that calls app.open has a launchExternal stub', () => {
    const offenders = findUnstubbedOpeners(testSources());
    assert.deepEqual(
      offenders,
      [],
      `These hosts can launch the real browser; pass launchExternal: (url) => seen.push(url):\n${offenders.join('\n')}`,
    );
  });
});
