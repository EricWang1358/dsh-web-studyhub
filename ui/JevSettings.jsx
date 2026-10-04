import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { ui, uiFormat, uiMessage } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Checkbox, Field, Hint, InlineMessage, ProviderCard, SecretKeyForm, SettingsSection, Select, Switch, TextInput, useToast } from './components/index.js';
import { readJSON, writeJSON } from './storage.js';
import { useAsyncAction } from './use-async.js';
import { TokenUsage } from './TokenUsage.jsx';
import JevLevelCheck from './JevLevelCheck.jsx';
import { JEV_FEATURE_META, JEV_PROVIDER_META, JEV_REPLACE_META, dshUsage, failureCode, keySourceText, percentText, privacyPoints, providerChoices, providerOf, setupStep, thresholdChoices } from './jev-flow.js';
import css from './jev.css';

/* 设置 › 高级 › 实验性功能 › Jev. EXPERIMENTAL, hidden until "Show experimental features" is on (ui/ExperimentalSettings.jsx), and off by default
   even then. It is never anything but an experiment: opt-in, labelled as one, with the trade-off ("faster and cheaper, but accuracy may drop")
   said wherever a model call can be replaced.

   Jev is TypeSafe AI's "System One" model: a cheap, fast classifier-shaped service. The learner can let it answer a few decision-shaped model
   calls instead (lib/jev-sites.js), or only add reference signals; either way it never writes anything by itself, and when Jev is missing, failing
   or unsure everything works as before. The block is one guided flow, in this order: (a) a walk-through of what Jev could replace, (b) the provider,
   its key and its privacy note, (c) the switches: each turns ON at once, or says what is still missing and offers that step. Nothing is sent
   until ALL of these hold: a key is available, the privacy note of the CHOSEN provider is confirmed, the master switch is on, and the individual
   switch is on. A pasted key is stored in the DSH home (never in the library, an export or a backup) and shown back only as its last four
   characters; a key from an environment variable is never stored and only its variable's NAME is shown. */

const TEST_STATE = { valid: () => ui('可用：密钥有效，Jev 连得上') };
const GUIDE_KEY = 'study-jev-guide-seen';
const guideSeen = () => readJSON(GUIDE_KEY, 0) === 1;
const rememberGuide = () => writeJSON(GUIDE_KEY, 1); // a private window just asks again next time

const ExperimentalBadge = () => <Badge size="sm" tone="accent" className="jev-chip">{ui('实验性')}</Badge>;

/** The privacy note and the one-time confirmation of ONE provider: what is sent, where it goes, what the provider says (and does not say). */
export function JevPrivacy({ confirmed, onChange, disabled, privacyUrl, provider, host }) {
  const id = useId(), chosen = providerOf({ provider });
  return (
    <div className="jev-privacy" data-confirmed={confirmed ? 'true' : 'false'} data-provider={chosen}>
      <h3 className="jev-privacy__title">{ui('发送内容与隐私')}</h3>
      <ul className="jev-privacy__list">{privacyPoints(chosen, { host }).map((text, index) => <li key={index}>{text}</li>)}</ul>
      {privacyUrl && <p className="jev-privacy__link"><a href={privacyUrl} target="_blank" rel="noreferrer">{ui('查看服务商的隐私与数据说明')}<span className="sh-visually-hidden">{ui('（在新标签页打开）')}</span></a></p>}
      <Checkbox id={id} label={JEV_PROVIDER_META[chosen].confirmLabel()} checked={!!confirmed} disabled={disabled} onChange={onChange} />
    </div>
  );
}

/** Tokens and calls: today, in total, and per experiment, in the same rows as the study model's usage. Tokens only, never a price. */
export function JevUsageView({ usage }) {
  const used = [...JEV_REPLACE_META, ...JEV_FEATURE_META].filter(feature => usage?.byFeature?.[feature.id]?.calls > 0);
  const test = usage?.byFeature?.test?.calls > 0;
  return (
    <div className="jev-usage" data-jev-usage>
      <h3 className="jev-usage__title">{ui('Jev 用量')}</h3>
      {!usage?.total?.calls ? <Hint>{ui('还没有调用过 Jev。')}</Hint> : <>
        <div className="jev-usage__row"><strong>{ui('今天')}</strong><TokenUsage usage={dshUsage(usage.today)} inline copy={false} /></div>
        <div className="jev-usage__row"><strong>{ui('合计')}</strong><TokenUsage usage={dshUsage(usage.total)} inline copy={false} /></div>
        {(used.length > 0 || test) && <details className="jev-usage__more"><summary>{ui('按功能查看')}</summary>
          {used.map(feature => <div key={feature.id} className="jev-usage__row"><span>{feature.label()}</span><TokenUsage usage={dshUsage(usage.byFeature[feature.id])} inline copy={false} /></div>)}
          {test && <div className="jev-usage__row"><span>{ui('验证密钥时的调用')}</span><TokenUsage usage={dshUsage(usage.byFeature.test)} inline copy={false} /></div>}
        </details>}
      </>}
      <Hint>{ui('Jev 的 token 与学习模型的用量分开统计；这里只显示 token 数，不显示价格。')}</Hint>
    </div>
  );
}

