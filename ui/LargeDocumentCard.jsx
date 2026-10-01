import React, { useId, useState } from 'react';
import { ui, uiFormat, uiLocale } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Icon } from './components/index.js';
import { LARGE_DOCUMENT_LIMITS, TOOLS, VERIFIED_AT, mcpConfigSnippet, toolsFor } from '../lib/large-documents.js';
import css from './large-documents.css';

/* 大教材建议 (WP28). StudyHub does not index a 1000-page textbook itself: the
   learner converts the PDF with a recommended tool, imports the result here, and
   (for whole-book questions) lets a retrieval tool that DSH exposes pick the
   pages. This card says so calmly, in the place where the problem showed up,
   with the download channels (official and reachable from mainland China) and
   the steps. It never claims a tool is installed: `retrieval` is what the host
   detected (retrieval.status). */

const SUMMARY = {
  mineru: () => ui('把 PDF 转成带页码的文字：支持扫描件、公式、表格和中文。导入时选它输出的 content_list.json。'),
  docling: () => ui('开源（MIT），输出带页码的 JSON，适合愿意用命令行或 Python 的人。导入时选它输出的 .json。'),
  'mcp-local-rag': () => ui('在本机检索，文档不出电脑；读 PDF、Word、Markdown 和纯文本。默认的向量模型偏英文，中文教材要换多语言模型。'),
  ragflow: () => ui('完整的知识库应用（用 Docker 运行，建议 16 GB 内存），中文友好；通过 MCP 接口被 DSH 调用。'),
};
const KIND_LABEL = { official: () => ui('官方'), source: () => ui('源码'), package: () => ui('安装包'), mainland: () => ui('国内可用') };

/** The one name for a provider: the tool and, for MCP, the server it comes from. */
export function providerLabel(provider) {
  if (!provider) return '';
  return provider.kind === 'mcp' && provider.server ? `${provider.label}（${provider.server}）` : String(provider.label ?? '');
}

function reasonText(reason, detail = {}) {
  const name = detail.name ? uiFormat('「{0}」', [detail.name]) : ui('这个文件');
  const number = value => Number(value).toLocaleString(uiLocale());
  switch (reason) {
    case 'pdf-size': return uiFormat('{0}超过 8 MB，StudyHub 不直接导入这么大的文件。先用转换工具把它变成带页码的文字，再导入转换结果：按页保存、按章节选，原文引用照常可用。', [name]);
    case 'pdf-pages': return uiFormat('{0}超过 200 页，StudyHub 不直接导入。先用转换工具把它变成带页码的文字，再导入转换结果：按页保存、按章节选。', [name]);
    case 'text-chars': return uiFormat('{0}提取出的文字超过 60 万字。先用转换工具转换，再按章节导入或选择。', [name]);
    case 'selection': return uiFormat('所选资料约 {0} 个字符，超过一次生成的上限（{1}）。可以按章节缩小选择，或用检索工具只挑出和主题相关的页面。',
      [number(detail.chars ?? 0), number(LARGE_DOCUMENT_LIMITS.selectionChars)]);
    case 'long-document': return uiFormat('{0}有 {1} 页。整本书一起出题既贵又不聚焦，建议按章节选择，或配合检索工具只取相关页面。', [name, number(detail.pages ?? 0)]);
    default: return ui('这份资料很大，可以按章节选择，或配合转换和检索工具使用。');
  }
}

const STEPS = {
  convert: [() => ui('用转换工具处理这份 PDF，得到 .json（推荐）或带分页标记的 .md。'), () => ui('回到「添加资料」，把转换结果拖进来：StudyHub 按页保存，并按标题分出章节。'),
    () => ui('在「创建题组」里按章节勾选要学的部分。'), () => ui('整本书都要用时：在 DSH 里添加一个检索工具，再到「设置 › 扩展：文档转换与检索」选择它。')],
  select: [() => ui('在资料列表里点「选择章节」，只勾选这次要学的章节。'), () => ui('或者在 DSH 里添加一个检索工具（MCP），再到「设置 › 扩展：文档转换与检索」选择它。'),
    () => ui('在「这次想练什么？」写下主题，StudyHub 只把检索到的页面发给 AI。'), () => ui('还没有转换过？先用转换工具把 PDF 转成带页码的文字，再导入。')],
};

function ConfigSnippet({ tool }) {
  const [copied, setCopied] = useState(false);
  const snippet = mcpConfigSnippet(tool.id);
  const id = useId();
  async function copy() {
    try { await navigator.clipboard.writeText(snippet); setCopied(true); setTimeout(() => setCopied(false), 2500); } catch { setCopied(false); }
  }
  return (
    <Disclosure summary={ui('DSH 配置（可复制）')} className="large-doc__config">
      <p className="large-doc__note" id={id}>{ui('把下面这段加到 DSH 主目录的 cordis.patch.yml（已有内容的话接在后面），并把路径换成放转换结果的文件夹。保存后 DSH 会连接它，不需要重装 StudyHub。')}</p>
      <pre className="large-doc__code" aria-describedby={id}><code>{snippet}</code></pre>
      <Button size="sm" variant="secondary" onClick={copy}>{copied ? ui('已复制') : ui('复制配置')}</Button>
    </Disclosure>
  );
}

