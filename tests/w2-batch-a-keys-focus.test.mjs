import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { shortcutAction } from '../ui/review/session-logic.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('W2-01: global A and S shortcuts do not hijack timed exam option keys or exit the exam', () => {
  const baseEvent = {
    key: 'a',
    code: 'KeyA',
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    inEditable: false,
    onButton: false,
  };
  const examCtx = {
    inside: true,
    modalOpen: false,
    page: 'exam',
    run: null,
    busy: false,
    shortcutHelp: false,
    endAsked: false,
    markingTerms: false,
    choice: false,
    isCloze: false,
    rubricCard: false,
    selected: [],
    clozeValues: {},
  };

  const examA = shortcutAction(baseEvent, examCtx);
  assert.equal(examA?.action ?? null, null, 'pressing A on exam page must not toggle autopilot');

  const examS = shortcutAction({ ...baseEvent, key: 's', code: 'KeyS' }, examCtx);
  assert.equal(examS?.action ?? null, null, 'pressing S on exam page must not trigger resume');

  const homeA = shortcutAction(baseEvent, { ...examCtx, page: 'home' });
  assert.deepEqual(homeA?.action, { type: 'autopilot' }, 'A still toggles autopilot outside exam');

  const homeS = shortcutAction({ ...baseEvent, key: 's', code: 'KeyS' }, { ...examCtx, page: 'home' });
  assert.deepEqual(homeS?.action, { type: 'resume' }, 'S still resumes practice outside exam');

  const helpSrc = read('ui/ShortcutHelp.jsx');
  assert.match(helpSrc, /page === "exam"/, 'ShortcutHelp reflects exam-specific shortcuts');
  assert.match(helpSrc, /模拟考试：选择选项/, 'ShortcutHelp documents exam option keys');
});

test('W2-02: MasteryMap search Esc clears/blurs without closing Graph, and objectScope filters decks & skips course outline', () => {
  const mapSrc = read('ui/mastery-map/MasteryMap.jsx');
  assert.match(mapSrc, /event\.key !== 'Escape'/, 'MasteryMap search input handles Esc locally');
  assert.match(mapSrc, /isComposing|keyCode === 229/, 'MasteryMap search Esc guards IME composition');
  assert.match(mapSrc, /event\.stopPropagation\(\)/, 'MasteryMap search Esc stops bubbling to Graph');

  const graphSrc = read('ui/Graph.jsx');
  assert.match(graphSrc, /if \(ev\.nativeEvent\?\.isComposing \|\| ev\.isComposing \|\| ev\.keyCode === 229\) return;/, 'Graph keydown guards IME composition');
  assert.match(graphSrc, /if \(objectScope \|\| course === "\*" \|\| typeof course !== "string"\)/, 'Graph skips course.outline fetch in objectScope');
  assert.match(graphSrc, /outline=\{objectScope \? null :/, 'Graph passes null outline to MasteryMap in objectScope');
  assert.match(graphSrc, /if \(objectScope && Array\.isArray\(scope\) && scope\.length\)/, 'Graph filters masteryDecks by objectScope');
});

test('W2-04: AssistFormPanel keeps existing draft when setAssistMode resolves to the same mode', () => {
  const src = read('ui/review/AssistFormPanel.jsx');
  assert.match(src, /prev\.key === key && curMode === resolved/, 'AssistFormPanel no-ops when re-selecting the active mode');
});


test('W2-09: UpdateDialog locks close/Esc/snooze during both DSH and desktop host upgrades', () => {
  const ucSrc = read('ui/UpdateCenter.jsx');
  assert.match(ucSrc, /const \[hostWorking, setHostWorking\] = useState\(false\);/, 'UpdateDialog tracks hostWorking');
  assert.match(ucSrc, /const busy = working \|\| hostWorking;/, 'combines DSH and desktop upgrade busy states');
  assert.match(ucSrc, /<Dialog[^>]*busy=\{busy\}/, 'passes busy to Dialog to block Esc and close button');
  assert.match(ucSrc, /lock=\{busy\}[^>]*onClick=\{later\}/, 'locks 稍后提醒 while upgrade is running');
  assert.match(ucSrc, /onBusyChange=\{setHostWorking\}/, 'propagates onBusyChange to GuidedUpgrade');

  const deskSrc = read('ui/desktop/DesktopUpgradeGuide.jsx');
  assert.match(deskSrc, /onBusyChange\?\.\(phase === 'working'\)/, 'DesktopUpgradeGuide reports working phase');
  assert.match(deskSrc, /onBusyChange\?\.\(false\)/, 'DesktopUpgradeGuide resets busy state on unmount');
});

test('W2-10: ContextMenu and Menu restore focus safely with preventScroll', () => {
  const src = read('ui/components/Menu.jsx');
  assert.match(src, /button\.current\?\.focus\(\{ preventScroll: true \}\)/, 'Menu restores focus without scrolling');
  assert.match(src, /within\?\.closest\?\.\('\[tabindex\]'\)/, 'ContextMenu has container fallback when trigger ref is detached');
  assert.match(src, /onClose\?\.\(\);\s*restoreFocus\(\);\s*if \(item\.run\) item\.run\(\); else onSelect\?\.\(item\.id\);/, 'ContextMenu restores focus before invoking item action');
});
