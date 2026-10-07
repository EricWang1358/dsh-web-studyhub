import React, { useId, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button, Checkbox, IconButton, Select } from '../components/index.js';
import { useApp } from '../app/app-context.js';
import { failureText } from '../failure.js';
import { contractOf, isRunningTask } from './task-model.js';
import { controlItems, stepValue, appliedText, defaultsPatch, controlLabel, reasonText } from './task-control.js';

/* 即时控制: the knobs of a running job, in one block of the same shape for every job, drawn from its contract (actions.set). A change goes to job.control {action: 'set'}
   and applies from the job's next call (a call in flight is never interrupted); the reply says what is now in force and the row says so. The row is
   always there, so a job that cannot be adjusted, or has ended, says that in the same place (with the contract's own reason) instead of the row
   appearing or going away. A bar on top (the name and 存为默认, what the row cannot do, and under them a line of its own for what is in force, so a longer sentence there moves nothing) and the controls under it, which wrap as whole
   units (a label never leaves its select); a select is as wide as its longest word needs, whatever it shows. */

function Stepper({ item, disabled, onChange }) {
  const id = useId();
  return (
    <span className="tc-control" role="group" aria-labelledby={id} data-control={item.key}>
      <span className="tc-control__label" id={id}>{item.label}</span>
      <span className="tc-stepper">
        <IconButton icon="minus" size="sm" variant="secondary" className="tc-stepper__btn" label={uiFormat('减少{0}', [item.label])} disabled={disabled || item.value <= item.min} onClick={() => onChange(stepValue(item, -1))} />
        <strong className="tc-stepper__value" aria-live="off">{item.value}</strong>
        <IconButton icon="plus" size="sm" variant="secondary" className="tc-stepper__btn" label={uiFormat('增加{0}', [item.label])} disabled={disabled || item.value >= item.max} onClick={() => onChange(stepValue(item, 1))} />
      </span>
    </span>
  );
}

function Choose({ item, disabled, onChange }) {
  const id = useId();
  return (
    <span className="tc-control" data-control={item.key}>
      <label className="tc-control__label" htmlFor={id}>{item.label}</label>
      <Select id={id} className="tc-select" value={item.value} disabled={disabled} onChange={onChange} options={item.options} />
    </span>
  );
}

function Toggle({ item, disabled, onChange }) {
  return <span className="tc-control" data-control={item.key}><Checkbox label={item.label} checked={item.value} disabled={disabled} onChange={onChange} /></span>;
}

export default function ControlRow({ job }) {
  const { core, data } = useApp();
  const contract = contractOf(job), set = contract.actions.set;
  const [note, setNote] = useState({ text: '', tone: 'idle' }), [working, setWorking] = useState(false), [saved, setSaved] = useState(false);
  const items = controlItems(job, data?.model?.session), defaults = defaultsPatch(job);
  const send = async (patch) => {
    if (working) return;
    setWorking(true);
    try {
      const reply = await core.call('job.control', { jobId: contract.jobId, action: 'set', patch });
      setNote({ text: appliedText(reply?.applied), tone: 'success' });
      setSaved(false);
    } catch (error) { setNote({ text: failureText(error), tone: 'error' }); } finally { setWorking(false); }
  };
  const save = async () => {
    try { await core.act(defaults.action, defaults.args); setSaved(true); setNote({ text: ui('✓ 已存为默认'), tone: 'success' }); } catch (error) { setNote({ text: failureText(error), tone: 'error' }); }
  };
  return (
    <div className="tc-controls" role="group" aria-label={ui('即时控制')} data-empty={items.length ? undefined : 'true'}>
      <div className="tc-controls__bar">
        <span className="tc-controls__title">{ui('即时控制')}</span>
        {items.length === 0 && <span className="tc-controls__idle">{set.available ? ui('这个任务现在没有可以调整的设置。')
          : contract.status === 'interrupted' && contract.actions.retry.available ? ui('任务被中断了，已完成的部分都保留着；点「接着做」继续。')
            : ['failed', 'cancelled'].includes(contract.status) && contract.actions.retry.available ? ui('任务没有做完，已出的题都保留着；点「接着做」继续。') : reasonText(set)}</span>}
        {items.length > 0 && defaults && <Button size="sm" variant="quiet" className="tc-controls__save" disabled={saved || core.busy} onClick={save}
          title={uiFormat('把这里的{0}存为以后新任务的默认', [items.slice(0, 2).map((item) => controlLabel(item.key)).join('、')])}>{ui('存为默认')}</Button>}
        {isRunningTask(job) && ['capability-unsupported', 'no-safe-checkpoint', 'single-round', 'manual-run'].includes(contract.actions.pause.reason?.code) && <span className="tc-controls__note">{reasonText(contract.actions.pause, 'pause')}</span>}
        <span className="tc-controls__applied" role="status" data-tone={note.tone}>{note.text || (items.length ? ui('改动从下一次调用生效') : '')}</span>
      </div>
      {items.length > 0 && <div className="tc-controls__items">
        {items.map((item) => {
          const change = (value) => send({ [item.key]: value });
          if (item.type === 'int') return <Stepper key={item.key} item={item} disabled={working} onChange={change} />;
          if (item.type === 'enum') return <Choose key={item.key} item={item} disabled={working} onChange={change} />;
          return <Toggle key={item.key} item={item} disabled={working} onChange={change} />;
        })}
      </div>}
    </div>
  );
}
