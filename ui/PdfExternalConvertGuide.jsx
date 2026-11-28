import React, { useRef } from 'react';
import { ui, uiFormat } from './i18n.js';
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

function ExternalToolRow({ tool }) {
  const codeRef = useRef(null);
  const { copied, failed, copy } = useCopyFeedback(tool.url);
  const name = ui(tool.name);
  const handleCopy = async () => {
    const ok = await copy();
    if (!ok) selectElementText(codeRef.current);
  };
  return (
    <li className="pdf-ext-guide__item" data-external-tool={tool.id}>
      <div className="pdf-ext-guide__head">
        <strong>{name}</strong>
        <span className="pdf-ext-guide__role">{ui(tool.role)}</span>
      </div>
      <div className="pdf-ext-guide__url-row">
        <code ref={codeRef} className="pdf-ext-guide__url" translate="no">{tool.url}</code>
        <Button
          variant="secondary"
          size="sm"
          icon={copied ? 'check' : undefined}
          className="pdf-ext-guide__copy-btn"
          aria-label={uiFormat('复制 {0} 的链接', [name])}
          data-copy-tool={tool.id}
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
        {EXTERNAL_PDF_TOOLS.map(tool => <ExternalToolRow key={tool.id} tool={tool} />)}
      </ul>

      <div className="pdf-ext-guide__guide" role="region" aria-label={ui(EXTERNAL_PDF_IMPORT_TITLE)}>
        <h4 className="pdf-ext-guide__subtitle">{ui(EXTERNAL_PDF_IMPORT_TITLE)}</h4>
        <ol className="pdf-ext-guide__steps">
          {EXTERNAL_PDF_IMPORT_STEPS.map(step => (
            <li key={step.id} className="pdf-ext-guide__step" data-guide-step={step.id}>
              <strong>{ui(step.title)}</strong>
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
