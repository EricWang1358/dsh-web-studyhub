import React, { useEffect, useState } from 'react';
import { ui, uiFormat, errorMessage } from './i18n.js';
import { useStudy } from './study-context.jsx';
import { useInjectCss } from './shared.js';
import { useCopyFeedback } from './use-copy-feedback.js';
import { formatBytes, formatDateTime } from './format.js';
import { DiagramFrame } from './diagram-frame.js';
import { Badge, Button, ConfirmDialog, Dialog, InlineMessage, LoadingState } from './components/index.js';
import css from './skeleton-companion.css';

/* 交互图: the diagrams a skeleton carries (docs/companions.md). The learner's agent drew each one with an outside tool (Archify) and
   registered it with skeleton.diagram.attach; the library keeps a copy. Here they are listed (title, date, size, and whether the skeleton
   changed since), opened in the isolated frame of ui/diagram-frame.js, and deleted. StudyHub never runs, edits or sends the file. */

/** The rows the list shows, from the skeleton's records: a plain size and date, and whether the skeleton changed since. */
export function diagramRows(diagrams, revision) {
  return (diagrams || []).map((diagram) => ({ id: diagram.id, title: diagram.title, size: formatBytes(diagram.bytes), date: formatDateTime(diagram.createdAt, 'stamp'),
    // skeleton.diagram.list says it; the skeleton record itself carries the revision each diagram was drawn from.
    stale: diagram.stale ?? (revision !== undefined && diagram.skeletonRevision !== revision) }));
}

/** One diagram in the isolated frame: a failed or tampered file says why in plain words and shows nothing. */
function DiagramViewer({ skeletonId, row, onClose }) {
  const { call, host } = useStudy();
  const [state, setState] = useState({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    call('skeleton.diagram.get', { id: skeletonId, diagramId: row.id })
      .then((result) => { if (live) setState({ status: 'ready', html: result.html, file: result.file }); })
      .catch((failure) => { if (live) setState({ status: 'failed', text: errorMessage(failure) || ui('这张图暂时读不出来。') }); });
    return () => { live = false; };
  }, [call, skeletonId, row.id, attempt]);
  const copy = useCopyFeedback(() => state.file || '');
  const openFile = typeof host?.openFile === 'function' && state.file ? () => host.openFile(state.file) : null;
  return (
    <Dialog size="full" title={row.title} description={ui('这是外部生成的图，在隔离窗口里显示')} onClose={onClose}
      footer={state.status === 'ready' && (
        <div className="sk-diagram-foot">
          <span className="sk-diagram-links muted small">{ui('里面的链接不会在这里打开。')}</span>
          <Button size="sm" variant="quiet" icon={copy.copied ? 'check' : undefined} onClick={copy.copy}>{copy.copied ? ui('已复制') : ui('复制文件路径')}</Button>
          {openFile && <Button size="sm" onClick={openFile}>{ui('在浏览器中打开')}</Button>}
        </div>
      )}>
      {state.status === 'loading' && <LoadingState label={ui('正在读取这张图…')} />}
      {state.status === 'failed' && <InlineMessage tone="error" boxed action={{ label: ui('重试'), onClick: () => setAttempt((n) => n + 1) }}>{state.text}</InlineMessage>}
      {state.status === 'ready' && <DiagramFrame html={state.html} title={ui('外部生成的交互图')} />}
    </Dialog>
  );
}

export default function SkeletonDiagrams({ skeletonId, diagrams, revision }) {
  const { act } = useStudy();
  useInjectCss(css, 'study-skeleton-companion');
  const [opened, setOpened] = useState(null);
  const [removing, setRemoving] = useState(null);
  const rows = diagramRows(diagrams, revision);
  if (!rows.length) return null;
  return (
    <section className="sk-diagrams" aria-label={ui('交互图')}>
      <h4 className="sk-diagrams__title">{ui('交互图')} <span className="muted">{rows.length}</span></h4>
      <ul className="sk-diagrams__list">
        {rows.map((row) => (
          <li key={row.id} className="sk-diagrams__row">
            <div className="sk-diagrams__main">
              <strong className="sk-diagrams__name">{row.title}</strong>
              <small className="muted">{[row.date, row.size].filter(Boolean).join(' · ')}</small>
              {row.stale && <Badge tone="warning" className="sk-diagrams__stale">{ui('骨架已更新，图可能过期')}</Badge>}
            </div>
            <div className="sk-diagrams__actions">
              <Button size="sm" onClick={() => setOpened(row)}>{ui('打开')}</Button>
              <Button size="sm" variant="quiet" onClick={() => setRemoving(row)}>{ui('删除')}</Button>
            </div>
          </li>
        ))}
      </ul>
      {opened && <DiagramViewer skeletonId={skeletonId} row={opened} onClose={() => setOpened(null)} />}
      {removing && (
        <ConfirmDialog title={uiFormat('删除图「{0}」？', [removing.title])} description={ui('只删这张图在学习库里的副本，不影响骨架，也不影响你工作目录里的原文件。')}
          confirmLabel={ui('删除')} onClose={() => setRemoving(null)}
          onConfirm={() => act('skeleton.diagram.remove', { id: skeletonId, diagramId: removing.id }, undefined, { rethrow: true })} />
      )}
    </section>
  );
}
