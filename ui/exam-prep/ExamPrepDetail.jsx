import React, { useMemo, useState } from 'react';
import { ui, uiFormat } from '../i18n.js';
import { formatDateTime, formatList, joinMeta } from '../format.js';
import { Badge, Button, ConfirmDialog, ErrorState, PageHeader, SegmentedControl, TextInput } from '../components/index.js';
import { useStudy } from '../study-context.jsx';
import { useLiveEffect } from '../use-async.js';
import Explain from './Explain.jsx';
import PointTree from './PointTree.jsx';
import { buildTree, countPoints, filterTree, skippedPages, unmatchedQuestions } from './model.js';
import { basisLine, countsLine, staleNote, tierName } from './words.js';

/* 备考补习, the detail view of one 考点清单: its basis and counts, the points (filter, search, places with 看原页), and what the build could not
   place: sample-paper questions with no point and slides with no readable text. 重新生成 asks again with the same inputs (a new version that
   replaces this one); a list whose materials changed since it was made says so, and offers nothing else than the same 重新生成. */

/** Delete = archive, then remove with the confirmation the dialog just took (the library's own two steps). */
export async function deleteList(act, id) {
  const archived = await act('source.archive', { sourceIds: [id], archived: true }, undefined, { rethrow: true, refreshAfter: false });
  if (archived === undefined) throw new Error(ui('另一个操作还在进行，请稍后重试。'));
  await act('source.remove', { sourceIds: [id], confirm: true }, undefined, { rethrow: true });
}

function Sections({ blueprint }) {
  const unmatched = unmatchedQuestions(blueprint), skipped = skippedPages(blueprint), book = blueprint.recommendedReading;
  return (
    <>
      {unmatched.length > 0 && (
        <section className="exam-prep-section" data-section="unmatched">
          <h2 className="exam-prep-section__title"><Explain k="unmatched" focusable>{ui('样卷里没对上的题')}</Explain></h2>
          <p className="exam-prep-section__body">{formatList(unmatched)}</p>
        </section>
      )}
      {skipped.length > 0 && (
        <section className="exam-prep-section" data-section="skipped">
          <h2 className="exam-prep-section__title"><Explain k="skipped" focusable>{ui('没有可读文字的课件页')}</Explain></h2>
          <ul className="exam-prep-section__list">
            {skipped.map(item => <li key={item.title}>{uiFormat('{0}：第 {1} 页', [item.title, item.pages.join('、')])}</li>)}
          </ul>
        </section>
      )}
      {book && (
        <section className="exam-prep-section" data-section="reading">
          <h2 className="exam-prep-section__title"><Explain k="reading" focusable>{ui('推荐阅读')}</Explain></h2>
          <p className="exam-prep-section__body">{joinMeta([book.title, book.author, book.note])}{book.url ? <> · <a href={book.url} target="_blank" rel="noreferrer noopener">{book.url}</a></> : null}</p>
        </section>
      )}
    </>
  );
}

/** The whole record of a list (`source.get`: the snapshot carries only its summary). A record never changes under its id, so it is read once. */
export function useListRecord(call, id) {
  const [state, setState] = useState({ status: 'loading' });
  useLiveEffect(live => {
    setState({ status: 'loading' });
    Promise.resolve().then(() => call('source.get', { id, limit: 1 })).then(
      record => { if (live()) setState(record?.blueprint ? { status: 'ready', record } : { status: 'error' }); },
      error => { if (live()) setState({ status: 'error', error }); });
  }, [id]);
  return state;
}

/** The detail view: everything the summary knows at once (header, basis, counts, filter), the points and the leftovers when the record has been read. */
export default function ExamPrepDetail(props) {
  const { call } = useStudy();
  const loaded = useListRecord(call, props.row.id);
  return <ExamPrepDetailView {...props} blueprint={loaded.status === 'ready' ? loaded.record.blueprint : null} failure={loaded.status === 'error' ? loaded : null} />;
}

