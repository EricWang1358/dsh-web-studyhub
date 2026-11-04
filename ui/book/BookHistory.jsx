import React, { useMemo, useRef, useState } from 'react';
import { ui, uiFormat, errorMessage } from '../i18n.js';
import { Badge, Button, Combobox, InlineMessage, LoadingState, SegmentedControl } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import { STRUCTURE_FILE } from '../../lib/course-book-own-titles.js';
import { fileText } from './model.js';
import { diffLines, formatHistoryTime } from './book-diff.js';

/* Read-only version & structure history panel for 复习全书 (#489 Item 8):
   - Shows each saved version of the selected file (version number, timestamp, character count, source: 你 / 程序 / AI),
   - Previews a line diff against the current saved file (or full text) and restores any chosen version non-destructively,
   - Lists up to 10 structure changes (rename / move / delete / place from 未归位), letting the latest active one be undone. */

function sourceLabel(by) {
  if (by === 'program') return ui('来源：程序');
  if (by === 'ai') return ui('来源：AI');
  return ui('来源：你');
}

function structureSummaryText(item) {
  if (item.kind === 'rename' && item.fromTitle && item.title) return uiFormat('改名：「{0}」→「{1}」', [item.fromTitle, item.title]);
  if (item.kind === 'move' && item.title) return uiFormat('移动：「{0}」', [item.title]);
  if (item.kind === 'delete' && item.title) return uiFormat('删除：「{0}」', [item.title]);
  if (item.kind === 'place' && item.title && item.targetTitle) return uiFormat('从「未归位」放回：「{0}」→「{1}」', [item.title, item.targetTitle]);
  if (item.kind === 'place' && item.targetTitle) return uiFormat('从「未归位」放回到「{0}」', [item.targetTitle]);
  return ui('调整目录');
}

