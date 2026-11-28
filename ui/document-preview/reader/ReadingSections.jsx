import React, { useContext, useEffect, useRef, useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, Icon, TextInput } from '../../components/index.js';
import { HandOff } from '../../hand-off/HandOff.jsx';
import { hasChatHost } from '../../hand-off/use-hand-off.js';
import { StudyServicesContext } from '../../study-context.jsx';
import { isSlideFormat } from '../../../lib/office/limits.js';
import { pagePicture, useVisionState, VISION_UNSUPPORTED_NOTICE } from '../PageAsk.jsx';
import { lineBreakPieces, headingMark } from './text-sections.js';
import { isFigurePlaceholder } from '../peek/peek-logic.js';
import { splitStudyMath } from '../../study-media.js';
import { formulaClass } from './formula.js';
import { FormulaWatch, formulaDrawing, useFormulaShown } from './lazy-formulas.js';
import { createFormulaWatch } from '../../formula-queue.js';

/** One formula, as formula.js's formulaHtml writes it: the stored text hidden, the drawing a marker beside it. The raw text
 * decides the drawing, so a re-render of the page (a selection, a find) never draws it again. It is drawn when it comes near the
 * screen (lazy-formulas.js); until then its own text, muted, stands in the marker. */
const ReaderFormula = React.memo(function ReaderFormula({ formula }) {
  const view = useRef(null), shown = useFormulaShown(view);
  return <span className={formulaClass(formula.display)}>
    <span className="sh-visually-hidden reader-math__source" aria-hidden="true">{formula.raw}</span>
    {shown ? <span key="drawn" ref={view} className="reader-math__view" data-study-marker="true" dangerouslySetInnerHTML={{ __html: formulaDrawing(formula) }} />
      : <span key="pending" ref={view} className="reader-math__view reader-math__view--pending" data-study-marker="true">{formula.raw}</span>}
  </span>;
}, (before, after) => before.formula.raw === after.formula.raw);

/** Prose with its CJK line joins marked (a hidden newline between two lines, so selection and find see the stored text). */
const withJoins = (text, key) => lineBreakPieces(text).map((part, index) => typeof part === 'string' ? part : <span key={`${key}.${index}`} className="reader-join">{'\n'}</span>);

/** Text with $…$ / $$…$$ / \(…\) / \[…\] drawn as formulas; everything else, joins included when `join`, as it is stored. */
const withFormulas = (text, join) => splitStudyMath(text).flatMap((piece, at) => typeof piece !== 'string' ? [<ReaderFormula key={at} formula={piece} />]
  : join ? withJoins(piece, at) : [piece]);

/** A heading line: a Markdown "# " stays in the text, hidden like a transcript's 【】, and the formulas in it are drawn. */
function Heading({ text }) {
  const mark = headingMark(text);
  return <h4 className="reader-p reader-p--heading">{mark && <span className="reader-bracket" aria-hidden="true">{mark}</span>}{withFormulas(text.slice(mark.length))}</h4>;
}

/** A converter's page footnote (lib/footnote-html.js): a note element of React nodes, never the stored HTML and never its style. The stored tags stay in the
   text, hidden like a heading's "# " (reader-bracket), so selection, find and citations still count exactly the stored text; the words are drawn like prose, formulas included. */
function Footnote({ paragraph }) {
  return <p className="reader-p reader-p--footnote reader-footnote" role="note"><span className="reader-bracket" aria-hidden="true">{paragraph.open}</span>{withFormulas(paragraph.inner, true)}
    <span className="reader-bracket" aria-hidden="true">{paragraph.close}</span></p>;
}

/** A thematic break: a quiet rule. Its characters stay in the text, hidden like a heading's "# ", so selection, find and citations still count the stored text. */
function Rule({ text }) {
  return <div className="reader-p reader-p--rule"><span className="reader-bracket" aria-hidden="true">{text}</span><hr className="reader-rule" /></div>;
}

/** A transcript's label (【英文原句】, [Chinese translation]): a small caption over its text. Its brackets stay in the text, hidden like a heading's "# ". */
function Label({ text }) {
  const open = text.slice(0, 1), close = text.length > 1 ? text.slice(-1) : '';
  return <p className="reader-p reader-p--label"><span className="reader-bracket" aria-hidden="true">{open}</span>{text.slice(1, close ? -1 : undefined)}
    <span className="reader-bracket" aria-hidden="true">{close}</span></p>;
}

