import React, { useEffect, useId, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, InlineMessage } from './components/index.js';
import { DetectionLine, ToolGroup, providerLabel } from './LargeDocumentCard.jsx';
import css from './large-documents.css';

export { providerLabel };

/* 设置 › 扩展：文档转换与检索 (WP28). What DSH exposes that StudyHub can use for
   search, the choice of one tool, a harmless test, and the same recommendations
   the "大教材建议" card gives. Nothing is said to be installed unless the host
   detected it (retrieval.status). */

const NOTHING = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [] };
const stripTool = value => String(value ?? '').replace(/^mcp:/, '');

/** Props: call(action, args), initialStatus (skips the first read; tests and previews), setNotice. */
export default function ExtensionsSettings({ call, initialStatus = null, setNotice, onStatus }) {
  useInjectCss(css, 'study-large-documents');
  const [status, setStatus] = useState(initialStatus);
  const [working, setWorking] = useState(false), [probe, setProbe] = useState(null), [error, setError] = useState('');
  const selectId = useId();
  useEffect(() => {
    if (initialStatus || typeof call !== 'function') { if (!initialStatus) setStatus(NOTHING); return undefined; }
    let live = true;
    Promise.resolve(call('retrieval.status', {})).then(value => { if (live) setStatus(value || NOTHING); }, () => { if (live) setStatus(NOTHING); });
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const current = status || NOTHING;
  const choose = async provider => {
    setWorking(true); setError(''); setProbe(null);
    try {
      const next = await call('retrieval.set', { provider });
      setStatus(next); onStatus?.(next);
      setNotice?.({ text: provider === 'builtin' ? ui('已改为不使用检索。') : ui('已选择检索工具。出题时，超过 15 万字的选择会先用它挑出相关页面。'), tone: 'success' });
    } catch (failure) { setError(failure?.message || String(failure)); }
    finally { setWorking(false); }
  };
  const test = async () => {
    setWorking(true); setError(''); setProbe(null);
    try { setProbe(await call('retrieval.test', {})); }
    catch (failure) { setError(failure?.message || String(failure)); }
    finally { setWorking(false); }
  };
  const mcpOthers = current.otherTools || [];
  const canChoose = current.providers.length > 0 || mcpOthers.length > 0;
  return (
    <fieldset className="settings-section extensions-settings" data-tour="settings-extensions">
      <legend className="settings-section__title">{ui('扩展：文档转换与检索')}</legend>
      <p className="settings-section__lead">{ui('大教材（上百页的 PDF）建议先用转换工具变成带页码的文字，再导入；整本书出题时，可以让 DSH 里的检索工具只挑出相关页面。StudyHub 只提供接口，工具由你自己安装。')}</p>
      <DetectionLine retrieval={current} />
      {current.missing && <InlineMessage tone="warning" boxed title={uiFormat('之前选择的检索工具「{0}」现在找不到', [stripTool(current.missing)])}>
        {ui('已暂时改为不使用检索。请确认它在 DSH 里已启用，或在下面重新选择。')}
      </InlineMessage>}
      {canChoose && <div className="extensions-settings__choice">
        <label htmlFor={selectId}>{ui('用哪个工具检索')}
          <select id={selectId} value={current.effective} disabled={working} onChange={event => choose(event.target.value)}>
            <option value="builtin">{ui('不使用检索（把选中的资料全部交给 AI）')}</option>
            {current.providers.map(provider => <option key={provider.id} value={provider.id}>{providerLabel(provider)}</option>)}
            {mcpOthers.length > 0 && <optgroup label={ui('其他 MCP 工具')}>
              {mcpOthers.map(tool => <option key={tool.name} value={`mcp:${tool.name}`}>{providerLabel({ kind: 'mcp', label: tool.label, server: tool.server })}</option>)}
            </optgroup>}
          </select>
        </label>
        <Button variant="secondary" busy={working} disabled={current.effective === 'builtin'} onClick={test}>{ui('测试')}</Button>
      </div>}
      {error && <InlineMessage className="extensions-settings__result">{error}</InlineMessage>}
      {probe?.ok && <InlineMessage tone={probe.matched || !probe.hits ? 'success' : 'warning'} className="extensions-settings__result">
        {probe.matched ? uiFormat('工具有回应：找到 {0} 段，对应资料里的 {1} 页。', [probe.hits, probe.matched])
          : probe.hits ? uiFormat('工具有回应（{0} 段），但没能对应到你资料里的页面。它索引的可能是别的文件；请把转换后的结果放进它读取的文件夹。', [probe.hits])
            : ui('工具有回应，但没有返回内容。可能还没有建立索引。')}
      </InlineMessage>}
      {probe && !probe.ok && probe.reason !== 'builtin' && <InlineMessage className="extensions-settings__result">{probe.message || ui('检索工具没有回应。')}</InlineMessage>}
      <Disclosure summary={ui('推荐的工具与下载渠道')} meta={ui('转换 · 检索')} defaultOpen={!current.hostCanSearch}>
        <div className="extensions-settings__tools">
          <ToolGroup role="converter" title={ui('转换工具：把 PDF 变成带页码的文字')} />
          <ToolGroup role="retrieval" title={ui('检索工具：只让 AI 看相关页面')}
            lead={ui('检索工具由 DSH 连接（MCP）。StudyHub 会自动发现它，并在出题时只取检索到的页面。')} />
        </div>
      </Disclosure>
    </fieldset>
  );
}
