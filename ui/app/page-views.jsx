import React, { useEffect } from 'react';
import { ui, uiFormat, setUiLanguage } from '../i18n.js';
import { pageAvailable } from '../capabilities.js';
import { exportAppearance, importAppearance } from '../appearance-prefs.js';
import { normalizeScienceSettings } from '../science-settings.js';
import { parseDraft } from '../draft-editor.js';
import { Skeleton, Workflows, Graph, AudioDashboard, BlogNotes } from '../workspace-views.jsx';
import StudyMap from '../StudyMap.jsx';
import Welcome, { SampleBanner } from '../Welcome.jsx';
import Dashboard from '../Dashboard.jsx';
import Exam from '../Exam.jsx';
import WrongBook from '../WrongBook.jsx';
import DailyPlan, { RelatedTasks } from '../DailyPlan.jsx';
import Sources from '../Sources.jsx';
import Manage from '../Manage.jsx';
import Settings, { backupFileName } from '../Settings.jsx';
import Generate from '../Generate.jsx';
import Draft from '../Draft.jsx';
import Review from '../Review.jsx';
import AudioImport from '../AudioImport.jsx';
import { Button, PageHeader } from '../components/index.js';
import { useApp } from './app-context.js';
import { SourceForm } from './modals/AddSourceDialog.jsx';
import { createSetupHandlers } from './setup-handlers.js';
import { shellTitleOf } from './shell-title.js';
import WorkspaceBindingPanel from './WorkspaceBindingPanel.jsx';
import { RecoveryBanner } from './AppBanners.jsx';
import { formatDateTime } from '../format.js';

/* One adapter per page: the registry (ui/pages.js) names the page, this file maps it to the component and says which of the app's
   state and verbs the component is given. A page owned by someone else keeps its props; the adapter is the only place that knows them. */

function LibraryView() {
  const { data, core, nav, set, session, intents, drafts, notebooks, tour, dailyPlan, settingsEntry } = useApp();
  const { busy, notify } = core;
  if (tour.showWelcome) return (
    <Welcome model={tour.modelState} sample={data.sample} busy={busy || tour.sampleBusy} onStartSample={tour.loadSampleAndTour}
      onStartTour={() => tour.startTour({ restart: true })} onImport={tour.openFirstImport} onSetupModel={settingsEntry.openModelSettings}
      onRemoveSample={() => tour.setRemovingSample(true)} onLater={tour.hideWelcome} />
  );
  return (
    <>
      {data.sample?.loaded && <SampleBanner sample={data.sample} busy={busy || tour.sampleBusy} onTour={() => tour.startTour({ restart: true })} onRemove={() => tour.setRemovingSample(true)} />}
      <StudyMap data={data} setupHandlers={createSetupHandlers({ data, nav, set, intents, drafts, settingsEntry })} notebooks={notebooks}
        reveal={intents.revealHome} onRevealed={() => intents.setRevealHome(0)}
        actions={{
          start: intents.startReview, resume: intents.openRun, manage: intents.openDeck, removeDeck: (id) => set.setRemovingDeck({ id, root: data.root }),
          openDraft: (draft) => drafts.openDraft(draft, { navigation: true }), continueDraft: drafts.continueDraft,
          retryGeneration: (job) => {
            const available = new Set(data.sources.map((source) => source.id));
            intents.goGenerate({ sourceIds: (job.sourceIds || []).filter((id) => available.has(id)),
              genPatch: (current) => ({ kind: job.kind || current.kind, count: job.requestedTotal || job.count || current.count }) });
            notify(ui('已带回可用资料、题型和题数；请核对学习目标后再生成。'));
          },
          addSource: () => set.setModal({ type: 'add' }), createManual: drafts.createManual, importLibrary: () => intents.goGenerate({ source: 'json' }),
          generateFromSources: (ids) => intents.goGenerate({ sourceIds: ids }), startCourseFlow: intents.startCourseFlow,
          onCoachPractice: pageAvailable(data, 'review') ? session.onCoachPractice : undefined,
          onWeakPoints: pageAvailable(data, 'wrongbook') ? () => nav.navigate('wrongbook') : undefined,
          onShowGraph: (scope, options) => { set.setGraphScope(scope ?? null); set.setGraphCanvas(options?.canvas !== false); nav.navigate('graph'); },
          onCourseSettings: settingsEntry.setCourseSettings,
        }}>
        {pageAvailable(data, 'review') && <DailyPlan key={`${data.root}:${dailyPlan.date}`} plan={dailyPlan} primaryAction={false} onBoard={() => nav.navigate('board')}
          modelReady={data.model?.ready !== false} openModelSettings={settingsEntry.openModelSettings} />}
        <RecoveryBanner />
      </StudyMap>
    </>
  );
}

