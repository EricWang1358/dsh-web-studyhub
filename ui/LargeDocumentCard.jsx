import React, { useId, useState } from 'react';
import { ui, uiFormat } from './i18n.js';
import { useInjectCss } from './shared.js';
import { Badge, Button, Disclosure, Hint, Icon, Tooltip } from './components/index.js';
import { adviceTip } from './index-scope.js';
import { formatNumber } from './format.js';
import { megabytes } from '../lib/office/limits.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import { LARGE_DOCUMENT_LIMITS, TOOLS, VERIFIED_AT, mcpConfigSnippet } from '../lib/large-documents.js';
import ExtensionPanel from './ExtensionPanel.jsx';
import PdfConversion from './PdfConversion.jsx';
import css from './large-documents.css';

/* 大教材建议 (WP28, WP28b). StudyHub does not index a 1000-page textbook itself, and
   the learner never edits a file or types a command: StudyHub converts the PDF with MinerU
   itself (local mineru and its models first, or an explicitly chosen cloud route after it recovers; big books
   are cut into pieces and put back together), and, for whole-book questions, installs
   StudyHub's search extension with one click and builds the index of the course with
   another. The desktop client, the command line, Docker and hand-written configuration
   routes exist but live under 高级. It never claims a tool is installed: `retrieval`
   is what the host reported (retrieval.status). */

const SUMMARY = {
  'mineru-local': () => ui('优先安装本地 mineru 并下载模型，在「设置 › PDF 转换（MinerU）」完成检测和启用。解析不会上传文档；模型下载需先确认。'),
  'mineru-cloud': () => ui('云端暂不可用，优先使用本地模型。恢复后可手动选择云端；已保存令牌不代表服务可用。'),
  mineru: () => <>{ui('桌面客户端目前也反馈不可用，优先使用上面的本地模型；客户端恢复后可再尝试。')}{' '}{ui('手动路线：有图形界面的桌面客户端（Windows / macOS），或本地命令行 mineru parse --pages。导出带页码的 JSON 再拖进来。')}</>,
  docling: () => ui('开源（MIT），输出带页码的 JSON，适合愿意用命令行或 Python 的人。导入时选它输出的 .json。'),
  'mcp-local-rag': () => ui('在本机检索，文档不出电脑；读 PDF、Word、Markdown 和纯文本。默认的向量模型偏英文，中文教材要换多语言模型。'),
  ragflow: () => ui('完整的知识库应用（用 Docker 运行，建议 16 GB 内存），中文友好；通过 MCP 接口被 DSH 调用。'),
};
const KIND_LABEL = { official: () => ui('官方'), source: () => ui('源码'), package: () => ui('安装包'), mainland: () => ui('国内可用') };
const NEEDS = { token: () => ui('需要免费令牌'), 'command-line': () => ui('需要命令行'), docker: () => ui('需要 Docker'), manual: () => ui('需要手动配置') };

/** The one name for a provider: the tool and, for MCP, the server it comes from. */
export function providerLabel(provider) {
  if (!provider) return '';
  return provider.kind === 'mcp' && provider.server ? `${provider.label}（${provider.server}）` : String(provider.label ?? '');
}

function reasonText(reason, detail = {}) {
  const name = detail.name ? uiFormat('「{0}」', [detail.name]) : ui('这个文件');
  const number = value => formatNumber(value);
  switch (reason) {
    case 'pdf-size': return uiFormat('{0}超过 {1} MB，StudyHub 不直接导入这么大的文件。先用转换工具把它变成带页码的文字，再导入转换结果：按页保存、按章节选，原文引用照常可用。', [name, megabytes(LARGE_DOCUMENT_LIMITS.pdfBytes)]);
    case 'pdf-pages': return uiFormat('{0}超过 {1} 页，StudyHub 不直接导入。先用转换工具把它变成带页码的文字，再导入转换结果：按页保存、按章节选。', [name, LARGE_DOCUMENT_LIMITS.pdfPages]);
    case 'text-chars': return uiFormat('{0}提取出的文字超过 {1} 字符。先用转换工具转换，再按章节导入或选择。', [name, number(LARGE_DOCUMENT_LIMITS.selectionChars)]);
    case 'selection': return uiFormat('所选资料约 {0} 个字符，超过一次生成的上限（{1}）。可以按章节缩小选择，或用检索工具只挑出和主题相关的页面。',
      [number(detail.chars ?? 0), number(LARGE_DOCUMENT_LIMITS.selectionChars)]);
    case 'long-document': return uiFormat('{0}有 {1} 页。整本书一起出题既贵又不聚焦，建议按章节选择，或配合检索工具只取相关页面。', [name, number(detail.pages ?? 0)]);
    default: return ui('这份资料很大，可以按章节选择，或配合转换和检索工具使用。');
  }
}

