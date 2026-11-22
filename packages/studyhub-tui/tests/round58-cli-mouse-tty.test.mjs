// Unit tests for round58 SGR 1006 mouse wheel opt-in CLI & TTY lifecycle:
// `node --test tests/round58-cli-mouse-tty.test.mjs`
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { tsImport } from 'tsx/esm/api';

const cliArgsMod = await tsImport('../src/cli-args.ts', import.meta.url);
const terminalMod = await tsImport('../src/terminal.ts', import.meta.url);

const { parseCliArgs, shouldEnableMouse, cliHelpText } = cliArgsMod;
const { enterTerminalSession, ENABLE_SGR_MOUSE, DISABLE_SGR_MOUSE } = terminalMod;

describe('parseCliArgs & shouldEnableMouse (--mouse / --no-mouse / STUDYHUB_TUI_MOUSE)', () => {
  test('parseCliArgs leaves mouse undefined by default and supports --mouse / --no-mouse', () => {
    const def = parseCliArgs([]);
    assert.equal(def.mouse, undefined);
    assert.equal(def.error, undefined);

    const enabled = parseCliArgs(['--mouse']);
    assert.equal(enabled.mouse, true);
    assert.equal(enabled.error, undefined);

    const disabled = parseCliArgs(['--no-mouse']);
    assert.equal(disabled.mouse, false);
    assert.equal(disabled.error, undefined);

    assert.equal(parseCliArgs(['--mouse', '--no-mouse']).mouse, false);
    assert.equal(parseCliArgs(['--no-mouse', '--mouse']).mouse, true);
  });

  test('shouldEnableMouse is opt-in and parses truthy/falsy env values', () => {
    assert.equal(shouldEnableMouse({}), false);
    assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: '' }), false);
    assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: '   ' }), false);

    for (const val of ['1', 'true', 'yes', 'on', ' TRUE ', 'On', 'Yes']) {
      assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: val }), true, `expected true for ${JSON.stringify(val)}`);
    }

    for (const val of ['0', 'false', 'no', 'off', ' FALSE ', 'Off', 'No', 'invalid']) {
      assert.equal(shouldEnableMouse({ STUDYHUB_TUI_MOUSE: val }), false, `expected false for ${JSON.stringify(val)}`);
    }
  });

  test('cliHelpText documents --mouse, --no-mouse, and STUDYHUB_TUI_MOUSE', () => {
    const help = cliHelpText('1.0.0');
    assert.ok(help.includes('--mouse'), 'help text mentions --mouse');
    assert.ok(help.includes('--no-mouse'), 'help text mentions --no-mouse');
    assert.ok(help.includes('STUDYHUB_TUI_MOUSE'), 'help text mentions STUDYHUB_TUI_MOUSE');
  });
});