function WorkflowsView() {
  const { data, nav, lib, intents, dailyPlan, settingsEntry } = useApp();
  return (
    <Workflows key={lib.workflowReturn?.nonce || 'workflows'} data={data} onOpenSettings={settingsEntry.openModelSettings}
      renderRelated={(sessionId) => <RelatedTasks plan={dailyPlan} reference={{ root: data.root, kind: 'workflow', sessionId }} onBoard={() => nav.navigate('board')} />}
      openSession={lib.workflowReturn?.sessionId} openRun={intents.openRun} />
  );
}

function SkeletonView() {
  const { data, lib, set, session, intents } = useApp();
  const run = session.run;
  return (
    <Skeleton data={data} focusId={lib.skeletonFocus} onFocus={set.setSkeletonFocus}
      onPractice={(cards) => intents.practice([...new Map(cards.map((card) => [card.cardId, { deckId: card.deckId, cardId: card.cardId }])).values()],
        { returnTo: run && !run.complete ? run.id : undefined })} />
  );
}

function DashboardView() {
  const { data, nav, intents } = useApp();
  return (
    <Dashboard data={data} onStartScope={(scope) => intents.practice(scope, { fresh: false })} onLibrary={() => nav.navigate('library')}
      onCreate={() => intents.goGenerate()} onSources={() => nav.navigate('sources')} onAudioUsage={() => nav.navigate('audio')} />
  );
}

function ExamView() {
  const { data, core, nav, lib, session, learn, intents, settingsEntry } = useApp();
  return (
    <Exam initialRunId={lib.examRunId} initialKind={lib.examKind} key={`${data.root}:${lib.examKind}:${lib.examRunId || 'latest'}`} data={data}
      onLocation={(location) => { core.refs.examLocation.current = location; }}
      onStartRun={(next, origin) => { if (origin) learn.rememberContext(learn.captureContext({ page: 'exam', exam: origin })); session.enterRun(next); }}
      onExit={() => nav.navigate('library')} onCreate={() => intents.goGenerate()} onCreateCase={() => intents.goGenerate({ source: 'case' })}
      onSetupModel={settingsEntry.openModelSettings} />
  );
}

function WrongBookView() {
  const { data, core, nav, session, intents, settingsEntry } = useApp();
  return (
    <WrongBook data={data} onPracticePrepared={(args) => core.act('coach.practice', args || {}, session.enterRun)}
      onOpenSettings={settingsEntry.openModelSettings} onPractice={(scope) => intents.practice(scope)} onStart={() => intents.practice(undefined, { fresh: false })}
      onLibrary={() => nav.navigate('library')} onCreate={() => intents.goGenerate()} onSources={() => nav.navigate('sources')} />
  );
}

function GraphView() {
  const { data, core, nav, lib, set, intents } = useApp();
  return (
    <Graph call={core.call} busy={core.busy} scope={lib.graphScope} library={data} canvasWanted={lib.graphCanvas} onCanvasHandled={() => set.setGraphCanvas(false)}
      onClose={() => nav.navigate('library')} onStudyCard={({ deckId, cardId }) => intents.practice([{ deckId, cardId }])} />
  );
}

