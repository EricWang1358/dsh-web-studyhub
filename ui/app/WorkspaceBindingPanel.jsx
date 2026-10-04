import React, { useContext, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Button } from '../components/index.js';
import LibraryUsage from '../LibraryUsage.jsx';
import ReasoningEffortField from '../ReasoningEffortField.jsx';
import { AppContext } from './app-context.js';

/* Which folder the library lives in and which model makes the questions: the panel on the empty start page and in Settings.
   The folder and model drafts (the typed-in alternatives to the picker) are its own; everything else is the app's binding.
   Settings and the start page render it themselves; outside the app (a preview, a pane under test) it draws nothing. */
export default function WorkspaceBindingPanel() {
  const app = useContext(AppContext);
  return app ? <Binding app={app} /> : null;
}

function Binding({ app }) {
  const { host, data, core, connection } = app;
  const { call, busy } = core;
  const { binding, setBinding, updateBinding } = connection;
  const [rootDraft, setRootDraft] = useState(null), [modelDraft, setModelDraft] = useState(null);
  const modelGroups = host.modelGroups || [];
  const followedModel = host.sessionModel || (binding.modelSource === 'session' ? binding.route : null);
  const modelName = (model) => {
    if (!model) return '';
    const group = modelGroups.find((item) => item.id === model.provider), entry = group?.models.find((item) => item.id === model.model);
    return `${group?.name || model.provider} · ${entry?.name || model.model}`;
  };
  const customModelKey = binding.modelSource === 'custom' ? JSON.stringify([binding.provider, binding.model]) : '';
  const customListed = modelGroups.some((group) => group.id === binding.provider && group.models.some((model) => model.id === binding.model));
  async function chooseRoot() {
    if (!host.pickDirectory) { setRootDraft(binding.root || ''); return; }
    try {
      const picked = await host.pickDirectory();
      if (picked) await updateBinding({ root: picked });
    } catch {
      setRootDraft(binding.root || '');
      core.notify(ui('无法打开目录选择器，请直接输入路径。'));
    }
  }
  const where = binding.rootSource === 'workspace' ? ui('当前工作区') : binding.rootSource === 'config' ? ui('插件配置指定') : ui('自定义目录');
  const modelNote = binding.modelSource === 'session'
    ? ui('与对话输入框选择的模型一致，切换后自动生效。生成时所选资料会发送给该模型；复习不调用模型。')
    : ui('只用于出题与讲解，不改变对话模型。生成时所选资料会发送给该模型；复习不调用模型。');
  return (
    <div className="binding-panel">
      <div className="binding-row">
        <div className="binding-main">
          <span className="binding-label">{ui('学习库')}</span>
          <code className="binding-value" title={binding.root}>{binding.root || '—'}</code>
          <small>{uiFormat('{0} · {1}', [where, ui('资料、题库与复习记录保存在这里')])}</small>
          <LibraryUsage root={binding.root} call={call} active={!!data} />
        </div>
        <div className="binding-actions">
          <Button onClick={chooseRoot} disabled={busy}>{ui('更换目录…')}</Button>
          {binding.rootSource === 'custom' && <Button disabled={busy} onClick={() => updateBinding({ root: '' })}>{ui('改回当前工作区')}</Button>}
        </div>
      </div>
      {rootDraft !== null && (
        <form className="binding-inline" onSubmit={async (event) => { event.preventDefault(); if (await updateBinding({ root: rootDraft })) setRootDraft(null); }}>
          <input autoFocus required aria-label={ui('学习库绝对路径')} value={rootDraft} onChange={(event) => setRootDraft(event.target.value)} />
          <Button type="submit" variant="primary" disabled={busy}>{ui('使用此目录')}</Button>
          <Button onClick={() => setRootDraft(null)}>{ui('取消')}</Button>
        </form>
      )}
      <div className="binding-row">
        <label className="binding-main">
          <span className="binding-label">{ui('生成模型')}</span>
          <select value={customModelKey} disabled={busy} onChange={(event) => {
            const value = event.target.value;
            if (value === 'manual') setModelDraft({ provider: binding.provider, model: binding.model });
            else if (!value) updateBinding({ provider: '', model: '' });
            else { const [provider, model] = JSON.parse(value); updateBinding({ provider, model }); }
          }}>
            <option value="">{followedModel ? uiFormat('跟随当前会话（{0}）', [modelName(followedModel)]) : ui('跟随当前会话')}</option>
            {modelGroups.map((group) => (
              <optgroup key={group.id} label={group.name || group.id}>
                {group.models.map((model) => <option key={model.id} value={JSON.stringify([group.id, model.id])}>{model.name || model.id}</option>)}
              </optgroup>
            ))}
            {customModelKey && !customListed && <option value={customModelKey}>{modelName(binding)}</option>}
            <option value="manual">{ui('手动填写…')}</option>
          </select>
          <small>{modelNote}</small>
        </label>
      </div>
      {modelDraft && (
        <form className="binding-inline" onSubmit={async (event) => { event.preventDefault(); if (await updateBinding(modelDraft)) setModelDraft(null); }}>
          <input autoFocus required aria-label="Provider" placeholder="Provider" value={modelDraft.provider}
            onChange={(event) => setModelDraft({ ...modelDraft, provider: event.target.value })} />
          <input required aria-label={ui('模型 ID')} placeholder={ui('模型 ID')} value={modelDraft.model}
            onChange={(event) => setModelDraft({ ...modelDraft, model: event.target.value })} />
          <Button type="submit" variant="primary" disabled={busy}>{ui('使用')}</Button>
          <Button onClick={() => setModelDraft(null)}>{ui('取消')}</Button>
        </form>
      )}
      <ReasoningEffortField binding={binding} busy={busy} refreshKey={JSON.stringify(followedModel || null)}
        onChange={(reasoningEffort) => updateBinding({ reasoningEffort })}
        onRefresh={() => call('binding.get').then(setBinding, () => {})} />
    </div>
  );
}
