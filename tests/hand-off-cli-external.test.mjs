/* External-agent CLI handoff fallback & prompt wording contracts (#1714):
   - DSH main-chat fill (`outcome === 'filled'`) stays byte-for-byte unchanged (zero extra tokens in both zh and en);
   - Desktop / external clipboard fallback appends program-filled `study-cli.mjs` command (`call <action> --file <payload.json> --root "<libraryRoot>"`)
     inside the StudyHub notes block (keeping trailing `我想：` / `What I want:` at the very end and folded cleanly in HandOffSheet);
   - Explicitly permits calling `study-cli.mjs` via shell when `study_workspace` is unavailable, preserves the stop-without-editing-`.dsh-study/` rule,
     and clarifies that a blank trailing `我想：` / `What I want:` means proceed with the instructions above;
   - Handles partial/missing `studyCliPath` / `libraryRoot` safely (no `undefined`/`null`) and is idempotent;
   - Fixes the ambiguous CLI-ban wording in `ui/topic-group-prompt.js` (zh & en, merge & replace), and verifies the generated `skeleton.topics` /
     `topic.groups.save` payloads execute cleanly against a real temporary StudyService library. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { StudyService } from '../lib/service.js';
import { loadUi } from './helpers/ui-module.mjs';

const m = await loadUi(`
  export { deliverToChat, withLanguageTail } from './ui/hand-off/use-hand-off.js';
  export { default as HandOffSheet } from './ui/hand-off/HandOffSheet.jsx';
  export { StudyServicesContext } from './ui/study-context.jsx';
  export { handOffText } from './ui/agent-prompts/index.js';
  export { messageParts, withExternalCliNote, composeMessage } from './ui/agent-prompts/message.js';
  export { languageTail } from './ui/agent-prompts/say.js';
  export { groupPrompt } from './ui/topic-group-prompt.js';
  export { setUiLanguage } from './ui/i18n.js';
`);

const h = React.createElement;
const CLI_PATH = '/opt/studyhub/runtime/scripts/study-cli.mjs';
const LIB_ROOT = '/Users/learner/Study Library';
const DESKTOP_HOST = {
  capabilities: { edition: 'desktop', chat: false, agentTasks: false, landing: false },
  studyCliPath: CLI_PATH,
};

test('DSH main-chat fill keeps prompt text byte-for-byte unchanged (zero extra tokens) in zh and en', async () => {
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    try {
      const prompt = m.handOffText('topics.group', { mode: 'merge', ungrouped: 8, course: 'OS', alternative: true }, lang);
      const seen = [];
      const copied = [];
      const outcome = await m.deliverToChat({
        host: { askInChat: (text) => { seen.push(text); return 'filled'; }, showChat: () => {} },
        prompt,
        libraryRoot: LIB_ROOT,
        studyCliPath: CLI_PATH,
        notify: () => {},
        clipboard: { writeText: async (text) => copied.push(text) },
      });
      assert.equal(outcome, 'filled', lang);
      assert.deepEqual(seen, [prompt], `${lang}: DSH main-chat fill must stay byte-for-byte unchanged`);
      assert.deepEqual(copied, [], `${lang}: nothing copied when filled`);
      assert.doesNotMatch(seen[0], /study-cli\.mjs|外部调用：|External CLI:/, `${lang}: zero external CLI tokens in DSH main chat`);
    } finally {
      m.setUiLanguage('zh');
    }
  }
});

test('Desktop / external clipboard copy injects program-filled study-cli.mjs fallback inside notes while keeping trailing 我想： / What I want: last', async () => {
  const expectedCmd = `\`node "${CLI_PATH}" call <action> --file <payload.json> --root "${LIB_ROOT}"\``;
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    try {
      const prompt = m.handOffText('topics.group', { mode: 'merge', ungrouped: 5, course: 'Networks', alternative: true }, lang);
      const copied = [];
      const sheets = [];
      const outcome = await m.deliverToChat({
        host: DESKTOP_HOST,
        prompt,
        libraryRoot: LIB_ROOT,
        notify: () => {},
        openSheet: (sheet) => sheets.push(sheet),
        clipboard: { writeText: async (text) => copied.push(text) },
      });
      assert.equal(outcome, 'copied', lang);
      assert.equal(copied.length, 1, lang);
      const text = copied[0];
      assert.ok(text.includes(expectedCmd), `${lang}: expected exact CLI command in copied prompt:\n${text}`);
      assert.ok(text.includes('.dsh-study/'), `${lang}: preserves stop-without-hand-editing .dsh-study/ rule`);
      const expectedTail = lang === 'zh' ? '我想：' : 'What I want:';
      assert.ok(text.endsWith(`\n\n${expectedTail}`), `${lang}: trailing ${expectedTail} remains the very last line`);
      const parts = m.messageParts(text, lang);
      assert.equal(parts.tail, expectedTail, `${lang}: messageParts still detects tail`);
      assert.ok(parts.notes.some((line) => line.includes(expectedCmd)), `${lang}: CLI note lives inside foldable notes`);
      assert.ok(parts.notes.some((line) => line.includes(expectedTail)), `${lang}: blank-tail rule lives inside foldable notes`);
      if (lang === 'zh') {
        assert.match(text, /允许在终端调用 study-cli\.mjs/);
        assert.match(text, /都不可用，请停下来向我说明，不要直接手改 \.dsh-study\//);
        assert.match(text, /留空.*直接按以上附注执行/);
      } else {
        assert.match(text, /allowed to invoke study-cli\.mjs via shell/);
        assert.match(text, /neither study_workspace nor study-cli\.mjs is available, stop and explain/);
        assert.match(text, /What I want:.*left blank.*proceed directly/);
        assert.doesNotMatch(text, /[㐀-鿿]/, 'English copied prompt has zero untranslated Han characters');
      }
      assert.equal(sheets.length, 0);
    } finally {
      m.setUiLanguage('zh');
    }
  }
});

test('External fallback on tail-less structured prompt keeps languageTail last and renders cleanly inside HandOffSheet', async () => {
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    try {
      const prompt = m.handOffText('book.edit', { course: 'OS', hid: 'p1', title: 'Scheduling', bookLanguage: lang }, lang);
      const sheets = [];
      const outcome = await m.deliverToChat({
        host: DESKTOP_HOST,
        prompt,
        libraryRoot: LIB_ROOT,
        notify: () => {},
        openSheet: (sheet) => sheets.push(sheet),
        clipboard: { writeText: async () => { throw new Error('denied'); } },
      });
      assert.equal(outcome, 'shown', lang);
      assert.equal(sheets.length, 1, lang);
      const shownText = sheets[0].text;
      assert.ok(shownText.endsWith(m.languageTail(lang)), `${lang}: languageTail stays at the end when there is no tail`);
      assert.ok(shownText.includes(CLI_PATH) && shownText.includes(LIB_ROOT), `${lang}: manual copy sheet carries full CLI paths`);
      const html = renderToStaticMarkup(h(
        m.StudyServicesContext.Provider,
        { value: { host: DESKTOP_HOST, askInChat: async () => 'shown', notify: () => {} } },
        h(m.HandOffSheet, { sheet: sheets[0], onClose() {} }),
      ));
      assert.match(html, /sh-handoff-sheet__fold/, `${lang}: notes fold renders`);
      assert.ok(html.includes('study-cli.mjs'), `${lang}: CLI note appears inside folded notes`);
      assert.doesNotMatch(html, /```/, `${lang}: no raw triple-backtick fence in rendered sheet`);
      if (lang === 'en') {
        assert.doesNotMatch(html.replace(/<[^>]+>/g, ' '), /[㐀-鿿]/, 'English HandOffSheet has zero Han characters');
      }
    } finally {
      m.setUiLanguage('zh');
    }
  }
});

test('withExternalCliNote handles partial/missing paths safely and is idempotent', () => {
  for (const lang of ['zh', 'en']) {
    const base = m.handOffText('deck.ask', { deckTitle: 'Algorithms' }, lang);
    const rootOnly = m.withExternalCliNote(base, { libraryRoot: LIB_ROOT, language: lang });
    assert.equal(rootOnly, base, `${lang}: root-only (no study-cli path known) adds nothing`);

    const cliOnly = m.withExternalCliNote(base, { studyCliPath: CLI_PATH, language: lang });
    assert.ok(cliOnly.includes(`node "${CLI_PATH}" call <action> --file <payload.json>`), `${lang}: cli-only includes CLI path`);
    assert.doesNotMatch(cliOnly, /undefined|null/, `${lang}: no undefined/null in cli-only`);

    const neither = m.withExternalCliNote(base, { language: lang });
    assert.equal(neither, base, `${lang}: neither adds nothing`);

    const once = m.withExternalCliNote(base, { libraryRoot: LIB_ROOT, studyCliPath: CLI_PATH, language: lang });
    assert.equal(m.withExternalCliNote(once, { libraryRoot: LIB_ROOT, studyCliPath: CLI_PATH, language: lang }), once, `${lang}: idempotent`);
    if (lang === 'en') {
      for (const variant of [cliOnly, once]) {
        assert.doesNotMatch(variant, /[㐀-鿿]/, 'English fallback variants have zero Han characters');
      }
    }
  }
});

test('topic-group-prompt clarifies ambiguous CLI-ban wording in zh and en for both merge and replace', () => {
  for (const mode of ['merge', 'replace']) {
    const zh = m.groupPrompt({ mode, topicCount: 24, ungrouped: 6, course: 'OS', alternative: mode === 'merge' }, 'zh');
    const zhJoined = zh.notes.join('\n');
    assert.doesNotMatch(zhJoined, /不要用命令行或脚本解析/, `zh ${mode}: ambiguous CLI ban removed`);
    assert.match(zhJoined, /返回结果直接读，不要另写脚本或命令去解析它/, `zh ${mode}: clarified result-parsing wording present`);

    const en = m.groupPrompt({ mode, topicCount: 24, ungrouped: 6, course: 'OS', alternative: mode === 'merge' }, 'en');
    const enJoined = [en.ask, ...en.notes].join('\n');
    assert.doesNotMatch(enJoined, /never with shell commands or scripts/, `en ${mode}: ambiguous CLI ban removed`);
    assert.match(enJoined, /read each returned result directly instead of writing extra scripts or commands to parse it/, `en ${mode}: clarified English wording present`);
    assert.doesNotMatch(enJoined, /[㐀-鿿]/, `en ${mode}: zero untranslated Han characters`);
  }
});

test('topic-group prompt payloads execute cleanly against a real temporary library', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'study-handoff-cli-'));
  const service = new StudyService(root);
  t.after(async () => {
    await service.dispose();
    await rm(root, { recursive: true, force: true });
  });

  await service.call('deck.import', {
    course: 'OS',
    text: JSON.stringify({
      title: 'OS Core',
      course: 'OS',
      cards: [
        { id: 'c1', kind: 'flashcard', topic: 'Deadlock', prompt: 'What is deadlock?', answer: 'Circular wait.' },
        { id: 'c2', kind: 'flashcard', topic: 'Paging', prompt: 'What is paging?', answer: 'Fixed-size frames.' },
      ],
    }),
  });

  const prompt = m.handOffText('topics.group', { mode: 'merge', ungrouped: 2, course: 'OS', alternative: true }, 'zh');
  const payloadMatch = prompt.match(/skeleton\.topics (\{[^}]+\})/);
  assert.ok(payloadMatch, 'merge prompt embeds valid JSON payload for skeleton.topics');
  const readPayload = JSON.parse(payloadMatch[1]);

  const topicsPage = await service.call('skeleton.topics', readPayload);
  assert.equal(topicsPage.total, 2);
  assert.equal(topicsPage.topics.length, 2);

  await service.call('topic.groups.save', {
    mode: 'merge',
    course: 'OS',
    groups: [{
      title: 'Concurrency & Memory',
      description: 'Core OS resource management',
      topics: topicsPage.topics.map((item) => item.key),
    }],
  });

  const after = await service.call('skeleton.topics', readPayload);
  assert.equal(after.total, 0);
  assert.equal(after.groups.ungroupedCount, 0);
});

/* The Windows command-line rules (CommandLineToArgvW / the MSVC runtime, what `node` itself gets): a backslash run before a double quote is halved and an odd
   run escapes the quote; any other backslash is literal; spaces outside quotes split. A copied command must come back from this as the intended arguments. */
