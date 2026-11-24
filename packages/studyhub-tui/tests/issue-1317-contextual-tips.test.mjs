// Tests for #1317: Context-aware quiet usage tips in the right empty space of KeyHintBar.
// node --test tests/issue-1317-contextual-tips.test.mjs
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { after, describe, test } from 'node:test';
import { render } from 'ink';
import React from 'react';
import stripAnsi from 'strip-ansi';
import { register } from 'tsx/esm/api';

const unregisterTsx = register();
after(() => {
  unregisterTsx?.();
});

const [{ selectContextualTip }, { KeyHintBar }, storeMod] = await Promise.all([
  import('../src/shell/contextual-tips.ts'),
  import('../src/components/Badge.tsx'),
  import('../src/state/store.ts'),
]);

const { useTuiStore, DEFAULT_PREFERENCES } = storeMod;

function renderOnce(element, cols) {
  return new Promise((resolve) => {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => stdin;
    const stdout = new PassThrough();
    stdout.isTTY = true;
    stdout.columns = cols;
    stdout.rows = 4;
    stdout.getColorDepth = () => 1;

    let last = '';
    stdout.on('data', (chunk) => {
      const plain = stripAnsi(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      if (plain.trim()) last = plain;
    });

    const inst = render(element, { stdout, stdin, exitOnCtrlC: false, patchConsole: false, debug: true });
    setTimeout(() => {
      inst.unmount();
      stdin.destroy();
      stdout.destroy();
      resolve(last);
    }, 60);
  });
}

describe('#1317 Contextual footer usage tips', () => {
  test('1. Selects context-appropriate tips for wrong, right, unanswered, no-model, exam, and disabled settings', () => {
    // Wrong answer -> AI mistake analysis with [h]
    const wrongTip = selectContextualTip({
      page: 'review',
      card: { cardId: 'c1', cardIndex: 0, revealed: true, isWrong: true, hasCitation: true },
      modelReady: true,
      proactiveHints: true,
      lang: 'zh',
      rotation: 0,
    });
    assert.ok(wrongTip);
    assert.equal(wrongTip.key, 'h');
    assert.ok(wrongTip.text.includes('[h]') && wrongTip.text.includes('AI'));

    // Correct answer -> switches away from AI error analysis to retell/focus
    const rightTip = selectContextualTip({
      page: 'review',
      card: { cardId: 'c1', cardIndex: 0, revealed: true, isWrong: false, hasCitation: true },
      modelReady: true,
      proactiveHints: true,
      lang: 'zh',
      rotation: 0,
    });
    assert.ok(rightTip);
    assert.notEqual(rightTip.id, wrongTip.id);
    assert.equal(rightTip.key, 'F');
    assert.ok(rightTip.text.includes('[F]'));

    // Unanswered -> step-by-step teach [L]
    const stuckTip = selectContextualTip({
      page: 'review',
      card: { cardId: 'c1', cardIndex: 0, revealed: false, isWrong: false },
      modelReady: true,
      proactiveHints: true,
      lang: 'zh',
      rotation: 0,
    });
    assert.ok(stuckTip);
    assert.equal(stuckTip.key, 'L');
    assert.ok(stuckTip.text.includes('[L]'));

    // Rotation advances to a different tip on next card or after 10 keystrokes
    const rotated = selectContextualTip({
      page: 'review',
      card: { cardId: 'c2', cardIndex: 1, revealed: false, isWrong: false },
      modelReady: true,
      proactiveHints: true,
      lang: 'zh',
      rotation: 0,
    });
    assert.ok(rotated && rotated.id !== stuckTip.id);

    // No model -> never suggests AI-only tools; points to Settings [,]
    const noModelTip = selectContextualTip({
      page: 'review',
      card: { cardId: 'c1', cardIndex: 0, revealed: true, isWrong: true },
      modelReady: false,
      proactiveHints: true,
      lang: 'zh',
    });
    assert.ok(noModelTip);
    assert.equal(noModelTip.key, ',');
    assert.ok(!/\[[hLTF]\]/.test(noModelTip.text), 'Must not suggest AI keys when model is not ready');

    // Exam mode & proactiveHints=false -> null
    assert.equal(
      selectContextualTip({
        page: 'review',
        card: { cardId: 'c1', revealed: false, isExam: true },
        modelReady: true,
        proactiveHints: true,
        lang: 'zh',
      }),
      null,
    );
    assert.equal(
      selectContextualTip({
        page: 'review',
        card: { cardId: 'c1', revealed: true, isWrong: true },
        modelReady: true,
        proactiveHints: false,
        lang: 'zh',
      }),
      null,
    );
  });

  test('2. KeyHintBar shows tip on wide (150 cols) window, hides on narrow (80 cols) without dropping key hints, and works in zh/en/ascii', async () => {
    const hints = [
      { key: '1-6', label: '作答' },
      { key: 'Enter', label: '下一题' },
      { key: 'h', label: '讲解' },
      { key: 'u', label: '撤销' },
      { key: 'Ctrl+K', label: '命令' },
      { key: '?', label: '帮助' },
    ];
    const zhTip = selectContextualTip({
      page: 'review',
      card: { cardId: 'c1', cardIndex: 0, revealed: true, isWrong: true },
      modelReady: true,
      lang: 'zh',
    });
    const enTip = selectContextualTip({
      page: 'review',
      card: { cardId: 'c1', cardIndex: 0, revealed: true, isWrong: true },
      modelReady: true,
      lang: 'en',
    });

    // Wide 150 cols (zh) -> tip is shown alongside all hints
    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'zh', asciiMode: false } });
    const wideZh = await renderOnce(React.createElement(KeyHintBar, { hints, width: 150, tip: zhTip.text }), 150);
    assert.ok(wideZh.includes('Ctrl+K') && wideZh.includes('帮助'), 'All key hints must stay visible');
    assert.ok(wideZh.includes('AI 帮我分析错在哪'), `Expected tip on 150-col wide bar, got:\n${wideZh}`);

    // Narrow 80 cols -> tip is omitted, all hints preserved
    const narrowZh = await renderOnce(React.createElement(KeyHintBar, { hints, width: 80, tip: zhTip.text }), 80);
    assert.ok(narrowZh.includes('Ctrl+K') && narrowZh.includes('帮助'), 'Key hints must not be squeezed at 80 cols');
    assert.ok(!narrowZh.includes('AI 帮我分析错在哪'), 'Tip must not appear when remaining width is too narrow');

    // Wide 150 cols (en + --ascii) -> pure ASCII output with tip
    useTuiStore.setState({ preferences: { ...DEFAULT_PREFERENCES, language: 'en', asciiMode: true } });
    const enHints = [
      { key: '1-6', label: 'Answer' },
      { key: 'Enter', label: 'Next' },
      { key: 'Ctrl+K', label: 'Cmd' },
      { key: '?', label: 'Help' },
    ];
    const wideEnAscii = await renderOnce(React.createElement(KeyHintBar, { hints: enHints, width: 150, tip: enTip.text }), 150);
    assert.ok(wideEnAscii.includes('[h]') && wideEnAscii.includes('AI mistake analysis'));
    assert.match(wideEnAscii.trim(), /^[\x20-\x7e\r\n]+$/, 'ASCII mode footer with tip must be 100% pure ASCII');
  });
});
