import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Field, Hint, Icon, InlineMessage, ProviderCard, Select, TextInput } from '../components/index.js';

const EFFORT_OPTIONS = Object.freeze([
  { value: '', label: 'CLI 默认' },
  { value: 'low', label: '低（更快）' },
  { value: 'medium', label: '中（均衡）' },
  { value: 'high', label: '高（更深入）' },
]);

const STATUS_BADGE = Object.freeze({
  ready: { tone: 'success', text: '本机已就绪' },
  unauthenticated: { tone: 'warning', text: '未登录' },
  'broken-shim': { tone: 'warning', text: '路径异常' },
  'not-installed': { tone: 'neutral', text: '未安装' },
  'coming-soon': { tone: 'info', text: '即将支持' },
});

function badgeInfo(status) {
  return STATUS_BADGE[status] || STATUS_BADGE['not-installed'];
}

function modelOptionsFor(provider, currentModel) {
  const listed = Array.isArray(provider?.models) ? provider.models : [];
  if (!listed.length) return null;
  const hasCurrent = !currentModel || listed.some((item) => item.id === currentModel);
  return [
    { value: '', label: ui('使用 CLI 默认模型') },
    ...listed.map((item) => ({ value: item.id, label: item.name || item.id })),
    ...(hasCurrent ? [] : [{ value: currentModel, label: currentModel }]),
  ];
}

const REASON_TEMPLATES = Object.freeze({
  'not-installed': '未检测到本机安装',
  'not-installed-coming-soon': '尚未安装（即将支持）',
  'coming-soon-detected': '已检测到 {0}，即将支持',
  'coming-soon': '即将支持',
  'broken-shim': '启动脚本指向的目标文件不存在：{0}',
  'broken-shim-coming-soon': '启动脚本指向的目标文件不存在：{0}（即将支持）',
  unauthenticated: '本机已安装，但尚未登录',
});

function reasonDetailOf(provider) {
  const params = provider?.reasonParams || {};
  return params.detail || params.version || params.target || provider?.version || '';
}

function providerReasonText(provider) {
  const raw = provider?.reason ? ui(provider.reason) : '';
  const template = REASON_TEMPLATES[provider?.reasonCode];
  if (!template) return raw;
  if (!template.includes('{0}')) return raw || ui(template);
  const detail = reasonDetailOf(provider);
  return detail ? uiFormat(template, [detail]) : raw;
}

function ProviderStatusRow({ provider }) {
  const badge = badgeInfo(provider.status);
  const reasonText = providerReasonText(provider);
  return (
    <div className="desktop-cli__row" data-desktop-provider={provider.id} data-status={provider.status}>
      <div className="desktop-cli__meta">
        <span className="desktop-cli__name">{provider.name || provider.id}</span>
        <Badge size="sm" tone={badge.tone}>{ui(badge.text)}</Badge>
        {provider.version && <span className="desktop-cli__reason">{provider.version}</span>}
      </div>
      {reasonText && <span className="desktop-cli__reason">{reasonText}</span>}
    </div>
  );
}

function CliControls({ provider, draft, setDraft, locked }) {
  const options = modelOptionsFor(provider, draft.model);
  return (
    <div className="desktop-cli__grid">
      <Field label={ui('模型（可选）')} width="full" hint={ui('留空时使用本机 agy 的默认模型。')}>
        {options ? (
          <Select value={draft.model} disabled={locked} options={options} onChange={(value) => setDraft({ ...draft, model: value })} />
        ) : (
          <TextInput value={draft.model} disabled={locked} spellCheck={false} placeholder={ui('留空使用默认模型')}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
        )}
      </Field>
      <Field label={ui('推理强度（可选）')} width="full">
        <Select value={draft.effort} disabled={locked}
          options={EFFORT_OPTIONS.map((item) => ({ value: item.value, label: ui(item.label) }))}
          onChange={(value) => setDraft({ ...draft, effort: value })} />
      </Field>
    </div>
  );
}

function CliTestResult({ result }) {
  if (!result) return null;
  const text = result.ok
    ? uiFormat('连通成功（{0} ms）：{1}', [Math.round(result.latencyMs || 0), result.message || 'OK'])
    : uiFormat('测试失败：{0}', [result.message || ui('没有返回原因')]);
  return <InlineMessage tone={result.ok ? 'success' : 'error'}>{text}</InlineMessage>;
}