function windowsArgv(line) {
  const args = [];
  let cur = '', inQuote = false, started = false;
  for (let i = 0; i < line.length; i++) {
    let slashes = 0;
    while (line[i] === '\\') { slashes++; i++; }
    if (line[i] === '"') {
      cur += '\\'.repeat(Math.floor(slashes / 2));
      started = true;
      if (slashes % 2) cur += '"'; else inQuote = !inQuote;
    } else {
      cur += '\\'.repeat(slashes);
      if (slashes) started = true;
      if (i >= line.length) break;
      if (/\s/.test(line[i]) && !inQuote) { if (started) args.push(cur); cur = ''; started = false; } else { cur += line[i]; started = true; }
    }
  }
  if (started) args.push(cur);
  return args;
}
const commandOf = (text) => text.match(/`((?:"[^"\n]*"|node) [^`\n]*call <action>[^`\n]*)`/)?.[1];

const WIN_NODE = String.raw`C:\Program Files\StudyHub\resources\runtime\node.exe`;
const WIN_CLI = String.raw`C:\Program Files\StudyHub\resources\runtime\scripts\study-cli.mjs`;
const WIN_ROOT = String.raw`D:\Study Library`;
const WEB_DEMO_HOST = { capabilities: { edition: 'web-demo', chat: false, agentTasks: false, landing: false } };

