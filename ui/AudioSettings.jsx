import { getUiLanguage, ui, uiFormat, uiMessage, useUiLanguage } from './i18n.js';
import React, { useEffect, useRef, useState } from 'react';
import AudioReasoning from './AudioReasoning.jsx';
import { Badge, Disclosure, Field, Hint, InlineMessage, ProviderCard, ProviderGrid, SecretKeyForm, SegmentedControl, Select, SetupRequired, SettingsSection, TextInput, useToast } from './components/index.js';
import { KEY_FIELDS, providerOf, providersFor } from '../lib/audio-providers.js';
import { audioFocusPending, requestAudioSettingsFocus, takeAudioSettingsFocus } from './audio-focus.js';
import { useInjectCss } from './shared.js';
import css from './audio-settings.css';

export { audioFocusPending, requestAudioSettingsFocus };

/* 音频转写设置：每个服务商一张卡片（三步、真实链接、一个密钥框、验证）。
   转写按 Gemini 免费 → 硅基流动 → Groq → Gemini 付费 的顺序尝试，只配一个也可以。
   付费密钥、模型、并发和推理强度放在「高级」里，用「更快 / 均衡 / 更准」三个预设代替矩阵。
   密钥只写入用户目录下的 audio.json，不进学习库、备份或快照；这里只能看到「已保存」和末四位。 */

/* The card copy that is about this page, not the provider: the three steps (a step links to the provider's console or key page, from
   lib/audio-providers.js), the field's placeholder and a note. Names, badges and every link come from the registry. */
const CARD_COPY = Object.freeze({
  siliconflow: { steps: [{ text: '打开硅基流动，用手机号注册并登录', link: 'consoleUrl' }, { text: '在「API 密钥」页新建一个密钥并复制', link: 'keyUrl' }, { text: '粘贴到下面，点「保存并验证」' }],
    placeholder: '粘贴硅基流动的 API 密钥（sk-…）', note: '只用于转写；校对和翻译仍由 DSH 的模型完成。' },
  groq: { steps: [{ text: '在 Groq 控制台注册并登录', link: 'consoleUrl' }, { text: '在「API Keys」页创建一个密钥并复制', link: 'keyUrl' }, { text: '粘贴到下面，点「保存并验证」' }],
    placeholder: '粘贴 Groq 的 API 密钥（gsk_…）', note: '每分钟和每天都有免费上限，用完会自动换下一个服务。' },
  free: { steps: [{ text: '用 Google 账号登录 AI Studio', link: 'consoleUrl' }, { text: '在「Get API key」页创建一个密钥（这个项目不要开通计费）', link: 'keyUrl' }, { text: '粘贴到下面，点「保存并验证」' }],
    placeholder: '粘贴 AI Studio 的 API 密钥', note: '课堂实录只支持 Gemini。免费额度下 Google 可能用内容改进产品；欧盟、瑞士、英国地区不可用。' },
});
/** One transcription provider: what it is, where to get a key, and the three steps. */
export const PROVIDERS = Object.freeze(Object.fromEntries(Object.entries(CARD_COPY).map(([tier, copy]) => {
  const provider = providerOf(tier);
  return [tier, { tier, field: provider.keyField, name: provider.name, badge: provider.badge, tone: provider.tone || undefined,
    steps: copy.steps.map(({ text, link }) => (link ? { text, href: provider[link] } : { text })), placeholder: copy.placeholder, note: copy.note }];
})));
/** Cards in the order a learner should consider them: mainland China first gets the provider that works there. */
export const providerOrder = (language) => providersFor(language).map((provider) => provider.tier);

/** Proofreading and translation depth as three plain choices; "balanced" is the default. */
export const PRESETS = Object.freeze({
  fast: { proofreadReasoning: 'low', translateReasoning: 'low' },
  balanced: { proofreadReasoning: 'default', translateReasoning: 'low' },
  accurate: { proofreadReasoning: 'high', translateReasoning: 'medium' },
});
export function presetOf(settings = {}) {
  const proof = settings.proofreadReasoning || 'default', translate = settings.translateReasoning || 'low';
  return Object.keys(PRESETS).find((name) => PRESETS[name].proofreadReasoning === proof && PRESETS[name].translateReasoning === translate) || 'custom';
}

