/* Exam Coach step 3 keeps what the learner typed when an earlier save answers late.
   Switching steps saves the step in the background; when that answer arrived after the learner had already typed a quota
   or ticked crunch mode, the page replaced the whole plan with the server's copy and dropped the typing. The browser test
   #853 saw this as a compiled preview without the zero-quota line. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { click, loadInteractiveUi, withBrowserGlobals } from './helpers/react-harness.mjs';

function family(id, title, quota) {
  return {
    id,
    title,
    origin: 'source-fact',
    primaryFormat: 'quiz',
    allowedFormats: ['quiz'],
    allowFormSubstitute: false,
    quota,
    quotaUnit: 'question',
    questionsPerUnit: 1,
    priority: 'high',
    timeBudgetSec: 90,
    reasoningSteps: ['读题'],
    rubricPoints: [],
    confirmations: {},
    sample: { format: 'quiz', stem: '题干', answer: '答案', rubric: '' },
  };
}

function coachServer() {
  let stored = {
    specVersion: 'v1',
    stage: 'evidence',
    templateName: '期末',
    crunchMode: { enabled: false, remainingMinutes: 120 },
    taskFamilies: [family('fam-a', '索引边界', 3), family('fam-b', '并发锁权衡', 3)],
  };
  const saves = [];
  const held = [];
  const call = async (action, args = {}) => {
    if (action === 'coach.calibration.get') return { spec: stored, evidence: null };
    if (action === 'coach.calibration.save') {
      saves.push(args);
      const { course: _course, uiLanguage: _lang, ...patch } = args;
      stored = { ...stored, ...patch };
      const answer = { spec: stored, evidence: null };
      if (patch.taskFamilies) return answer;
      return new Promise((resolve) => { held.push(() => resolve(answer)); });
    }
    return {};
  };
  return { call, saves, releaseStageSave: () => held.shift()?.() };
}

test('#853 Exam Coach: a late step-switch save keeps the quota and crunch mode typed in step 3', async () => {
  const interactive = await loadInteractiveUi(`
    export { default as ExamCoachPage } from './ui/ExamCoachPage.jsx';
    export { StudyServicesContext } from './ui/study-context.jsx';
    export { setUiLanguage } from './ui/i18n.js';
  `);
  await withBrowserGlobals(async () => {
    interactive.exports.setUiLanguage('zh');
    const server = coachServer();
    const noop = () => {};
    const services = { call: server.call, act: noop, busy: false, notify: noop };
    const h = interactive.React.createElement;
    const data = { root: 'r', focus: { course: '数据库系统' }, sources: [], decks: [], attempts: [], courses: [{ name: '数据库系统' }] };
    const mounted = interactive.mount(() => h(
      interactive.exports.StudyServicesContext.Provider,
      { value: services },
      h(interactive.exports.ExamCoachPage, { data }),
    ));
    try {
      await mounted.flush(6);
      const stages = mounted.find((n) => n.props?.label === '教练阶段' && typeof n.props.onChange === 'function');
      assert.ok(stages, 'the step switcher renders');
      await mounted.act(() => stages.props.onChange('configure'));
      await mounted.flush(6);
      assert.equal(server.saves.length, 1, 'the step switch saved the step in the background');

      const quotaInputs = () => mounted.findAll((n) => n.type === 'input' && n.props?.type === 'number' && n.props.min === 0 && n.props.max === 50);
      assert.equal(quotaInputs().length, 2, 'step 3 shows one quota per task family');
      await mounted.act(() => quotaInputs()[1].props.onChange({ target: { value: '0' } }));
      const crunchLabel = mounted.find((n) => n.type === 'label' && mounted.text(n).includes('开启考前压缩模式'));
      const crunch = crunchLabel && mounted.find((n) => n.type === 'input' && n.props?.type === 'checkbox', crunchLabel);
      assert.ok(crunch, 'the crunch-mode checkbox renders');
      await mounted.act(() => crunch.props.onChange({ target: { checked: true } }));
      await mounted.flush(6);

      await mounted.act(() => server.releaseStageSave());
      await mounted.flush(6);

      assert.equal(quotaInputs()[1].props.value, '0', 'the quota typed before the late answer is still shown');
      const save = mounted.find((n) => n.type === 'button' && mounted.text(n).includes('保存配置并查看生成与能力证据'));
      assert.ok(save, 'the save-configuration button renders');
      await mounted.act(() => click(save));
      await mounted.flush(6);

      const saved = server.saves.at(-1);
      assert.equal(saved.stage, 'evidence');
      assert.deepEqual(saved.taskFamilies.map((f) => [f.id, f.quota]), [['fam-a', 3], ['fam-b', 0]], 'the zero quota is saved');
      assert.equal(saved.crunchMode?.enabled, true, 'crunch mode ticked before the late answer is saved');
    } finally {
      mounted.unmount();
    }
  });
});