test('the fallback command runs the bundled node the desktop host reports, and plain node only when no node path is known', async () => {
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    try {
      const prompt = m.handOffText('deck.ask', { deckTitle: 'Algorithms' }, lang);
      const run = async (host, extra = {}) => {
        const copied = [];
        await m.deliverToChat({ host, prompt, libraryRoot: WIN_ROOT, notify: () => {}, clipboard: { writeText: async (text) => copied.push(text) }, ...extra });
        return copied[0];
      };
      // the node path travels with the host, next to studyCliPath
      const fromHost = await run({ capabilities: DESKTOP_HOST.capabilities, studyCliPath: WIN_CLI, studyNodePath: WIN_NODE });
      assert.ok(fromHost.includes(`\`"${WIN_NODE}" "${WIN_CLI}" call <action> --file <payload.json> --root "${WIN_ROOT}"\``), `${lang}: bundled node, quoted, runs the bundled CLI:\n${fromHost}`);
      assert.doesNotMatch(fromHost, /`node "/, `${lang}: no bare node from PATH when the node path is known`);
      assert.deepEqual(windowsArgv(commandOf(fromHost)), [WIN_NODE, WIN_CLI, 'call', '<action>', '--file', '<payload.json>', '--root', WIN_ROOT], `${lang}: parses as the intended arguments (spaces in the install folder)`);
      // the same through the arguments askInChat passes
      const fromArgs = await run({ capabilities: DESKTOP_HOST.capabilities }, { studyCliPath: WIN_CLI, studyNodePath: WIN_NODE });
      assert.ok(fromArgs.includes(`"${WIN_NODE}" "${WIN_CLI}" call`), `${lang}: explicit argument works too`);
      // the CLI path known but no node path (a plugin / CLI install where node is on PATH anyway): plain node
      const noNode = await run({ capabilities: DESKTOP_HOST.capabilities, studyCliPath: WIN_CLI });
      assert.ok(noNode.includes(`\`node "${WIN_CLI}" call <action> --file <payload.json> --root "${WIN_ROOT}"\``), `${lang}: plain node fallback`);
      assert.doesNotMatch(noNode, new RegExp(WIN_NODE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${lang}: no node path invented`);
      // a CLI path without a library root keeps the node path as well
      const noRoot = m.withExternalCliNote(prompt, { studyCliPath: WIN_CLI, studyNodePath: WIN_NODE, language: lang });
      assert.ok(noRoot.includes(`"${WIN_NODE}" "${WIN_CLI}" call <action> --file <payload.json> --root "<`), `${lang}: path-only variant uses the node path`);
      if (lang === 'en') for (const text of [fromHost, noNode, noRoot]) assert.doesNotMatch(text, /[㐀-鿿]/, 'English fallback has zero Han characters');
    } finally {
      m.setUiLanguage('zh');
    }
  }
});

