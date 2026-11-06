import React, { useState } from 'react';
import { ui, uiFormat } from '../../i18n.js';
import { Dialog, useToast } from '../../components/index.js';
import { relatedTaskItems } from '../../DailyPlan.jsx';
import { DocumentViewer } from '../../workspace-views.jsx';
import { ReaderHeading } from '../../document-preview/RenameTitle.jsx';
import { documentSourceIds } from '../../../lib/source-groups.js';
import { draftToOpen } from '../../document-preview/practice/practice-range.js';
import { useApp } from '../app-context.js';

/** The reader: a material full-size, with the questions and tasks that belong to it. Opens at a quote or where the learner stopped reading. */
export default function SourceReaderDialog({ modal, onClose }) {
  const { data, host, core, nav, learn, intents, drafts, dailyPlan, selectionNotices, settingsEntry } = useApp();
  const { call, act, busy, refresh } = core;
  const toast = useToast();
  const source = modal.source;
  // The reader is a dialog over the page: a Settings page opened from it is not seen unless the dialog goes (the host's own model settings open beside it and the reader stays).
  const openSettings = (section) => { onClose(); settingsEntry.openSettings(section); };
  const openModelSettings = () => { if (!host.openModelSettings) onClose(); settingsEntry.openModelSettings(); };
  // What the reader's 更多 adds (the rename, today's tasks, the question sets): they were buttons above the reader, and are items of its menu now.
  const [renameRequest, setRenameRequest] = useState(0);
  const moreItems = !source ? [] : [
    ...(data.sources?.some(item => item.id === source.id) ? [{ id: 'rename', icon: 'edit', label: ui('重命名…'), run: () => setRenameRequest(count => count + 1) }] : []),
    ...relatedTaskItems({ plan: dailyPlan, reference: { root: data.root, kind: 'source', id: source.id }, onBoard: () => { onClose(); nav.navigate('board'); } }),
    ...(source.usedBy || []).map(deck => ({ id: `deck:${deck.kind}:${deck.id}`, icon: 'book', label: deck.archived ? uiFormat('{0} · 已归档', [deck.title]) : deck.title, hint: ui('题组'),
      disabled: busy || deck.kind === 'draft', run: () => learn.openLearningTarget({ kind: 'deck', id: deck.id }) })),
  ];
  const title = source
    ? <ReaderHeading data={data} source={source} act={act} call={call} renameRequest={renameRequest}
      onRenamed={(done) => toast.success(done.status === 'renamed' ? uiFormat('已重命名为「{0}」', [done.title]) : ui('名称没有变化'))} />
    : ui('资料不可用');
  return (
    <Dialog title={title} size="full" className="source-preview" bodyLabel={ui('资料内容')} guardDrops onClose={onClose}>
      {modal.quote && !source && <blockquote className="highlight-quote">{modal.quote}</blockquote>}
      {source ? (
        <>
          <DocumentViewer source={source} quote={modal.quote} moreItems={moreItems} call={call} data={data} host={host} generateDisabled={busy}
            onOpenModelSettings={openModelSettings} onOpenSettings={openSettings}
            onGenerate={() => intents.goGenerate({ sourceIds: documentSourceIds(data.sources, source.id), remember: true, closeModal: true })}
            onPublished={() => refresh()} onOpenCard={(reference) => { onClose(); learn.openLearningTarget({ kind: 'card', ...reference }); }}
            onOpenDeck={(deckId) => learn.openLearningTarget({ kind: 'deck', id: deckId })}
            onPractice={({ deckId, cardIds }) => learn.openLearningTarget({ kind: 'cards', deckId, cardIds })}
            onPracticePages={intents.practiceFromReading}
            onGeneratePages={(ids) => intents.goGenerate({ sourceIds: ids, remember: true, closeModal: true })} resume={modal.resume}
            onOpenDraftPages={(draftIds) => {
              // The questions of these pages are still in a draft: the same 草稿 page the home card and 检查草稿 open.
              const draft = draftToOpen(draftIds, data.drafts);
              if (!draft) { toast.error(ui('这份草稿已经不在了，可能已发布或删除。')); return; }
              onClose(); drafts.openDraft(draft, { navigation: true });
            }}
            backLabel={modal.back ? ui('回到这道题') : undefined} onBack={modal.back ? onClose : undefined}
            onStarted={(started) => { selectionNotices.track(started.jobId); return refresh(); }}
            onCaseFromPassage={(passage) => intents.goGenerate({ source: 'case', remember: true, closeModal: true,
              caseInitial: { sourceIds: documentSourceIds(data.sources, source.id), focus: passage.quote, nonce: Date.now() } })} />
        </>
      ) : <p className="muted">{ui('无法找到此资料。')}</p>}
    </Dialog>
  );
}
