import React, { useRef } from 'react';
import { ui, uiFormat } from './i18n.js';
import { formatNumber } from './format.js';
import { LARGE_DOCUMENT_LIMITS } from '../lib/large-documents.js';
import { MAX_OFFICE_BYTES, MAX_TEXT_DOCUMENT_BYTES, megabytes } from '../lib/office/limits.js';
import { useInjectCss } from './shared.js';
import { Button, Disclosure, Hint, InlineMessage } from './components/index.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import {
  EXTERNAL_PDF_GUIDE_META,
  EXTERNAL_PDF_GUIDE_TITLE,
  EXTERNAL_PDF_IMPORT_STEPS,
  EXTERNAL_PDF_IMPORT_TITLE,
  EXTERNAL_PDF_PRIVACY_NOTICE,
  EXTERNAL_PDF_SCOPE_NOTE,
  EXTERNAL_PDF_TOOLS,
  PAGE_MARKER,
} from './pdf-external-guide.js';
import css from './mineru.css';

/* 「想用外部工具转换？」 + 「转换完成后怎么导入」 (#1765).
   Shared across PDF conversion entry (PdfConversion), job detail (PdfDetail), and Settings (MineruPane).
   Plain copyable text URLs only: StudyHub never invokes third-party conversion APIs or proxies files. */

function selectElementText(node) {
  if (!node || typeof document === 'undefined' || typeof window === 'undefined') return;
  if (typeof document.createRange !== 'function' || typeof window.getSelection !== 'function') return;
  try {
    const range = document.createRange();
    range.selectNodeContents(node);
    const selection = window.getSelection();
    selection?.removeAllRanges?.();
    selection?.addRange?.(range);
  } catch { /* selection API unavailable in this environment */ }
}

/** Licence, platforms and outputs of a catalogue tool on one line (the line a tool card shows). */
export const toolMetaLine = tool => [ui(tool.license), tool.platforms.map(platform => ui(platform)).join(' / '), ...(tool.outputs ? [tool.outputs.join(', ')] : [])].join(' · ');

/** What to download once a converter is done: the one line the PaddleOCR option (LargeDocumentCard) and step 1 below both say. */
export function ConvertedFileFormats() {
  return <>{ui('解析完成后，下载 JSON 结果文件（或带')}{' '}<code>{PAGE_MARKER}</code>{' '}{ui('页码标记的 Markdown）')}</>;
}

/** Step 1: the file to download, the formats StudyHub reads and its limits (the same sentence and constants the import hub's drop area uses). */
function FormatsStep() {
  return (
    <>
      <p><ConvertedFileFormats /></p>
      <p>{ui('支持导入的格式：Markdown（.md / .markdown）、纯文本（.txt）、LaTeX（.tex）、HTML（.html / .htm）、Word（.docx）、PowerPoint（.pptx / .ppt）、带文字层的 PDF（.pdf），以及转换工具导出的结构化 JSON（.json：PaddleOCR / Docling / MinerU）。')}</p>
      <p>{uiFormat('PDF 最多 {0} 页，提取出的文字最多 {1} 字符', [LARGE_DOCUMENT_LIMITS.pdfPages, formatNumber(LARGE_DOCUMENT_LIMITS.selectionChars)])}</p>
      <p>{uiFormat('PDF 与文本最大 {0} MB，Word / PPT / 转换 JSON 最大 {1} MB', [megabytes(MAX_TEXT_DOCUMENT_BYTES), megabytes(MAX_OFFICE_BYTES)])}</p>
    </>
  );
}

function ExternalToolRow({ entry }) {
  const { tool } = entry;
  const codeRef = useRef(null);
  const { copied, failed, copy } = useCopyFeedback(entry.url);
  const name = ui(tool.name);
  const handleCopy = async () => {
    const ok = await copy();
    if (!ok) selectElementText(codeRef.current);
  };
  return (
    <li className="pdf-ext-guide__item" data-external-tool={entry.id}>
      <div className="pdf-ext-guide__head">
        <strong>{name}</strong>
        <span className="pdf-ext-guide__role">{toolMetaLine(tool)}</span>
      </div>
      <div className="pdf-ext-guide__url-row">
        <code ref={codeRef} className="pdf-ext-guide__url" translate="no">{entry.url}</code>
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? 'check' : undefined}
          className="pdf-ext-guide__copy-btn"
          aria-label={uiFormat('复制 {0} 的链接', [name])}
          data-copy-tool={entry.id}
          onClick={handleCopy}
        >
          {copied ? ui('已复制') : ui('复制链接')}
        </Button>
      </div>
      {failed && (
        <Hint as="small" className="pdf-ext-guide__copy-error" role="status">
          {ui('无法自动复制，请直接选中上方链接手动复制。')}
        </Hint>
      )}
    </li>
  );
}

export default function PdfExternalConvertGuide({ defaultOpen = false, className, ...rest }) {
  useInjectCss(css, 'study-mineru');
  return (
    <Disclosure
      summary={ui(EXTERNAL_PDF_GUIDE_TITLE)}
      meta={ui(EXTERNAL_PDF_GUIDE_META)}
      defaultOpen={defaultOpen}
      className={className ? `pdf-ext-guide ${className}` : 'pdf-ext-guide'}
      bodyClassName="pdf-ext-guide__body"
      data-pdf-external-guide
      {...rest}
    >
      <InlineMessage tone="info" boxed className="pdf-ext-guide__notice">
        <p className="pdf-ext-guide__privacy"><strong>{ui(EXTERNAL_PDF_PRIVACY_NOTICE)}</strong></p>
        <p className="pdf-ext-guide__scope">{ui(EXTERNAL_PDF_SCOPE_NOTE)}</p>
      </InlineMessage>

      <ul className="pdf-ext-guide__list" aria-label={ui('外部转换工具参考链接')}>
        {EXTERNAL_PDF_TOOLS.map(entry => <ExternalToolRow key={entry.id} entry={entry} />)}
      </ul>

      <div className="pdf-ext-guide__guide" role="region" aria-label={ui(EXTERNAL_PDF_IMPORT_TITLE)}>
        <h4 className="pdf-ext-guide__subtitle">{ui(EXTERNAL_PDF_IMPORT_TITLE)}</h4>
        <ol className="pdf-ext-guide__steps">
          {EXTERNAL_PDF_IMPORT_STEPS.map(step => (
            <li key={step.id} className="pdf-ext-guide__step" data-guide-step={step.id}>
              <strong>{ui(step.title)}</strong>
              {step.id === 'formats' && <FormatsStep />}
              {step.body && <p>{ui(step.body)}</p>}
              {step.items && (
                <ul className="pdf-ext-guide__troubles">
                  {step.items.map(item => (
                    <li key={item.id} data-failure-case={item.id}>
                      <strong>{uiFormat('{0}：', [ui(item.label)])}</strong>
                      <span>{ui(item.detail)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      </div>
    </Disclosure>
  );
}