export default function BookHistory({
  course, book, file, fileOptions = null, onPickFile, dirty = false, locked = false, initialData = null, initialMode = 'diff', onRestored,
}) {
  const { call, notify } = useStudy();
  const [data, setData] = useState(initialData);
  const [loading, setLoading] = useState(() => !initialData);
  const [pickedKey, setPickedKey] = useState('');
  const [mode, setMode] = useState(initialMode);
  const [restoring, setRestoring] = useState(false);
  const [undoingStructure, setUndoingStructure] = useState(false);
  const seeded = useRef(Boolean(initialData));

  useLiveEffect(isLive => {
    if (seeded.current) { seeded.current = false; return; }
    setLoading(true);
    call('course.book.revision', { course, history: true, file }).then(
      answer => { if (isLive()) { setData(answer); setLoading(false); } },
      failure => { if (isLive()) { setData({ error: failure }); setLoading(false); } },
    );
  }, [call, course, file, book?.revision, book?.structureVersion]);

  const versions = data?.versions || [];
  const structure = data?.structure || [];
  const keyOf = item => `${item.version}:${item.at}:${item.redo ? 'r' : 'v'}`;
  const selected = versions.find(item => keyOf(item) === pickedKey) ?? versions[0] ?? null;
  const currentSaved = useMemo(() => fileText(book, file), [book, file]);
  const diff = useMemo(() => (selected ? diffLines(selected.text, currentSaved) : null), [selected, currentSaved]);
  const busy = restoring || undoingStructure;

  const restoreVersion = async () => {
    if (!selected) return;
    setRestoring(true);
    try {
      const next = await call('course.book.revert', {
        course,
        file,
        entryVersion: selected.version,
        at: selected.at,
        ...(selected.redo ? { redo: true } : {}),
      });
      notify({ text: uiFormat('已恢复到第 {0} 版', [selected.version]), tone: 'success' });
      onRestored?.(next);
    } catch (failure) {
      notify({ text: errorMessage(failure), tone: 'error' });
    } finally {
      setRestoring(false);
    }
  };

  const undoLatestStructure = async () => {
    setUndoingStructure(true);
    try {
      const next = await call('course.book.revert', {
        course,
        file: STRUCTURE_FILE,
        version: book.structureVersion,
        answer: 'book',
      });
      notify({ text: ui('已撤销目录改动'), tone: 'success' });
      onRestored?.(next);
    } catch (failure) {
      notify({ text: errorMessage(failure), tone: 'error' });
    } finally {
      setUndoingStructure(false);
    }
  };

  return (
    <section className="book-history" aria-label={ui('版本历史')} data-book-history="">
      {fileOptions && onPickFile && (
        <div className="book-history__picker">
          <Combobox className="book-history__file" label={ui('要改的文件')} aria-label={ui('要改的文件')} searchPlaceholder={ui('搜索文件')}
            value={file} options={fileOptions} disabled={busy || locked} onChange={value => onPickFile(value)} />
        </div>
      )}
      {dirty && <InlineMessage tone="info">{ui('先保存或放弃当前未保存的改动，再恢复历史版本。')}</InlineMessage>}
      {loading ? <LoadingState inline label={ui('正在读取版本历史…')} /> : data?.error ? <InlineMessage tone="error">{errorMessage(data.error)}</InlineMessage> : (
        <>
          <div className="book-history__section">
            <div className="book-history__heading">{ui('当前文件的历史版本')}</div>
            {!versions.length ? <div className="book-history__empty">{ui('这份文件还没有更早的版本。')}</div> : (
              <div className="book-history__split">
                <div className="book-history__list" role="list">
                  {versions.map(item => {
                    const id = keyOf(item), active = selected && keyOf(selected) === id;
                    const stamp = formatHistoryTime(item.at);
                    return (
                      <div key={id} className="book-history__row" role="listitem">
                        <Button size="sm" variant={active ? 'secondary' : 'quiet'} className="book-history__select"
                          aria-pressed={active} lock={busy || locked} onClick={() => setPickedKey(id)}>
                          <span className="book-history__ver">{uiFormat('第 {0} 版', [item.version])}</span>
                          {stamp && <span className="book-history__meta">{stamp}</span>}
                          <span className="book-history__meta">{uiFormat('{0} 字', [item.chars])}</span>
                          <span className="book-history__meta">{sourceLabel(item.by)}</span>
                        </Button>
                        {item.redo && <Badge size="sm" tone="neutral">{ui('回退前留存')}</Badge>}
                      </div>
                    );
                  })}
                </div>
                {selected && (
                  <div className="book-history__preview">
                    <div className="book-history__toolbar">
                      <SegmentedControl size="sm" label={ui('版本历史')} value={mode} onChange={setMode} options={[
                        { value: 'diff', label: ui('差异对比') },
                        { value: 'full', label: ui('完整内容') },
                      ]} />
                      <Button size="sm" variant="secondary" icon="undo" className="book-history__restore"
                        disabled={dirty} busy={restoring} lock={locked || undoingStructure} onClick={restoreVersion}>
                        {ui('恢复这一版')}
                      </Button>
                    </div>
                    {mode === 'diff' ? (
                      diff?.identical ? <div className="book-history__empty">{ui('这一版与当前已保存内容相同。')}</div> : (
                        <>
                          <div className="book-history__legend">{ui('与当前已保存内容对比：− 这一版原有的行 · + 当前版本改写或新增的行')}</div>
                          <div className="book-history__diff" role="region" aria-label={ui('差异对比')}>
                            {diff.rows.map((row, idx) => (
                              row.kind === 'skip' ? (
                                <div key={`skip-${idx}`} className="book-history__line book-history__line--skip">
                                  {uiFormat('⋯ 省略 {0} 行相同内容', [row.count])}
                                </div>
                              ) : (
                                <div key={`line-${idx}`} className={`book-history__line book-history__line--${row.kind}`}>
                                  <span className="book-history__sign" aria-hidden="true">{row.kind === 'del' ? '−' : row.kind === 'add' ? '+' : ' '}</span>
                                  <span className="book-history__code">{row.text || ' '}</span>
                                </div>
                              )
                            ))}
                            {diff.truncated && (
                              <div className="book-history__line book-history__line--skip">
                                {uiFormat('⋯ 差异较长，仅展示前 {0} 行对比', [diff.rows.length])}
                              </div>
                            )}
                          </div>
                        </>
                      )
                    ) : (
                      <div className="book-history__full" role="region" aria-label={ui('完整内容')}>{selected.text || ''}</div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="book-history__section">
            <div className="book-history__heading">{ui('目录改动记录')}</div>
            {!structure.length ? <div className="book-history__empty">{ui('还没有目录改动记录。')}</div> : (
              <div className="book-history__struct-list" role="list">
                {structure.map(item => {
                  const stamp = formatHistoryTime(item.at);
                  return (
                    <div key={`struct-${item.version}-${item.at}`} className="book-history__struct-row" role="listitem">
                      <div className="book-history__struct-main">
                        <span className="book-history__struct-title">{structureSummaryText(item)}</span>
                        {stamp && <span className="book-history__meta">{stamp}</span>}
                      </div>
                      {item.undoable ? (
                        <Button size="sm" variant="quiet" icon="undo" className="book-history__struct-undo"
                          disabled={dirty} busy={undoingStructure} lock={locked || restoring} onClick={undoLatestStructure}>
                          {ui('撤销这次目录改动')}
                        </Button>
                      ) : (
                        <Badge size="sm" tone="neutral">
                          {item.active ? ui('更早的改动（只能撤最近一次）') : ui('总纲已重建，不再可撤')}
                        </Badge>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}
    </section>
  );
}