describe('enterTerminalSession SGR 1006 mouse lifecycle', () => {
  function makeMockTty({ stdoutTty = true, stdinTty = true, isRaw = true } = {}) {
    const written = [];
    const rawCalls = [];

    const stdout = new EventEmitter();
    stdout.isTTY = stdoutTty;
    stdout.setDefaultEncoding = () => {};
    stdout.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };

    const stdin = new EventEmitter();
    stdin.isTTY = stdinTty;
    stdin.isRaw = isRaw;
    stdin.setRawMode = (mode) => {
      rawCalls.push(mode);
      stdin.isRaw = mode;
      return stdin;
    };

    return { stdout, stdin, written, rawCalls };
  }

  test('default (mouse omitted or false) writes alt screen ONLY and keeps mouseActive false', () => {
    for (const mouseOpt of [undefined, false]) {
      const mock = makeMockTty();
      const session = enterTerminalSession({
        stdout: mock.stdout,
        stdin: mock.stdin,
        altScreen: true,
        ...(mouseOpt === undefined ? {} : { mouse: mouseOpt }),
      });

      assert.equal(session.isTty, true);
      assert.equal(session.altScreenActive, true);
      assert.equal(session.mouseActive, false);
      assert.equal(mock.written.length, 1);
      assert.ok(mock.written[0].includes('\x1b[?1049h'), 'enters alt screen');
      assert.ok(!mock.written[0].includes('\x1b[?1000h'), 'does not write 1000h');
      assert.ok(!mock.written[0].includes('\x1b[?1006h'), 'does not write 1006h');

      session.restore();
      assert.equal(mock.written.length, 2);
      assert.equal(mock.written[1], '\x1b[0m\x1b[?25h\x1b[?1049l');
      assert.ok(!mock.written[1].includes('\x1b[?1006l'));
      assert.ok(!mock.written[1].includes('\x1b[?1000l'));
    }
  });

  test('opt-in (mouse: true) enables SGR 1006 mouse and disables it BEFORE alt-screen exit idempotently', () => {
    assert.equal(ENABLE_SGR_MOUSE, '\x1b[?1000h\x1b[?1006h');
    assert.equal(DISABLE_SGR_MOUSE, '\x1b[?1006l\x1b[?1000l');

    const mock = makeMockTty();
    const session = enterTerminalSession({
      stdout: mock.stdout,
      stdin: mock.stdin,
      altScreen: true,
      mouse: true,
    });

    assert.equal(session.isTty, true);
    assert.equal(session.altScreenActive, true);
    assert.equal(session.mouseActive, true);
    const entryOutput = mock.written.join('');
    assert.ok(entryOutput.includes('\x1b[?1049h'), 'enters alt screen');
    assert.ok(entryOutput.includes('\x1b[?1000h\x1b[?1006h'), 'enables SGR 1006 mouse');

    const countBeforeRestore = mock.written.length;
    session.restore();
    assert.equal(mock.written.length, countBeforeRestore + 1);
    const restoreSeq = mock.written[mock.written.length - 1];
    const disableIdx = restoreSeq.indexOf('\x1b[?1006l\x1b[?1000l');
    const exitAltIdx = restoreSeq.indexOf('\x1b[?1049l');
    const resetIdx = restoreSeq.indexOf('\x1b[0m\x1b[?25h');
    assert.ok(disableIdx >= 0, 'restore writes DISABLE_SGR_MOUSE');
    assert.ok(resetIdx > disableIdx, 'DISABLE_SGR_MOUSE precedes style reset & show cursor');
    assert.ok(exitAltIdx > disableIdx, 'DISABLE_SGR_MOUSE precedes EXIT_ALT_SCREEN');
    assert.deepEqual(mock.rawCalls, [false]);

    // Idempotent second restore()
    session.restore();
    assert.equal(mock.written.length, countBeforeRestore + 1);
    assert.deepEqual(mock.rawCalls, [false]);
  });

  test('opt-in (mouse: true, altScreen: false) enables and restores SGR mouse without alt screen', () => {
    const mock = makeMockTty({ isRaw: false });
    const session = enterTerminalSession({
      stdout: mock.stdout,
      stdin: mock.stdin,
      altScreen: false,
      mouse: true,
    });

    assert.equal(session.altScreenActive, false);
    assert.equal(session.mouseActive, true);
    assert.equal(mock.written.join(''), '\x1b[?1000h\x1b[?1006h');

    session.restore();
    assert.equal(mock.written[mock.written.length - 1], '\x1b[?1006l\x1b[?1000l\x1b[0m\x1b[?25h');
  });

  test('non-TTY streams keep mouseActive false and write nothing even with mouse: true', () => {
    for (const [stdoutTty, stdinTty] of [
      [false, false],
      [false, true],
      [true, false],
    ]) {
      const mock = makeMockTty({ stdoutTty, stdinTty, isRaw: false });
      const session = enterTerminalSession({
        stdout: mock.stdout,
        stdin: mock.stdin,
        altScreen: true,
        mouse: true,
      });

      assert.equal(session.isTty, false);
      assert.equal(session.altScreenActive, false);
      assert.equal(session.mouseActive, false);
      assert.deepEqual(mock.written, []);

      session.restore();
      session.restore();
      assert.deepEqual(mock.written, []);
      assert.deepEqual(mock.rawCalls, []);
    }
  });
});
