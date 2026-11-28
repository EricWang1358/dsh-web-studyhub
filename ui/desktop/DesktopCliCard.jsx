import React, { useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Badge, Button, Field, Hint, Icon, InlineMessage, ProviderCard, SegmentedControl, Select, TextArea, TextInput } from '../components/index.js';

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
  'coming-soon': { tone: 'neutral', text: '暂不支持' },
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
  'coming-soon-not-installed': '尚未安装（按服务条款暂不支持复用消费者订阅登录）',
  'not-installed-coming-soon': '尚未安装（按服务条款暂不支持复用消费者订阅登录）',
  'coming-soon-detected': '已检测到 {0}（按服务条款暂不支持复用消费者订阅登录）',
  'coming-soon': '按服务条款暂不支持复用消费者订阅登录',
  'broken-shim': '启动脚本指向的目标文件不存在：{0}',
  'broken-shim-coming-soon': '启动脚本指向的目标文件不存在：{0}（暂不支持）',
  unauthenticated: '本机已安装，但尚未登录',
});

function formatVersionDetail(version) {
  const text = String(version || '').trim();
  if (!text) return '';
  return text.startsWith('v') ? text : `v${text}`;
}

function reasonDetailOf(provider) {
  const params = provider?.reasonParams || {};
  return params.detail || formatVersionDetail(params.version || provider?.version) || params.target || '';
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
      <Field label={ui('模型（可选）')} width="full" hint={uiFormat('留空时使用本机 {0} 的默认模型。', [provider.id])}>
        {options ? (
          <Select value={draft.model} disabled={locked} options={options} onChange={(value) => setDraft({ ...draft, model: value })} />
        ) : (
          <TextInput value={draft.model} disabled={locked} spellCheck={false} placeholder={ui('留空使用默认模型')}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })} />
        )}
      </Field>
      <Field label={ui('推理强度（可选）')} width="full"
        hint={ui('档位越高思考越深，速度越慢、耗额度也越多；日常用 CLI 默认即可。')}>
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

function CliActionBar({ providerId, active, dirty, working, onActivate, onTest, onRescan }) {
  const locked = Boolean(working);
  const saveTag = `save-${providerId}`;
  const testTag = `test-${providerId}`;
  const activateLabel = !active
    ? uiFormat('一键启用本机 {0}', [providerId])
    : dirty ? uiFormat('保存 {0} 设置', [providerId]) : uiFormat('已启用本机 {0}', [providerId]);
  return (
    <div className="desktop-model__actions">
      <Button variant={active && !dirty ? 'secondary' : 'primary'} busy={working === saveTag}
        disabled={active && !dirty}
        lock={locked && working !== saveTag} onClick={onActivate}>
        {activateLabel}
      </Button>
      <Button variant="secondary" busy={working === testTag} lock={locked && working !== testTag} onClick={onTest}>
        {ui('测试连通')}
      </Button>
      <Button variant="quiet" busy={working === 'scan'} lock={locked && working !== 'scan'} onClick={onRescan}>
        {ui('重新扫描')}
      </Button>
    </div>
  );
}

/** What the card keeps of an open: the backend's answer (with the opening note) as it came, { ok: true } when the action only says it worked, null on a refusal. */
export async function cliOpenResult(openCli, providerId) {
  const result = await openCli(providerId);
  if (!result) return null;
  return typeof result === 'object' ? result : { ok: true };
}

/* 「在学习库里打开 CLI」: the desktop edition has no main chat, so the local CLI in a command-line window of its own is the chat beside StudyHub.
   Settings only (the first-run and gate cards stay short). The page sends the CLI's name; the program and the folder are the backend's to decide. */