test('no CLI note without a known study-cli path (the web demo, a host that never reported one): the copied prompt is left as it was', async () => {
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    try {
      const prompt = m.handOffText('deck.ask', { deckTitle: 'Algorithms' }, lang);
      for (const host of [WEB_DEMO_HOST, { capabilities: { chat: false } }, null]) {
        const copied = [];
        const sheets = [];
        await m.deliverToChat({ host, prompt, libraryRoot: '/demo', notify: () => {}, openSheet: (sheet) => sheets.push(sheet), clipboard: { writeText: async (text) => copied.push(text) } });
        assert.equal(copied.length, 1, lang);
        assert.doesNotMatch(copied[0], /study-cli|外部调用：|External CLI:|\/demo/, `${lang}: nothing for an outside agent to run against /demo`);
        assert.equal(copied[0], m.withLanguageTail(prompt), `${lang}: the copy is the prompt and its language sentence, nothing else`);
      }
      const refused = [];
      await m.deliverToChat({ host: WEB_DEMO_HOST, prompt, libraryRoot: '/demo', notify: () => {}, openSheet: (sheet) => refused.push(sheet), clipboard: { writeText: async () => { throw new Error('denied'); } } });
      assert.doesNotMatch(refused[0].text, /study-cli|\/demo/, `${lang}: nor in the card shown when the clipboard refuses`);
      assert.equal(m.withExternalCliNote(prompt, { libraryRoot: '/demo', language: lang }), prompt, `${lang}: root alone adds nothing`);
      assert.equal(m.withExternalCliNote(prompt, { language: lang }), prompt, `${lang}: nothing known adds nothing`);
      assert.equal(m.withExternalCliNote(prompt, { libraryRoot: '/demo', studyNodePath: WIN_NODE, language: lang }), prompt, `${lang}: a node path alone adds nothing`);
    } finally {
      m.setUiLanguage('zh');
    }
  }
});

