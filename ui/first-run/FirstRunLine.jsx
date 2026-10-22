import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Hint, Icon, Tooltip } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useStudy } from '../study-context.jsx';
import { modelSetupCopy } from '../ModelSetupGate.jsx';
import { useModelSettingsLabel } from '../ModelErrorNote.jsx';
import { CORE_TOUR_LENGTH } from '../tour/steps.js';
import css from './first-run.css';

/* The first-run line (3.6 D2): 配模型 → 加资料 → 做第一组, drawn from firstRunLine (ui/first-run/line.js). ONE component in two forms:
     page      the library's whole first screen until the first own deck is published: the welcome words, the three steps, two quiet links at the bottom
     compact   the card in the home's today slot after 「以后再说」 (and while a tour shows the home): the three rows and the open step's button
   Each step is one row: its number or ✓ and one sentence. Only the open step has a body, and the body has at most ONE primary (cinnabar) button; the third
   step's body keeps one height through its states (ready, generating, a draft), so a run finishing does not move the page.
   `on` holds what the buttons do: { recheck, openModelSettings, importFirst, importMore(ownIds), generate(sourceIds), publish(draft), openDraft(draft),
   startSample, later }. A missing handler draws no button. `jobs` is the run card(s) of the third step (the home's compact job cards, moved here: they are
   not drawn anywhere else on the first screen).
   Seam (D4): step 3's 「出第一组题」 calls on.generate(sourceIds), which goes to 创建题组 with the material ticked; generating straight from the line replaces
   that handler. Seam (发给主会话, #453): when an import fails, step 2 is where the shared hand-off unit (ui/hand-off/) goes, beside the import's own message. */

/** One sentence per step and state: what the row says. */
export function stepSentence(step) {
  if (step.id === 'model') {
    if (step.status === 'todo') return ui('配一个 AI 模型，出题要用它');
    if (!step.label) return step.verified ? ui('模型已连接') : ui('已选择模型');
    return step.verified ? uiFormat('已连接：{0}', [step.label]) : uiFormat('已选择模型：{0}', [step.label]);
  }
  if (step.id === 'material') {
    if (step.status === 'todo') return ui('添加一份资料：讲义、课件或笔记');
    return step.count > 1 ? uiFormat('{0} 等 {1} 份资料 · 已添加', [step.title, step.count]) : uiFormat('{0} · 已添加', [step.title]);
  }
  return ({
    waiting: ui('用资料出第一组题'),
    ready: step.modelReady ? ui('用资料出第一组题') : ui('配好模型后，用资料出第一组题'),
    generating: ui('正在出第一组题'),
    failed: ui('第一组题没有出完'),
    'draft-clean': ui('第一组题出好了'),
    'draft-review': ui('第一组题出好了'),
  })[step.status] || ui('用资料出第一组题');
}

/** The one action of the open step in the compact card (the page form says more in the step's body). null: nothing to press here (a run's card or the model's steps carry it). */
export function compactAction(line, on = {}) {
  const [, material, deck] = line.steps;
  if (material.status === 'todo' && on.importFirst) return { label: ui('添加资料'), run: on.importFirst };
  if (deck.status === 'ready' && on.generate) return { label: ui('出第一组题'), run: () => on.generate(deck.sourceIds) };
  if (deck.status === 'draft-clean' && on.publish) return { label: ui('发布并开始练'), run: () => on.publish(deck.draft) };
  if (deck.status === 'draft-review' && on.openDraft) return { label: ui('检查草稿'), run: () => on.openDraft(deck.draft) };
  return null;
}

function Mark({ index, done }) {
  return <span className="frl-mark" aria-hidden="true">{done ? <Icon name="check" size={14} /> : index + 1}</span>;
}