function CliActionBar({ active, dirty, working, onActivate, onTest, onScan }) {
  const locked = Boolean(working);
  const activateLabel = !active
    ? ui('一键启用本机 agy')
    : dirty ? ui('保存 agy 设置') : ui('已启用本机 agy');
  return (
    <div className="desktop-model__actions">
      <Button variant={active && !dirty ? 'secondary' : 'primary'} busy={working === 'save-agy'} lock={locked && working !== 'save-agy'} onClick={onActivate}>
        {activateLabel}
      </Button>
      <Button variant="secondary" busy={working === 'test-agy'} lock={locked && working !== 'test-agy'} onClick={onTest}>
        {ui('测试连通')}
      </Button>
      <Button variant="quiet" busy={working === 'scan'} lock={locked && working !== 'scan'} onClick={onScan}>
        {ui('重新扫描')}
      </Button>
    </div>
  );
}

function ReadyCliBadges({ provider, active }) {
  return (
    <>
      <Badge size="sm" tone="success">{ui('本机已就绪')}</Badge>
      {provider.version && <Badge size="sm" tone="neutral">{provider.version}</Badge>}
      {active && <Badge size="sm" tone="info">{ui('当前已启用')}</Badge>}
    </>
  );
}

function cliDraftState(provider, agy, draft) {
  const savedModel = agy?.model || '';
  const savedEffort = agy?.effort || '';
  const dirty = draft.model !== savedModel || draft.effort !== savedEffort;
  const payload = {
    executablePath: provider.executablePath || agy?.executablePath || '',
    model: draft.model.trim(),
    effort: draft.effort,
  };
  return { dirty, payload };
}

function ReadyCliFooter({ compact, otherProviders }) {
  if (compact) return null;
  return (
    <>
      <Hint className="desktop-model__note">
        {ui('本机 CLI 模式为保护本机资源与限额，出题并发默认 1（最高 2）；大批量高频出题也可在下方切换为 API Key 模式。')}
      </Hint>
      {otherProviders.map((item) => <ProviderStatusRow key={item.id} provider={item} />)}
    </>
  );
}

function ReadyCliCard({ provider, otherProviders, active, agy, actions, working, compact }) {
  const [draft, setDraft] = useState(() => ({ model: agy?.model || '', effort: agy?.effort || '' }));
  const [testResult, setTestResult] = useState(null);
  const { dirty, payload } = cliDraftState(provider, agy, draft);
  const status = active
    ? ui('当前通过本机 agy 执行 AI 任务（无需填写 API Key）')
    : ui('检测到本机已安装并登录 agy，可一键启用');

  const activate = async () => {
    setTestResult(null);
    await actions.saveAgy(payload);
  };
  const testCli = async () => {
    setTestResult(null);
    const result = await actions.testAgy(payload);
    if (result) setTestResult(result);
  };

  return (
    <ProviderCard layout="stack" data-desktop-cli-card="ready"
      title={uiFormat('本机 CLI：{0}', [provider.name || 'agy'])}
      badges={<ReadyCliBadges provider={provider} active={active} />}
      status={status} set={active}>
      {!compact && <CliControls provider={provider} draft={draft} setDraft={setDraft} locked={Boolean(working)} />}
      <CliActionBar active={active} dirty={dirty} working={working} onActivate={activate} onTest={testCli} onScan={actions.scan} />
      <CliTestResult result={testResult} />
      <ReadyCliFooter compact={compact} otherProviders={otherProviders} />
    </ProviderCard>
  );
}

function QuietCliStrip({ providers, onScan, working }) {
  const [open, setOpen] = useState(false);
  const locked = Boolean(working);
  return (
    <details className="desktop-cli-strip" data-desktop-cli-card="quiet" open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="desktop-cli-strip__summary">
        <Icon className={open ? 'desktop-cli-strip__chevron is-open' : 'desktop-cli-strip__chevron'} name="chevron" size={14} />
        <span>{ui('本机 CLI（agy / claude / codex）：暂未检测到可直接使用的本机 CLI')}</span>
        <span className="desktop-cli-strip__toggle">{open ? ui('收起') : ui('查看状态')}</span>
      </summary>
      <div className="desktop-cli-strip__body">
        {providers.map((item) => <ProviderStatusRow key={item.id} provider={item} />)}
        <div className="desktop-model__actions">
          <Button size="sm" variant="secondary" busy={working === 'scan'} lock={locked && working !== 'scan'} onClick={onScan}>
            {ui('重新扫描本机 CLI')}
          </Button>
        </div>
      </div>
    </details>
  );
}

/** Local CLI section: primary card at top when a ready supported CLI exists, quiet collapsible strip otherwise. */
export default function DesktopCliCard({ providers = [], mode, agy, actions, working, compact = false }) {
  const ready = providers.find((item) => item.supported && item.status === 'ready');
  if (ready) {
    const others = providers.filter((item) => item.id !== ready.id);
    return <ReadyCliCard provider={ready} otherProviders={others} active={mode === 'agy'} agy={agy} actions={actions} working={working} compact={compact} />;
  }
  return <QuietCliStrip providers={providers} onScan={actions.scan} working={working} />;
}
