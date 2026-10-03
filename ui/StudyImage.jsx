import React from 'react';
import { createPortal } from 'react-dom';
import { useUiLanguage } from './i18n.js';
import { safeStudyImage } from './study-media.js';
import { useSciencePreferences } from './SciencePreferences.jsx';

export default function StudyImage({ src, alt, interactive }) {
  const preferences = useSciencePreferences();
  interactive = interactive && preferences.imageEnlarge;
  const language = useUiLanguage(), en = language === 'en';
  const [failed, setFailed] = React.useState(false), [open, setOpen] = React.useState(false);
  const dialog = React.useRef(null), trigger = React.useRef(null);
  const safe = safeStudyImage(src);
  React.useEffect(() => { setFailed(false); setOpen(false); }, [src]);
  React.useEffect(() => {
    if (!open || !dialog.current) return;
    const element = dialog.current, opener = trigger.current;
    element.showModal();
    return () => { element.close(); opener?.focus(); };
  }, [open]);
  const stop = event => event.stopPropagation();
  const unavailable = en ? 'Image unavailable' : '图片不可用';
  if (!safe || failed) return <span className="md-image-fallback" role="img" aria-label={alt ? alt + ': ' + unavailable : unavailable}>
    {alt && <span className="md-image-caption">{alt}</span>}<span>{unavailable}</span>
  </span>;
  const image = <img src={safe} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => { setFailed(true); setOpen(false); }} />;
  const host = typeof document === 'undefined' ? null : document.querySelector('.study-app') || document.body;
  const caption = alt && preferences.imageCaptions && <span className="md-image-caption">{alt}</span>;
  return <span className={'md-image' + (interactive ? '' : ' md-image-static')}>
    {interactive ? <button ref={trigger} type="button" className="md-image-open" aria-label={`${en ? 'Enlarge image' : '放大图片'}${alt ? ': ' + alt : ''}`} onClick={event => { stop(event); setOpen(true); }} onKeyDown={stop}>
      {image}<span className="md-image-info">{caption}<span className="md-image-action" aria-hidden="true">{en ? 'Enlarge' : '放大'}</span></span>
    </button> : <>{image}{caption}</>}
    {open && host && createPortal(<dialog ref={dialog} className="md-image-dialog" aria-label={alt || (en ? 'Image' : '图片')} onClose={() => setOpen(false)} onCancel={() => setOpen(false)} onClick={stop} onKeyDown={stop}>
      <div className="md-image-dialog-header">
        <p>{alt || (en ? 'Image' : '图片')}</p>
        <button type="button" className="md-image-close" autoFocus onClick={() => setOpen(false)}>{en ? 'Close' : '关闭'}</button>
      </div>
      <div className="md-image-dialog-canvas"><img src={safe} alt={alt} referrerPolicy="no-referrer" onError={() => { setFailed(true); setOpen(false); }} /></div>
    </dialog>, host)}
  </span>;
}