/** (a) The walk-through of what Jev could replace: one replaceable model call per step, with next / back / skip. Shown here and nowhere else. */
export function JevGuide({ initialStep }) {
  const total = JEV_REPLACE_META.length, titleId = useId();
  const [step, setStep] = useState(initialStep ?? (guideSeen() ? -1 : 0));
  const finish = () => { rememberGuide(); setStep(-1); };
  if (step < 0 || step >= total) return (
    <p className="jev-guide jev-guide--done" data-jev-guide="done">
      <span>{ui('你已经看过「Jev 可以替换哪些调用」。')}</span>
      <Button variant="quiet" size="sm" onClick={() => setStep(0)}>{ui('再看一遍')}</Button>
    </p>
  );
  const site = JEV_REPLACE_META[step], last = step === total - 1;
  return (
    <section className="jev-guide" data-jev-guide={step + 1} aria-labelledby={titleId}>
      <header className="jev-guide__head">
        <h3 id={titleId}>{ui('Jev 可以替换哪些调用')}</h3>
        <ExperimentalBadge />
        <span className="jev-guide__count">{uiFormat('{0} / {1}', [step + 1, total])}</span>
      </header>
      <h4 className="jev-guide__site">{site.label()}</h4>
      <dl className="jev-guide__list">
        <dt>{ui('现在')}</dt><dd>{site.hint()}</dd>
        <dt>{ui('用 Jev')}</dt><dd>{site.instead()}</dd>
        <dt>{ui('取舍')}</dt><dd>{ui('更快、更省，但准确度可能下降。')}</dd>
      </dl>
      <div className="jev-guide__actions">
        <Button variant="quiet" size="sm" disabled={step === 0} onClick={() => setStep(step - 1)}>{ui('上一个')}</Button>
        {last ? <Button variant="primary" size="sm" onClick={finish}>{ui('完成')}</Button> : <Button variant="primary" size="sm" onClick={() => setStep(step + 1)}>{ui('下一个')}</Button>}
        <Button variant="quiet" size="sm" onClick={finish}>{ui('跳过')}</Button>
      </div>
    </section>
  );
}

const PREREQ = {
  endpoint: { text: () => ui('自定义端点还没有填写完整（接口地址和模型名）。'), go: () => ui('去填写端点') },
  key: { text: () => ui('还没有可用的密钥。'), go: () => ui('去填写密钥') },
  confirm: { text: () => ui('还没有确认隐私说明。'), go: () => ui('去确认隐私说明') },
};

/** (c) The per-site switches. A switch turns ON at once; if the provider, key or confirmation is still missing it says what and offers that step. */
export function JevReplaceList({ settings, onToggle, onGoto, initialBlocked = '', disabled = false }) {
  const [blocked, setBlocked] = useState(initialBlocked), step = setupStep(settings), ready = step === 'ready';
  const toggle = (site, checked) => {
    if (checked && !ready) { setBlocked(site); onGoto?.(step); return; }
    setBlocked('');
    onToggle?.(site, checked);
  };
  const need = PREREQ[step];
  return (
    <fieldset className="jev-replace" data-experimental="true" disabled={disabled}>
      <legend>{ui('用 Jev 替换模型调用')}<ExperimentalBadge /></legend>
      <Hint>{ui('默认全部关闭。打开某一项后，这一步会先问 Jev；出错、被限流或不确定时，自动改用原来的模型，并且只提示一次。随时可以关掉。')}</Hint>
      {JEV_REPLACE_META.map(site => <Switch key={site.id} data-replace={site.id} label={site.label()} checked={!!settings.replace?.[site.id]} onChange={checked => toggle(site.id, checked)}
        hint={<>{site.hint()}<span className="jev-replace__replaces">{site.replaces()}</span><span>{ui('预期：更快、更省，但准确度可能下降。')}</span></>} />)}
      {!ready && need && <div className="jev-prereq" role="status">
        <p><strong>{need.text()}</strong> {ui('先完成这一步，上面的开关才会生效。')}</p>
        <Button size="sm" variant="secondary" data-goto={step} onClick={() => onGoto?.(step)}>{need.go()}</Button>
      </div>}
      {blocked && !ready && <p className="jev-prereq__blocked" role="alert">{uiFormat('先完成上面的步骤，才能打开「{0}」。', [JEV_REPLACE_META.find(site => site.id === blocked)?.label() ?? ''])}</p>}
      <Hint className="jev-replace__compare">{ui('想知道在你的资料上差多少？用评估脚本把 Jev 和现在的模型对比：node scripts/eval-jev.mjs（见 docs/jev-experimental.md）。')}</Hint>
    </fieldset>
  );
}