/** One recommended tool: what it does, licence, platforms, where to get it. */
export function ToolCard({ tool, config = false }) {
  return (
    <article className="large-doc__tool" data-tool={tool.id}>
      <header className="large-doc__tool-head">
        <strong>{tool.name}</strong>
        {tool.recommended && <span className="large-doc__badge">{ui('推荐')}</span>}
      </header>
      <p className="large-doc__summary">{SUMMARY[tool.id]()}</p>
      <p className="large-doc__meta">{[tool.license, tool.platforms.join(' / '), ...(tool.outputs ? [tool.outputs.join(', ')] : [])].join(' · ')}</p>
      <ul className="large-doc__channels" aria-label={uiFormat('{0} 的下载渠道', [tool.name])}>
        {tool.channels.map(channel => <li key={channel.url}>
          <a href={channel.url} target="_blank" rel="noreferrer">{ui(channel.label)}<Icon name="external" size={13} /></a>
          <span className={`large-doc__kind large-doc__kind--${channel.kind}`}>{KIND_LABEL[channel.kind]()}</span>
        </li>)}
      </ul>
      {config && tool.server && <ConfigSnippet tool={tool} />}
    </article>
  );
}

/** The recommended tools of one role. */
export function ToolGroup({ role, title, lead }) {
  return (
    <div className="large-doc__group" data-role={role}>
      <h3 className="large-doc__group-title">{title}</h3>
      {lead && <p className="large-doc__note">{lead}</p>}
      <div className="large-doc__tools">{toolsFor(role).map(tool => <ToolCard key={tool.id} tool={tool} config={role === 'retrieval'} />)}</div>
    </div>
  );
}

/** What the host detected, in one line (never "installed" for a tool nobody chose). */
export function DetectionLine({ retrieval, onOpenSettings }) {
  const providers = retrieval?.providers || [];
  const active = retrieval?.effective && retrieval.effective !== 'builtin' ? providers.find(provider => provider.id === retrieval.effective) : null;
  // Unknown (not read yet) is not "none detected": say nothing.
  if (!retrieval) return null;
  let text, tone = 'none';
  if (active) { text = uiFormat('已启用检索：{0}', [providerLabel(active)]); tone = 'on'; }
  else if (retrieval?.effective && retrieval.effective !== 'builtin') { text = ui('已选择的检索工具已启用。'); tone = 'on'; }
  else if (providers.length) { text = uiFormat('检测到 {0} 个检索工具，还没有选择。', [providers.length]); tone = 'found'; }
  else text = ui('没有检测到检索工具。');
  return (
    <p className={`large-doc__detect large-doc__detect--${tone}`} role="status">
      <Icon name={tone === 'on' ? 'success' : 'info'} size={16} />
      <span>{text}</span>
      {onOpenSettings && tone !== 'on' && <Button size="sm" variant="link" onClick={onOpenSettings}>{ui('打开检索设置')}</Button>}
      {onOpenSettings && tone === 'on' && <Button size="sm" variant="link" onClick={onOpenSettings}>{ui('查看检索设置')}</Button>}
    </p>
  );
}

/**
 * Props: reason ('pdf-size' | 'pdf-pages' | 'text-chars' | 'selection' | 'long-document'),
 * detail ({ name?, chars?, pages? }), retrieval (retrieval.status, optional),
 * onOpenSettings (shows the settings link), className. Extra props land on the root.
 */
export default function LargeDocumentCard({ reason, detail = {}, retrieval = null, onOpenSettings, className, ...rest }) {
  useInjectCss(css, 'study-large-documents');
  const titleId = useId();
  const converting = reason === 'pdf-size' || reason === 'pdf-pages' || reason === 'text-chars';
  const steps = converting ? STEPS.convert : STEPS.select;
  const converters = <ToolGroup role="converter" title={ui('转换工具：把 PDF 变成带页码的文字')} />;
  const retrievers = <ToolGroup role="retrieval" title={ui('检索工具：只让 AI 看相关页面')}
    lead={ui('检索工具由 DSH 连接（MCP）。StudyHub 会自动发现它，并在出题时只取检索到的页面。')} />;
  return (
    <section className={`large-doc${className ? ` ${className}` : ''}`} aria-labelledby={titleId} data-reason={reason} {...rest}>
      <header className="large-doc__head">
        <Icon name="info" size={20} className="large-doc__icon" />
        <div>
          <h2 id={titleId} className="large-doc__title">{ui('大教材建议')}</h2>
          <p className="large-doc__reason">{reasonText(reason, detail)}</p>
        </div>
      </header>
      <ol className="large-doc__steps">{steps.map((step, index) => <li key={index} className="large-doc__step">{step()}</li>)}</ol>
      {converting ? <>
        {converters}
        <Disclosure summary={ui('需要整本检索时')} meta={ui('可选')} className="large-doc__more">{retrievers}</Disclosure>
      </> : <>
        {retrievers}
        <Disclosure summary={ui('还没有转换过 PDF？')} meta={ui('转换工具')} className="large-doc__more">{converters}</Disclosure>
      </>}
      <DetectionLine retrieval={retrieval} onOpenSettings={onOpenSettings} />
      <p className="large-doc__verified">{uiFormat('渠道与协议于 {0} 核对；以各项目官方页面为准。', [VERIFIED_AT])}</p>
    </section>
  );
}

export { TOOLS };