/** Step 1, open: the gate's own words (ModelSetupGate is the one source), the key line, and 重新检查; the only way to the settings is the quiet link in the step that picks a model. */
function ModelBody({ step, on }) {
  const { busy } = useStudy();
  const [checking, setChecking] = useState(false), [checked, setChecked] = useState(false);
  const live = useRef(true), settingsLabel = useModelSettingsLabel();
  useEffect(() => () => { live.current = false; }, []);
  const copy = modelSetupCopy(step, 'welcome', { recheck: !!on.recheck });
  const recheck = on.recheck && (async () => {
    setChecking(true);
    try { await on.recheck(); if (live.current) setChecked(true); } catch { if (live.current) setChecked(false); } finally { if (live.current) setChecking(false); }
  });
  const steps = copy.steps.length ? [...copy.steps, { text: copy.then }] : [];
  return (
    <>
      <p className="frl-body__text">{copy.why}</p>
      {steps.length > 0 && <ol className="frl-setup">
        {steps.map((item, index) => (
          <li key={index}>
            <span className="frl-setup__num" aria-hidden="true">{index + 1}</span>
            <span className="frl-setup__text">{item.text}
              {item.choose && on.openModelSettings && <>{' '}<Button variant="link" size="sm" className="first-run__link" disabled={busy} onClick={on.openModelSettings}>{settingsLabel}</Button></>}
              {item.hint && <span className="frl-setup__hint">{item.hint}</span>}
            </span>
          </li>
        ))}
      </ol>}
      {checked && !checking && <Hint role="status">{ui('已重新检查，目前还没有连上。')}</Hint>}
      {recheck && <div className="frl-body__actions">
        <Button variant="primary" icon="refresh" busy={checking} busyLabel={ui('正在检查…')} disabled={busy} data-first-run="recheck" onClick={recheck}>{ui('重新检查')}</Button>
      </div>}
    </>
  );
}

function MaterialBody({ on }) {
  const { busy } = useStudy();
  return (
    <>
      <p className="frl-body__text">{ui('PDF、Word、PowerPoint、Markdown、保存下来的网页文件（.html）或文本都可以，原文件会保留。添加后就能用它出题。')}</p>
      {on.importFirst && <div className="frl-body__actions">
        <Button variant="primary" icon="upload" disabled={busy} data-first-run="import" onClick={on.importFirst}>{ui('添加资料')}</Button>
      </div>}
    </>
  );
}

function DeckBody({ step, on, jobs }) {
  const { busy } = useStudy();
  const { status, draft } = step;
  if (status === 'generating' || status === 'failed') return (
    <>
      {jobs}
      {status === 'generating' && <p className="frl-body__note">{ui('出题在后台进行，离开这一页也不会中断。')}</p>}
    </>
  );
  if (status === 'draft-clean') return (
    <>
      <p className="frl-body__text">{ui('出题时已逐题审阅；发布时会再检查一遍题目的结构，然后直接开始练第一轮。')}</p>
      <div className="frl-body__actions">
        {on.publish && <Button variant="primary" iconEnd="arrow-right" disabled={busy} data-first-run="publish" onClick={() => on.publish(draft)}>{ui('发布并开始练')}</Button>}
        {on.openDraft && <Button variant="link" className="first-run__link" disabled={busy} data-first-run="look" onClick={() => on.openDraft(draft)}>{ui('先看看草稿')}</Button>}
      </div>
    </>
  );
  if (status === 'draft-review') return (
    <>
      <p className="frl-body__text">{ui('发布前先在草稿页看一遍：每道题都能修改，看完点「发布并开始练 →」。')}</p>
      {on.openDraft && <div className="frl-body__actions">
        <Button variant="primary" iconEnd="arrow-right" disabled={busy} data-first-run="review" onClick={() => on.openDraft(draft)}>{ui('检查草稿')}</Button>
      </div>}
    </>
  );
  return (
    <>
      <p className="frl-body__text">{ui('在「创建题组」里，这份资料已经勾好；确认题型和题数，AI 出题后会逐题检查，再交给你确认。')}</p>
      {on.generate && <div className="frl-body__actions">
        <Button variant="primary" iconEnd="arrow-right" disabled={busy} data-first-run="generate" onClick={() => on.generate(step.sourceIds)}>{ui('出第一组题')}</Button>
      </div>}
    </>
  );
}