function CliChatRow({ provider, working, openCli }) {
  const [opened, setOpened] = useState(null);
  const tag = `open-${provider.id}`;
  const open = async () => {
    setOpened(null);
    setOpened(await cliOpenResult(openCli, provider.id));
  };
  return (
    <div className="desktop-cli__chat" data-desktop-cli-open={provider.id}>
      <div className="desktop-model__actions">
        <Button variant="secondary" icon="external" busy={working === tag} lock={Boolean(working) && working !== tag} onClick={open}>
          {uiFormat('在学习库里打开 {0}', [provider.id])}
        </Button>
      </div>
      <Hint>
        {ui('另开一个命令行窗口和它对话，可以和 StudyHub 左右并排（Win + ← / →）。打开时会复制一段开场提示：粘贴进新窗口，它就会用 StudyHub 自带的 study-cli 读写学习库。它也能直接改学习库里的文件，那些改动不经过 StudyHub 的检查。')}
      </Hint>
      <CliOpenedNote providerId={provider.id} result={opened} />
    </div>
  );
}

/** What 「在学习库里打开 CLI」 did: the window is open, and the opening note is on the clipboard, or shown here to select when the clipboard refused. */
export function CliOpenedNote({ providerId, result }) {
  if (!result) return null;
  if (!result.opening) return <InlineMessage tone="success">{uiFormat('已在学习库目录打开 {0}，在新窗口里和它对话。', [providerId])}</InlineMessage>;
  if (result.copied) {
    return (
      <InlineMessage tone="success">
        {uiFormat('已在学习库目录打开 {0}；开场提示已复制：先在新窗口里粘贴（右键或 Ctrl + V）并回车，{0} 就知道用 study-cli 读写学习库。', [providerId])}
      </InlineMessage>
    );
  }
  return (
    <div className="desktop-cli__opening" data-desktop-cli-opening="">
      <InlineMessage tone="success">
        {uiFormat('已在学习库目录打开 {0}，但没能复制开场提示：把下面这段复制下来，粘贴进新窗口并回车，{0} 就知道用 study-cli 读写学习库。', [providerId])}
      </InlineMessage>
      <TextArea readOnly rows={6} value={result.opening} aria-label={ui('开场提示')}
        onFocus={(event) => event.currentTarget.select()} />
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

function ReadyCliSelector({ readyProviders, selectedId, mode, onSelect, locked }) {
  if (readyProviders.length <= 1) return null;
  const options = readyProviders.map((item) => ({
    value: item.id,
    label: item.id === mode ? uiFormat('{0}（当前）', [item.name || item.id]) : (item.name || item.id),
  }));
  return (
    <div className="desktop-cli__switcher" data-desktop-cli-switcher="">
      <SegmentedControl label={ui('选择本机 CLI 引擎')} size="sm" wrap
        value={selectedId} disabled={locked} options={options} onChange={onSelect} />
    </div>
  );
}

function cliConfigMap({ agy, codex }) {
  return { agy: agy || {}, codex: codex || {} };
}

function initialDrafts(configs) {
  return Object.fromEntries(
    Object.entries(configs).map(([id, cfg]) => [id, { model: cfg?.model || '', effort: cfg?.effort || '' }]),
  );
}

function pickSelectedProvider(readyProviders, selectedId, mode) {
  return readyProviders.find((item) => item.id === selectedId)
    || readyProviders.find((item) => item.id === mode)
    || readyProviders[0];
}

function cliDraftState(provider, savedConfig, draft) {
  const savedModel = savedConfig?.model || '';
  const savedEffort = savedConfig?.effort || '';
  const dirty = draft.model !== savedModel || draft.effort !== savedEffort;
  const payload = {
    executablePath: provider.executablePath || savedConfig?.executablePath || '',
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

function ReadyCliCard({ readyProviders, otherProviders, mode, configs, actions, working, compact }) {
  const [selectedId, setSelectedId] = useState(() => pickSelectedProvider(readyProviders, mode, mode).id);
  const [drafts, setDrafts] = useState(() => initialDrafts(configs));
  const [testResults, setTestResults] = useState({});

  const selected = pickSelectedProvider(readyProviders, selectedId, mode);
  const saved = configs[selected.id] || {};
  const draft = drafts[selected.id] || { model: saved.model || '', effort: saved.effort || '' };
  const setDraft = (next) => setDrafts((prev) => ({ ...prev, [selected.id]: next }));
  const active = mode === selected.id;
  const { dirty, payload } = cliDraftState(selected, saved, draft);
  const title = readyProviders.length > 1
    ? ui('本机 CLI 引擎')
    : uiFormat('本机 CLI：{0}', [selected.name || selected.id]);
  const status = active
    ? uiFormat('当前通过本机 {0} 执行 AI 任务（无需填写 API Key）', [selected.id])
    : uiFormat('检测到本机已安装并登录 {0}，可一键启用', [selected.id]);

  const activate = async () => {
    setTestResults((prev) => ({ ...prev, [selected.id]: null }));
    const updated = await actions.saveCli(selected.id, payload);
    if (updated) setDraft({ model: payload.model, effort: payload.effort });
  };
  const testCli = async () => {
    setTestResults((prev) => ({ ...prev, [selected.id]: null }));
    const result = await actions.testCli(selected.id, payload);
    if (result) setTestResults((prev) => ({ ...prev, [selected.id]: result }));
  };

  return (
    <ProviderCard layout="stack" data-desktop-cli-card="ready" data-desktop-cli-selected={selected.id}
      title={title} badges={<ReadyCliBadges provider={selected} active={active} />} status={status} set={active}>
      <ReadyCliSelector readyProviders={readyProviders} selectedId={selected.id} mode={mode}
        onSelect={setSelectedId} locked={Boolean(working)} />
      {!compact && <CliControls provider={selected} draft={draft} setDraft={setDraft} locked={Boolean(working)} />}
      <CliActionBar providerId={selected.id} active={active} dirty={dirty} working={working}
        onActivate={activate} onTest={testCli} onRescan={actions.scan} />
      <CliTestResult result={testResults[selected.id]} />
      {!compact && <CliChatRow key={selected.id} provider={selected} working={working} openCli={actions.openCli} />}
      <ReadyCliFooter compact={compact} otherProviders={otherProviders} />
    </ProviderCard>
  );
}

function QuietCliStrip({ providers, onRescan, working }) {
  const [open, setOpen] = useState(false);
  const locked = Boolean(working);
  return (
    <details className="desktop-cli-strip" data-desktop-cli-card="quiet" open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="desktop-cli-strip__summary">
        <Icon className={open ? 'desktop-cli-strip__chevron is-open' : 'desktop-cli-strip__chevron'} name="chevron" size={14} />
        <span>{ui('本机 CLI（agy / codex）：暂未检测到可直接使用的本机 CLI')}</span>
        <span className="desktop-cli-strip__toggle">{open ? ui('收起') : ui('查看状态')}</span>
      </summary>
      <div className="desktop-cli-strip__body">
        {providers.map((item) => <ProviderStatusRow key={item.id} provider={item} />)}
        <div className="desktop-model__actions">
          <Button size="sm" variant="secondary" busy={working === 'scan'} lock={locked && working !== 'scan'} onClick={onRescan}>
            {ui('重新扫描本机 CLI')}
          </Button>
        </div>
      </div>
    </details>
  );
}

/** Local CLI section: primary card at top when 1+ ready supported CLIs exist, quiet collapsible strip otherwise. */
export default function DesktopCliCard({ providers = [], mode, agy, codex, actions, working, compact = false }) {
  const readyProviders = providers.filter((item) => item.supported && item.status === 'ready');
  if (readyProviders.length > 0) {
    const readyIds = new Set(readyProviders.map((item) => item.id));
    const others = providers.filter((item) => !readyIds.has(item.id));
    return (
      <ReadyCliCard readyProviders={readyProviders} otherProviders={others} mode={mode}
        configs={cliConfigMap({ agy, codex })} actions={actions} working={working} compact={compact} />
    );
  }
  return <QuietCliStrip providers={providers} onRescan={actions.scan} working={working} />;
}