const STEPS = {
  convert: [() => ui('点下面的「开始本地解析」：用本机的 mineru（免费、不上传）。尚未就绪时，先到「设置 › PDF 转换」安装并下载模型。'),
    () => ui('StudyHub 自动分段、逐段解析、合并，进度显示在资料页；中途出错只重做出错的那一段。'),
    () => ui('解析完成后按页保存，并按标题分出章节，不用再拖文件。'),
    () => ui('在「创建题组」里按章节勾选；整本书都要用时，点下面的「安装检索扩展」，再为这门课建立检索索引。')],
  select: [() => ui('在资料列表里点「选择章节」，只勾选这次要学的章节。'), () => ui('或者点下面的「安装检索扩展」，再为这门课建立检索索引。'),
    () => ui('在「这次想练什么？」写下主题，StudyHub 只把检索到的页面发给 AI。'), () => ui('还没有转换过？先在「添加资料」的「PDF 解析」里把 PDF 转成带页码的文字，再导入。')],
};

/** One recommended tool: what it does, what it asks of you, licence, platforms, where to get it. */
export function ToolCard({ tool }) {
  return (
    <article className="large-doc__tool" data-tool={tool.id}>
      <header className="large-doc__tool-head">
        <strong>{ui(tool.name)}</strong>
        {tool.recommended && (tool.id === 'mineru-local' || ['download', 'token'].includes(tool.needs)) && <Badge tone="info" size="sm">{ui('推荐')}</Badge>}
        {NEEDS[tool.needs] && <Badge size="sm">{NEEDS[tool.needs]()}</Badge>}
      </header>
      <p className="large-doc__summary">{SUMMARY[tool.id]()}</p>
      <p className="large-doc__meta">{[ui(tool.license), tool.platforms.join(' / '), ...(tool.outputs ? [tool.outputs.join(', ')] : [])].join(' · ')}</p>
      <ul className="large-doc__channels" aria-label={uiFormat('{0} 的下载渠道', [ui(tool.name)])}>
        {tool.channels.map(channel => <li key={channel.url}>
          <a href={channel.url} target="_blank" rel="noreferrer">{ui(channel.label)}<Icon name="external" size={13} /></a>
          <Badge size="sm" tone={channel.kind === 'mainland' ? 'success' : 'neutral'}>{KIND_LABEL[channel.kind]()}</Badge>
        </li>)}
      </ul>
    </article>
  );
}

const byId = id => TOOLS.find(tool => tool.id === id);

/**
 * The leading converter: StudyHub runs local MinerU or shows its setup. With `call` the whole flow is here;
 * without it the card explains local model setup. `file` is the PDF a too-large import was
 * refused for (without one the learner picks a PDF), `onStarted` hears that a conversion began.
 */
export function ConverterMain({ available = true, call, file = null, courses = [], onOpenSettings, onStarted }) {
  const [picked, setPicked] = useState(null);
  return (
    <div className="large-doc__group" data-role="converter">
      <h3 className="large-doc__group-title">{ui('转换：把 PDF 变成带页码的文字')}</h3>
      {typeof call === 'function'
        ? <PdfConversion available={available} compact file={file || picked} onFile={file ? undefined : setPicked} call={call} courses={courses} onOpenSettings={onOpenSettings} onStarted={onStarted} />
        : <div className="large-doc__tools"><ToolCard tool={byId('mineru-local')} /><Hint>{ui('云端暂不可用，优先使用本地模型。恢复后可手动选择云端；已保存令牌不代表服务可用。')}</Hint></div>}
      <Hint>{ui('转换结果带页码，StudyHub 才能按页引用；超过 200 页的书会自动分段处理。')}</Hint>
    </div>
  );
}

function ConfigSnippet({ tool, describedBy }) {
  const { copied, copy } = useCopyFeedback(mcpConfigSnippet(tool.id));
  return <div className="large-doc__snippet">
    <strong>{tool.name}</strong>
    <pre className="large-doc__code" aria-describedby={describedBy}><code>{mcpConfigSnippet(tool.id)}</code></pre>
    <Button size="sm" variant="secondary" icon={copied ? 'check' : undefined} onClick={copy}>{copied ? ui('已复制') : ui('复制配置')}</Button>
  </div>;
}

function ManualConfig() {
  const id = useId();
  return (
    <Disclosure summary={ui('高级：手动配置')} meta={ui('需要手动配置')} className="large-doc__config">
      <Hint id={id}>{ui('不想用一键安装的检索扩展，也可以自己连接别的检索工具：把下面的配置加到 DSH 主目录的 cordis.patch.yml（已有内容的话接在后面），并把路径换成放转换结果的文件夹。保存后 DSH 会连接它，不需要重装 StudyHub。')}</Hint>
      {TOOLS.filter(tool => tool.server).map(tool => <ConfigSnippet key={tool.id} tool={tool} describedBy={id} />)}
      <ToolCard tool={byId('mcp-local-rag')} />
    </Disclosure>
  );
}

