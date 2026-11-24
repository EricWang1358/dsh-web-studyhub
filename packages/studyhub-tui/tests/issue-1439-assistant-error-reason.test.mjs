// #1439: the assistant's "mark reason" used a made-up action and always said "careless".
// The assistant now asks which of the six reasons applies and writes through the real backend
// action. The contract tests below run the parser's output against that real action.
// Run: node --test tests/issue-1439-assistant-error-reason.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { Box, render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';
import { ERROR_REASONS as BACKEND_REASONS, errorReasonMutations } from '../../../lib/contexts/study/error-reason.js';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ parseAssistantIntent }, { buildContextChips }, { ERROR_REASONS }, assistantMod, { useTuiStore }] = await Promise.all([
  import('../src/shell/assistant-intent.ts'),
  import('../src/shell/assistant-chips.ts'),
  import('../src/views/wrongbook/helpers.ts'),
  import('../src/shell/AssistantPanel.tsx'),
  import('../src/state/store.ts'),
]);
const { AssistantPanel, _resetAssistantSessionMemory } = assistantMod;

const SET_REASON = 'attempt.errorReason.set';
const CARD = { currentCardId: 'c1', currentDeckId: 'd1' };

/** A library holding one failed attempt on d1/c1, the shape the backend action looks up. */
const libraryWithFailedAttempt = () => ({ attempts: [{ deckId: 'd1', cardId: 'c1', runId: 'r1', grade: 1 }] });

describe('#1439 parser: a named reason maps to the backend reason id', () => {
  test('"标记为粗心" becomes a confirmed write of slip through the real action', () => {
    const intent = parseAssistantIntent('把这题加入错题本并标记为粗心', CARD);
    assert.equal(intent.kind, 'write_confirm');
    assert.equal(intent.actionName, SET_REASON);
    assert.deepEqual(intent.params, { deckId: 'd1', cardId: 'c1', errorReason: 'slip' });
    assert.equal(intent.requiresConfirm, true);
  });

  test('every reason the wrong-book shows is understood by its Chinese and English name', () => {
    for (const reason of ERROR_REASONS) {
      for (const name of [reason.zh, reason.en]) {
        const intent = parseAssistantIntent(`错因标为${name}`, CARD);
        assert.equal(intent.kind, 'write_confirm', name);
        assert.equal(intent.params.errorReason, reason.id, name);
      }
    }
  });

  test('the confirmation names the reason the way the wrong-book does', () => {
    const intent = parseAssistantIntent('标记为粗心', CARD);
    assert.match(intent.previewMessage, /粗心手滑/);
  });
});

describe('#1439 parser: no reason is ever assumed', () => {
  test('without a reason the learner is asked to pick one', () => {
    for (const text of ['标记错因', '把这题加入错题本']) {
      const intent = parseAssistantIntent(text, CARD);
      assert.equal(intent.kind, 'pick_error_reason', text);
      assert.equal(intent.actionName, SET_REASON, text);
    }
  });

  test('a reason the backend does not know is not sent; the learner picks instead', () => {
    const intent = parseAssistantIntent('错因标为今天状态不好', CARD);
    assert.equal(intent.kind, 'pick_error_reason');
  });

  test('"mark as" something that is not a mistake reason is left to other commands', () => {
    assert.notEqual(parseAssistantIntent('把这份资料标记为重读', CARD).kind, 'pick_error_reason');
    assert.notEqual(parseAssistantIntent('把这份资料标记为重读', CARD).kind, 'write_confirm');
  });
});

describe('#1439 contract: what the assistant sends is what the backend accepts', () => {
  test('the reason list matches the backend list', () => {
    assert.deepEqual([...ERROR_REASONS.map((r) => r.id)].sort(), [...BACKEND_REASONS].sort());
  });

  test('the real action stores each reason from the parser output', () => {
    for (const reason of ERROR_REASONS) {
      const intent = parseAssistantIntent(`标记为${reason.zh}`, CARD);
      const library = libraryWithFailedAttempt();
      const answer = errorReasonMutations[SET_REASON](library, intent.params);
      assert.equal(answer.updated, true, reason.id);
      assert.equal(library.attempts[0].errorReason, reason.id);
    }
  });
});

describe('#1439 chips: the chip no longer decides the reason', () => {
  const chipsFor = (card) => buildContextChips({ page: 'review', card, practiceStack: [], statsByPage: {}, lang: 'zh' });

  test('after a wrong answer the chip asks to mark a reason and names none', () => {
    const chips = chipsFor({ deckId: 'd1', cardId: 'c1', isWrong: true });
    const mark = chips.find((chip) => chip.id === 'chip:mark-wrong');
    assert.ok(mark, 'the mark-reason chip is offered after a wrong answer');
    assert.equal(mark.label, '标记错因');
    assert.equal(parseAssistantIntent(mark.command, CARD).kind, 'pick_error_reason');
  });

  test('a card that was not answered wrong offers no mark-reason chip', () => {
    const chips = chipsFor({ deckId: 'd1', cardId: 'c1', isWrong: false });
    assert.equal(chips.some((chip) => chip.id === 'chip:mark-wrong'), false);
    assert.equal(chips.some((chip) => /错题本|标记为/.test(chip.command)), false);
  });
});

