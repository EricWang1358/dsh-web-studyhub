import React, { useContext, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Field, Hint, InlineMessage, ProviderCard, SecretKeyForm, Select, StepList, TextInput } from '../components/index.js';
import { useInjectCss } from '../shared.js';
import { useLiveEffect } from '../use-async.js';
import { AppContext } from '../app/app-context.js';
import { MODEL_PRESETS, presetOf } from './presets.js';
import css from './zcode.css';

/* The ZCode edition's model: ZCode lends a plugin no model, so the learner fills in one OpenAI-compatible endpoint
   (address, model, key) here, under Settings › 学习库与模型 and inside the model gate before a step that needs it.
   The host keeps it in the StudyHub config file of this computer (packages/studyhub-zcode/host/workspace.mjs) and only
   ever answers whether a key is saved and its last four characters. 测试 sends one tiny request to the endpoint. */

const RESULT = (result) => (result?.ok ? result.message : uiFormat('不可用：{0}', [result?.message || ui('没有返回原因')]));

/** `compact`: the form inside a gate (no card title, no notes the gate already says). */
export default function ZcodeModelSetup({ compact = false }) {
  useInjectCss(css, 'study-zcode');
  const app = useContext(AppContext);
  const call = app?.core?.call, refresh = app?.core?.refresh;
  const [view, setView] = useState(null), [draft, setDraft] = useState(null), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useLiveEffect((live) => {
    if (!call) return;
    // Nothing saved yet: start from the first mainland preset, so the learner only pastes a key.
    const start = (value) => (value.baseUrl ? { baseUrl: value.baseUrl, model: value.model } : { baseUrl: MODEL_PRESETS[0].baseUrl, model: value.model || MODEL_PRESETS[0].model });
    call('model.config.get').then((value) => { if (live()) { setView(value); setDraft(start(value)); } },
      (failure) => { if (live()) setError(failure.message); });
  }, [call]);
  if (!call) return null;
  if (!view || !draft) return error ? <InlineMessage tone="error">{error}</InlineMessage> : null;
  const preset = presetOf(draft.baseUrl), chosen = MODEL_PRESETS.find((item) => item.id === preset);
  const dirty = draft.baseUrl !== view.baseUrl || draft.model !== view.model;
  const label = chosen ? chosen.name : '';
  async function save(patch) {
    setError('');
    try {
      const next = await call('model.config.set', { baseUrl: draft.baseUrl, model: draft.model, label, ...patch });
      setView(next);
      setDraft({ baseUrl: next.baseUrl, model: next.model });
      await refresh?.();
      return next;
    } catch (failure) { setError(failure.message); throw failure; }
  }
  async function saveEndpoint(event) {
    event.preventDefault();
    setSaving(true);
    try { await save({}); } catch { /* the message is shown */ } finally { setSaving(false); }
  }
  const choose = (id) => {
    const next = MODEL_PRESETS.find((item) => item.id === id);
    setDraft(next ? { baseUrl: next.baseUrl, model: next.model } : { baseUrl: '', model: '' });
  };
  const options = [...MODEL_PRESETS.map((item) => ({ value: item.id, label: ui(item.name) })), { value: 'custom', label: ui('其他（OpenAI 兼容接口）') }];
  return (
    <ProviderCard layout="stack" className="zcode-model" data-zcode-model={view.ready ? 'ready' : 'missing'}
      title={compact ? ui('在这里接入模型') : ui('生成模型')}
      badges={chosen && <Badge size="sm" tone="success">{ui(chosen.badge)}</Badge>}
      status={view.ready ? uiFormat('已保存：{0} · {1}', [view.label || view.baseUrl, view.model]) : ui('还没有可用的模型')} set={view.ready}>
      <form className="zcode-model__endpoint" onSubmit={saveEndpoint}>
        <Field label={ui('服务商')} width="full">
          <Select value={preset} onChange={choose} options={options} />
        </Field>
        {chosen && <StepList steps={chosen.steps.map((step) => ({ text: ui(step.text), href: step.href }))} />}
        <Field label={ui('接口地址')} width="full" hint={preset === 'custom' ? ui('服务商文档里的 OpenAI 兼容地址，通常以 /v1 结尾') : undefined}>
          <TextInput value={draft.baseUrl} spellCheck={false} placeholder="https://…/v1" onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
        </Field>
        <Field label={ui('模型')} width="full" hint={ui('模型名以服务商页面为准，可以改成你想用的')}>
          <TextInput value={draft.model} spellCheck={false} onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
        </Field>
        {view.key.set && dirty && <div className="zcode-model__actions">
          <Button type="submit" variant="primary" busy={saving} disabled={!draft.baseUrl.trim() || !draft.model.trim()}>{ui('保存接口和模型')}</Button>
          <Button variant="quiet" disabled={saving} onClick={() => setDraft({ baseUrl: view.baseUrl, model: view.model })}>{ui('取消')}</Button>
        </div>}
      </form>
      <span className="sh-field__label" aria-hidden="true">{ui('API Key')}</span>
      <SecretKeyForm name="zcode-model-key" label={ui('API Key')} placeholder={ui('粘贴服务商的 API Key')} saved={view.key}
        verifyLabel={ui('测试')} saveLabel={ui('保存并测试')} resultText={RESULT}
        busy={saving || !draft.baseUrl.trim() || !draft.model.trim()}
        envNote={ui('这个密钥来自环境变量 STUDYHUB_API_KEY，不能在这里清除；要换掉它，请改系统的环境变量。')}
        onSave={(key) => save({ apiKey: key })} onClear={() => save({ apiKey: '' })}
        onVerify={() => call('model.config.test', {})} />
      {error && <InlineMessage tone="error" onDismiss={() => setError('')}>{error}</InlineMessage>}
      {!compact && <Hint className="zcode-model__note">
        {ui('出题、讲解和批改时，所选资料会发送到这个接口；密钥只保存在这台电脑的 StudyHub 配置文件里。后台任务在 ZCode 打开时运行，退出 ZCode 会结束它们，已完成的部分会保留。')}
      </Hint>}
    </ProviderCard>
  );
}