/** The controls of one saved state. `settings` is jev.settings.get, `usage` is jev.usage's `usage`; `failure` its last failure. */
export function JevSettingsView({ call, settings, usage, failure, busy, working, result, error, onKey, onVerify, onClearKey, onConfirm, onEnabled, onFeature, onThreshold, onProvider, onKeyEnv, onReplace, onCustom, onGoto }) {
  const [envName, setEnvName] = useState(settings.keyEnv || '');
  const [endpoint, setEndpoint] = useState(settings.custom?.endpoint || ''), [model, setModel] = useState(settings.custom?.model || '');
  const step = setupStep(settings), ready = step === 'ready';
  const locked = busy || !!working;
  const provider = providerOf(settings), meta = settings.providers?.find(item => item.id === provider);
  const family = meta?.family ?? (provider === 'typesafe' ? 'typesafe' : 'opencode'), outside = family !== 'typesafe', custom = family === 'custom';
  const source = keySourceText(settings);
  const useVariable = event => { event.preventDefault(); onKeyEnv?.(envName.trim()); };
  const saveCustom = event => { event.preventDefault(); onCustom?.({ customEndpoint: endpoint.trim(), customModel: model.trim() }); };
  const resultText = outcome => (outcome.ok ? TEST_STATE.valid() : uiMessage(outcome.message || failureCode('unexpected', provider)));
  const keyEnvForm = (
    <form className="jev-keyenv__form" onSubmit={useVariable}>
      <Field label={ui('存放密钥的环境变量名')} hint={ui('只保存变量的名字，不保存它的值；留空就用默认名字。')}>
        <TextInput name="jev-key-env" autoComplete="off" spellCheck={false} value={envName} disabled={locked}
          placeholder={settings.keyEnvDefault || meta?.defaultKeyEnv || 'OPENCODE_GO_API_KEY_2'} onChange={event => setEnvName(event.target.value)} />
      </Field>
      <div className="jev-field__actions"><Button type="submit" variant="secondary" size="sm" disabled={locked}>{ui('使用这个环境变量')}</Button></div>
    </form>
  );
  return (
    <>
      <JevGuide />
      <div className="jev-provider" data-provider={provider}>
        <Field label={ui('Jev 服务商')}>
          <Select name="jev-provider" value={provider} disabled={locked} onChange={event => onProvider?.(event.target.value)}>
            {providerChoices().map(choice => <option key={choice.id} value={choice.id}>{choice.label}</option>)}
          </Select>
        </Field>
        {meta && !custom && <Hint className="jev-provider__where">{uiFormat('发送到 {0}，模型 {1}。', [meta.host, meta.model])}</Hint>}
        {custom && <form className="jev-custom" onSubmit={saveCustom}>
          <Field label={ui('接口地址')}>
            <TextInput name="jev-custom-endpoint" autoComplete="off" spellCheck={false} value={endpoint} disabled={locked}
              placeholder="https://gateway.example.com/v1/systemone" onChange={event => setEndpoint(event.target.value)} />
          </Field>
          <Field label={ui('模型名')}>
            <TextInput name="jev-custom-model" autoComplete="off" spellCheck={false} value={model} disabled={locked}
              placeholder="jev-1.13" onChange={event => setModel(event.target.value)} />
          </Field>
          <div className="jev-field__actions"><Button type="submit" variant="secondary" size="sm" disabled={locked || !endpoint.trim() || !model.trim()}>{ui('保存端点')}</Button></div>
          <Hint>{ui('只会发送到这个地址。需要 https（本机可以用 http）；地址里不要带用户名、密码或查询参数。')}</Hint>
          {settings.custom?.host && <Hint className="jev-provider__where">{uiFormat('当前发送到 {0}，模型 {1}。', [settings.custom.host, settings.custom.model])}</Hint>}
        </form>}
        <Hint>{ui('Jev 有多个服务商可以配置：TypeSafe 自己的接口；OpenCode Go（订阅，jev-1.13，接口地址和 Go 的模型列表没有核实是否包含 Jev，未验证）；OpenCode Zen（付费的 jev-1.13，以及限时免费的 jev-1.13-free）；也可以填一个自定义端点（接口地址、模型名、存放密钥的环境变量名），给提供同样接口的其他网关用。据报道 OpenRouter、AIML、Netlify AI Gateway 也提供 Jev，但它们的接口格式我们没有核实（未验证）。服务商和密钥来源由你选，我们不推荐其中某一家；免费模型 jev-1.13-free 是否保留提示词或用于训练，OpenCode 的文档没有说明。换服务商要重新确认下面的隐私说明；一个服务商的密钥不会发给另一个。')}</Hint>
      </div>
      <JevPrivacy confirmed={settings.confirmed} disabled={locked} onChange={onConfirm} privacyUrl={settings.privacyUrl} provider={provider} host={custom ? settings.custom?.host : ''} />
      <ProviderCard layout="stack" className="jev-card" data-key-source={source.state} set={!!settings.key.set} title={ui('Jev 密钥')}
        badges={<Badge size="sm">{ui('文字内容会上传')}</Badge>} status={source.text}>
        {source.note && <Hint className="jev-keysource__note">{source.note}</Hint>}
        {/* The page runs save, check and clear itself (it re-reads the settings and the usage after each), so the form only displays. */}
        <SecretKeyForm name="jev-key" label={ui('Jev 密钥')} saved={settings.key} busy={busy} working={working} result={result} resultText={resultText}
          placeholder={outside ? (custom ? ui('自定义端点的密钥（可选，也可以只用环境变量）') : ui('OpenCode 密钥（可选，也可以只用环境变量）')) : ui('粘贴 TypeSafe 控制台里的 Jev 密钥')}
          saveLabel={ui('保存 Jev 密钥')} verifyLabel={ui('验证 Jev 密钥')} verifyDisabled={step !== 'ready'} verifyAfterSave={false} envNote={false}
          onSave={onKey} onVerify={onVerify} onClear={onClearKey}
          footnote={<>
            {step === 'confirm' && <Hint>{ui('先确认上面的隐私说明，才能验证密钥或使用任何 Jev 功能。')}</Hint>}
            <Hint>{ui('验证只发一句不含你内容的话；密钥只保存在 DSH 主目录里，不进学习库、备份或快照。')}</Hint>
          </>} />
        {custom && keyEnvForm}
        {outside && !custom && <details className="jev-keyenv">
          <summary>{ui('更换环境变量名')}</summary>
          {keyEnvForm}
        </details>}
      </ProviderCard>
      <JevReplaceList settings={settings} disabled={busy} onToggle={onReplace} onGoto={onGoto} />
      <fieldset className="jev-switches" disabled={!ready || locked}>
        <legend>{ui('实验功能开关')}</legend>
        {!ready && <Hint>{ui('保存密钥并确认隐私说明之后才能打开。')}</Hint>}
        <Switch className="jev-switches__master" data-usage="settings.jev" label={ui('启用 Jev 实验功能（总开关）')} hint={ui('关掉它就停用下面所有功能，立即生效；各项开关的选择会保留。')}
          checked={!!settings.enabled} onChange={onEnabled} />
        <Hint className="jev-signals__note">{ui('下面这些只给出参考信号，不替换任何模型调用。')}</Hint>
        {JEV_FEATURE_META.map(feature => <Switch key={feature.id} data-feature={feature.id} label={feature.label()} hint={feature.hint()}
          checked={!!settings.features[feature.id]} onChange={checked => onFeature(feature.id, checked)} />)}
        <Field label={ui('自动填入所需的把握')} width="sm" hint={ui('Jev 的把握低于这条线时，建议只展示概率，留给你决定；替换模型调用时，低于这条线的判断改交给原来的模型。默认 80%。')}>
          <Select value={String(settings.threshold)} onChange={event => onThreshold(Number(event.target.value))}>
            {thresholdChoices(settings.threshold).map(choice => <option key={choice} value={String(choice)}>{percentText(choice)}</option>)}
          </Select>
        </Field>
      </fieldset>
      {settings.enabled && settings.features.levelCheck && ready && <details className="jev-dev"><summary>{ui('开发者面板：题目认知层次对照')}</summary><JevLevelCheck call={call} /></details>}
      {failure && <InlineMessage tone="warning" className="jev-failure">{uiMessage(failureCode(failure.reason, failure.provider))}</InlineMessage>}
      <JevUsageView usage={usage} />
      {error && <InlineMessage tone="error">{uiMessage(error)}</InlineMessage>}
    </>
  );
}

