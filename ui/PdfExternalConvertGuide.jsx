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
} from './pdf-external-guide.js';
import { ConvertedFileFormats, toolMetaLine } from './converter-lines.jsx';
import css from './pdf-external-guide.css';

/* 「想用外部工具转换？」 + 「转换完成后怎么导入」 (#1765).
   Shared across PDF conversion entry (PdfConversion), job detail (PdfDetail), and Settings (MineruPane). Not in the workspace's first load: PdfDetail brings it
   through ui/pdf-external-guide-lazy.jsx (tests/workspace-closure-pages.test.mjs).
   Plain copyable text URLs only: the guide never invokes the pages it lists or passes files to them. (The optional MinerU official API route is a
   separate, opt-in part of the PDF panel and Settings: lib/contexts/audio/mineru-api.js; it is not reached from here.) */

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

/** Step 1: the file to download, the formats StudyHub reads and its limits (the same sentence and constants the import hub's drop area uses). */
function FormatsStep() {
  return (
    <>
      <p><ConvertedFileFormats /></p>
      <p>{ui('支持导入的格式：Markdown（.md / .markdown）、纯文本（.txt）、LaTeX（.tex）、HTML（.html / .htm）、Word（.docx）、PowerPoint（.pptx / .ppt）、带文字层的 PDF（.pdf），以及转换工具导出的结构化 JSON（.json：PaddleOCR / Docling / MinerU）。')}</p>
      <p>{ui('MinerU 网页版下载的是 .zip：解压后导入名字以 _content_list.json 结尾的文件，StudyHub 会按页保存；其中的 full.md 没有页码标记，只能当普通 Markdown 导入，不分页。')}</p>
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
  useInjectCss(css, 'study-pdf-ext-guide');
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