const RESULT = (result) => (result.ok ? ui('可用：密钥有效，网络也连得上') : uiFormat('不可用：{0}', [uiMessage(result.message || ui('没有返回原因'))]));

/**
 * One provider's key: paste, save and verify (the check never transcribes), verify a saved key, or clear it. The form is the
 * shared SecretKeyForm: the key input at full width, the actions, then the result message and an optional footnote (rows
 * that cards can line up). `initialResult` shows a check result on first render (previews and tests).
 */
export function ProviderKeyForm({ provider, state, call, busy = false, primary = true, onSaved, label, footnote, initialResult = null }) {
  const set = (patch) => Promise.resolve(call('audio.settings.set', patch)).then((next) => onSaved?.(next));
  return <SecretKeyForm name="audio-key" label={label || uiFormat('{0} 的 API 密钥', [ui(provider.name)])} placeholder={ui(provider.placeholder)}
    saved={state} busy={busy || !call} primary={primary} footnote={footnote} initialResult={initialResult} resultText={RESULT}
    onSave={(key) => set({ [provider.field]: key })} onClear={() => set({ [provider.field]: '' })}
    onVerify={() => Promise.resolve(call('audio.test', { tier: provider.tier })).then((report) => report?.[provider.tier] || { ok: false })} />;
}

/* A card's rows (head, saved status, steps, key input, actions, message/footnote)
   share the grid's rows through subgrid, so the same parts line up across cards. */
function KeyCard({ provider, state, call, busy, onSaved, recommended }) {
  return (
    <ProviderCard data-provider={provider.tier} title={ui(provider.name)} set={!!state?.set}
      badges={<>
        <Badge size="sm" tone={provider.tone === 'success' ? 'success' : 'neutral'}>{ui(provider.badge)}</Badge>
        {recommended && <Badge size="sm" tone="accent">{ui('推荐')}</Badge>}
      </>}
      status={state?.set ? uiFormat('已保存 {0}', [state.hint]) : ui('未配置')}
      steps={provider.steps.map((step) => ({ text: ui(step.text), href: step.href }))}>
      <ProviderKeyForm provider={provider} state={state} call={call} busy={busy} onSaved={onSaved} primary={!!recommended}
        footnote={<Hint>{ui(provider.note)}</Hint>} />
    </ProviderCard>
  );
}

/**
 * The gate shown INSTEAD of the audio drop zone while no transcription provider is configured: why, the three steps of
 * the provider that suits the learner's language (with the key field right there), and the way to the full settings.
 */
const GATE_COPY = Object.freeze({
  groq: { why: '录音要先转成文字。推荐 Groq：有免费额度，注册后马上能用。', other: { text: '也可以用 Google Gemini 的免费额度（需海外网络）', tier: 'free', label: '获取 Gemini 密钥' } },
  siliconflow: { why: '录音要先转成文字。推荐硅基流动 SenseVoice：免费 · 国内直连，注册后马上能用。', other: { text: '在海外网络下也可以用 Groq 或 Google Gemini 的免费额度', tier: 'groq', label: '获取 Groq 密钥' } },
});

