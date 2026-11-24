import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { publicCard } from '../lib/domain.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('W3-08: useSourceReader subscribes to useStudyBusy and skips deleted sources in today reread queue', () => {
  const src = read('ui/app/modals/source-reader.jsx');
  assert.match(src, /const studyBusy = useStudyBusy\(\);/);
  assert.match(src, /const busy = studyBusy \|\| Boolean\(core\.busy\);/);
  assert.match(src, /const findValidReread = \(from, step\) => \{/);
  assert.match(src, /const nextMatch = findValidReread\(rereadAt \+ 1, 1\);/);
});

test('W3-09: InlineRunDone offers primary 回到原题 on returnTo rounds and reads run.mastery || run.liveMastery', () => {
  const src = read('ui/review/InlineRun.jsx');
  assert.match(src, /const mastery = run\.mastery \|\| run\.liveMastery;/);
  assert.match(src, /const onBackOriginal = run\?\.returnTo && \(session\.coach\?\.onContinue \|\| session\.continueTo\)/);
  assert.match(src, /\{canReturn && <Button variant="primary" size="sm" icon="arrow-left" lock=\{busy\} onClick=\{onBackOriginal\}>\{ui\("回到原题"\)\}<\/Button>\}/);
  assert.match(src, /variant=\{canReturn \? "secondary" : "primary"\}/);
  assert.match(src, /支线练习 · \{0\} 题/);
});

test('W3-10: card flag is exposed in publicCard, prefilled in FlagDialog with explicit Clear button, and highlighted in QuestionRun', () => {
  const exposed = publicCard({ id: 'c1', kind: 'quiz', topic: 't', prompt: 'p', flag: 'Check distractor B', options: [] });
  assert.equal(exposed.flag, 'Check distractor B', 'publicCard exposes non-empty flag');

  const unflagged = publicCard({ id: 'c2', kind: 'quiz', topic: 't', prompt: 'p', options: [] });
  assert.equal('flag' in unflagged, false, 'publicCard omits flag when empty');

  const stateSrc = read('lib/study-state.js');
  assert.match(stateSrc, /flag: entryMeta\?\.flag \?\? entry\.card\.flag/);

  const dlgSrc = read('ui/app/modals/FlagDialog.jsx');
  assert.match(dlgSrc, /const existing = typeof run\?\.card\?\.flag === 'string' \? run\.card\.flag : '';/);
  assert.match(dlgSrc, /\{existing && <Button variant="secondary" lock=\{busy\} onClick=\{\(\) => submitFlag\(''\)\}>\{ui\('清除标记'\)\}<\/Button>\}/);
  assert.match(dlgSrc, /disabled=\{!trimmed\}/);
  assert.match(dlgSrc, /onUpdated\?\.\(nextReason\)/);

  const qSrc = read('ui/review/QuestionRun.jsx');
  assert.match(qSrc, /aria-pressed=\{!!run\.card\.flag\}/);
  assert.match(qSrc, /已标记：\{0\}/);
});

test('W3-11: HandOff and desktop callers adapt copyLabel/copyLead/copyWhat and aria-label when hasChatHost is false', () => {
  const handOffSrc = read('ui/hand-off/HandOff.jsx');
  assert.match(handOffSrc, /copyLabel = ''/);
  assert.match(handOffSrc, /copyLead = ''/);
  assert.match(handOffSrc, /copyWhat = ''/);
  assert.match(handOffSrc, /String\(label\)\.includes\('主会话'\)/);

  assert.match(read('ui/Review.jsx'), /copyLabel="复制错题讲解提示词"/);
  assert.match(read('ui/guided-study/GuidedStudyWorkbench.jsx'), /copyLabel=\{ui\('复制错题讲解提示词'\)\}/);
  assert.match(read('ui/review/ChapterHint.jsx'), /copyLabel="复制讲解提示词"/);
  assert.match(read('ui/document-preview/reader/MindMapPanel.jsx'), /copyLabel="复制导图细化提示词"/);
  assert.match(read('ui/book/PlanSection.jsx'), /copyLead="再复制提示词去规划："/);
  assert.match(read('ui/GenerationPath.jsx'), /copyLead="想先和 AI 聊聊怎么学："/);
  assert.match(read('ui/tasks/CompactJobCard.jsx'), /复制提示词：\{0\}/);
  assert.match(read('ui/book/BookMore.jsx'), /COPY_PROMPT_LABEL/);
});

test('W3-12: FirstRunLine sample tour button binds sampleBusy separately from global busy and use-tour guards re-entry', () => {
  const lineSrc = read('ui/first-run/FirstRunLine.jsx');
  assert.match(lineSrc, /sampleBusy = false/);
  assert.match(lineSrc, /busy=\{sampleBusy\} lock=\{busy\} data-first-run="sample"/);

  const pvSrc = read('ui/app/page-views.jsx');
  assert.match(pvSrc, /sampleBusy: tour\.sampleBusy \|\| tour\.sampleForTour/);

  const tourSrc = read('ui/app/use-tour.js');
  assert.match(tourSrc, /if \(sampleInFlightRef\.current\) return null;/);
  assert.match(tourSrc, /if \(sampleTourInFlightRef\.current \|\| sampleInFlightRef\.current\) return;/);
});

test('W3-13: CustomGate promotes whole-book action to primary and removes main-chat recommendation when canChat is false', () => {
  const src = read('ui/outline/CustomGate.jsx');
  assert.match(src, /const canChat = explicitCanChat \?\? hasChatHost\(host\);/);
  assert.match(src, /\{canChat && <Tooltip layer content=\{handOffTip\(CUSTOM_BOOK_WHAT, true\)\}><Button variant="primary" icon="external"/);
  assert.match(src, /<Button variant=\{canChat \? 'secondary' : 'primary'\} lock=\{busy\} onClick=\{onWhole\} data-custom-gate-action="whole">/);
  assert.match(src, /确认整本生成复习全书？/);
});