/** A quiet link on a closed row: the second step is never locked (a material can come before the model), and an added one can have a second. */
function RowLink({ step, on }) {
  const { busy } = useStudy();
  if (step.status === 'todo' && on.importFirst) return <Button variant="link" size="sm" className="frl-row-link first-run__link" disabled={busy} onClick={on.importFirst}>{ui('添加资料')}</Button>;
  if (step.status === 'done' && on.importMore) return <Button variant="link" size="sm" className="frl-row-link first-run__link" disabled={busy} data-first-run="more" onClick={() => on.importMore(step.sourceIds)}>{ui('再加一份')}</Button>;
  return null;
}

function Steps({ line, on, jobs, compact }) {
  return (
    <ol className="frl-steps" aria-label={ui('第一组题的三步')}>
      {line.steps.map((step, index) => {
        const open = !compact && index === line.step;
        return (
          <li key={step.id} className="frl-step" data-step={step.id} data-status={step.status} data-open={open || undefined} aria-current={index === line.step ? 'step' : undefined}>
            <div className="frl-step__row">
              <Mark index={index} done={step.status === 'done'} />
              <span className="frl-step__text">{stepSentence(step)}</span>
              {!compact && !open && step.id === 'material' && <RowLink step={step} on={on} />}
            </div>
            {open && <div className="frl-body" data-body={step.id}>
              {step.id === 'model' ? <ModelBody step={step} on={on} />
                : step.id === 'material' ? <MaterialBody on={on} />
                  : <DeckBody step={step} on={on} jobs={jobs} />}
            </div>}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * line: firstRunLine's answer (nothing is drawn unless `show`); form: 'page' | 'compact'; sample: data.sample (the quiet link to the sample tour needs a host
 * that has one, not loaded yet); todayLabel: the compact card's date.
 */
export default function FirstRunLine({ line, form = 'page', sample, todayLabel, jobs = null, on = {} }) {
  useInjectCss(css, 'study-first-run');
  const { busy } = useStudy();
  if (!line?.show) return null;
  if (form === 'compact') {
    const action = compactAction(line, on);
    return (
      <div className="today-card sh-paper-card first-run-card" data-first-run="compact">
        <div className="today-card-head">
          <span>{ui('第一组题')}</span>
          {todayLabel && <time>{todayLabel}</time>}
        </div>
        <Steps line={line} on={on} compact />
        {action && <Button variant="primary" className="today-go" iconEnd="arrow-right" disabled={busy} data-usage="home.start" onClick={action.run}>{action.label}</Button>}
      </div>
    );
  }
  const offerSample = !!sample && !sample.loaded && !!on.startSample;
  return (
    <div className="first-run" data-first-run="page" role="region" aria-labelledby="study-first-run-title">
      <header className="first-run__intro">
        <p className="first-run__eyebrow">{ui('开始使用')}</p>
        <h1 className="first-run__title" id="study-first-run-title">{ui('欢迎使用 StudyHub')}</h1>
        <p className="first-run__lead">{ui('把老师的课件变成题，每道题都点得回原页；做完一轮，看得见自己变熟。')}</p>
        <p className="first-run__sub">{ui('开源免费，资料存在你电脑上；模型自己选，按用量付费。')}</p>
      </header>
      <Steps line={line} on={on} jobs={jobs} />
      <footer className="first-run__footer">
        {offerSample && <span className="first-run__sample">
          <span>{ui('想先看看效果？')}</span>
          <Tooltip layer content={uiFormat('一门示例课程（设计模式）：一份讲义、九道带出处的题和三周练习记录，导览 {0} 步、一两分钟；示例数据随时一键移除。', [CORE_TOUR_LENGTH])}>
            <Button variant="link" size="sm" className="first-run__link" busy={busy} data-first-run="sample" onClick={on.startSample}>{ui('载入示例并开始导览')}</Button>
          </Tooltip>
        </span>}
        {on.later && <Button variant="link" size="sm" className="first-run__link first-run__later" data-first-run="later" onClick={on.later}>{ui('以后再说')}</Button>}
      </footer>
    </div>
  );
}