/** The settings section, connected. `initial` ({ settings, usage, failure }) skips the first read (previews, tests). */
export default function JevSettings({ call, busy = false, initial = null, initialResult = null }) {
  const toast = useToast();
  useInjectCss(css, 'study-jev');
  const section = useRef(null);
  const [settings, setSettings] = useState(initial?.settings ?? null), [usage, setUsage] = useState(initial?.usage ?? null), [failure, setFailure] = useState(initial?.failure ?? null);
  const [result, setResult] = useState(initialResult);
  const { run, working, error } = useAsyncAction({ exclusive: true });
  const refresh = useCallback(async () => {
    const page = await call('jev.usage', {});
    setSettings(page.settings); setUsage(page.usage); setFailure(page.failure);
  }, [call]);
  useEffect(() => {
    if (initial || typeof call !== 'function') return;
    void run('load', () => Promise.resolve(call('jev.usage', {})).then(page => { setSettings(page.settings); setUsage(page.usage); setFailure(page.failure); },
      () => { throw new Error(ui('读不到 Jev 设置。')); }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const change = (kind, patch, then) => run(kind, async () => { const next = await call('jev.settings.set', patch); setSettings(next); await then?.(next); await refresh(); });
  const verify = async () => { setResult(null); setResult(await call('jev.test', {})); await refresh(); };
  // A switch that turned out to be missing a step: scroll to and focus the control that completes it.
  const goto = step => {
    const root = section.current, target = root?.querySelector(step === 'confirm' ? '.jev-privacy .sh-check__input' : step === 'endpoint' ? 'input[name="jev-custom-endpoint"]' : 'input[name="jev-key"]');
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' }); target?.focus?.({ preventScroll: true });
  };
  return (
    <SettingsSection className="jev-settings" tour="settings-jev" data-experimental="true" ref={section}
      title={<>{ui('实验性 · Jev 判断服务')}<ExperimentalBadge /></>}
      lead={ui('Jev 是 TypeSafe AI 的「System One」模型：按服务商的说法又快又便宜（我们没有核实），擅长做选择题式的判断，比如一份资料属于哪门课、一道题有没有问题。默认全部关闭；它给出的只是参考信号，不会替你做决定，出错或不可用时一切照旧。它在本插件里始终只是实验功能，其他功能都不依赖它。')}>
      {!settings && !error && <Hint>{ui('正在读取 Jev 设置…')}</Hint>}
      {settings && <JevSettingsView call={call} settings={settings} usage={usage} failure={failure} busy={busy} working={working} result={result} error={error}
        onKey={key => change('save', { key }, async next => { setResult(null); if (next.confirmed) await verify(); })}
        onVerify={() => run('verify', verify)}
        onClearKey={() => change('clear', { key: '' }, async () => { setResult(null); })}
        onProvider={provider => change('provider', { provider }, async () => { setResult(null); })}
        onKeyEnv={keyEnv => change('keyEnv', { keyEnv }, async () => { setResult(null); })}
        onCustom={patch => change('custom', patch, async () => { setResult(null); })}
        onConfirm={checked => change('confirm', { confirm: checked }, async next => { toast.success(checked ? (providerOf(next) === 'typesafe' ? ui('已确认：Jev 功能会把所需内容发送到 TypeSafe 云端。') : providerOf(next) === 'custom' ? ui('已确认：Jev 功能会把所需内容发送到你填写的自定义端点。') : (providerOf(next) === 'opencode-go' ? ui('已确认：Jev 功能会把所需内容发送到 OpenCode Go 云端。') : ui('已确认：Jev 功能会把所需内容发送到 OpenCode Zen 云端。'))) : ui('已撤回确认；之后使用 Jev 前会再问一次。')); })}
        onEnabled={checked => change('enabled', { enabled: checked })}
        onFeature={(id, checked) => change('feature', { features: { [id]: checked } })}
        onReplace={(site, checked) => change('replace', { replace: { [site]: checked }, ...(checked && !settings.enabled ? { enabled: true } : {}) },
          async () => { if (checked && !settings.enabled) toast.success(ui('Jev 总开关也已一起打开。')); })}
        onGoto={goto}
        onThreshold={threshold => change('threshold', { threshold })} />}
      {settings?.settingsFile && <Hint>{uiFormat('密钥和开关保存在 {0}，不在学习库里，也不会出现在导出或备份中。', [settings.settingsFile])}</Hint>}
    </SettingsSection>
  );
}
