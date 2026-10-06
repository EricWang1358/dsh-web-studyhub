import React, { useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Field, InlineMessage, Select, SettingsSection, TextInput, useToast } from './components/index.js';
import { AdvancedTools, ConverterMain, DetectionLine, providerLabel } from './LargeDocumentCard.jsx';
import ExtensionPanel from './ExtensionPanel.jsx';
import { setRetrievalStatus, useRetrievalStatus } from './retrieval-status.js';
import { useAsyncAction } from './use-async.js';
import css from './large-documents.css';

export { providerLabel };

/* 设置 › 检索扩展 (WP28, WP28b). The way to search a big textbook is one
   click: convert with a desktop app, install the search extension, build the index of
   a course. Choosing another search tool that DSH exposes, the model download address
   and the hand-made routes are under 高级. Nothing is said to be installed unless the
   host reported it (retrieval.status). */

const NOTHING = { selected: 'builtin', effective: 'builtin', hostCanSearch: false, providers: [], otherTools: [] };
const stripTool = value => String(value ?? '').replace(/^mcp:/, '');

/** Props: call(action, args), initialStatus (skips the first read; tests and previews), courses + defaultCourse (the index). */
export default function ExtensionsSettings({ call, initialStatus = null, courses = [], defaultCourse = '', onStatus, initialPlan, initialRun }) {
  const toast = useToast();
  useInjectCss(css, 'study-large-documents');
  const query = useRetrievalStatus({ call, initialData: initialStatus ?? undefined, enabled: !initialStatus });
  const status = query.data ?? (query.error ? NOTHING : null);
  const [probe, setProbe] = useState(null);
  const { run, working, error } = useAsyncAction({ exclusive: true });
  // The download address shows what the host saved until the learner types one (what is typed is kept when the read lands late).
  const [typedEndpoint, setEndpoint] = useState(null);
  const accept = value => { if (!value) return; setRetrievalStatus(value); onStatus?.(value); };
  const endpoint = typedEndpoint ?? query.data?.hfEndpoint ?? '';
  const current = status || NOTHING;
  const choose = provider => { setProbe(null); return run('choose', async () => {
    accept(await call('retrieval.set', { provider }));
    toast.success(provider === 'builtin' ? ui('已改为不使用检索。') : ui('已选择检索工具。出题时，超过 15 万字的选择会先用它挑出相关页面。'));
  }); };
  const test = () => { setProbe(null); return run('test', async () => { setProbe(await call('retrieval.test', {})); }); };
  const saveEndpoint = () => run('endpoint', async () => {
    accept(await call('retrieval.endpoint.set', { endpoint }));
    toast.success(endpoint ? ui('已保存模型下载地址。重启 DSH 后生效。') : ui('已恢复默认的模型下载地址。重启 DSH 后生效。'));
  });
  const mcpOthers = current.otherTools || [];
  const canChoose = current.providers.length > 0 || mcpOthers.length > 0;
  return (
    <SettingsSection className="extensions-settings" tour="settings-extensions" title={ui('扩展：文档转换与检索')}
      lead={ui('大教材（上百页的 PDF）按三步用：先把 PDF 转成带页码的文字，导入后按章节选；整本书都要用时，安装检索扩展并为课程建立索引，出题时只用相关页面。StudyHub 不会替你改任何配置文件。')}>
      <ConverterMain />
      <div className="large-doc__group" data-role="retrieval">
        <h3 className="large-doc__group-title">{ui('检索：只让 AI 看相关页面')}</h3>
        <ExtensionPanel call={call} status={status} onStatus={accept} courses={courses} defaultCourse={defaultCourse} initialPlan={initialPlan} initialRun={initialRun} />
      </div>
      <DetectionLine retrieval={current} />
      {current.missing && <InlineMessage tone="warning" boxed title={uiFormat('之前选择的检索工具「{0}」现在找不到', [stripTool(current.missing)])}>
        {ui('已暂时改为不使用检索。请确认它在 DSH 里已启用，或在下面重新选择。')}
      </InlineMessage>}
      <Disclosure summary={ui('高级')} meta={ui('其他检索工具 · 模型下载地址 · 手动配置')} defaultOpen={!!current.missing}>
        <div className="extensions-settings__advanced">
          {canChoose && <div className="extensions-settings__choice">
            <Field label={ui('用哪个工具检索')}>
              <Select value={current.effective} disabled={!!working} onChange={choose} options={[
                { value: 'builtin', label: ui('不使用检索（把选中的资料全部交给 AI）') },
                ...current.providers.map(provider => ({ value: provider.id, label: providerLabel(provider) })),
                ...(mcpOthers.length > 0 ? [{ group: ui('其他 MCP 工具'), options: mcpOthers.map(tool => ({ value: `mcp:${tool.name}`, label: providerLabel({ kind: 'mcp', label: tool.label, server: tool.server }) })) }] : [])]} />
            </Field>
            <Button variant="secondary" busy={working === 'test'} disabled={!!working || current.effective === 'builtin'} onClick={test}>{ui('测试')}</Button>
          </div>}
          {error && <InlineMessage className="extensions-settings__result">{error}</InlineMessage>}
          {probe?.ok && <InlineMessage tone={probe.matched || !probe.hits ? 'success' : 'warning'} className="extensions-settings__result">
            {probe.matched ? uiFormat('工具有回应：找到 {0} 段，对应资料里的 {1} 页。', [probe.hits, probe.matched])
              : probe.hits ? uiFormat('工具有回应（{0} 段），但没能对应到你资料里的页面。它索引的可能是别的文件；请把转换后的结果放进它读取的文件夹。', [probe.hits])
                : ui('工具有回应，但没有返回内容。可能还没有建立索引。')}
          </InlineMessage>}
          {probe && !probe.ok && probe.reason !== 'builtin' && <InlineMessage className="extensions-settings__result">{probe.message || ui('检索工具没有回应。')}</InlineMessage>}
          <div className="extensions-settings__endpoint">
            <Field label={ui('模型下载地址')} width="full"
              hint={ui('检索扩展第一次建立索引时，从这个地址下载检索模型。默认地址在你的网络里打不开时，可以改成别的地址；留空就是默认地址。改动在重启 DSH 后生效。')}>
              <TextInput type="url" value={endpoint} placeholder="https://huggingface.co" disabled={!!working} onChange={event => setEndpoint(event.target.value)} />
            </Field>
            <Button size="sm" variant="secondary" busy={working === 'endpoint'} disabled={!!working} onClick={saveEndpoint}>{ui('保存下载地址')}</Button>
          </div>
          <AdvancedTools />
        </div>
      </Disclosure>
    </SettingsSection>
  );
}
