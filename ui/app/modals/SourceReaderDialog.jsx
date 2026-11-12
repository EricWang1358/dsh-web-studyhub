import React, { useState } from 'react';
import { errorMessage, ui, uiFormat } from '../../i18n.js';
import { Dialog, useToast } from '../../components/index.js';
import { relatedTaskItems } from '../../DailyPlan.jsx';
import { DocumentViewer } from '../../workspace-views.jsx';
import { ReaderHeading } from '../../document-preview/RenameTitle.jsx';
import { documentSourceIds } from '../../../lib/source-groups.js';
import { draftToOpen } from '../../document-preview/practice/practice-range.js';
import { hasContext, pageAvailable } from '../../capabilities.js';
import { useApp } from '../app-context.js';

/** The reader: a material full-size, with the questions and tasks that belong to it. Opens at a quote or where the learner stopped reading. */
export default function SourceReaderDialog({ modal, onClose }) {
  const { data, host, core, nav, learn, intents, drafts, dailyPlan, selectionNotices, settingsEntry, set } = useApp();
  const { call, act, busy, refresh } = core;
  const toast = useToast();
  const source = modal.source;
  const canGenerate = pageAvailable(data, 'generate');
  const canPractice = hasContext(data, 'bank') && hasContext(data, 'study');
  const canDraft = pageAvailable(data, 'draft');
  const canBank = hasContext(data, 'bank');
  // The reader is a dialog over the page: a Settings page opened from it is not seen unless the dialog goes (the host's own model settings open beside it and the reader stays).
  const openSettings = (section) => { onClose(); settingsEntry.openSettings(section); };
  const openModelSettings = () => { if (!host.openModelSettings) onClose(); settingsEntry.openModelSettings(); };
  // What the reader's 更多 adds (the rename, today's tasks, the question sets): they were buttons above the reader, and are items of its menu now.
  const [renameRequest, setRenameRequest] = useState(0);
  const moreItems = !source ? [] : [
    ...(data.sources?.some(item => item.id === source.id) ? [{ id: 'rename', icon: 'edit', label: ui('重命名…'), run: () => setRenameRequest(count => count + 1) }] : []),
    ...(dailyPlan ? relatedTaskItems({ plan: dailyPlan, reference: { root: data.root, kind: 'source', id: source.id }, onBoard: () => { onClose(); nav.navigate('board'); } }) : []),
    ...(canBank ? (source.usedBy || []) : []).map(deck => ({ id: `deck:${deck.kind}:${deck.id}`, icon: 'book', label: deck.archived ? uiFormat('{0} · 已归档', [deck.title]) : deck.title, hint: ui('题组'),
      disabled: busy || deck.kind === 'draft' || !canPractice, run: () => learn.openLearningTarget({ kind: 'deck', id: deck.id }) })),
  ];
  // 今日 「重读 N 段」 (#1018): 已重读 keeps the time on the mark (materials.marks.seen), then the reader moves on to the next passage; after the last one it stays where it is.
  const rereadItems = modal.reread?.items || [], rereadAt = modal.reread?.index ?? 0, rereadItem = rereadItems[rereadAt];
  const reread = source && rereadItem ? { position: rereadAt + 1, total: rereadItems.length, onDone: async () => {
    try {
      await call('materials.marks.seen', { sourceId: rereadItem.selection.sourceId, revision: rereadItem.revision, id: rereadItem.id });
    } catch (cause) { toast.error(errorMessage(cause)); return; }
    void refresh();
    const next = rereadItems[rereadAt + 1], nextSource = next && data.sources?.find(item => item.id === next.selection.sourceId);
    if (nextSource) { set.setModal({ ...modal, source: { ...nextSource, selection: next.selection }, quote: next.selection.quote, reread: { items: rereadItems, index: rereadAt + 1 } }); return; }
    toast.success(ui('今天要重读的段落都读完了'));
    set.setModal({ ...modal, reread: null });
  } } : null;
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
            onGenerate={canGenerate ? () => intents.goGenerate({ sourceIds: documentSourceIds(data.sources, source.id), remember: true, closeModal: true }) : undefined}
            onPublished={() => refresh()} onOpenCard={canBank ? (reference) => { onClose(); learn.openLearningTarget({ kind: 'card', ...reference }); } : undefined}
            onOpenDeck={canPractice ? (deckId) => learn.openLearningTarget({ kind: 'deck', id: deckId }) : undefined}
            onPractice={canPractice ? ({ deckId, cardIds }) => learn.openLearningTarget({ kind: 'cards', deckId, cardIds }) : undefined}
            onPracticePages={canPractice ? intents.practiceFromReading : undefined}
            onGeneratePages={canGenerate ? (ids) => intents.goGenerate({ sourceIds: ids, remember: true, closeModal: true }) : undefined} resume={modal.resume}
            onOpenDraftPages={canDraft ? (draftIds) => {
              // The questions of these pages are still in a draft: the same 草稿 page the home card and 检查草稿 open.
              const draft = draftToOpen(draftIds, data.drafts);
              if (!draft) { toast.error(ui('这份草稿已经不在了，可能已发布或删除。')); return; }
              onClose(); drafts.openDraft(draft, { navigation: true });
            } : undefined}
            /* 用 MinerU 重新转换 (#1001): the one PDF 解析 entry of 添加资料, with this PDF and its course; the reader gives way to it. */
            reread={reread} onReconvert={(file) => set.setModal({ type: 'add', ...(source.courses?.[0] ? { course: source.courses[0] } : {}), resumeConversion: file })}
            backLabel={modal.back ? ui('回到这道题') : undefined} onBack={modal.back ? onClose : undefined} peekPage={modal.peekPage} pickPages={!!modal.pickPages}
            onStarted={(started) => { selectionNotices.track(started.jobId); return refresh(); }}
            onGenerateStarted={() => refresh()}
            onCaseFromPassage={canGenerate ? (passage) => intents.goGenerate({ source: 'case', remember: true, closeModal: true,
              caseInitial: { sourceIds: documentSourceIds(data.sources, source.id), focus: passage.quote, nonce: Date.now() } }) : undefined} />
        </>
      ) : <p className="muted">{ui('无法找到此资料。')}</p>}
    </Dialog>
  );
}
