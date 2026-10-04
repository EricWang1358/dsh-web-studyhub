import React from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Button, Dialog, useToast } from '../../components/index.js';
import { RelatedTasks } from '../../DailyPlan.jsx';
import { DocumentViewer } from '../../workspace-views.jsx';
import { ReaderHeading } from '../../document-preview/RenameTitle.jsx';
import { documentSourceIds } from '../../../lib/source-groups.js';
import { useApp } from '../app-context.js';

/** The reader: a material full-size, with the questions and tasks that belong to it. Opens at a quote or where the learner stopped reading. */
export default function SourceReaderDialog({ modal, onClose }) {
  const { data, host, core, nav, learn, intents, dailyPlan, selectionNotices } = useApp();
  const { call, act, busy, refresh } = core;
  const toast = useToast();
  const source = modal.source;
  const title = source
    ? <ReaderHeading data={data} source={source} act={act} call={call}
      onRenamed={(done) => toast.success(done.status === 'renamed' ? uiFormat('已重命名为「{0}」', [done.title]) : ui('名称没有变化'))} />
    : ui('资料不可用');
  return (
    <Dialog title={title} size="full" className="source-preview" bodyLabel={ui('资料内容')} guardDrops onClose={onClose}>
      {modal.quote && !source && <blockquote className="highlight-quote">{modal.quote}</blockquote>}
      {source ? (
        <>
          <RelatedTasks plan={dailyPlan} reference={{ root: data.root, kind: 'source', id: source.id }} onBoard={() => { onClose(); nav.navigate('board'); }} />
          {!!source.usedBy?.length && (
            <div className="source-connections">
              <small className="muted">{ui('使用这份资料的题组')}</small>
              {source.usedBy.map((deck) => (
                <Button key={`${deck.kind}:${deck.id}`} variant="quiet" size="sm" disabled={busy || deck.kind === 'draft'}
                  onClick={() => learn.openLearningTarget({ kind: 'deck', id: deck.id })}>
                  {deck.archived ? uiFormat('{0} · 已归档', [deck.title]) : deck.title}
                </Button>
              ))}
            </div>
          )}
          <DocumentViewer source={source} quote={modal.quote} call={call} data={data} host={host} generateDisabled={busy}
            onGenerate={() => intents.goGenerate({ sourceIds: documentSourceIds(data.sources, source.id), remember: true, closeModal: true })}
            onPublished={() => refresh()} onOpenCard={(reference) => { onClose(); learn.openLearningTarget({ kind: 'card', ...reference }); }}
            onOpenDeck={(deckId) => learn.openLearningTarget({ kind: 'deck', id: deckId })}
            onPractice={({ deckId, cardIds }) => learn.openLearningTarget({ kind: 'cards', deckId, cardIds })}
            onPracticePages={intents.practiceFromReading}
            onGeneratePages={(ids) => intents.goGenerate({ sourceIds: ids, remember: true, closeModal: true })} resume={modal.resume}
            backLabel={modal.back ? ui('回到这道题') : undefined} onBack={modal.back ? onClose : undefined}
            onStarted={(started) => { selectionNotices.track(started.jobId); return refresh(); }}
            onCaseFromPassage={(passage) => intents.goGenerate({ source: 'case', remember: true, closeModal: true,
              caseInitial: { sourceIds: documentSourceIds(data.sources, source.id), focus: passage.quote, nonce: Date.now() } })} />
        </>
      ) : <p className="muted">{ui('无法找到此资料。')}</p>}
    </Dialog>
  );
}
