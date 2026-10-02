import React from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { useInjectCss } from '../../shared.js';
import { Button } from '../../components/index.js';
import { ZOOMS } from './peek-logic.js';
import css from './peek.css';

/* 看原页: a small floating panel that shows ONE page of the attached original PDF next to the text, on demand. It never loads the
   PDF viewer: pdf.js (renderer.js, loaded on first use) draws that page into one canvas, small first and then sharp; the last six
   page bitmaps are kept for going back and forth; a render is cancelled when the page changes or the panel closes; closing frees
   the bitmaps and destroys the document. Without a usable original it says why in one line and offers 补全原文件 instead of an
   empty frame. The text has no pictures (a converted book keeps none): a figure is shown from the original page. */

/** The panel as markup, for every phase: 'loading' | 'ready' | 'error' | 'none' | 'mismatch'. */
export default function PagePeekView({ phase, page, total, zoom = 1, figure = false, busy = false, message = '', mismatch = null, issue = null,
  panelRef, canvasRef, scrollRef, onClose, onPrev, onNext, onZoom, onFit, onAttach, onRetry, onDragStart, onResizeStart, onGripKey, onKeyDown }) {
  useInjectCss(css, 'study-page-peek');
  const ready = phase === 'ready';
  return <div className="page-peek" role="dialog" aria-modal="false" aria-label={ui('原页预览')} tabIndex={-1} ref={panelRef} data-phase={phase} onKeyDown={onKeyDown}>
    {ready && <button type="button" className="page-peek__grip page-peek__grip--nw" aria-label={ui('从左上角调整大小（也可用方向键）')} title={ui('从左上角调整大小（也可用方向键）')}
      onPointerDown={onResizeStart?.('nw')} onKeyDown={onGripKey?.('nw')} />}
    <header className="page-peek__head" onPointerDown={onDragStart}>
      <strong className="page-peek__title">{ui('看原页')}</strong>
      <span className="page-peek__where" aria-live="polite">{uiFormat('第 {0} / {1} 页', [page, total])}</span>
      <div className="page-peek__tools">
        {ready && <>
          <Button size="sm" variant="quiet" aria-label={ui('上一页')} title={ui('上一页')} disabled={page <= 1} onClick={onPrev}><span aria-hidden="true">‹</span></Button>
          <Button size="sm" variant="quiet" aria-label={ui('下一页')} title={ui('下一页')} disabled={page >= total} onClick={onNext}><span aria-hidden="true">›</span></Button>
          <Button size="sm" variant="quiet" aria-label={ui('缩小')} title={ui('缩小')} disabled={zoom <= ZOOMS[0]} onClick={() => onZoom(-1)}><span aria-hidden="true">−</span></Button>
          <output className="page-peek__zoom" aria-live="polite">{Math.round(zoom * 100)}%</output>
          <Button size="sm" variant="quiet" aria-label={ui('放大')} title={ui('放大')} disabled={zoom >= ZOOMS.at(-1)} onClick={() => onZoom(1)}><span aria-hidden="true">＋</span></Button>
          <Button size="sm" variant="quiet" aria-label={ui('适合宽度')} title={ui('适合宽度')} onClick={onFit}><span aria-hidden="true">⤢</span></Button>
        </>}
        <Button size="sm" variant="quiet" aria-label={ui('关闭')} title={ui('关闭')} onClick={onClose}><span aria-hidden="true">×</span></Button>
      </div>
    </header>
    <div className="page-peek__body">
      {phase === 'loading' && <p className="page-peek__state" role="status"><span className="sh-spinner" aria-hidden="true" />{ui('正在读取原文件…')}</p>}
      {phase === 'none' && <div className="page-peek__state page-peek__state--note">
        <p>{issue?.kind && issue.kind !== 'none' && issue.message ? issue.message : ui('这份资料只保存了提取出的文字，没有原文件，所以看不到原页。')}</p>
        <Button size="sm" variant="secondary" icon="file" onClick={() => onAttach?.(issue?.kind && issue.kind !== 'none' ? 'relink' : 'attach')}>
          {issue?.kind && issue.kind !== 'none' ? ui('重新指定…') : ui('补全原文件…')}</Button>
      </div>}
      {phase === 'mismatch' && <div className="page-peek__state page-peek__state--note" role="alert">
        <p>{uiFormat('文字版共 {0} 页，原文件有 {1} 页：页码对不上，为避免看错页，这里不显示。', [mismatch?.totalPages, mismatch?.pdfPages])}</p>
        <Button size="sm" variant="secondary" onClick={() => onAttach?.('relink')}>{ui('重新指定…')}</Button>
      </div>}
      {phase === 'error' && <div className="page-peek__state page-peek__state--note" role="alert">
        <p>{uiFormat('这一页没能显示：{0}', [message])}</p>
        <Button size="sm" variant="secondary" onClick={onRetry}>{ui('重试')}</Button>
      </div>}
      {ready && <div className="page-peek__scroll" ref={scrollRef} tabIndex={0} role="region" aria-label={ui('原页')} data-fit={zoom === 1 ? 'true' : 'false'}>
        <canvas ref={canvasRef} className="page-peek__canvas" role="img" aria-label={uiFormat('原文件第 {0} 页', [page])} />
      </div>}
      {ready && busy && <p className="page-peek__busy" role="status">{ui('正在绘制…')}</p>}
      {ready && figure && <p className="page-peek__note">{ui('文字版不含图片：这里直接显示原文件的这一页。')}</p>}
    </div>
    {ready && <footer className="page-peek__foot">
      <button type="button" className="page-peek__grip page-peek__grip--se" aria-label={ui('拖动调整大小（也可用方向键）')} title={ui('拖动调整大小（也可用方向键）')}
        onPointerDown={onResizeStart?.('se')} onKeyDown={onGripKey?.('se')} />
    </footer>}
  </div>;
}