function ManageView() {
  const { data, nav, lib, set, drafts } = useApp();
  if (!lib.managedDeck) return null;
  return (
    <Manage openDraft={drafts.openDraft} setPage={nav.navigate} managedDeck={lib.managedDeck}
      decks={data.decks} sources={data.sources} modelReady={data.modelReady} setManagedDeck={set.setManagedDeck} folderDraft={lib.folderDraft}
      setFolderDraft={set.setFolderDraft} onRemoveDeck={(id) => set.setRemovingDeck({ id, root: data.root })} />
  );
}

function SourcesView() {
  const { data, host, nav, lib, set, learn, sources, settingsEntry } = useApp();
  return (
    <Sources key={data.root} data={data} setModal={set.setModal} sourceForm={<SourceForm />}
      highlight={lib.sourceHighlight} openAgent={host.openAgent} onOpenSources={learn.openAudioSources}
      onLegacyRetry={(job) => { set.setLegacyAudioJobId(job.id); nav.navigate('audio'); }}
      onOpenSettings={(section) => settingsEntry.openSettings(section === 'settings-marker' ? section : 'settings-mineru')} onGenerate={sources.generateFromSources} />
  );
}

/** The 音频转写 page's header: the shared PageHeader, its two links to neighbouring pages as quiet Buttons. */
export function AudioHeader({ onSettings, onSources }) {
  return (
    <PageHeader title={ui('音频转写')} description={ui('导入录音文件，后台完成转录、校对和翻译；进度与完成通知会进入信箱。')}
      actions={<>
        <Button variant="quiet" onClick={onSettings}>{ui('音频设置')}</Button>
        <Button variant="quiet" onClick={onSources}>{ui('查看资料')}</Button>
      </>} />
  );
}

function AudioView() {
  const { data, host, nav, lib, set, learn } = useApp();
  return (
    <section className="page">
      <AudioHeader onSettings={() => nav.navigate('settings')} onSources={() => nav.navigate('sources')} />
      <AudioImport data={data} canAsk={!!host.askInChat}
        openAgent={host.openAgent} onOpenSources={learn.openAudioSources} onOpenSettings={() => nav.show.page('settings')}
        recoveryJobId={lib.legacyAudioJobId} onRecoveryChange={set.setLegacyAudioJobId} />
      <AudioDashboard />
    </section>
  );
}

function GenerateView() {
  const { data, nav, lib, set, drafts, intents, connection, settingsEntry, canChat } = useApp();
  return (
    <Generate data={data} running={connection.running} setPage={nav.navigate}
      openDraft={drafts.openDraft} genSource={intents.genSource} setGenSource={intents.setGenSource} gen={lib.gen} setGen={set.setGen}
      selectedSources={lib.selectedSources} setSelectedSources={set.setSelectedSources} setModal={set.setModal} canChat={canChat}
      openModelSettings={settingsEntry.openModelSettings}
      onStarted={() => { intents.setRevealHome((count) => count + 1); set.setCaseInitial(null); nav.show.page('library'); }}
      caseInitial={lib.caseInitial || undefined} onCourseSettings={settingsEntry.setCourseSettings} reasoningEffort={connection.binding.effort?.current || ''}
      key={lib.caseInitial?.nonce || 'generate'} />
  );
}

function DraftView() {
  const { data, nav, lib, set, session, drafts, intents } = useApp();
  if (!lib.draft) return null;
  return (
    <Draft data={data} draft={lib.draft} draftLoaded={lib.draftLoaded} setDraft={set.setDraft}
      draftText={lib.draftText} setDraftText={set.setDraftText} jsonMode={lib.jsonMode} setJsonMode={set.setJsonMode} openDraft={drafts.openDraft}
      continueDraft={drafts.continueDraft} onOpenPublished={intents.openDeck} onStartPublished={session.enterRun} clearRecovery={drafts.clearRecovery}
      setPage={nav.navigate} setModal={set.setModal} setSelectedSources={set.setSelectedSources}
      setGenSource={intents.setGenSource} blankCard={drafts.blankCard} patchCard={drafts.patchCard} parseDraft={parseDraft} />
  );
}