/* What a transcript writes at the start of a recording (80 "=", 《file》全量中英对照逐字稿, the English title, 80 "="): kept in the text, hidden like a heading's "# ", except the
   English title, which is the recording's quiet subtitle. In an English transcript the lines are the rule, "Full Bilingual Transcript: file", the title, the rule. */
const TITLE_LINE = /^(Full Bilingual Transcript:\s*)(.*)$/;
function Furniture({ paragraph }) {
  const lines = paragraph.text.split('\n'), zh = lines[1]?.startsWith('《'), at = lines.length >= 4 ? 2 : -1;
  return <p className="reader-p reader-p--furniture">{lines.map((line, index) => {
    const mark = index === at ? (zh ? TITLE_LINE.exec(line) : [line, '', line]) : null, text = index < lines.length - 1 ? `${line}\n` : line;
    return mark
      ? <React.Fragment key={index}><span className="reader-bracket" aria-hidden="true">{mark[1]}</span><span className="reader-furniture__title">{mark[2]}</span><span className="reader-bracket" aria-hidden="true">{'\n'}</span></React.Fragment>
      : <span key={index} className="reader-bracket" aria-hidden="true">{text}</span>;
  })}</p>;
}

const VISUAL_LABELS = Object.freeze({ image: '图片', chart: '图表', smartart: 'SmartArt 图形' });

function omittedVisualsLabel(visuals) {
  const list = [...new Set((Array.isArray(visuals) ? visuals : []).filter(kind => Object.hasOwn(VISUAL_LABELS, kind)))];
  return list.map(kind => ui(VISUAL_LABELS[kind])).join(ui('、'));
}

function unreadNoticeText({ page, format, skipped, omittedVisuals, canRenderImage }) {
  const slide = isSlideFormat(format);
  if (skipped) {
    if (slide) return uiFormat('第 {0} 张幻灯片仅含图片或没有可读文字，已跳过。', [page]);
    return canRenderImage
      ? uiFormat('第 {0} 页仅含图片或没有可读文字，已跳过。', [page])
      : uiFormat('第 {0} 页仅含图片或没有可读文字，已跳过；未附原 PDF，无法自动带本页截图。', [page]);
  }
  if (slide) {
    const names = omittedVisualsLabel(omittedVisuals);
    return names
      ? uiFormat('这一张幻灯片里的{0}没有读进来，文字版不包含这些内容（幻灯片不会自动附截图）。', [names])
      : ui('这一张幻灯片里的图片或图表没有读进来，文字版不包含这些内容（幻灯片不会自动附截图）。');
  }
  return canRenderImage
    ? ui('这一页里的图片或图表没有读进来，文字版不包含图里的内容。')
    : ui('这一页里的图片或图表没有读进来，文字版不包含图里的内容；未附原 PDF，无法自动带本页截图。');
}

