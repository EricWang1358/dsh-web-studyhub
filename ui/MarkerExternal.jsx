import React, { useEffect, useRef, useState } from 'react';
import { ui } from './i18n.js';
import { Button, Disclosure } from './components/index.js';
import { detectConvertedFormat } from '../lib/converted-document.js';
import { MAX_TEXT_DOCUMENT_BYTES } from '../lib/office/limits.js';
import { createMarkerConversionScript, MARKER_SCRIPT_FILENAME } from '../lib/marker-external.js';
import { useInjectCss } from './shared.js';
import css from './import-hub.css';

/** Validate before the shared import queue so Marker JSON cannot become a deck. */
export async function validateMarkerOutput(file) {
  if (!/\.(?:md|markdown)$/i.test(file?.name || '')) throw new Error(ui('请选择 Marker 转换后的 .md 或 .markdown 文件，不是原 PDF 或 JSON。'));
  if (file.size > MAX_TEXT_DOCUMENT_BYTES) throw new Error(ui('文件超过 8 MB。请按章节拆分后再导入。'));
  const text = (await file.text()).replace(/\r\n?/g, '\n');
  if (detectConvertedFormat(text) !== 'marker-paginated') throw new Error(ui('没有找到 Marker 分页标记。请用下载的脚本重新转换，或运行 Marker 时加上 --paginate_output。'));
  return file;
}

export function downloadMarkerScript() {
  const url = URL.createObjectURL(new Blob([createMarkerConversionScript()], { type: 'text/x-python;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = MARKER_SCRIPT_FILENAME;
  try { link.click(); } finally { setTimeout(() => URL.revokeObjectURL(url), 1000); }
}

export default function MarkerExternal({ disabled = false, onFiles, settings = false, onOpenSettings }) {
  useInjectCss(css, 'study-import-hub');
  const picker = useRef(null), reading = useRef(false), latestDisabled = useRef(disabled), latestOnFiles = useRef(onFiles), alive = useRef(true);
  latestDisabled.current = disabled; latestOnFiles.current = onFiles;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const [checking, setChecking] = useState(false), [error, setError] = useState('');
  const blocked = disabled || checking;
  async function selected(event) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || !alive.current || latestDisabled.current || reading.current) return;
    reading.current = true; setChecking(true); setError('');
    try {
      await validateMarkerOutput(file);
      if (!alive.current) return;
      if (latestDisabled.current) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
      await latestOnFiles.current?.([file]);
    }
    catch (failure) { if (alive.current) setError(failure.message || ui('导入失败，请重试。')); }
    finally { reading.current = false; if (alive.current) setChecking(false); }
  }
  function download() {
    if (blocked) return;
    setError('');
    try { downloadMarkerScript(); }
    catch { setError(ui('脚本下载失败，请重试，或按官方指南手动运行 Marker。')); }
  }
  if (!settings) return <section className="import-hub__converter" aria-label="Marker">
    <h3>Marker</h3>
    <p>{ui('在本机外部转换，再导入分页 Markdown。')}</p>
    <div className="import-hub__converter-actions">
      <Button size="sm" disabled={blocked} onClick={() => { if (!blocked) picker.current?.click(); }}>{ui('选择转换结果')}</Button>
      {onOpenSettings && <Button variant="link" size="sm" disabled={blocked} onClick={() => onOpenSettings('settings-marker')}>{ui('安装与使用设置')}</Button>}
    </div>
    <input ref={picker} type="file" accept=".md,.markdown" aria-label={ui('选择 Marker 转换后的文件')} disabled={blocked} hidden onChange={selected} />
    {error && <p role="alert" className="warning">{error}</p>}
  </section>;
  return <Disclosure summary={ui('安装与使用说明')} open>
    <div className="import-hub__marker">
      <p>{ui('在自己电脑上安装并运行 Marker，再选择转换结果。StudyHub 只提供脚本与结果导入，不会安装或启动 Marker。')}</p>
      <ol>
        <li>{ui('按官方指南准备 Python 环境并安装 marker-pdf。建议使用独立虚拟环境，核对当前版本的系统与硬件要求。')}{' '}
          <a href="https://github.com/datalab-to/marker#installation" target="_blank" rel="noreferrer">{ui('Marker 安装指南')}</a></li>
        <li>{ui('一键下载转换脚本，保存后在该 Python 环境中运行以下命令，按提示选择本地 PDF。')}
          <pre><code>python studyhub-marker-convert.py</code></pre></li>
        <li>{ui('转换完成后，回到「添加资料 → 文件」，在 Marker 方案中选择转换结果。')}</li>
      </ol>
      <p className="muted small">{ui('首次运行可能下载模型，需要网络、磁盘空间与等待时间。脚本只调用本地转换，不启用 LLM 增强，也不读取 StudyHub 的模型配置。')}</p>
      <p className="muted small">{ui('Marker 2 的 OCR 后端还需按官方指南准备 Docker / NVIDIA 或 llama-server 等依赖；只安装 Python 包可能不足以运行。若已有远程推理配置，请先检查，转换工具可能将资料发送到该服务。')}</p>
      <p className="muted small">
        <a href="https://github.com/datalab-to/marker#commercial-usage" target="_blank" rel="noreferrer">{ui('查看代码与模型许可')}</a></p>
      <p className="muted small">{ui('与 MinerU 的效果因资料而异；本地转换耗时和内存取决于设备。导入后请核对公式、表格、阅读顺序与页码，图片文件不会随 Markdown 自动导入。')}</p>
      <div className="import-hub__marker-actions">
        <Button size="sm" disabled={blocked} onClick={download}>{ui('下载 Marker 转换脚本')}</Button>
      </div>
      {error && <p role="alert" className="warning">{error}</p>}
    </div>
  </Disclosure>;
}
