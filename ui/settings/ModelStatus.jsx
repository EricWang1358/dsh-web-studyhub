import React, { useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { Hint, InlineMessage } from '../components/index.js';
import ModelSetupGate from '../ModelSetupGate.jsx';
import { modelReadiness } from '../generation-status.js';

/**
 * Whether a model is connected, at the top of Settings › 学习库与模型, from the library's own answer (data.model: the route the generation would use and whether DSH
 * can run it, lib/host.js modelStatus). What it knows is said as far as it goes ("模型" is in the words: the top bar's 已连接 is about the library):
 *   ok        模型已连接：{label}: DSH has the route and its key; whether the key is valid only a real call shows
 *   unknown   已选择模型：{label}: this DSH cannot tell, so the model is not called connected
 *   otherwise the gate (feature "settings") with the reason and the exact steps. The key is DSH's: this page has no key field, and its button opens DSH's
 *   model panel only when the host offers one (host.openModelSettings); a link back to this page would do nothing.
 * `refresh` reads the library again (the state is also polled, so coming back from DSH updates it by itself); the button is there for the learner who wants to be sure.
 */
export default function ModelStatus({ data, host, refresh }) {
  const model = modelReadiness(data);
  const [checking, setChecking] = useState(false), [checked, setChecked] = useState(false);
  const live = useRef(true);
  useEffect(() => () => { live.current = false; }, []);
  const recheck = refresh && (async () => {
    setChecking(true);
    try { await refresh(); if (live.current) setChecked(true); } catch { if (live.current) setChecked(false); } finally { if (live.current) setChecking(false); }
  });
  if (model.ready && model.reason === 'ok')
    return <InlineMessage tone="success" boxed data-model-status="connected" title={model.label ? uiFormat('模型已连接：{0}', [model.label]) : ui('模型已连接')}>
      {ui('出题与讲解用的就是它；密钥是否有效，要到真正用的时候才会知道。')}</InlineMessage>;
  if (model.ready)
    return <InlineMessage tone="info" boxed data-model-status="unverified" title={model.label ? uiFormat('已选择模型：{0}', [model.label]) : ui('已选择模型')}>
      {ui('这个 DSH 没有告诉 StudyHub 密钥是否已配置，所以还不能确认可用；第一次用到时才会知道。')}</InlineMessage>;
  return (
    <ModelSetupGate variant="block" feature="settings" model={model} data-model-status="missing" onRecheck={recheck} checking={checking}
      onOpenSettings={host?.openModelSettings ? () => host.openModelSettings() : false}>
      {checked && !checking && <Hint role="status" className="model-status-note">{ui('已重新检查，目前还没有连上。')}</Hint>}
    </ModelSetupGate>
  );
}
