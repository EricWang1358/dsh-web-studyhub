import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Button, Field, Hint, Select, SettingsSection, Switch, useToast } from '../components/index.js';
import { PRACTICE_DEFAULTS, resolvePracticeSettings } from '../../lib/practice-settings.js';
import { AUTO_ADVANCE_MS, RESULT_COUNTDOWN_SECONDS } from '../review/session-logic.js';

/* 设置 › 练习: the learner's personal defaults for the daily practice, saved at once (settings.practice.set); 恢复默认 forgets them (settings.practice.reset).
   Autopilot and the round size are what the practice page and the home card read; 本轮点评 is the one place that says the result page asks the model. */
export const ROUND_SIZES = [10, 15, 20, 30, 40, 50];
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const seconds = (ms) => String(ms / 1000);

export default function PracticePane({ data, busy, act }) {
  const toast = useToast();
  const saved = data?.settings?.practice, savedValues = resolvePracticeSettings(saved), key = JSON.stringify(savedValues);
  const [values, setValues] = useState(savedValues), [working, setWorking] = useState(false), [error, setError] = useState('');
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  // What the library says wins again as soon as it arrives; until then the control shows what was just chosen.
  useEffect(() => { setValues(JSON.parse(key)); }, [key]);
  const run = async (action, args, shown) => {
    if (busy || working || typeof act !== 'function') return;
    setError(''); setWorking(true); setValues(shown);
    try {
      const result = await act(action, args, () => toast.success(ui('练习设置已保存')), { rethrow: true });
      if (result === undefined && live.current) setValues(savedValues); // another action was running: nothing was saved
    } catch (cause) { if (live.current) { setValues(savedValues); setError(errorMessage(cause)); } }
    finally { if (live.current) setWorking(false); }
  };
  const set = (patch) => run('settings.practice.set', { patch }, { ...values, ...patch });
  const disabled = busy || working;
  const sizes = ROUND_SIZES.includes(values.roundSize) ? ROUND_SIZES : [...ROUND_SIZES, values.roundSize].sort((a, b) => a - b);
  return <div className="settings-form">
    <SettingsSection tour="settings-practice" disabled={disabled} title={ui('练习')}
      lead={ui('每天的练习怎么走。这里是你的个人默认值，改动立即保存；练习页里也能临时开关自动驾驶。')}>
      <Field label={ui('每轮题数')} hint={uiFormat('首页的「今日学习」每轮最多这么多题：先排到期复习，再排薄弱题，最后补新题，新题最多占一半。当前是 {0} 题一轮，新题最多 {1} 道。', [values.roundSize, Math.ceil(values.roundSize / 2)])}>
        <Select name="roundSize" value={String(values.roundSize)} disabled={disabled} onChange={(roundSize) => set({ roundSize: Number(roundSize) })}
          options={sizes.map((size) => ({ value: String(size), label: uiFormat('{0} 题', [size]) }))} />
      </Field>
      <Switch name="autopilot" label={ui('自动驾驶')} checked={values.autopilot} disabled={disabled} onChange={(autopilot) => set({ autopilot })}
        hint={uiFormat('答对（或自评达标）后，等 {0} 秒自动进入下一题；一轮做完，结果页也会在 {1} 秒后自动开始建议的下一步（学习流和「回到原题」的练习除外）。点任意处或按任意键就能停下。练习页的工具栏里也有这个开关，按 A 键同样可以切换。', [seconds(AUTO_ADVANCE_MS), RESULT_COUNTDOWN_SECONDS])} />
      <Switch name="debrief" label={ui('本轮点评由模型来写')} checked={values.debrief} disabled={disabled} onChange={(debrief) => set({ debrief })}
        hint={ui('每轮做完、答了 3 题以上时，结果页会请较轻量的模型写一句点评并更新你的学习画像摘要，这是练习里唯一自动调用模型的地方。关掉后不再调用模型：点评卡片只按作答统计给出建议。')} />
      {error && <Hint tone="error" role="alert">{error}</Hint>}
      <div className="settings-actions">
        <Button disabled={disabled || (saved === undefined && same(values, PRACTICE_DEFAULTS))}
          onClick={() => run('settings.practice.reset', {}, resolvePracticeSettings())}>{ui('恢复默认')}</Button>
      </div>
      <Hint>{ui('改动立即保存，只影响之后的练习。')}</Hint>
    </SettingsSection>
  </div>;
}
