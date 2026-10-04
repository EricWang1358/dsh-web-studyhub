import React, { useEffect, useRef, useState } from 'react';
import { ui, uiMessage } from './i18n.js';
import { downloadMarkerScript } from './marker-script.js';
import { Button, Disclosure, Field, Hint, Icon, InlineMessage, TextInput } from './components/index.js';
import MarkerInstall from './MarkerInstall.jsx';
import { useInjectCss } from './shared.js';
import css from './marker-install.css';

export default function MarkerSettings({ call, disabled = false, available = true }) {
  const alive = useRef(true), revision = useRef(0), saving = useRef(false);
  useInjectCss(css, 'study-marker-install');
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [command, setCommand] = useState(''), [status, setStatus] = useState(null), [working, setWorking] = useState(false), [error, setError] = useState('');
  const [loading, setLoading] = useState(available && !!call);
  useEffect(() => {
    if (!available || !call) { setLoading(false); return undefined; }
    let live = true;
    const generation = ++revision.current;
    setLoading(true);
    Promise.resolve(call('marker.settings.get', {})).then(settings => {
      if (live) setCommand(settings.command || '');
    }, failure => { if (live) setError(uiMessage(String(failure.message || failure))); })
      .finally(() => { if (live) setLoading(false); });
    Promise.resolve(call('marker.local.status', {})).then(result => {
      if (live && revision.current === generation) setStatus(result);
    }, failure => { if (live && revision.current === generation) setError(uiMessage(String(failure.message || failure))); });
    return () => { live = false; };
  }, [call, available]);
  async function save() {
    if (!available || !call || loading || saving.current) return;
    saving.current = true;
    const generation = ++revision.current;
    setWorking(true); setStatus(null); setError('');
    try {
      await call('marker.settings.set', { command: command.trim() });
      const result = await call('marker.local.status', {});
      if (alive.current && revision.current === generation) setStatus(result);
    } catch (failure) { if (alive.current) setError(uiMessage(String(failure.message || failure))); }
    finally { saving.current = false; if (alive.current) setWorking(false); }
  }
  // After an install, a cancel or an uninstall the path and the state are read again: the installer wrote the path itself.
  async function reload() {
    if (!available || !call) return;
    const generation = ++revision.current;
    try {
      const [settings, result] = await Promise.all([call('marker.settings.get', {}), call('marker.local.status', {})]);
      if (alive.current && revision.current === generation) { setCommand(settings.command || ''); setStatus(result); setError(''); }
    } catch (failure) { if (alive.current) setError(uiMessage(String(failure.message || failure))); }
  }
  return <div className="marker-settings">
    <p>{ui('选好 PDF 后，StudyHub 会调用本机 Marker，显示进度并自动导入结果。')}</p>
    {!available && <InlineMessage tone="info">{ui('此安装未启用 PDF 解析组件。启用 StudyHub 的音频组件后可在应用内解析；也可用下面的脚本手动转换。')}</InlineMessage>}
    {available && call && <MarkerInstall call={call} disabled={disabled} markerReady={status?.state === 'ready'} onChanged={reload} />}
    <div className="marker-settings__manual">
    <h4>{ui('已经有 Marker？手动指定程序路径')}</h4>
    <Field label={ui('Marker 程序路径')} hint={ui('留空会自动查找 marker_single。也可以填写虚拟环境中该程序的完整路径。')}>
      <TextInput value={command} placeholder="marker_single" disabled={disabled || working || loading || !available} onChange={event => { ++revision.current; setStatus(null); setError(''); setCommand(event.target.value); }} />
    </Field>
    <Button disabled={disabled || !call || loading || !available} busy={working} onClick={save}>{ui('保存并检测')}</Button>
    <Hint>{ui('程序运行在 StudyHub 服务所在的电脑上。检测只确认命令可用；模型和 OCR 后端会在实际解析时检查。')}</Hint>
    {status && <p role="status" className="marker-settings__status" data-ready={status.state === 'ready'}><Icon name={status.state === 'ready' ? 'success' : 'info'} size={16} />{status.state === 'ready' ? ui('Marker 已就绪') : ui('Marker 尚未就绪')}{status.message ? ` · ${uiMessage(status.message)}` : ''}</p>}
    {error && <InlineMessage tone="error">{error}</InlineMessage>}
    </div>
    <Disclosure summary={ui('安装与使用说明')}>
      <p>{ui('按官方指南准备 Python 环境并安装 marker-pdf。建议使用独立虚拟环境，核对当前版本的系统与硬件要求。')}{' '}<a className="marker-link" href="https://github.com/datalab-to/marker#installation" target="_blank" rel="noreferrer">{ui('Marker 安装指南')}</a></p>
      <p>{ui('首次运行可能下载模型，需要网络、磁盘空间与等待时间。转换不启用 LLM 增强，也不读取 StudyHub 的模型配置。')}</p>
      <p>{ui('Marker 2 的 OCR 后端还需按官方指南准备 Docker / NVIDIA 或 llama-server 等依赖；只安装 Python 包可能不足以运行。若已有远程推理配置，请先检查，转换工具可能将资料发送到该服务。')}</p>
      <p><a className="marker-link" href="https://github.com/datalab-to/marker#commercial-usage" target="_blank" rel="noreferrer">{ui('查看代码与模型许可')}</a></p>
      <Button size="sm" disabled={disabled} onClick={() => { try { downloadMarkerScript(); } catch { setError(ui('脚本下载失败，请重试，或按官方指南手动运行 Marker。')); } }}>{ui('下载 Marker 转换脚本')}</Button>
      <Hint>{ui('需要手动转换时可用这个脚本。完成后把分页 Markdown 拖进「添加资料」。')}</Hint>
    </Disclosure>
  </div>;
}