function UnreadImageNotice({ page, text = '', omittedVisuals = [], skipped = false, unreadImages, visionState }) {
  const services = useContext(StudyServicesContext);
  const canHandOff = !!services;
  const host = services?.host, call = services?.call;
  const canChat = hasChatHost(host);
  const [request, setRequest] = useState('');
  const [drawing, setDrawing] = useState(false);
  const format = unreadImages?.format || '';
  const slide = isSlideFormat(format);
  const canRenderImage = !!unreadImages?.canRenderImage;
  const showVisionWarn = canHandOff && canChat && visionState === 'unsupported';
  const what = canRenderImage
    ? '把这一页的文字、本页图片和你的问题发给主会话'
    : (slide ? '把这一张幻灯片的文字、页码和你的问题发给主会话' : '把这一页的文字、页码和你的问题发给主会话');
  const copyWhat = canRenderImage
    ? '把这一页的文字、你的问题和已存到工作区的页面截图路径复制到剪贴板，贴进 agy CLI 即可看图'
    : (slide ? '把这一张幻灯片的文字、页码和你的问题复制到剪贴板，贴进 agy CLI 继续看图' : '把这一页的文字、页码和你的问题复制到剪贴板，贴进 agy CLI 继续看图');
  const buildInput = async () => {
    const handOff = {
      pages: 1,
      ...(unreadImages?.loadPageImages ? { loadImages: () => unreadImages.loadPageImages(page) } : {}),
    };
    const extra = unreadImages?.loadPageImages
      ? await pagePicture(host, handOff, setDrawing, { call })
      : {};
    return {
      title: unreadImages?.title || '',
      page,
      text: skipped ? '' : text,
      question: request.trim(),
      format,
      unreadImages: true,
      ...(omittedVisuals.length ? { omittedVisuals } : {}),
      ...(unreadImages?.original ? { original: unreadImages.original } : {}),
      ...extra,
    };
  };
  return (
    <div className="reader-unread" data-study-marker="true" data-find-skip="true" data-unread-page={page} role="note">
      <div className="reader-unread__head">
        <Icon name="info" className="sh-icon--inline reader-unread__icon" />
        <p className="reader-unread__text">{unreadNoticeText({ page, format, skipped, omittedVisuals, canRenderImage })}</p>
      </div>
      {showVisionWarn && (
        <p className="reader-unread__warn" data-vision-unsupported="true">{ui(VISION_UNSUPPORTED_NOTICE)}</p>
      )}
      {canHandOff && (
        <div className="reader-unread__controls">
          <TextInput
            size="sm"
            className="reader-unread__input"
            value={request}
            onChange={event => setRequest(event.target.value)}
            aria-label={ui('补充你的问题或需求')}
            placeholder={ui('补充你的问题或需求（可选）')}
          />
          <HandOff
            id="reader.page"
            shape="secondary"
            copyLabel="复制给 agy CLI"
            what={what}
            copyWhat={copyWhat}
            input={buildInput}
          />
        </div>
      )}
      {drawing && <p className="reader-unread__drawing" role="status">{uiFormat('正在画第 {0} 页的图…', [page])}</p>}
    </div>
  );
}

function interleaveSkipped(sections, skippedPages) {
  const skipped = (Array.isArray(skippedPages) ? skippedPages : [])
    .filter(Number.isInteger)
    .sort((a, b) => a - b);
  if (!skipped.length) return sections.map(section => ({ kind: 'section', section }));
  const existing = new Set(sections.filter(section => section.kind === 'page').map(section => section.page));
  const missing = [...new Set(skipped)].filter(page => !existing.has(page));
  if (!missing.length) return sections.map(section => ({ kind: 'section', section }));
  const items = [];
  let idx = 0;
  for (const section of sections) {
    if (section.kind === 'page') {
      while (idx < missing.length && missing[idx] < section.page) {
        items.push({ kind: 'skipped', page: missing[idx++] });
      }
    }
    items.push({ kind: 'section', section });
  }
  while (idx < missing.length) items.push({ kind: 'skipped', page: missing[idx++] });
  return items;
}

/**
 * Text sources set for reading. Each section keeps the markers the selection tools use:
 * data-study-page / data-study-source on a page, data-study-text around the paragraphs.
 * A transcript part's 【】 stay in the text (hidden, not removed), so a passage captured in
 * the plain 原文 view still finds its context here.
 * `scrollRoot` (a ref to the scroll area) draws the formulas as they come near the screen (ui/formula-queue.js); without it every one is drawn at once.
 * Memoised: a change of the reading position, a selection or a panel does not draw the chapter again (keep `labelOf` and `onPeek` stable).
 */
const ReadingSections = React.memo(function ReadingSections({ sections, labelOf, onPeek, peekHeld = false, scrollRoot, unreadImages = null }) {
  const services = useContext(StudyServicesContext);
  const visionState = useVisionState(services?.host, !!services && !!unreadImages);
  const [watch] = useState(() => scrollRoot ? createFormulaWatch(() => scrollRoot.current) : null);
  useEffect(() => () => watch?.disconnect(), [watch]);
  const drawn = <Sections sections={sections} labelOf={labelOf} onPeek={onPeek} peekHeld={peekHeld} unreadImages={unreadImages} visionState={visionState} />;
  return watch ? <FormulaWatch.Provider value={watch}>{drawn}</FormulaWatch.Provider> : drawn;
});
export default ReadingSections;

