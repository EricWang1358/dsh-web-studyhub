import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Field, Hint, InlineMessage, ProviderCard, SecretKeyForm, Select, StepList, TextInput } from '../components/index.js';
import { MODEL_PRESETS, presetById, presetOf } from './presets.js';

const RESULT_TEXT = (result) => {
  if (result?.ok) {
    return uiFormat('连通成功（{0} ms）：{1}', [Math.round(result.latencyMs || 0), result.message || 'OK']);
  }
  return uiFormat('不可用：{0}', [result?.message || ui('没有返回原因')]);
};

function initialOpenAiDraft(openai) {
  if (openai?.baseUrl) {
    return { baseUrl: openai.baseUrl, model: openai.model || '' };
  }
  return { baseUrl: MODEL_PRESETS[0].baseUrl, model: openai?.model || MODEL_PRESETS[0].model };
}

function providerOptions() {
  return [
    ...MODEL_PRESETS.map((item) => ({ value: item.id, label: ui(item.name) })),
    { value: 'custom', label: ui('其他（OpenAI 兼容接口）') },
  ];
}

function EndpointFields({ preset, chosen, draft, setDraft, hasKey }) {
  const urlHints = [
    preset === 'custom' ? ui('服务商文档里的 OpenAI 兼容地址，通常以 /v1 结尾') : '',
    hasKey ? ui('换成另一个服务商的地址时，请重新粘贴对应服务商的 API Key。') : '',
  ].filter(Boolean).join(' ');

  return (
    <>
      {chosen && <StepList steps={chosen.steps.map((step) => ({ text: ui(step.text), href: step.href }))} />}
      <Field label={ui('接口地址')} width="full" hint={urlHints || undefined}>
        <TextInput value={draft.baseUrl} spellCheck={false} placeholder="https://…/v1"
          onChange={(event) => setDraft({ ...draft, baseUrl: event.target.value })} />
      </Field>
      <Field label={ui('模型')} width="full" hint={ui('模型名以服务商页面为准，可以改成你想用的')}>
        <TextInput value={draft.model} spellCheck={false}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
      </Field>
    </>
  );
}

function openAiStatus({ ready, hasKey, chosen, openai }) {
  if (ready) {
    const providerLabel = chosen ? ui(chosen.name) : openai.baseUrl;
    return uiFormat('当前已启用：{0} · {1}', [providerLabel, openai.model]);
  }
  if (hasKey) return ui('已保存 API Key，点击「切换并使用 API Key」即可切换为此模式');
  return ui('粘贴 API Key 即可使用（无需配置终端）');
}

function OpenAiBadges({ chosen, active, hasKey }) {
  return (
    <>
      {chosen && <Badge size="sm" tone="success">{ui(chosen.badge)}</Badge>}
      {active && hasKey && <Badge size="sm" tone="info">{ui('当前已启用')}</Badge>}
    </>
  );
}

function isOpenAiDirty(draft, openai) {
  return draft.baseUrl !== (openai?.baseUrl || '') || draft.model !== (openai?.model || '');
}

function deriveOpenAiModel(draft, openai, active) {
  const preset = presetOf(draft.baseUrl);
  const chosen = presetById(preset);
  const hasKey = Boolean(openai?.hasKey);
  const dirty = isOpenAiDirty(draft, openai);
  const baseUrl = draft.baseUrl.trim();
  const model = draft.model.trim();
  const incomplete = !baseUrl || !model;
  const ready = Boolean(active && hasKey && openai?.baseUrl && openai?.model);
  const savedKey = { set: hasKey, hint: openai?.keyLast4 ? `…${openai.keyLast4}` : '' };
  return {
    preset,
    chosen,
    hasKey,
    dirty,
    incomplete,
    ready,
    savedKey,
    showSaveActions: hasKey && (dirty || !active),
    payload: { providerId: preset, baseUrl, model },
  };
}

/** OpenAI-compatible API Key setup card with domestic direct presets (智谱 / 硅基流动 / DeepSeek / 自定义). */
export default function DesktopOpenAiForm({ openai, active, actions, working, compact = false }) {
  const [draft, setDraft] = useState(() => initialOpenAiDraft(openai));
  const state = deriveOpenAiModel(draft, openai, active);

  const choosePreset = (id) => {
    const picked = presetById(id);
    setDraft(picked ? { baseUrl: picked.baseUrl, model: picked.model } : { baseUrl: '', model: '' });
  };

  const resetDraft = () => setDraft(initialOpenAiDraft(openai));
  const saveEndpoint = async (event) => {
    event.preventDefault();
    if (state.incomplete || working) return;
    if (typeof actions.saveOpenAiEndpoint === 'function') {
      await actions.saveOpenAiEndpoint(state.payload);
      return;
    }
    try { await actions.saveOpenAi(state.payload); } catch { /* handled by action */ }
  };

  return (
    <ProviderCard layout="stack" data-desktop-openai-card={state.ready ? 'ready' : 'idle'}
      title={compact ? ui('使用 API Key 接入模型') : ui('API Key 模型（OpenAI 兼容接口）')}
      badges={<OpenAiBadges chosen={state.chosen} active={active} hasKey={state.hasKey} />}
      status={openAiStatus({ ready: state.ready, hasKey: state.hasKey, chosen: state.chosen, openai })} set={state.ready}>
      <form className="desktop-model__endpoint" onSubmit={saveEndpoint}>
        <Field label={ui('服务商')} width="full">
          <Select value={state.preset} options={providerOptions()} onChange={choosePreset} />
        </Field>
        <EndpointFields preset={state.preset} chosen={state.chosen} draft={draft} setDraft={setDraft} hasKey={state.hasKey} />
        {/* The submit stands inside its form in this file, so the icon gate reads what it does from the form's onSubmit (tests/helpers/go-on.mjs). */}
        {state.showSaveActions && (
          <div className="desktop-model__actions">
            <Button type="submit" variant="primary" busy={working === 'save-openai'} disabled={state.incomplete}>
              {active ? ui('保存接口和模型') : ui('切换并使用 API Key')}
            </Button>
            {state.dirty && <Button variant="quiet" lock={Boolean(working)} onClick={resetDraft}>{ui('取消')}</Button>}
          </div>
        )}
      </form>
      <span className="sh-field__label" aria-hidden="true">{ui('API Key')}</span>
      {state.incomplete && (
        <InlineMessage tone="info" data-desktop-openai-incomplete="">
          {ui('先填好上面的接口地址和模型，再保存 API Key。')}
        </InlineMessage>
      )}
      <SecretKeyForm name="desktop-openai-key" label={ui('API Key')} placeholder={ui('粘贴服务商的 API Key')}
        saved={state.savedKey} verifyLabel={ui('测试')} saveLabel={ui('保存并测试')} resultText={RESULT_TEXT}
        primary={!state.showSaveActions}
        busy={Boolean(working) || state.incomplete}
        onSave={(apiKey) => actions.saveOpenAi({ ...state.payload, apiKey })}
        onClear={() => actions.saveOpenAi({ apiKey: '' })}
        onVerify={() => actions.testOpenAi(state.payload)} />
      {!compact && (
        <Hint className="desktop-model__note">
          {ui('出题、讲解和批改时，所选资料会发送到你配置的接口；API Key 仅保存在本机 StudyHub 桌面版配置文件中，不会上传到第三方服务器。')}
        </Hint>
      )}
    </ProviderCard>
  );
}