/** Settings reads the services from useStudy() and its panes draw the binding panel, the course list and the sample controls themselves. */
function SettingsView() {
  const { data, language, core, shell, lib, set, tour, settingsEntry, resetLibraryState } = useApp();
  const { call, setError, notify } = core;
  const { appearance, updateAppearance } = shell;
  async function exportData() {
    try {
      const backup = await call('export');
      const url = URL.createObjectURL(new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName();
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Originals attached by path stay where the learner keeps them; say how many are not in this file.
      const referenced = backup.portableMaterials?.referencedOriginals?.length;
      if (referenced) notify({ text: uiFormat('备份已导出。其中 {0} 份原文件只记了路径，没有放进备份；换电脑后需要重新指定。', [referenced]), tone: 'success', persistent: true });
    } catch (failure) {
      setError(failure.message);
    }
  }
  return (
    <Settings data={data} settings={lib.settings} setSettings={set.setSettings}
      legacy={settingsEntry.legacy} setLegacy={settingsEntry.setLegacy}
      exportData={exportData}
      appearance={{ language, onLanguage: setUiLanguage, ...appearance, onTheme: shell.setTheme,
        onScience: (value) => shell.setSciencePrefs(normalizeScienceSettings(value)),
        onMotion: (value) => updateAppearance({ motion: value }),
        onContrast: (value) => updateAppearance({ contrast: value }),
        onDensity: (value) => updateAppearance({ density: value }),
        onRadius: (value) => updateAppearance({ radius: value }),
        onScale: (value) => updateAppearance({ scale: value }),
        onFont: (value) => updateAppearance({ font: value }),
        onFontTitle: (value) => updateAppearance({ fontTitle: value }),
        onFontCustom: (value) => updateAppearance({ fontCustom: value }),
        onAccent: (value) => updateAppearance({ accent: value }),
        onReset: shell.resetAppearance, onExport: () => exportAppearance(appearance),
        onImport: (text) => { const imported = importAppearance(text); if (imported) updateAppearance(imported); return !!imported; } }}
      tourActive={!!tour.tourStep} focusSection={settingsEntry.settingsFocus} onFocused={() => settingsEntry.setSettingsFocus('')}
      onRestored={(restored) => {
        resetLibraryState('restore');
        notify({ text: restored?.backupPath ? uiFormat('学习库已恢复。原数据已保存到 {0}', [restored.backupPath])
          : ui('学习库已恢复。原数据已自动保存到当前学习库的 backups 文件夹。'), tone: 'success', persistent: true });
      }} />
  );
}

function ReviewView({ feedback }) {
  const { data, core, nav, lib, set, session, learn, intents, dailyPlan, settingsEntry } = useApp();
  const run = session.run;
  // A finished round may change what today's plan shows next (practice progress is counted from the answers), so read it again once.
  useEffect(() => { if (run?.complete) dailyPlan.refresh?.(); }, [run?.id, run?.complete]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!run) return null;
  const detour = lib.detour && !(lib.detour.runId === run.id && lib.detour.index === run.index) ? lib.detour : null;
  const links = {
    onBackToWorkflow: (sessionId) => { set.setWorkflowReturn({ sessionId, nonce: Date.now() }); nav.navigate('workflows'); },
    onCourseFlow: intents.startCourseFlow,
    onOpenNote: (noteId) => learn.openLearningTarget({ kind: 'note', id: noteId }),
    onRecapSettings: () => { learn.rememberContext(learn.captureContext()); settingsEntry.setSettingsFocus('settings-daily-recap'); nav.show.page('settings'); },
    onModelSettings: settingsEntry.openModelSettings,
    onMakeNote: () => {
      const origin = learn.captureContext();
      return core.act('note.create', { title: uiFormat('学习笔记 · {0}', [formatDateTime(Date.now(), 'date')]),
        cards: [{ deckId: run.deckId || run.card?.deckId, cardId: run.card?.id }] }, (note) => { learn.rememberContext(origin); nav.show.note(note.id); });
    },
    onMakeTask: learn.openBoardWithContext,
    openSkeleton: (id) => learn.openLearningTarget({ kind: 'skeleton', id }),
    onReturnToReading: learn.returnToReading,
  };
  return (
    <>
      <RelatedTasks plan={dailyPlan} runId={run.id} onBoard={() => nav.navigate('board')} />
      <Review session={session} data={data} shellTitle={shellTitleOf('review', { run, decks: data?.decks })} feedback={feedback}
        coachProps={data ? { ...session.coach, destination: run.complete ? session.continueTo(dailyPlan) : undefined } : undefined} links={links}
        context={{ label: learn.trailLabel, onReturn: learn.returnFromContext, detour, onReturnFromDetour: learn.returnFromDetour }} />
    </>
  );
}

function NotesView() {
  const { data, nav, lib, set, shell, learn, settingsEntry } = useApp();
  return (
    <BlogNotes key={data.root} data={data} theme={shell.resolvedTheme} onModelSettings={settingsEntry.openModelSettings}
      onRecapSettings={() => { learn.rememberContext(learn.captureContext()); settingsEntry.setSettingsFocus('settings-daily-recap'); nav.show.page('settings'); }}
      initialId={lib.noteInitialId} onSelect={set.setNoteInitialId} onOpenCard={(reference) => learn.openLearningTarget({ kind: 'card', ...reference })}
      backLabel={learn.trailLabel} onBack={learn.hasTrail ? learn.returnFromContext : () => { set.setNoteInitialId(''); nav.navigate('library'); }} />
  );
}

/** The component of each page that shows through <PageView>. Board and live class are drawn by the shell itself (they keep running or load without a snapshot). */
export const PAGE_VIEWS = {
  library: LibraryView, workflows: WorkflowsView, skeleton: SkeletonView, dashboard: DashboardView, exam: ExamView, wrongbook: WrongBookView, graph: GraphView,
  manage: ManageView, sources: SourcesView, audio: AudioView, generate: GenerateView, draft: DraftView, settings: SettingsView, review: ReviewView, notes: NotesView,
};

/** What the learner sees when the host has switched the page's components off. */
export function DisabledPage() {
  const { nav } = useApp();
  return (
    <section className="page" role="status">
      <PageHeader title={ui('此功能已停用')} description={ui('在 DSH 插件管理器中启用所需组件后即可继续，已保存的学习资料仍会保留。')}
        actions={<Button onClick={() => nav.navigate('settings', { animate: true, keepTrail: false })}>{ui('工作区设置')}</Button>} />
    </section>
  );
}

/** The start page before a library has loaded: which folder and model, and a retry. */
export function StartPage() {
  const { core } = useApp();
  return (
    <section className="onboarding">
      <div className="eyebrow">{ui('你的学习空间')}</div>
      <h1>{ui('把资料变成真正会的知识。')}</h1>
      <p className="intro">{ui('学习库默认在当前工作区，出题模型跟随当前会话。无法打开时，可以换一个目录后重试。')}</p>
      <WorkspaceBindingPanel />
      <Button variant="primary" disabled={core.busy} onClick={() => core.refresh().then(() => core.setError(''), (failure) => core.setError(failure.message))}>{ui('重试')}</Button>
    </section>
  );
}

/** The registry's component for a page (ui/pages.js names it, PAGE_VIEWS draws it). */
export function PageView({ page, feedback }) {
  const View = PAGE_VIEWS[page];
  return View ? <View feedback={feedback} /> : null;
}
