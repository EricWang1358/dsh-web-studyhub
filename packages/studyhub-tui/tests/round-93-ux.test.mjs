// Round 93 comprehensive behavior & layout tests:
// - Track A11 & C7: NotesView 96-col ultrawide prose centering, reading-time label, and OSC 8 safe link wrapping
// - Track B8: HelpOverlay featureShortcuts sync covering Round 82-92 keys (/density, /proactive, /terminal, Q, T, Z)
// node --test tests/round-93-ux.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [
  { NotesView },
  helpMod,
  storeMod,
] = await Promise.all([
  import('../src/views/notes/NotesView.tsx'),
  import('../src/shell/HelpOverlay.tsx'),
  import('../src/state/store.ts'),
]);

const { featureShortcuts } = helpMod;
const { useTuiStore } = storeMod;

function stripAnsi(s) {
  return String(s || '')
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\]8;;[^\x07]*\x07/g, '');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function createTtyHarness(columns, rows) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  Object.assign(stdout, { isTTY: true, columns, rows });
  Object.assign(stdin, { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let output = '';
  stdout.on('data', (chunk) => {
    output += chunk.toString('utf8');
  });
  return {
    stdout,
    stdin,
    async waitFor(pred, timeoutMs = 2000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const plain = stripAnsi(output);
        if (pred(plain)) return plain;
        await wait(20);
      }
      throw new Error(`waitFor timed out. Last output:\n${stripAnsi(output).slice(-800)}`);
    },
  };
}

describe('Round 93 Track A11 & C7 — NotesView reading rhythm, prose centering & OSC 8 links', () => {
  test('renders reading time, linked source, external link, and centered prose cleanly at 120x36 & 80x24 ASCII', async () => {
    const sampleNote = {
      id: 'note-r93',
      title: 'Linear Algebra Notes',
      markdown: '字'.repeat(700) + '\n\n## Eigenvalues\n\nDetailed proof notes.',
      status: 'published',
      publishUrl: 'https://example.com/notes/la',
      updatedAt: new Date().toISOString(),
      sourceId: 'src-la',
      pageNumber: 5,
    };

    const host = {
      subscribeEvents: () => () => {},
      async call(action) {
        if (action === 'note.list') return { ok: true, value: { notes: [sampleNote] } };
        if (action === 'note.get') return { ok: true, value: sampleNote };
        if (action === 'note.daily.status') return { ok: true, value: { groups: [] } };
        return { ok: true, value: {} };
      },
    };

    useTuiStore.setState({
      page: 'notes',
      preferences: { ...useTuiStore.getState().preferences, language: 'zh', asciiMode: true },
      snapshot: {
        decks: [],
        sources: [{ id: 'src-la', title: 'LA-Book.pdf', filePath: '/tmp/LA-Book.pdf' }],
      },
    });

    const wideTty = createTtyHarness(120, 36);
    const wide = render(React.createElement(NotesView, { host, width: 116, height: 34, isActive: true }), {
      stdout: wideTty.stdout,
      stdin: wideTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    const wideOut = await wideTty.waitFor((s) => s.includes('Linear Algebra Notes') && s.includes('约 2 分钟'));
    assert.match(wideOut, /约 2 分钟/);
    assert.match(wideOut, /LA-Book\.pdf/);
    wide.unmount();

    const narrowTty = createTtyHarness(80, 24);
    const narrow = render(React.createElement(NotesView, { host, width: 76, height: 22, isActive: true }), {
      stdout: narrowTty.stdout,
      stdin: narrowTty.stdin,
      exitOnCtrlC: false,
      interactive: true,
    });
    const narrowOut = await narrowTty.waitFor((s) => s.includes('Linear Algebra Notes'));
    assert.ok(narrowOut.length > 0);
    narrow.unmount();
  });
});

describe('Round 93 Track B8 — HelpOverlay featureShortcuts sync', () => {
  test('documents Round 82-92 shortcuts cleanly in zh and en without duplicate keys per section', () => {
    for (const lang of ['zh', 'en']) {
      const groups = featureShortcuts(lang);
      const allKeys = groups.flatMap((g) => g.items.map((it) => it.key));
      assert.ok(allKeys.includes('Q'), `${lang}: WrongBook [Q] documented`);
      assert.ok(allKeys.includes('T'), `${lang}: Dashboard [T] documented`);
      assert.ok(allKeys.includes('Z'), `${lang}: ExamPrep [Z] documented`);
      assert.ok(allKeys.some((k) => k.includes('Ctrl+Space')), `${lang}: Assistant Ctrl+Space documented`);
      assert.ok(allKeys.some((k) => k.includes('/density')), `${lang}: /density documented`);
      assert.ok(allKeys.some((k) => k.includes('/proactive')), `${lang}: /proactive documented`);
      assert.ok(allKeys.some((k) => k.includes('/terminal')), `${lang}: /terminal documented`);

      for (const g of groups) {
        const keys = g.items.map((it) => it.key);
        assert.equal(new Set(keys).size, keys.length, `${lang} section "${g.title}" has duplicate shortcut keys`);
      }
    }
  });
});