test('the blank 我想： / What I want: bullet is added only when the message really ends with that tail', async () => {
  for (const lang of ['zh', 'en']) {
    m.setUiLanguage(lang);
    try {
      const askTail = m.messageParts(m.handOffText('topics.group', { mode: 'merge', ungrouped: 5, course: 'Networks', alternative: true }, lang), lang).tail;
      assert.equal(askTail, lang === 'zh' ? '我想：' : 'What I want:');
      const blankNote = lang === 'zh' ? /留空/ : /left blank/;
      const opts = { studyCliPath: CLI_PATH, libraryRoot: LIB_ROOT, language: lang };
      const withAsk = m.withExternalCliNote(m.handOffText('topics.group', { mode: 'merge', ungrouped: 5, course: 'Networks', alternative: true }, lang), opts);
      assert.match(withAsk, blankNote, `${lang}: a message ending with ${askTail} gets the blank-tail note`);
      for (const [name, text] of [
        ['book.edit (no tail)', m.handOffText('book.edit', { course: 'OS', hid: 'p1', title: 'Scheduling', bookLanguage: lang }, lang)],
        ['deck.ask (no tail)', m.handOffText('deck.ask', { deckTitle: 'Algorithms' }, lang)],
        ['paste tail', m.composeMessage({ ask: 'x', notes: ['y'] }, { tail: 'paste', language: lang })],
        ['plain text without a notes block', `just a sentence\n${m.languageTail(lang)}`],
      ]) {
        const out = m.withExternalCliNote(text, opts);
        assert.match(out, /study-cli\.mjs/, `${lang} ${name}: the CLI note itself is still there`);
        assert.doesNotMatch(out, blankNote, `${lang} ${name}: no blank-tail note when there is no ${askTail} at the end`);
        assert.doesNotMatch(out, /末尾补充|Trailing note/, `${lang} ${name}: no trailing-note bullet`);
      }
      const askMessage = m.composeMessage({ ask: 'x', notes: ['y'] }, { tail: 'ask', language: lang });
      assert.match(m.withExternalCliNote(askMessage, opts), blankNote, `${lang}: the ask tail of a composed message counts`);
    } finally {
      m.setUiLanguage('zh');
    }
  }
});

test('a library on a drive root, or with a trailing backslash, is written so Windows argument parsing reads it back right', async () => {
  const cases = [
    ['D:\\', 'D:/'],
    ['d:\\\\', 'd:/'],
    ['D:/', 'D:/'],
    ['C:\\Users\\me\\Study Library\\', 'C:\\Users\\me\\Study Library'],
    ['C:\\Users\\me\\Study Library\\\\', 'C:\\Users\\me\\Study Library'],
    ['\\\\nas\\share\\', '\\\\nas\\share'],
    [String.raw`D:\Study Library`, String.raw`D:\Study Library`],
    ['/Users/me/Study Library', '/Users/me/Study Library'],
    ['/', '/'],
  ];
  for (const lang of ['zh', 'en']) {
    for (const [root, expected] of cases) {
      for (const nodePath of ['', WIN_NODE]) {
        const text = m.withExternalCliNote(m.handOffText('deck.ask', { deckTitle: 'Algorithms' }, lang), { studyCliPath: WIN_CLI, studyNodePath: nodePath, libraryRoot: root, language: lang });
        const argv = windowsArgv(commandOf(text));
        assert.deepEqual(argv.slice(-2), ['--root', expected], `${lang} ${JSON.stringify(root)}: --root reads back as ${expected}`);
        assert.equal(argv.length, 8, `${lang} ${JSON.stringify(root)}: no argument swallowed by a stray escaped quote`);
      }
    }
  }
});
