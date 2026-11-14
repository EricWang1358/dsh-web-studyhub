import React from 'react';
import { createPortal } from 'react-dom';
import { ui, useUiLanguage } from './i18n.js';
import { Button, Dialog } from './components/index.js';
import { safeStudyImage } from './study-media.js';
import { useSciencePreferences } from './SciencePreferences.jsx';

const ZOOM_MIN = 1;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;
const clampZoom = value => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round(value * 100) / 100));

export default function StudyImage({ src, alt, interactive }) {
  const preferences = useSciencePreferences();
  interactive = interactive && preferences.imageEnlarge;
  useUiLanguage();
  const [failed, setFailed] = React.useState(false), [open, setOpen] = React.useState(false), [zoom, setZoom] = React.useState(1);
  const triggerRef = React.useRef(null), canvasRef = React.useRef(null);
  const safe = safeStudyImage(src);
  React.useEffect(() => { setFailed(false); setOpen(false); setZoom(1); }, [src]);
  const stop = event => event.stopPropagation();
  const zoomBy = React.useCallback(delta => setZoom(prev => clampZoom(prev + delta)), []);
  const resetZoom = React.useCallback(() => setZoom(1), []);
  const closeDialog = React.useCallback(() => {
    setOpen(false);
    setZoom(1);
    const restore = () => { if (triggerRef.current?.isConnected) triggerRef.current.focus({ preventScroll: true }); };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(restore);
    else restore();
  }, []);
  React.useEffect(() => {
    const node = canvasRef.current;
    if (!open || !node) return undefined;
    const onWheel = event => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [open, zoomBy]);
  const handleDialogKeyDown = event => {
    stop(event);
    if (event.altKey) return;
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      zoomBy(ZOOM_STEP);
    } else if (event.key === '-') {
      event.preventDefault();
      zoomBy(-ZOOM_STEP);
    } else if (event.key === '0') {
      event.preventDefault();
      resetZoom();
    }
  };
  const unavailable = ui('图片不可用');
  if (!safe || failed) return <span className="md-image-fallback" role="img" aria-label={alt ? alt + ': ' + unavailable : unavailable}>
    {alt && <span className="md-image-caption">{alt}</span>}<span>{unavailable}</span>
  </span>;
  const image = <img src={safe} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setFailed(true); setOpen(false); }} />;
  const host = typeof document === 'undefined' ? null : document.querySelector('.study-app') || document.body;
  const caption = alt && preferences.imageCaptions && <span className="md-image-caption">{alt}</span>;
  return <span className={'md-image' + (interactive ? '' : ' md-image-static')}>
    {interactive ? <button ref={triggerRef} type="button" className="md-image-open" aria-label={`${ui('放大图片')}${alt ? ': ' + alt : ''}`} onClick={event => { stop(event); setZoom(1); setOpen(true); }} onKeyDown={stop}>
      {image}<span className="md-image-info">{caption}<span className="md-image-action" aria-hidden="true">{ui('放大查看')}</span></span>
    </button> : <>{image}{caption}</>}
    {/* The dialog is portalled out of the text, and its events must not reach the card or row the image sits in. */}
    {open && host && createPortal(<span style={{ display: 'contents' }} onClick={stop} onKeyDown={handleDialogKeyDown}>
      <Dialog title={alt || ui('图片预览')} size="media" onClose={closeDialog}>
        <div className="md-image-toolbar" role="toolbar" aria-label={ui('缩放')}>
          <Button size="sm" variant="quiet" icon="minus" disabled={zoom <= ZOOM_MIN} onClick={() => zoomBy(-ZOOM_STEP)}>{ui('缩小')}</Button>
          <Button size="sm" variant="quiet" aria-label={ui('重设缩放')} onClick={resetZoom}>{`${Math.round(zoom * 100)}%`}</Button>
          <Button size="sm" variant="quiet" icon="plus" disabled={zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)}>{ui('放大')}</Button>
        </div>
        <div ref={canvasRef} className="md-image-dialog-canvas" data-zoomed={zoom > 1 ? 'true' : undefined}>
          <img
            src={safe}
            alt={alt}
            referrerPolicy="no-referrer"
            style={zoom > 1 ? { transform: `scale(${zoom})`, transformOrigin: 'top left' } : undefined}
            onError={() => { setFailed(true); setOpen(false); }}
          />
        </div>
      </Dialog>
    </span>, host)}
  </span>;
}