export function ExamPrepDetailView({ row, blueprint = null, failure = null, onBack, onOpenSource, onOpenTask, onRegenerate, onDeleted }) {
  const { act, busy } = useStudy();
  const tree = useMemo(() => blueprint ? buildTree(blueprint.points) : null, [blueprint]);
  const counts = useMemo(() => tree ? countPoints(tree) : row.counts, [tree, row.counts]);
  const [tier, setTier] = useState('all'), [query, setQuery] = useState(''), [deleting, setDeleting] = useState(false);
  const roots = useMemo(() => tree ? filterTree(tree, { tier, query }) : [], [tree, tier, query]);
  const searching = query.trim().length > 0;
  const options = [{ value: 'all', label: uiFormat('全部 {0}', [counts.total]) }, { value: 'must', label: `${tierName('must')} ${counts.must}` },
    { value: 'extra', label: `${tierName('extra')} ${counts.extra}` }];
  const basis = blueprint?.basis ?? row.basis;
  const meta = joinMeta([row.scope, row.course, row.updatedAt ? formatDateTime(row.updatedAt, 'short') : '']);
  const ready = !!tree;
  return (
    <section className="page exam-prep" data-usage-area="examprep">
      <PageHeader title={row.title} description={meta || undefined} back={{ label: ui('返回考点清单'), onClick: onBack }}
        actions={<>
          <Explain k="regenerate"><Button variant="secondary" icon="refresh" data-usage="examprep.regenerate" disabled={busy || !ready || !!row.build} onClick={() => onRegenerate(row, blueprint)}>{ui('重新生成')}</Button></Explain>
          <Explain k="delete"><Button variant="quiet" icon="trash" data-usage="examprep.delete" disabled={busy} onClick={() => setDeleting(true)}>{ui('删除')}</Button></Explain>
        </>} />
      <div className="exam-prep-summary">
        <Explain k="basis" focusable className="exam-prep-summary__basis">{basisLine(basis)}</Explain>
        <span className="exam-prep-summary__counts">{countsLine(counts)}</span>
        {row.stale && !row.archived && <Badge size="sm" tone="warning" icon="warning" className="exam-prep-summary__stale">{staleNote()}</Badge>}
        {row.build && (
          <span className="exam-prep-row__state">
            <Explain k="building" focusable><Badge size="sm" tone="accent" dot>{ui('正在重新生成')}</Badge></Explain>
            <Button variant="link" size="sm" onClick={() => onOpenTask(row.build.taskId)}>{ui('在任务里查看')}</Button>
          </span>
        )}
      </div>
      <div className="exam-prep-toolbar">
        <SegmentedControl label={ui('按类别筛选')} size="sm" value={tier} options={options} onChange={setTier} disabled={!ready} data-usage="examprep.filter" />
        <TextInput type="search" className="exam-prep-search" value={query} onChange={event => setQuery(event.target.value)} disabled={!ready}
          placeholder={ui('搜索考点或原文')} aria-label={ui('搜索考点或原文')} />
      </div>
      {failure ? <ErrorState title={ui('读不出这份考点清单')} error={failure.error || ui('记录里没有考点。')} />
        : !ready ? <div className="exam-prep-tree is-loading" role="status" aria-busy="true" aria-label={ui('正在读取考点')} />
          : roots.length ? <PointTree roots={roots} basis={basis} forceOpen={searching} onOpenSource={onOpenSource} label={ui('考点')} />
            : <p className="exam-prep-none" role="status">{ui('没有符合的考点。')}</p>}
      {ready && <Sections blueprint={blueprint} />}
      {deleting && (
        <ConfirmDialog title={uiFormat('删除「{0}」？', [row.title])} confirmLabel={ui('删除')} onClose={() => setDeleting(false)}
          onConfirm={() => deleteList(act, row.id)} onDone={() => { setDeleting(false); onDeleted(row); }}>
          <p>{ui('这份考点清单会从备考补习移除，无法恢复。课件和样卷不受影响。')}</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