/** `peekHeld`: no 看原页 to press yet (the material is still opening), but each one keeps its place, hidden, so the page does not grow a line when it comes. */
function Sections({ sections, labelOf, onPeek, peekHeld, unreadImages, visionState }) {
  const entries = interleaveSkipped(sections, unreadImages?.skippedPages);
  return entries.map(entry => {
    if (entry.kind === 'skipped') {
      const skippedLabel = labelOf({ kind: 'page', page: entry.page });
      return <section key={`skipped-${entry.page}`} className="reader-section reader-section--skipped" data-skipped-page={entry.page} data-study-marker="true" data-find-skip="true">
        {skippedLabel && <header className="reader-section__head" data-find-skip="true">
          <span className="reader-section__label">{skippedLabel}</span>
          {onPeek && <Button variant="quiet" size="sm" className="reader-peek" data-peek-page={entry.page} onClick={event => onPeek(entry.page, { figure: true, trigger: event.currentTarget })}>{ui('看原页')}</Button>}
        </header>}
        <UnreadImageNotice page={entry.page} skipped unreadImages={unreadImages} visionState={visionState} />
      </section>;
    }
    const section = entry.section;
    const label = labelOf(section), paged = section.kind === 'page';
    const meta = unreadImages?.bySourceId?.get ? unreadImages.bySourceId.get(section.sourceId) : unreadImages?.bySourceId?.[section.sourceId];
    const omittedVisuals = Array.isArray(meta?.omittedVisuals) && meta.omittedVisuals.length
      ? meta.omittedVisuals
      : Array.isArray(section.omittedVisuals) ? section.omittedVisuals : [];
    const hasPlaceholder = paged && section.paragraphs.some(paragraph => isFigurePlaceholder(paragraph.text));
    const showUnreadNotice = paged && !!unreadImages && (Boolean(meta?.hasImages) || Boolean(section.hasImages) || omittedVisuals.length > 0 || hasPlaceholder);
    const sectionText = typeof meta?.text === 'string' ? meta.text : section.paragraphs.map(paragraph => paragraph.text).join('\n\n');
    return <section key={section.id} className={`reader-section reader-section--${section.kind}`} data-outline-id={section.kind === 'lead' ? undefined : section.id}
      {...(paged ? { 'data-study-page': section.page, 'data-study-source': section.sourceId } : {})}>
      {(label || (!paged && section.title)) && <header className="reader-section__head" data-find-skip={paged ? 'true' : undefined}>
        {label && <span className="reader-section__label">{label}</span>}
        {paged && (onPeek ? <Button variant="quiet" size="sm" className="reader-peek" data-peek-page={section.page} title={ui('看原页')} onClick={event => onPeek(section.page, { figure: false, trigger: event.currentTarget })}>{ui('看原页')}</Button>
          : peekHeld && <Button variant="quiet" size="sm" className="reader-peek" data-reserved="" aria-hidden="true" tabIndex={-1} disabled>{ui('看原页')}</Button>)}
        {!paged && section.title && <h3 className="reader-section__title">
          <span className="reader-bracket" aria-hidden="true">{section.open ?? '【'}</span>{section.title}<span className="reader-bracket" aria-hidden="true">{section.close ?? '】'}</span></h3>}
      </header>}
      <div className="reader-prose" data-study-text="true">
        {section.paragraphs.map((paragraph, index) => paged && onPeek && isFigurePlaceholder(paragraph.text)
          ? <p key={index} className="reader-p reader-p--figure">{paragraph.text}<span className="reader-peek-mark" data-study-marker="true"><button type="button" className="reader-peek" data-peek-page={section.page} data-peek-figure="true" title={ui('看原页')}
            onClick={event => onPeek(section.page, { figure: true, trigger: event.currentTarget })}>{ui('看原页')}</button></span></p>
          : paragraph.kind === 'rule'
          ? <Rule key={index} text={paragraph.text} />
          : paragraph.kind === 'footnote'
          ? <Footnote key={index} paragraph={paragraph} />
          : paragraph.kind === 'heading'
          ? <Heading key={index} text={paragraph.text} />
          : paragraph.kind === 'label'
          ? <Label key={index} text={paragraph.text} />
          : paragraph.kind === 'furniture'
          ? <Furniture key={index} paragraph={paragraph} />
          : <p key={index} className={`reader-p reader-p--${paragraph.kind}`}>{paragraph.kind === 'layout' && paragraph.text.startsWith('```')
            ? paragraph.text : withFormulas(paragraph.text, paragraph.kind === 'prose')}</p>)}
      </div>
      {showUnreadNotice && (
        <UnreadImageNotice page={section.page} text={sectionText} omittedVisuals={omittedVisuals} unreadImages={unreadImages} visionState={visionState} />
      )}
    </section>;
  });
}
