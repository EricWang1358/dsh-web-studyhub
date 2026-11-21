import React, { useEffect, useState } from 'react';
import { useLiveEffect } from '../../use-async.js';
import { ui } from '../../i18n.js';
import { Button, InlineMessage, LoadingState, Tooltip } from '../../components/index.js';
import { stepZoom } from '../peek/peek-logic.js';
import PdfPageBar from './PdfPageBar.jsx';
import { isPagedUrl, originalBytes, pagedFailure } from '../peek/paged-original.js';

/*
 * 原始 PDF (#488): the page controls, and the page drawn in place (peek/PdfPageView.jsx). The browser's viewer stays one press away for what only it does (finding in the whole
 * file, scrolling through it) and is what a file that cannot be drawn here or blocks the main thread too long falls back to. settings: { zoom, native, slow, keepSinglePage },
 * the reader's, so they survive a visit to 阅读.
 */
export default function PdfOriginal({ fileUrl, title, page, total, onPage, settings, onSettings }) {
  // A paged original (too big to send whole) has no file for the browser's own viewer: it is always drawn here, a page at a time.
  const paged = isPagedUrl(fileUrl), [failed, setFailed] = useState(false), [retryKey, setRetryKey] = useState(0);
  const native = !paged && (settings.native || failed);
  const pagedSlow = paged && !failed && Boolean(settings.slow) && !settings.keepSinglePage;
  useEffect(() => { setFailed(false); setRetryKey(0); }, [fileUrl]);
  // pdf.js lives in the peek's chunk, fetched when this view is first opened, never with the reader; a chunk that does not load falls back like a file that cannot be drawn.
  const [PdfPageView, setView] = useState(null);
  useLiveEffect((isLive) => {
    if (native || PdfPageView) return;
    import('../peek/PagePeek.jsx').then(module => { if (isLive()) setView(() => module.PdfPageView); }).catch(() => { if (isLive()) setFailed(true); });
  }, [native, PdfPageView]);
  const loadBytes = () => originalBytes(fileUrl);
  const handlePage = next => {
    if (pagedSlow) onSettings({ native: false, slow: false });
    onPage?.(next);
  };
  const toggleNative = () => onSettings(settings.native
    ? { native: false, slow: false, keepSinglePage: Boolean(settings.slow || settings.keepSinglePage) }
    : { native: true, slow: false });
  const continuePagedSlow = () => onSettings({ native: false, slow: false, keepSinglePage: true });
  const retryPagedSlow = () => {
    onSettings({ native: false, slow: false });
    setRetryKey(count => count + 1);
  };
  return <div className="reader-original">
    <PdfPageBar page={page} total={total} onPage={handlePage} zoom={native ? undefined : settings.zoom}
      onZoom={direction => onSettings({ zoom: direction ? stepZoom(settings.zoom, direction) : 1 })}>
      {!failed && !paged && <Tooltip layer content={ui(settings.native ? '一次画一页：翻页不重新载入，缩放不变，显示的就是面板问的那一页。' : '能在整份文件里查找、连续滚动；但每次翻页都会重新载入，缩放不保留。')}>
        <Button variant="link" size="sm" onClick={toggleNative}>{ui(settings.native ? '回到单页视图' : '用浏览器的查看器')}</Button>
      </Tooltip>}
    </PdfPageBar>
    {failed && <InlineMessage tone="info">{paged ? pagedFailure(fileUrl) || ui('这份原文件现在打不开：它可能被移走或改动了。') : ui('这份文件在这里画不出来，已换成浏览器的查看器。')}</InlineMessage>}
    {!failed && native && settings.slow && <InlineMessage tone="info">{ui('这份文件单页绘制太慢，已换成浏览器的查看器，避免翻页卡顿。')}</InlineMessage>}
    {pagedSlow && <InlineMessage tone="info"
      action={{ label: ui('继续绘制这一页'), onClick: continuePagedSlow }}
      secondary={{ label: ui('重试'), onClick: retryPagedSlow }}>
      {ui('这一页绘制太慢；大文件按需读取，没法切到浏览器的查看器。你可以取消耗时限制继续绘制，或翻到其他页。')}
    </InlineMessage>}
    {/* A new frame per page: the browser's PDF viewer ignores a later change of #page=, so the page asked about and the page shown would differ. */}
    {native ? <iframe key={page} src={`${fileUrl}#page=${page}`} title={title} />
      : PdfPageView ? <PdfPageView key={fileUrl} loadBytes={loadBytes} page={page} totalPages={total} zoom={settings.zoom}
        budgetMs={settings.keepSinglePage ? Infinity : undefined} retryKey={retryKey} onPage={handlePage}
        onSlow={() => onSettings(paged ? { native: false, slow: true } : { native: true, slow: true })} onFail={() => setFailed(true)} /> : <LoadingState label={ui('正在打开资料…')} />}
  </div>;
}