/** The routes that need a terminal, Docker or a configuration file: kept, but out of the way. */
export function AdvancedTools() {
  return (
    <Disclosure summary={ui('高级：其他方式（桌面客户端、命令行、Docker）')} meta={ui('给熟悉命令行的人')} className="large-doc__more large-doc__advanced">
      <div className="large-doc__tools"><ToolCard tool={byId('mineru')} /><ToolCard tool={byId('docling')} /><ToolCard tool={byId('ragflow')} /></div>
      <ManualConfig />
    </Disclosure>
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
  else if (retrieval.companion?.running) { text = ui('检索扩展已就绪；建好索引后会自动用它挑选页面。'); tone = 'found'; }
  else if (providers.length) { text = uiFormat('检测到 {0} 个检索工具，还没有选择。', [providers.length]); tone = 'found'; }
  // Installed but not up yet: the extension panel already asks for a restart; "none detected" would contradict it.
  else if (retrieval.extension?.installed) return null;
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
 * detail ({ name?, chars?, pages?, file? } — the File a too-large import was refused for), courseNames + onConversionStarted (the MinerU flow), retrieval (retrieval.status, optional), onOpenSettings
 * (shows the settings link), call + courses + defaultCourse + onRetrieval (the one-click
 * install and the index builder; without `call` the card only explains), initialPlan /
 * initialRun / initialApproval (previews and tests), className. Extra props land on the root.
 */
export default function LargeDocumentCard({ reason, detail = {}, document, retrieval = null, onOpenSettings, call, courses = [], defaultCourse = '', onRetrieval,
  conversionAvailable = true, courseNames = [], onConversionStarted, initialPlan, initialRun, initialApproval, className, ...rest }) {
  useInjectCss(css, 'study-large-documents');
  const titleId = useId();
  const converting = reason === 'pdf-size' || reason === 'pdf-pages' || reason === 'text-chars';
  const steps = converting ? STEPS.convert : STEPS.select;
  const search = <div className="large-doc__group" data-role="retrieval">
    <h3 className="large-doc__group-title">{ui('检索：只让 AI 看相关页面')}</h3>
    {typeof call === 'function'
      ? <ExtensionPanel call={call} status={retrieval} onStatus={onRetrieval} courses={courses} defaultCourse={defaultCourse} document={document}
        initialPlan={initialPlan} initialRun={initialRun} initialApproval={initialApproval} />
      : <Hint>{ui('在「设置 › 检索扩展」里一键安装检索扩展，再为这门课建立检索索引。')}</Hint>}
  </div>;
  return (
    <section className={`large-doc${className ? ` ${className}` : ''}`} aria-labelledby={titleId} data-reason={reason} {...rest}>
      <header className="large-doc__head">
        <Icon name="info" size={20} className="large-doc__icon" />
        <div>
          {/* Why a long book is advised by chapter; the other reasons (a file too large to import, a selection too big) say their own reason below. */}
          {reason === 'long-document'
            ? <Tooltip layer anchorClassName="large-doc__tip" content={adviceTip()}><h2 id={titleId} className="large-doc__title" tabIndex={0}>{ui('大教材建议')}</h2></Tooltip>
            : <h2 id={titleId} className="large-doc__title">{ui('大教材建议')}</h2>}
          <p className="large-doc__reason">{reasonText(reason, detail)}</p>
        </div>
      </header>
      <ol className="large-doc__steps">{steps.map((step, index) => <li key={index} className="large-doc__step">{step()}</li>)}</ol>
      {converting ? <>
        <ConverterMain available={conversionAvailable} call={call} file={detail.file} courses={courseNames} onOpenSettings={onOpenSettings} onStarted={onConversionStarted} />
        <Disclosure summary={ui('需要整本检索时')} meta={ui('可选')} className="large-doc__more" defaultOpen={retrieval?.extension?.installed === true}>{search}</Disclosure>
      </> : <>
        {search}
        <Disclosure summary={ui('还没有转换过 PDF？')} meta={ui('转换工具')} className="large-doc__more"><ConverterMain available={conversionAvailable} call={call} courses={courseNames} onOpenSettings={onOpenSettings} onStarted={onConversionStarted} /></Disclosure>
      </>}
      <AdvancedTools />
      <DetectionLine retrieval={retrieval} onOpenSettings={onOpenSettings} />
      <p className="large-doc__verified">{uiFormat('渠道与协议于 {0} 核对；以各项目官方页面为准。', [VERIFIED_AT])}</p>
    </section>
  );
}

export { TOOLS };
