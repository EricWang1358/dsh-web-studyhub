import React from 'react';
import { ui } from '../i18n.js';
import canvasCss from './canvas.css';
import { useComponentCss, cx } from '../components/css.js';
import { Button, IconButton } from '../components/index.js';

/** Zoom out, the current zoom, zoom in and fit: the controls every canvas shares. `fitTitle` explains the fit button. */
export function ZoomControls({ zoomAt, fit, percent, disabled = false, fitTitle, variant = 'secondary' }) {
  useComponentCss(canvasCss, 'study-canvas');
  return (
    <>
      <IconButton icon="minus" size="sm" variant={variant} label={ui('缩小')} disabled={disabled} onClick={() => zoomAt(1 / 1.2)} />
      {percent != null && <output className="canvas-zoom-value" aria-label={ui('当前缩放')}>{percent}%</output>}
      <IconButton icon="plus" size="sm" variant={variant} label={ui('放大')} disabled={disabled} onClick={() => zoomAt(1.2)} />
      <Button size="sm" variant={variant} disabled={disabled} title={fitTitle} onClick={() => fit()}>{ui('适应')}</Button>
    </>
  );
}

/** The one fullscreen button; the label pair is 全屏查看 / 退出全屏 everywhere. */
export function FullscreenButton({ full, onToggle, title, ...rest }) {
  return <Button size="sm" aria-pressed={!!full} title={title} onClick={onToggle} {...rest}>{full ? ui('退出全屏') : ui('全屏查看')}</Button>;
}

/** The toolbar above a canvas: zoom controls, then whatever else the canvas offers (`children`). */
export function ZoomBar({ zoomAt, fit, percent, className, children }) {
  return (
    <div className={cx('skc-toolbar', className)}>
      <ZoomControls zoomAt={zoomAt} fit={fit} percent={percent} />
      {children}
    </div>
  );
}

export default ZoomBar;
