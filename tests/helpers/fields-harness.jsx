/* Browser harness for tests/wave2-g-fields-browser.test.mjs: the field primitives mounted with state, results on window. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Checkbox, Field, NumberInput, RadioCard, RadioCardGroup, Select, SettingsSection, Switch, TextInput } from '../../ui/components/index.js';

window.calls = { switch: [], check: [], disabled: 0, tier: [] };

function FieldsScenario() {
  const [name, setName] = useState('');
  const [on, setOn] = useState(false), [agree, setAgree] = useState(true), [tier, setTier] = useState('basic');
  const error = name.length > 3 ? '最多 3 个字' : undefined;
  return <div className="study-app">
    <Button>样式载入</Button>
    <SettingsSection title="设置" lead="说明" tour="settings-demo">
      <Field label="课程名称" hint="最多 3 个字" error={error}>
        <TextInput name="course" value={name} onChange={event => setName(event.target.value)} />
      </Field>
      <Field label="题数" hint="1–50" width="sm"><NumberInput name="count" value={5} min={1} max={50} suffix="道" onChange={() => {}} /></Field>
      <Field label="口吻" hint="亲切或专业"><Select name="tone" value="a" onChange={() => {}} options={[{ value: 'a', label: '亲切' }, { value: 'b', label: '专业' }]} /></Field>
      <Switch label="记录使用频率" hint="关掉后，已有的记录保留。" name="usage" checked={on} onChange={checked => { window.calls.switch.push(checked); setOn(checked); }} />
      <Checkbox label="同意上传" hint="文档会上传。" name="agree" checked={agree} onChange={checked => { window.calls.check.push(checked); setAgree(checked); }} />
      <Switch label="停用的开关" hint="不可用。" checked={false} disabled onChange={() => { window.calls.disabled += 1; }} />
      <RadioCardGroup legend="选一个档位">
        {['basic', 'standard'].map(value => <RadioCard key={value} name="tier" value={value} checked={tier === value} title={value} hint={`${value} 的说明`}
          onSelect={next => { window.calls.tier.push(next); setTier(next); }} />)}
      </RadioCardGroup>
    </SettingsSection>
  </div>;
}

const SCENARIOS = { fields: FieldsScenario };
let root;
window.mountScenario = name => {
  root?.unmount();
  const host = document.getElementById('root');
  host.replaceChildren();
  root = createRoot(host);
  const Scenario = SCENARIOS[name];
  root.render(<Scenario />);
};
window.harnessReady = true;
