import React, { useState } from 'react';
import { useLiveEffect } from '../../use-async.js';
import { ui } from '../../i18n.js';
import { Button, InlineMessage, LoadingState, Tooltip } from '../../components/index.js';
import { stepZoom } from '../peek/peek-logic.js';
import PdfPageBar from './PdfPageBar.jsx';

/*
 * 原始 PDF (#488): the page controls, and the page drawn in place (peek/PdfPageView.jsx). The browser's viewer stays one press away for what only it does (finding in the whole
 * file, scrolling through it) and is what a file that cannot be drawn here falls back to. settings: { zoom, native }, the reader's, so they survive a visit to 阅读.
 */
export default function PdfOriginal({ fileUrl, title, page, total, onPage, settings, onSettings }) {
  const [failed, setFailed] = useState(false), native = settings.native || failed;
  // pdf.js lives in the peek's chunk, fetched when this view is first opened, never with the reader; a chunk that does not load falls back like a file that cannot be drawn.
  const [PdfPageView, setView] = useState(null);
  useLiveEffect((isLive) => {
    if (native || PdfPageView) return;
    import('../peek/PagePeek.jsx').then(module => { if (isLive()) setView(() => module.PdfPageView); }).catch(() => { if (isLive()) setFailed(true); });
  }, [native, PdfPageView]);
  const loadBytes = async () => new Uint8Array(await (await fetch(fileUrl)).arrayBuffer());
  return <div className="reader-original">
    <PdfPageBar page={page} total={total} onPage={onPage} zoom={native ? undefined : settings.zoom}
      onZoom={direction => onSettings({ zoom: direction ? stepZoom(settings.zoom, direction) : 1 })}>
      {!failed && <Tooltip layer content={ui(settings.native ? '一次画一页：翻页不重新载入，缩放不变，显示的就是面板问的那一页。' : '能在整份文件里查找、连续滚动；但每次翻页都会重新载入，缩放不保留。')}>
        <Button variant="link" size="sm" onClick={() => onSettings({ native: !settings.native })}>{ui(settings.native ? '回到单页视图' : '用浏览器的查看器')}</Button>
      </Tooltip>}
    </PdfPageBar>
    {failed && <InlineMessage tone="info">{ui('这份文件在这里画不出来，已换成浏览器的查看器。')}</InlineMessage>}
    {/* A new frame per page: the browser's PDF viewer ignores a later change of #page=, so the page asked about and the page shown would differ. */}
    {native ? <iframe key={page} src={`${fileUrl}#page=${page}`} title={title} />
      : PdfPageView ? <PdfPageView key={fileUrl} loadBytes={loadBytes} page={page} totalPages={total} zoom={settings.zoom} onPage={onPage} onFail={() => setFailed(true)} /> : <LoadingState label={ui('正在打开资料…')} />}
  </div>;
}
