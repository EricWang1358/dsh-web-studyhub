import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Badge, Button, DisclosureToggle, Hint, InlineMessage, LoadingState, foldLabel } from '../components/index.js';
import { EMPTY_NOTEBOOKS } from './map-model.js';
import { readText, writeText } from '../storage.js';

const OPEN_KEY = 'study-nb-dir-open';
const readOpen = () => readText(OPEN_KEY) !== '0';

/* Cross-workspace notebook directory. Entries are links, not copies: each
   published notebook's study data stays in its own workspace, and clicking a
   foreign entry opens a fresh conversation there. */
export default function NotebookDirectory({ notebooks, error, busy, onPublish, onUnpublish, onOpen, refresh, onSearch }) {
  const [open, setOpen] = useState(readOpen);
  const [query, setQuery] = useState(''), [searching, setSearching] = useState(false), [results, setResults] = useState(null), [searchError, setSearchError] = useState('');
  const searchRequest = useRef(0);
  useEffect(() => {
    searchRequest.current++;
    setResults(null);
    setSearchError('');
    setSearching(false);
  }, [notebooks]);
  const list = notebooks?.notebooks || EMPTY_NOTEBOOKS;
  /* Global due queue: every published notebook's due decks, due first. */
  const dueRows = useMemo(() => {
    const rows = [];
    for (const n of list) for (const d of n.decks || []) if (!d.archived && d.due > 0) rows.push({ n, d });
    return rows.sort((a, b) => b.d.due - a.d.due).slice(0, 8);
  }, [list]);
  if (!notebooks) return (
    <section className="nb-dir" aria-label={ui('全局笔记本目录')}>
      <div className="section-heading map-heading">
        <h2>{ui('全局笔记本')}</h2>
        <Button size="sm" onClick={refresh} disabled={busy}>{ui('刷新')}</Button>
      </div>
      {error ? <InlineMessage tone="error">{uiFormat('目录读取失败：{0}', [error])}</InlineMessage> : <LoadingState label={ui('正在读取全局笔记本目录…')} />}
    </section>
  );
  const current = list.find((n) => n.current), others = list.filter((n) => !n.current), published = list.filter((n) => n.publishedAt).length;
  const toggle = () => setOpen((value) => {
    writeText(OPEN_KEY, value ? '0' : '1'); // per-device only
    return !value;
  });
  const stats = (n) => (n.exists ? uiFormat('{0} 个题组{1}', [n.deckCount, n.dueToday ? uiFormat(' · {0} 道到期', [n.dueToday]) : '']) : ui('学习库目录已不可访问'));
  const topics = (n) => n.decks.filter((d) => !d.archived).slice(0, 4).map((d) => d.title).join(' · ');
  const runSearch = async (event) => {
    event.preventDefault();
    const q = query.trim();
    if (!q || !onSearch || searching) return;
    const request = ++searchRequest.current;
    setSearching(true);
    setSearchError('');
    setResults(null);
    try {
      const found = await onSearch(q);
      if (request === searchRequest.current) setResults(found);
    } catch (failure) {
      if (request === searchRequest.current) setSearchError(errorMessage(failure));
    } finally {
      if (request === searchRequest.current) setSearching(false);
    }
  };
  return (
    <section className="nb-dir" aria-label={ui('全局笔记本目录')}>
      <div className="section-heading map-heading">
        <h2>
          <DisclosureToggle className="map-fold" open={open} label={foldLabel(open, ui('全局笔记本'))} onToggle={toggle} />{' '}{ui('全局笔记本')}{' '}<span>{published}</span>
        </h2>
        <div className="section-heading-actions">
          <Button size="sm" onClick={refresh} disabled={busy} title={ui('重新读取全局目录')}>{ui('刷新')}</Button>
          {!error && (current?.publishedAt
            ? <Button size="sm" onClick={onUnpublish} disabled={busy}>{ui('取消发布')}</Button>
            : <Button size="sm" onClick={onPublish} disabled={busy} title={ui('把本工作区的学习笔记本登记到 ~/.dsh 全局目录，其他工作区可一键跳转到这里')}>{ui('发布到全局目录')}</Button>)}
        </div>
      </div>
      {error && <InlineMessage tone="error">{ui('目录读取失败，仍显示上次结果：')}{error}</InlineMessage>}
      {open && (
        <>
          {dueRows.length > 0 && (
            <div className="nb-due">
              <div className="eyebrow">{ui('全局到期 · 跨工作区')}</div>
              <ul className="nb-list">
                {dueRows.map(({ n, d }) => (
                  <li key={`${n.root}:${d.id}`}>
                    <button className="nb-row due" disabled={busy || !n.exists} title={n.exists ? uiFormat('在新对话中打开：{0}', [n.workspace]) : n.workspace} onClick={() => onOpen?.(n)}>
                      <span className="nb-main"><strong>{n.title}</strong><small className="nb-path">{d.title}</small></span>
                      <span className="nb-stats">{uiFormat('{0} 道到期', [d.due])}</span>
                      <span className="nb-go" aria-hidden="true">→</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <form className="nb-search" onSubmit={runSearch}>
            <input type="search" aria-label={ui('跨笔记本搜索')} placeholder={ui('跨笔记本搜索题组、主题或题目…')} value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} />
            <Button type="submit" busy={searching} disabled={!query.trim() || !onSearch}>{searching ? ui('搜索中…') : ui('搜索')}</Button>
          </form>
          {searchError && <InlineMessage tone="error">{ui('搜索失败：')}{searchError}</InlineMessage>}
          {results && (results.items?.length ? (
            <ul className="nb-list nb-results">
              {results.items.map((r, i) => (
                <li key={`${r.root}:${r.cardId || r.deckId}:${i}`}>
                  <button className="nb-row" disabled={busy} title={r.workspace} onClick={() => onOpen?.({ workspace: r.workspace })}>
                    <span className="nb-main"><strong>{r.deckTitle}{r.topic ? ` › ${r.topic}` : ''}</strong><small className="nb-path">{r.prompt || r.cardId || ''}</small></span>
                    <span className="nb-stats">{r.title}</span>
                    <span className="nb-go" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : !searching && <Hint className="nb-empty">{ui('没有匹配的内容。')}</Hint>)}
          {list.length ? (
            <ul className="nb-list">
              {current?.publishedAt && (
                <li className="nb-row current" title={current.workspace}>
                  <Badge tone="info">{ui('本工作区')}</Badge>
                  <span className="nb-main"><strong>{current.title}</strong><small>{topics(current) || stats(current)}</small></span>
                  <span className="nb-stats">{stats(current)}</span>
                </li>
              )}
              {others.map((n) => (
                <li key={n.root}>
                  <button className={`nb-row${n.exists ? '' : ' missing'}`} disabled={busy || !n.exists || !onOpen}
                    title={n.exists ? uiFormat('在新对话中打开：{0}', [n.workspace]) : n.workspace} onClick={() => onOpen?.(n)}>
                    <span className="nb-main"><strong>{n.title}</strong><small className="nb-path">{n.workspace}</small></span>
                    <span className="nb-stats">{stats(n)}</span>
                    <span className="nb-go" aria-hidden="true">→</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Hint className="nb-empty">{ui('还没有发布的笔记本。在某个工作区的学习库点「发布到全局目录」后，可以在这里跨工作区跳转：点击会新建该工作区的对话。')}</Hint>
          )}
        </>
      )}
    </section>
  );
}