export function AudioSetupGate({ language = getUiLanguage(), call, onOpenSettings, onSaved, reason = 'no-provider' }) {
  useInjectCss(css, 'study-audio-settings');
  const lead = providerOrder(language)[0], provider = PROVIDERS[lead], copy = GATE_COPY[lead];
  const others = { text: copy.other.text, href: providerOf(copy.other.tier).keyUrl, label: copy.other.label };
  return (
    <SetupRequired className="audio-setup" icon="audio" title={ui('转写服务还没配置 · 约 2 分钟')}
      why={reason === 'paid-missing' ? ui('选择了「只用付费密钥」，但还没有配置 Gemini 付费密钥。去掉这个勾选，或在音频设置的「高级」里填写付费密钥。')
        : ui(copy.why)}
      steps={reason === 'paid-missing' ? [] : provider.steps.map((step) => ({ text: ui(step.text), href: step.href }))}
      secondary={onOpenSettings ? { label: ui('打开音频设置'), icon: 'key', onClick: onOpenSettings } : undefined}>
      {reason !== 'paid-missing' && <>
        <ProviderKeyForm provider={provider} call={call} onSaved={onSaved} label={uiFormat('{0} 的 API 密钥', [ui(provider.name)])} />
        <Hint className="audio-setup-alt">{ui(others.text)} · <a href={others.href} target="_blank" rel="noreferrer">{ui(others.label)}</a></Hint>
      </>}
    </SetupRequired>
  );
}