function createInkHarness(element, { cols = 96, rows = 30 } = {}) {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  stdin.ref = () => stdin;
  stdin.unref = () => stdin;
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = cols;
  stdout.rows = rows;
  stdout.getColorDepth = () => 1;
  const frames = [];
  stdout.on('data', (chunk) => {
    const plain = stripAnsi(chunk.toString('utf8'));
    if (plain.trim()) frames.push(plain);
  });
  const inst = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true, interactive: true });
  const latest = () => frames.at(-1) ?? '';
  return {
    write: (s) => stdin.write(s),
    async waitFor(predicate, timeoutMs = 3000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate(latest())) return latest();
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error(`Timed out waiting for frame. Last frame:\n${latest() || '<empty>'}`);
    },
    cleanup() {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
    },
  };
}

function openPanelOnWrongCard(host) {
  _resetAssistantSessionMemory();
  useTuiStore.setState({
    page: 'review',
    navContext: {},
    inputCaptured: false,
    showLaunchpad: false,
    practiceStack: [],
    assistantOpen: true,
    assistantFocused: true,
    assistantFullscreen: false,
    assistantTab: 'assistant',
    assistantStage: 'question',
    assistantCardContext: { runId: 'r1', deckId: 'd1', cardId: 'c1', cardIndex: 0, total: 3, prompt: '示例题', isWrong: true, revealed: true },
    snapshot: { focus: { course: '示例课' }, courses: [], decks: [{ id: 'd1', title: '示例题组' }], sources: [], jobs: [] },
    toasts: [],
    footerHints: [],
  });
  return createInkHarness(
    React.createElement(
      Box,
      { width: 96, height: 30 },
      React.createElement(AssistantPanel, { host, isActive: true, width: 96, height: 30, docked: true, onClose: () => {} }),
    ),
  );
}

/** A host backed by the real backend action, so a wrong name or argument fails here as it would for a learner. */
function hostOverRealAction(library) {
  const calls = [];
  return {
    calls,
    getLibraryRoot: () => '',
    call: async (name, args) => {
      calls.push({ name, args });
      if (name !== SET_REASON) return { ok: false, error: { message: `Unknown action: ${name}` } };
      try {
        return { ok: true, value: errorReasonMutations[SET_REASON](library, args) };
      } catch (failure) {
        if (failure?.noWrite) return { ok: true, value: failure.noWrite };
        return { ok: false, error: { message: failure.message, code: failure.code } };
      }
    },
  };
}

describe('#1439 panel: pick a reason, write it through the real action, undo it', () => {
  test('the chip lists the six reasons; picking one stores it and [z] clears it', async () => {
    const library = libraryWithFailedAttempt();
    const host = hostOverRealAction(library);
    const h = openPanelOnWrongCard(host);
    try {
      const chipFrame = await h.waitFor((s) => s.includes('标记错因'));
      const chipKey = chipFrame.match(/\[(\d)\]标记错因/)?.[1];
      assert.ok(chipKey, `the chip shows its number key:\n${chipFrame}`);
      h.write(chipKey);
      const picker = await h.waitFor((s) => ERROR_REASONS.every((r) => s.includes(r.zh)));
      assert.ok(picker.includes('选择错因'), 'the picker says what is being chosen');
      assert.equal(host.calls.length, 0, 'nothing is written before a reason is picked');

      h.write('2');
      await h.waitFor((s) => s.includes('错因已标为「漏看条件」'));
      assert.deepEqual(host.calls.at(-1), { name: SET_REASON, args: { deckId: 'd1', cardId: 'c1', errorReason: 'condition' } });
      assert.equal(library.attempts[0].errorReason, 'condition');

      h.write('z');
      await h.waitFor((s) => s.includes('已撤销'));
      assert.equal(library.attempts[0].errorReason, undefined, 'undo clears the reason in the library');
    } finally {
      h.cleanup();
    }
  });

  test('a card with no answer on record gets a plain explanation, not a failure', async () => {
    const host = hostOverRealAction({ attempts: [] });
    const h = openPanelOnWrongCard(host);
    try {
      const chipFrame = await h.waitFor((s) => s.includes('标记错因'));
      h.write(chipFrame.match(/\[(\d)\]标记错因/)[1]);
      await h.waitFor((s) => s.includes('粗心手滑'));
      h.write('4');
      const frame = await h.waitFor((s) => s.includes('还没有作答记录'));
      assert.equal(frame.includes('错因已标为'), false);
    } finally {
      h.cleanup();
    }
  });

  test('Esc on the picker writes nothing', async () => {
    const host = hostOverRealAction(libraryWithFailedAttempt());
    const h = openPanelOnWrongCard(host);
    try {
      const chipFrame = await h.waitFor((s) => s.includes('标记错因'));
      h.write(chipFrame.match(/\[(\d)\]标记错因/)[1]);
      await h.waitFor((s) => s.includes('粗心手滑'));
      h.write('\u001b');
      await h.waitFor((s) => s.includes('已取消'));
      assert.equal(host.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });
});