export default function AudioSettings({ busy, act, call, initialView = null }) {
  const toast = useToast();
  useInjectCss(css, 'study-audio-settings');
  const language = useUiLanguage();
  const [view, setView] = useState(initialView);
  const section = useRef(null);
  // Loaded with call(), not act(): act is single-flight and the settings page already loads 陪学 through it.
  useEffect(() => {
    let alive = true;
    call?.('audio.settings.get', {})?.then?.((value) => alive && setView(value), () => {});
    return () => { alive = false; };
  }, [call]);
  useEffect(() => {
    if (!view || !audioFocusPending() || !section.current) return;
    takeAudioSettingsFocus();
    section.current.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    section.current.querySelector('.sh-provider:not(.is-set) input[name="audio-key"]')?.focus?.({ preventScroll: true });
  }, [view]);
  if (!view) return null;
  const save = (patch, message) => act('audio.settings.set', patch, (next) => {
    setView(next); toast.success(message || ui('音频设置已保存'));
  }, { refreshAfter: false });
  const saved = (next) => { if (next) setView(next); };
  const modelField = (field, label) => <Field label={ui(label)}>
    <TextInput key={view[field]} defaultValue={view[field]} disabled={busy}
      onBlur={(event) => event.target.value.trim() !== view[field] && save({ [field]: event.target.value.trim() })} />
  </Field>;
  const preset = presetOf(view);
  const configured = KEY_FIELDS.filter((field) => view[field]?.set).length;
  return (
    <SettingsSection className="audio-settings" tour="settings-audio" ref={section} title={ui('音频转写')}
      lead={ui('录音要先转成文字。配一个服务就能用；配了几个时，按 Gemini 免费 → 硅基流动 → Groq → Gemini 付费 的顺序尝试，前一个不行自动换下一个。')}>
      {!configured && <InlineMessage tone="warning">{ui('还没有配置任何转写服务：从下面任选一个，约 2 分钟。')}</InlineMessage>}
      <ProviderGrid>
        {providerOrder(language).map((tier, index) => <KeyCard key={tier} provider={PROVIDERS[tier]} state={view[PROVIDERS[tier].field]}
          call={call} busy={busy} onSaved={saved} recommended={index === 0} />)}
      </ProviderGrid>
      <Hint className="audio-settings-path">{uiFormat('密钥只保存在这台电脑：{0}。不会进入学习库、备份或对话；请不要把密钥贴到对话里。', [view.settingsFile || '~/.dsh/study/audio.json'])}</Hint>
      <Disclosure className="audio-advanced settings-disclosure" summary={ui('高级')} meta={ui('校对与翻译的速度、付费密钥、模型')}>
        <Field group label={ui('校对与翻译')} width="full"
          hint={preset === 'custom' ? ui('当前是自定义组合（见下方「专家选项」）。') : ui('更快：推理最少；均衡：默认；更准：推理更多，耗时更长。只影响下一次处理。')}>
          <SegmentedControl label={ui('校对与翻译')} value={preset} disabled={busy} onChange={(name) => save(PRESETS[name], ui('已切换校对与翻译的速度'))}
            options={[{ value: 'fast', label: ui('更快') }, { value: 'balanced', label: ui('均衡') }, { value: 'accurate', label: ui('更准') }]} />
        </Field>
        <div className="audio-paid">
          <h4 className="settings-subtitle">{ui('Gemini 付费密钥（可选）')}</h4>
          <Hint>{ui('来自另一个开通计费并充值的 Google 项目，免费额度都用完时才用；导入时勾选「只用付费密钥」可以完全不经过免费服务。余额用完时请求会失败，不会自动降回免费。')}</Hint>
          <ProviderKeyForm provider={{ tier: 'paid', field: providerOf('paid').keyField, name: providerOf('paid').name, placeholder: '粘贴付费项目的 AI Studio 密钥' }}
            state={view.paidKey} call={call} busy={busy} primary={false} onSaved={saved} />
        </div>
        <Disclosure className="audio-expert settings-disclosure" summary={ui('专家选项')} meta={ui('模型、并发、推理强度')}>
          <Field label={ui('校对与翻译用哪个模型')}>
            <Select value={view.textProvider} disabled={busy} onChange={(e) => save({ textProvider: e.target.value })}>
              <option value="auto">{ui('自动（有对话模型就用它，否则用 Gemini）')}</option>
              <option value="gemini">{ui('Gemini（同样先免费后付费）')}</option>
              <option value="host">{ui('对话当前使用的模型')}</option>
            </Select>
          </Field>
          {modelField('transcribeModel', '转写模型')}
          {view.textProvider !== 'host' && modelField('textModel', 'Gemini 文本模型')}
          {modelField('siliconflowTranscribeModel', '硅基流动转写模型')}
          {modelField('groqTranscribeModel', 'Groq 转写模型')}
          {view.textProvider !== 'host' && modelField('groqTextModel', 'Groq 文本模型')}
          {modelField('liveModel', '课堂实时转写模型')}
          {view.textProvider !== 'host' && modelField('liveTranslateModel', '课堂实时翻译模型')}
          <Field label={ui('上下文校正推理强度')}>
            <Select value={view.liveCorrectionReasoning || 'low'} disabled={busy} onChange={event => save({ liveCorrectionReasoning: event.target.value })}>
              <option value="low">{ui('低（优先速度）')}</option><option value="default">{ui('模型默认')}</option>
            </Select>
          </Field>
          <Field label={ui('单条录音的校对与翻译并发数')}
            hint={ui('录音逐个处理；单条录音内同时处理 2 或 3 个校对或翻译窗口，按原顺序合并，已完成的部分可以复用。并发越高，越容易触发每分钟限流。')}>
            <Select value={view.textConcurrency ?? 3} disabled={busy} onChange={(e) => save({ textConcurrency: Number(e.target.value) })}>
              {[2, 3].map((count) => <option key={count} value={count}>{count === 3 ? uiFormat('{0} 个（默认）', [count]) : uiFormat('{0} 个', [count])}</option>)}
            </Select>
          </Field>
          <Field label={ui('每次请求最长')}
            hint={ui('录音不超过这个长度就整段发送；更长时按最少的段数平均切开，尽量在停顿处。若长录音经常等不到回应，可以调小。')}>
            <Select value={view.partMinutes ?? 59} disabled={busy} onChange={(e) => save({ partMinutes: Number(e.target.value) })}>
              {[[59, '59 分钟（推荐：请求最少，最省免费额度）'], [45, '45 分钟'], [30, '30 分钟'], [20, '20 分钟'], [10, '10 分钟']].map(([minutes, label]) =>
                <option key={minutes} value={minutes}>{ui(label)}</option>)}
            </Select>
          </Field>
          <Field label={ui('转写风格')}>
            <Select value={view.mode} disabled={busy} onChange={(e) => save({ mode: e.target.value })}>
              <option value="SMART">{ui('整理（去掉口头禅和重复，自动分段）')}</option>
              <option value="VERBATIM">{ui('逐字（保留每个字）')}</option>
            </Select>
          </Field>
          <AudioReasoning settings={view} busy={busy} onSave={save} />
        </Disclosure>
      </Disclosure>
    </SettingsSection>
  );
}
