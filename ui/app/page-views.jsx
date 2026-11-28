import React, { useEffect, useMemo } from 'react';
import { PageBoundary } from './page-boundary.jsx';
import { useStudyBusy } from '../study-context.jsx';
import { useDiagnostics } from '../diagnostics.js';
import { currentStudyHubVersion, currentUpgradeMarker } from '../UpdateCenter.jsx';
import { ui, uiFormat, setUiLanguage, errorMessage, getUiLanguage } from '../i18n.js';
import { pageAvailable } from '../capabilities.js';
import { pageFlag } from '../pages.js';
import { exportAppearance, importAppearance } from '../appearance-prefs.js';
import { normalizeScienceSettings } from '../science-settings.js';
import { parseDraft } from '../draft-editor.js';
import { Skeleton, Workflows, Graph, AudioDashboard, BlogNotes, TaskConsole, GuidedStudy, Dashboard, Exam, ExamPrep, ExamCoach, CourseOutline, BookPage } from '../workspace-views.jsx';
import { useGuidedQuestion } from '../guided-study/use-guided-question.js';
import { practiceArgs } from '../learning-navigation.js';
import { materialOpener, resultOpener } from '../tasks/task-actions.js';
import StudyMap from '../StudyMap.jsx';
import { hasOwnDeck } from '../study-map/home-plan.js';
import { SampleBanner } from '../Welcome.jsx';
import { firstRunLine } from '../first-run/line.js';
import { useFirstDeck } from '../first-run/use-first-deck.js';
import WrongBook from '../WrongBook.jsx';
import DailyPlan, { RelatedTasks } from '../DailyPlan.jsx';
import Sources from '../Sources.jsx';
import { keepBook } from '../book/model.js';
import { keepOutline } from '../outline/model.js';
import CrunchCard from '../book/CrunchCard.jsx';
import WeeklyCard from '../book/WeeklyCard.jsx';
import BookInlineRun from './modals/BookInlineRun.jsx';
import Manage from '../Manage.jsx';
import Settings, { backupFileName } from '../Settings.jsx';
import Generate from '../Generate.jsx';
import Draft from '../Draft.jsx';
import Review from '../Review.jsx';
import AudioImport from '../AudioImport.jsx';
import { Button, PageHeader } from '../components/index.js';
import { openAudioSettings } from '../audio-focus.js';
import { openIndexBuilder } from '../index-focus.js';
import { useApp, useAppSelector } from './app-context.js';
import { SourceForm } from './modals/AddSourceDialog.jsx';
import { createSetupHandlers } from './setup-handlers.js';
import { importForQuestions } from './import-handoff.js';
import { shellTitleOf } from './shell-title.js';
import WorkspaceBindingPanel from './WorkspaceBindingPanel.jsx';
import { RecoveryBanner } from './AppBanners.jsx';
import { qaToNoteArgs, questionNoteCourse, questionNoteRef, questionNoteTitle } from '../review/question-note.js';
import { appendFocus } from '../generate-form.js';
import { liteShows } from '../lite-view.js';
import { useLiteView } from '../use-lite-view.js';
import { retryForm, retryNotice } from './retry-generation.js';
import { practiseRound } from './practise-round.js';
import { openCompanionTarget } from '../companions/companion-ref.js';

/* One adapter per page: the registry (ui/pages.js) names the page, this file maps it to the component and says which of the app's
   state and verbs the component is given. A page owned by someone else keeps its props; the adapter is the only place that knows them. */

function LibraryView() {
  const { data, core, nav, lib, set, session, intents, drafts, notebooks, tour, dailyPlan, settingsEntry, learn, connection } = useApp();
  const busy = useStudyBusy();
  const { notify } = core;
  const lite = useLiteView();
  /* 期末一周 (M7): a course's book at a point, in 翻看 or with 今天读哪几节 open; another course than the current one is made current first (the book
     page shows the current course's book). 练 5 道 practises the point's next five, in a practice round's order. */
  const openCrunchBook = async (course, { target = null, view = null } = {}) => {
    const switched = course !== (data.focus?.course ?? null);
    // The card acts on another course than the current one: the app's course changes with it (nothing else happens when that fails), and the book says so once, in a quiet line.
    if (switched && !await core.act('focus.set', { course })) return;
    keepBook(data.root, course, { target, view, switched });
    nav.navigate('book');
  };
  // 练 5 道 keeps a way back to the home, like every round started from a page (the round itself does not depend on the current course).
  const practiseCrunch = async (course, point) => {
    try {
      const { practice } = await core.call('course.outline', { course, pick: { keys: [point.key] } });
      const scope = practice?.scope.slice(0, 5) || [];
      if (!scope.length) { notify(ui('这个知识点还没有题。先到「创建题组」从资料出题。')); return; }
      practiseRound({ intents, learn, session }, scope);
    } catch (failure) { notify({ text: errorMessage(failure), tone: 'error' }); }
  };
  const startMock = (run) => { learn.rememberContext(learn.captureContext()); session.enterRun(run); };
  /* The first-run line (ui/first-run): the whole first screen until the first own deck is published, unless 以后再说 put it away or a tour shows the home;
     then it is the compact card. Its 添加资料 and 再加一份 come back to the line (3.6 D4), whose third step says what will be made and its estimate and makes
     the first deck with 创建题组's own request (出第一组题, the learner's click only); 改题型和题数 opens 创建题组 with the materials ticked. */
  const line = firstRunLine(data), lineShown = line.show;
  const linePage = lineShown && !tour.tourStep && !tour.lineLater;
  const firstDeck = useFirstDeck({ data, gen: lib?.gen, setGen: set.setGen, deck: lineShown ? line.steps[2] : null,
    reasoningEffort: connection?.binding?.effort?.current || '', services: core });
  const firstRun = lineShown ? { form: linePage ? 'page' : 'compact', sampleBusy: tour.sampleBusy || tour.sampleForTour, plan: firstDeck, on: {
    importFirst: tour.openFirstImport, importMore: tour.openFirstImport,
    generate: firstDeck.start, tune: (sourceIds) => intents.goGenerate({ sourceIds, remember: true }),
    recheck: core.refresh, openModelSettings: settingsEntry.openModelSettings,
    startSample: tour.loadSampleAndTour, later: tour.hideWelcome } } : undefined;
  return (
    <>
      {/* While 载入示例并开始导览 loads the sample, the banner waits: the tour's home replaces the line as a whole, nothing slides in above the line first. */}
      {data.sample?.loaded && !(linePage && tour.sampleForTour) && <SampleBanner sample={data.sample} busy={busy || tour.sampleBusy} onTour={() => tour.startTour({ restart: true })} onRemove={() => tour.setRemovingSample(true)} />}
      <StudyMap data={data} setupHandlers={createSetupHandlers({ data, nav, set, intents, drafts, settingsEntry })} notebooks={notebooks} firstRun={firstRun}
        reveal={intents.revealHome} onRevealed={() => intents.setRevealHome(0)}
        actions={{
          start: intents.startReview, confirmStart: intents.confirmStart, resume: intents.openRun, manage: intents.openDeck, removeDeck: (id, options) => set.setRemovingDeck({ id, root: data.root, ...options }),
          openDraft: (draft) => drafts.openDraft(draft, { navigation: true }), topUpDraft: drafts.topUpDraft,
          retryGeneration: (job) => {
            // The whole request of the failed job goes back on the form, and the notice says only what was put back (ui/app/retry-generation.js).
            const available = new Set(data.sources.map((source) => source.id)), wanted = job.sourceIds || [];
            const { patch, lost, goneReferences, caseInitial } = retryForm(job, { sources: data.sources });
            intents.goGenerate({
              source: caseInitial ? 'case' : 'files',
              sourceIds: wanted.filter((id) => available.has(id)),
              genPatch: patch,
              ...(caseInitial ? { caseInitial } : {}),
            });
            notify(retryNotice({ lost, gone: wanted.filter((id) => !available.has(id)).length, goneReferences }));
          },
          addSource: () => (lineShown ? tour.openFirstImport() : set.setModal(data.decks.length ? { type: 'add' } : importForQuestions(intents.goGenerate))), createManual: drafts.createManual, importLibrary: () => intents.goGenerate({ source: 'json' }),
          generateFromSources: (ids) => intents.goGenerate({ sourceIds: ids }),
          onCoachPractice: pageAvailable(data, 'review') ? session.onCoachPractice : undefined,
          onWeakPoints: pageAvailable(data, 'wrongbook') ? () => nav.navigate('wrongbook') : undefined,
          onOpenExamBook: pageAvailable(data, 'book') ? (course) => openCrunchBook(course, { view: 'today' }) : undefined,
          onShowGraph: (scope, options) => { set.setGraphScope(scope ?? null); set.setGraphCanvas(options?.canvas !== false); set.setGraphMode(options?.mode || 'structure'); nav.navigate('graph'); },
          onOpenMasteryMap: pageAvailable(data, 'graph') ? () => { set.setGraphScope(null); set.setGraphCanvas(false); set.setGraphMode('mastery'); nav.navigate('graph'); } : undefined,
          onCourseSettings: settingsEntry.setCourseSettings,
          onGenerateFocus: (topics, course) => intents.goGenerate({ genPatch: (cur) => ({ ...cur, ...(course ? { course } : {}), focus: appendFocus(cur.focus, topics) }), remember: true }),
          onShowOutline: pageAvailable(data, 'outline') ? () => nav.navigate('outline') : undefined,
        }}>
        {liteShows(lite, 'home.daily-plan') && !linePage && pageAvailable(data, 'review') && hasOwnDeck(data) && <DailyPlan key={`${data.root}:${dailyPlan.date}`} plan={dailyPlan} primaryAction={false}
          onBoard={() => { set.setBoardView('today'); nav.navigate('board'); }}
          modelReady={data.model?.ready !== false} openModelSettings={settingsEntry.openModelSettings} autoPropose={!tour.tourStep} />}
        {!linePage && pageAvailable(data, 'book') && <CrunchCard data={data} onOpenBook={openCrunchBook} onPractice={practiseCrunch} onExamRun={startMock} />}
        {liteShows(lite, 'home.weekly-card') && !linePage && pageAvailable(data, 'book') && <WeeklyCard data={data} onOpenBook={openCrunchBook} onPractice={practiseCrunch} onExamRun={startMock} />}
        <RecoveryBanner />
      </StudyMap>
    </>
  );
}

function WorkflowsView() {
  const { data, nav, lib, set, intents, dailyPlan, settingsEntry } = useApp();
  return (
    <Workflows key={lib.workflowReturn?.nonce || 'workflows'} data={data} onOpenSettings={settingsEntry.openModelSettings}
      renderRelated={(sessionId) => <RelatedTasks plan={dailyPlan} reference={{ root: data.root, kind: 'workflow', sessionId }}
        onBoard={() => { set.setBoardView('today'); nav.navigate('board'); }} />}
      openSession={lib.workflowReturn?.sessionId} openRun={intents.openRun} />
  );
}

function SkeletonView() {
  const { data, lib, set, session, learn, intents } = useApp();
  const run = session.run;
  const fromActiveRun = Boolean(run && !run.complete && learn.trailPage === 'review');
  return (
    <Skeleton data={data} focusId={lib.skeletonFocus} onFocus={set.setSkeletonFocus}
      onPractice={(cards) => {
        const origin = fromActiveRun ? null : learn.captureContext();
        intents.practice([...new Map(cards.map((card) => [card.cardId, { deckId: card.deckId, cardId: card.cardId }])).values()],
          { returnTo: fromActiveRun ? run.id : undefined, then: (nextRun) => { if (origin) learn.rememberContext(origin); session.enterRun(nextRun); } });
      }} />
  );
}

function DashboardView() {
  const { data, core, nav, set, session, learn, intents, board, dailyPlan } = useApp();
  const offerUndo = (message, undo) => {
    core.toast.show({
      tone: 'success',
      message,
      undo: true,
      timeout: 8000,
      action: undo ? {
        label: ui('撤销'),
        onClick: async () => { core.toast.dismiss(); await undo(); },
      } : undefined,
    });
  };
  const editTimeLog = async (entry, minutes) => {
    const prevMinutes = entry.minutes;
    const ok = await board.state.mutate('board.timeLog.edit', { id: entry.id, minutes });
    if (ok) {
      dailyPlan.refresh?.();
      offerUndo(uiFormat('已改为 {0} 分钟：{1}', [minutes, entry.cardTitle]), async () => {
        const undone = await board.state.mutate('board.timeLog.edit', { id: entry.id, minutes: prevMinutes });
        if (undone) dailyPlan.refresh?.();
        return undone;
      });
    }
    return ok;
  };
  const removeTimeLog = async (entry) => {
    const snapshot = structuredClone(entry);
    const ok = await board.state.mutate('board.timeLog.remove', { id: entry.id });
    if (ok) {
      dailyPlan.refresh?.();
      offerUndo(uiFormat('已删除专注记录：{0}', [entry.cardTitle]), async () => {
        const undone = await board.state.mutate('board.timeLog.add', {
          ...(snapshot.cardId ? { cardId: snapshot.cardId } : {}),
          cardTitle: snapshot.cardTitle,
          date: snapshot.date,
          startedAt: snapshot.startedAt,
          minutes: snapshot.minutes,
        }, { optimistic: false });
        if (undone) dailyPlan.refresh?.();
        return undone;
      });
    }
    return ok;
  };
  return (
    <Dashboard data={data} board={board.state.board} boardReadOnly={Boolean(board.state.board?.readOnly)}
      onRefreshBoard={() => board.state.refresh({ force: true })}
      onEditTimeLog={editTimeLog} onRemoveTimeLog={removeTimeLog}
      onOpenToday={pageAvailable(data, 'board') ? () => { set.setBoardView('today'); nav.navigate('board'); } : undefined}
      onStartScope={(scope) => practiseRound({ intents, learn, session }, scope)} onLibrary={() => nav.navigate('library')}
      onCreate={() => intents.goGenerate()} onSources={() => nav.navigate('sources')} onAudioUsage={() => nav.navigate('audio')}
      onOpenWorkflowSession={pageAvailable(data, 'workflows') ? (sessionId) => nav.show.workflow(sessionId) : undefined}
      onOpenWorkflowArchive={pageAvailable(data, 'workflows') ? () => nav.navigate('workflows') : undefined} />
  );
}

function ExamView() {
  const { data, core, nav, lib, session, learn, intents, settingsEntry } = useApp();
  return (
    <Exam initialRunId={lib.examRunId} initialKind={lib.examKind} key={`${data.root}:${lib.examKind}:${lib.examRunId || 'latest'}`} data={data}
      onLocation={(location) => { core.refs.examLocation.current = location; }}
      onStartRun={(next, origin) => { if (origin) learn.rememberContext(learn.captureContext({ page: 'exam', exam: origin })); session.enterRun(next); }}
      onExit={() => nav.navigate('library')} onCreate={() => intents.goGenerate()} onCreateCase={() => intents.goGenerate({ source: 'case' })}
      onSetupModel={settingsEntry.openModelSettings}
      onOpenSource={(id, quote) => learn.openLearningTarget({ kind: 'source', id, quote })} />
  );
}

function WrongBookView() {
  const { data, core, nav, session, learn, intents, settingsEntry } = useApp();
  const onOpenBook = pageAvailable(data, 'book') ? ({ course: targetCourse, hid, view } = {}) => {
    const chosen = targetCourse || data.focus?.course || null;
    learn.rememberContext(learn.captureContext());
    keepBook(data.root, chosen, { target: hid || null, ...(view ? { view } : {}) });
    if (targetCourse && targetCourse !== data.focus?.course) void core.act('focus.set', { course: targetCourse });
    nav.navigate('book');
  } : undefined;
  return (
    <WrongBook data={data} onPracticePrepared={(args) => core.act('coach.practice', args || {}, session.enterRun)}
      onOpenSettings={settingsEntry.openModelSettings} onPractice={(scope) => intents.practice(scope)} onStart={() => intents.practice(undefined, { fresh: false })}
      onLibrary={() => nav.navigate('library')} onCreate={() => intents.goGenerate()} onSources={() => nav.navigate('sources')} onOpenBook={onOpenBook} />
  );
}

function GraphView() {
  const { data, core, nav, lib, set, session, learn, intents } = useApp();
  const onPracticeScope = (practiceScope, { resume = false } = {}) => {
    const origin = learn.captureContext();
    intents.practice(practiceScope, { fresh: !resume, then: (run) => { learn.rememberContext(origin); session.enterRun(run); } });
  };
  const onOpenOutline = pageAvailable(data, 'outline') ? async (targetCourse) => {
    if (typeof targetCourse === 'string' && targetCourse !== data.focus?.course) {
      if (!await core.act('focus.set', { course: targetCourse })) return;
    }
    nav.navigate('outline');
  } : undefined;
  const onOpenBook = pageAvailable(data, 'book') ? async (key, targetCourse) => {
    const chosen = typeof targetCourse === 'string' ? targetCourse : (data.focus?.course ?? null);
    if (typeof targetCourse === 'string' && targetCourse !== data.focus?.course) {
      if (!await core.act('focus.set', { course: targetCourse })) return;
    }
    keepBook(data.root, chosen, { target: key || null });
    nav.navigate('book');
  } : undefined;
  const onGoGenerateTopic = pageAvailable(data, 'generate') ? (topics, targetCourse) => {
    intents.goGenerate({
      genPatch: (cur) => ({
        ...cur,
        ...(targetCourse ? { course: targetCourse } : {}),
        focus: appendFocus(cur.focus, topics),
      }),
      remember: true,
    });
  } : undefined;
  return (
    <Graph scope={lib.graphScope} library={data} defaultMode={lib.graphMode} canvasWanted={lib.graphCanvas} onCanvasHandled={() => set.setGraphCanvas(false)}
      onClose={() => nav.navigate('library')} onStudyCard={({ deckId, cardId }) => intents.practice([{ deckId, cardId }])}
      onPracticeScope={onPracticeScope} onResumeRun={intents.openRun} onManageDeck={intents.openDeck}
      onOpenOutline={onOpenOutline} onOpenBook={onOpenBook}
      onOpenWrongBook={pageAvailable(data, 'wrongbook') ? () => nav.navigate('wrongbook') : undefined}
      onGoGenerateTopic={onGoGenerateTopic} />
  );
}

function ManageView() {
  const { data, nav, lib, set, drafts } = useApp();
  if (!lib.managedDeck) return null;
  return (
    <Manage openDraft={drafts.openDraft} setPage={nav.navigate} managedDeck={lib.managedDeck}
      decks={data.decks} focus={data.focus} sources={data.sources} modelReady={data.modelReady} setManagedDeck={set.setManagedDeck} folderDraft={lib.folderDraft}
      setFolderDraft={set.setFolderDraft} onRemoveDeck={(id, options) => set.setRemovingDeck({ id, root: data.root, ...options })} runs={data.runs} />
  );
}

function SourcesView() {
  const data = useAppSelector((s) => s.data);
  const host = useAppSelector((s) => s.host);
  const nav = useAppSelector((s) => s.nav);
  const sourceHighlight = useAppSelector((s) => s.lib?.sourceHighlight);
  const set = useAppSelector((s) => s.set);
  const learn = useAppSelector((s) => s.learn);
  const sources = useAppSelector((s) => s.sources);
  const intents = useAppSelector((s) => s.intents);
  const settingsEntry = useAppSelector((s) => s.settingsEntry);
  return (
    <Sources key={data.root} data={data} setModal={set.setModal} sourceForm={<SourceForm />}
      highlight={sourceHighlight} openAgent={host.openAgent} onOpenSources={learn.openAudioSources}
      onLegacyRetry={(job) => { set.setLegacyAudioJobId(job.id); nav.navigate('audio'); }}
      onOpenSettings={(section) => settingsEntry.openSettings(section === 'settings-marker' ? section : 'settings-mineru')} onBuildIndex={(course) => openIndexBuilder(settingsEntry.openSettings, course)} onGenerate={sources.generateFromSources}
      onPractice={(scope) => intents.practice(scope)} />
  );
}

/** The 音频转写 page's header: the shared PageHeader, its two links to neighbouring pages as quiet Buttons. While the setup card is on the page
    (`setupShown`), the card is the one way to the audio settings (#1708). */
export function AudioHeader({ onSettings, onSources, setupShown = false }) {
  const settings = !setupShown && onSettings, sources = !!onSources;
  return (
    <PageHeader title={ui('音频转写')} description={ui('导入录音文件，后台完成转录、校对和翻译；实时进度在本页和「任务」查看，转好后存入「资料」，完成时信箱会提醒你。')}
      actions={settings || sources ? <>
        {settings && <Button iconEnd="arrow-right" variant="quiet" onClick={onSettings}>{ui('音频设置')}</Button>}
        {sources && <Button iconEnd="arrow-right" variant="quiet" onClick={onSources}>{ui('查看资料')}</Button>}
      </> : undefined} />
  );
}

export function AudioView() {
  const { data, host, nav, lib, set, learn, sources } = useApp();
  const [setupShown, setSetupShown] = React.useState(false);
  return (
    <section className="page">
      <AudioHeader onSettings={openAudioSettings(() => nav.navigate('settings'))} onSources={() => nav.navigate('sources')} setupShown={setupShown} />
      <AudioImport data={data} onSetupShown={setSetupShown}
        openAgent={host.openAgent} onOpenSources={learn.openAudioSources} onOpenSettings={() => nav.show.page('settings')} onGenerate={sources.generateFromSources}
        recoveryJobId={lib.legacyAudioJobId} onRecoveryChange={set.setLegacyAudioJobId} />
      <AudioDashboard />
    </section>
  );
}

/** 任务: every background job in one place. What each job's 打开结果 leads to is decided here, where the app's navigation lives. */
function TasksView() {
  const app = useApp(), { data } = app;
  const openers = { resultOf: (job) => resultOpener(job, app), materialOf: (job) => materialOpener(job, app) };
  return <TaskConsole data={data} openers={openers} />;
}

/** 总纲: the current course's materials as a tree with their questions. A round started here comes back here (回到总纲); 接着练 resumes the row's unfinished round. */
function OutlineView() {
  const { data, nav, set, session, learn, intents } = useApp();
  const onPractice = (scope, { resume = false } = {}) => {
    const origin = learn.captureContext();
    intents.practice(scope, { fresh: !resume, then: (run) => { learn.rememberContext(origin); session.enterRun(run); } });
  };
  // 打开书页: the 复习全书 of the course, at the point the learner opened (its 总纲 key), or where they were in it.
  const onOpenBook = (key) => { keepBook(data.root, data.focus?.course ?? null, { target: key || null }); nav.navigate('book'); };
  const onOpenMasteryMap = pageAvailable(data, 'graph') ? () => {
    set.setGraphScope(null);
    set.setGraphCanvas(false);
    set.setGraphMode('mastery');
    nav.navigate('graph');
  } : undefined;
  const onGoGenerateTopic = (topic) => {
    const course = data.focus?.course;
    intents.goGenerate({
      genPatch: (cur) => ({
        ...cur,
        ...(course ? { course } : {}),
        ...(topic ? { focus: appendFocus(cur.focus, topic) } : {}),
      }),
      remember: true,
    });
  };
  const fromReview = learn.hasTrail && learn.trailPage === 'review';
  return <CourseOutline key={`${data.root}:${data.focus?.course}`} data={data}
    backLabel={fromReview ? learn.trailLabel : undefined}
    onBack={fromReview ? learn.returnFromContext : () => nav.navigate('library')}
    onCreate={() => intents.goGenerate()}
    onGoGenerateTopic={onGoGenerateTopic}
    onOpenMasteryMap={onOpenMasteryMap}
    onOpenSources={pageAvailable(data, 'sources') ? () => nav.navigate('sources') : undefined} onPractice={onPractice} onOpenTask={nav.show.task}
    onOpenSource={(id, quote) => learn.openLearningTarget({ kind: 'source', id, quote })} onOpenBook={onOpenBook} />;
}

/** 复习全书: the book of the current course, read only (M1). A question link starts the ordinary practice round with the way back (回到复习全书), which shows
    this page again; the page itself comes back at the heading and scroll the learner left. */
function BookView() {
  const { data, nav, session, learn, intents, shell, settingsEntry } = useApp();
  // `place`: the point the learner left from ("1.2.2 Title"), said on the result page as where the way back leads. `arrive`: called when the learner is brought back by the
  // trail (and only then): the book is told to put the focus on that point's heading.
  const onPractice = (scope, { resume = false, place = '' } = {}) => {
    const course = data.focus?.course ?? null;
    // A round started on this page always puts the focus back on the book's heading when the learner returns (even when the point's row is not found: `place` is empty then).
    const origin = learn.captureContext({ ...(place ? { place } : {}), arrive: () => keepBook(data.root, course, { back: true }) });
    intents.practice(scope, { fresh: !resume, then: (run) => { learn.rememberContext(origin); session.enterRun(run); } });
  };
  const inlinePractice = useMemo(() => {
    const course = data.focus?.course ?? null;
    return {
      Run: BookInlineRun,
      start: (scope, { resume = false, place = '' } = {}, onStarted) => {
        const origin = learn.captureContext({ ...(place ? { place } : {}), arrive: () => keepBook(data.root, course, { back: true }) });
        return intents.practice(scope, { fresh: !resume, then: (run) => onStarted?.(run, origin) });
      },
    };
  }, [data.root, data.focus?.course, intents, learn]);
  // A mock paper started in the book (M7) is the ordinary exam; its way back is the book.
  const onExamRun = (run) => { learn.rememberContext(learn.captureContext()); session.enterRun(run); };
  const hasReturnTrail = learn.hasTrail && (learn.trailPage === 'review' || learn.trailPage === 'wrongbook');
  return <BookPage key={`${data.root}:${data.focus?.course}`} data={data} theme={shell.resolvedTheme} onBack={() => nav.navigate('outline')}
    backLabel={hasReturnTrail ? learn.trailLabel : ''} onReturnBack={hasReturnTrail ? learn.returnFromContext : undefined}
    onPractice={onPractice} inlinePractice={inlinePractice} onOpenTask={nav.show.task}
    onCreate={() => intents.goGenerate()} onOpenSource={(id, quote) => learn.openLearningTarget({ kind: 'source', id, quote })} onExamRun={onExamRun}
    onCourseSettings={settingsEntry.setCourseSettings} onBuildIndex={(name) => openIndexBuilder(settingsEntry.openSettings, name)} holdLeave={nav.holdLeave} />;
}

/** 备考补习: the 考点清单 of the current course. A place of a point opens in the reader (the one way to open a material); a build is followed in the 任务 console.
    openImport opens the add-materials dialog for a course and hands back the ids it made; openSettings(section) goes to a Settings section, and with no section
    (the model setup gate passes a click) to the model settings. */
function ExamPrepView() {
  const { data, nav, set, learn, settingsEntry } = useApp();
  const openImport = ({ course, onImported } = {}) => set.setModal({ type: 'add', course: course ?? '', onImported });
  const openSettings = (section) => (typeof section === 'string' && section ? settingsEntry.openSettings(section) : settingsEntry.openModelSettings());
  return (
    <ExamPrep key={data.root} data={data} openSettings={openSettings} openImport={openImport}
      onOpenSource={(id, quote) => learn.openLearningTarget({ kind: 'source', id, quote })} onOpenTask={nav.show.task} />
  );
}

function ExamCoachView() {
  const { data, nav, intents, settingsEntry } = useApp();
  const onApplyToGenerate = (built) => {
    const req = built?.request || {};
    intents.goGenerate({
      source: 'files',
      sourceIds: req.sourceIds || [],
      remember: true,
      genPatch: (cur) => ({
        ...cur,
        ...(req.course ? { course: req.course } : {}),
        ...(req.focus ? { focus: req.focus } : {}),
        ...(req.difficulty ? { difficulty: req.difficulty } : {}),
        ...(req.count ? { customCount: String(req.count) } : {}),
        ...(req.kindCounts ? { kindCounts: req.kindCounts, kinds: Object.keys(req.kindCounts) } : {}),
        ...(req.moduleOverrides ? { moduleOverrides: req.moduleOverrides } : {}),
        ...(req.referenceSourceIds ? { referenceSourceIds: req.referenceSourceIds } : {}),
      }),
    });
  };
  return (
    <ExamCoach
      key={data.root}
      data={data}
      onGoGenerate={() => intents.goGenerate()}
      onApplyToGenerate={onApplyToGenerate}
      onOpenSettings={settingsEntry.openModelSettings}
      onOpenTasks={() => nav.navigate('tasks')}
    />
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
  const data = useAppSelector((s) => s.data);
  const nav = useAppSelector((s) => s.nav);
  const draft = useAppSelector((s) => s.lib?.draft);
  const draftLoaded = useAppSelector((s) => s.lib?.draftLoaded);
  const draftText = useAppSelector((s) => s.lib?.draftText);
  const jsonMode = useAppSelector((s) => s.lib?.jsonMode);
  const set = useAppSelector((s) => s.set);
  const enterRun = useAppSelector((s) => s.session?.enterRun);
  const drafts = useAppSelector((s) => s.drafts);
  const openDeck = useAppSelector((s) => s.intents?.openDeck);
  const openSourceAt = useAppSelector((s) => s.learn?.openSourceAt);
  if (!draft) return null;
  return (
    <Draft data={data} draft={draft} draftLoaded={draftLoaded} setDraft={set.setDraft}
      draftText={draftText} setDraftText={set.setDraftText} jsonMode={jsonMode} setJsonMode={set.setJsonMode} openDraft={drafts.openDraft}
      topUpDraft={drafts.topUpDraft} openSourceAt={openSourceAt} onOpenPublished={openDeck} onStartPublished={enterRun} clearRecovery={drafts.clearRecovery}
      setPage={nav.navigate} setModal={set.setModal}
      blankCard={drafts.blankCard} patchCard={drafts.patchCard} parseDraft={parseDraft} />
  );
}

/** Settings reads the services from useStudy() and its panes draw the binding panel, the course list and the sample controls themselves. */
function SettingsView() {
  const { data, language, core, shell, lib, nav, set, tour, settingsEntry, resetLibraryState, learn, session } = useApp();
  const { call, setError, notify } = core;
  const { appearance, updateAppearance } = shell;
  async function openProfileRef(ref) {
    if (!ref || typeof ref !== 'object') return;
    if (ref.kind === 'card' && ref.deckId && ref.cardId) {
      await learn.openLearningTarget({ kind: 'card', deckId: ref.deckId, cardId: ref.cardId });
      return;
    }
    if (ref.kind === 'hid' && ref.hid && pageAvailable(data, 'book')) {
      await openReviewCoursePage({
        place: { course: ref.course }, data, core, session, learn, nav, targetPage: 'book',
        prepare: (targetCourse) => keepBook(data?.root, targetCourse, { target: ref.hid }),
      });
      return;
    }
    if (ref.kind === 'companion' && ref.companionId) {
      let matchedCourse = '';
      let matchedTitle = '';
      for (const courseItem of data?.courses || []) {
        const hit = (courseItem?.companions || []).find((item) => item?.id === ref.companionId);
        if (hit) {
          matchedCourse = courseItem.name || '';
          matchedTitle = hit.title || '';
          break;
        }
      }
      openCompanionTarget(set.setModal, {
        companionId: ref.companionId,
        ...(ref.slide >= 1 ? { slide: ref.slide } : {}),
        ...(matchedCourse ? { course: matchedCourse } : {}),
        ...(matchedTitle ? { companionTitle: matchedTitle } : {}),
        returnLabel: ui('返回设置'),
        from: 'settings',
      });
    }
  }
  async function exportData() {
    try {
      const backup = await call('export');
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = backupFileName();
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Originals attached by path stay where the learner keeps them; say how many are not in this file.
      const referenced = backup.portableMaterials?.referencedOriginals?.length;
      const missing = backup.portableMaterials?.missingAttachments;
      const largeMb = blob.size > 60 * 1024 * 1024 ? Math.round(blob.size / (1024 * 1024)) : 0;
      const parts = [];
      if (referenced) parts.push(uiFormat('备份已导出。其中 {0} 份原文件只记了路径，没有放进备份；换电脑后需要重新指定。', [referenced]));
      if (missing) parts.push(uiFormat('有 {0} 份已丢失的原件副本已跳过，对应资料仅以文字形态写入备份。', [missing]));
      if (largeMb) parts.push(uiFormat('备份体积较大（约 {0} MB），恢复时将自动分片上传，请耐心等待。', [largeMb]));
      if (parts.length) notify({ text: referenced ? parts.join(' ') : [ui('备份已导出。'), ...parts].join(' '), tone: missing ? 'warning' : 'success', persistent: true });
    } catch (failure) {
      setError(failure.message);
    }
  }
  return (
    <Settings data={data} nav={nav} settings={lib.settings} setSettings={set.setSettings}
      legacy={settingsEntry.legacy} setLegacy={settingsEntry.setLegacy}
      exportData={exportData} onOpenRef={openProfileRef}
      appearance={{ language, onLanguage: setUiLanguage, ...appearance, onTheme: shell.setTheme,
        onMinimal: (value) => updateAppearance({ minimal: value }),
        onStyle: (value) => updateAppearance({ style: value }),
        onScience: (value) => shell.setSciencePrefs(normalizeScienceSettings(value)),
        onMotion: (value) => updateAppearance({ motion: value }),
        onContrast: (value) => updateAppearance({ contrast: value }),
        onDensity: (value) => updateAppearance({ density: value }),
        onRadius: (value) => updateAppearance({ radius: value }),
        onCraft: (value) => updateAppearance({ craft: value }),
        onScale: (value) => updateAppearance({ scale: value }),
        onFont: (value) => updateAppearance({ font: value }),
        onFontTitle: (value) => updateAppearance({ fontTitle: value }),
        onFontCustom: (value) => updateAppearance({ fontCustom: value }),
        onAccent: (value) => updateAppearance({ accent: value }),
        onSound: (value) => updateAppearance({ sound: value }),
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

export async function openReviewCoursePage({ place, data, core, session, learn, nav, targetPage, prepare }) {
  if (await session.flushDraft?.() === false) return;
  const previousCourse = data?.focus?.course ?? null;
  const targetCourse = typeof place?.course === 'string' ? place.course : previousCourse;
  const switched = typeof place?.course === 'string' && place.course !== previousCourse;
  const origin = learn.captureContext(switched ? { course: previousCourse, courseSwitched: true } : {});
  if (switched && !await core.act('focus.set', { course: place.course })) return;
  learn.rememberContext(origin);
  prepare(targetCourse);
  nav.navigate(targetPage);
}

function ReviewView({ feedback }) {
  const { data, core, nav, lib, set, session, learn, dailyPlan, settingsEntry, tour } = useApp();
  const run = session.run;
  // A finished round may change what today's plan shows next (practice progress is counted from the answers), so read it again once.
  useEffect(() => { if (run?.complete) dailyPlan.refresh?.(); }, [run?.id, run?.complete]); // eslint-disable-line react-hooks/exhaustive-deps
  const detour = run && lib.detour && !(lib.detour.runId === run.id && lib.detour.index === run.index) ? lib.detour : null;
  const links = useMemo(() => {
    if (!run) return {};
    const questionRef = questionNoteRef(run);
    return {
      onBackToWorkflow: (sessionId) => { set.setWorkflowReturn({ sessionId, nonce: Date.now() }); nav.navigate('workflows'); },
      onOpenNote: (noteId) => learn.openLearningTarget({ kind: 'note', id: noteId }),
      onRecapSettings: () => { learn.rememberContext(learn.captureContext()); settingsEntry.setSettingsFocus('settings-daily-recap'); nav.show.page('settings'); },
      onPracticeSettings: () => { learn.rememberContext(learn.captureContext()); settingsEntry.setSettingsFocus('settings-practice'); nav.show.page('settings'); },
      onModelSettings: settingsEntry.openModelSettings,
      // 写笔记 opens today's course study note (appending this question's block when new; #1017) in the page's language.
      onMakeNote: () => {
        const origin = learn.captureContext();
        const noteCourse = questionNoteCourse(run, data?.decks);
        return core.act('note.create', { title: questionNoteTitle(noteCourse), cards: [questionRef], reuse: true, prefill: true, language: getUiLanguage() },
          (note) => { learn.rememberContext(origin); nav.show.note(note.id); });
      },
      // 存进笔记 under a Q&A: into today's course study note, once per follow-up (note.qa.add); the practice page then reads 已存进笔记 from the note badges.
      onSaveQaToNote: (followupId) => core.act('note.qa.add', qaToNoteArgs(run, followupId, data?.decks), undefined, { rethrow: true }),
      onMakeTask: learn.openBoardWithContext,
      openSkeleton: (id) => learn.openLearningTarget({ kind: 'skeleton', id }),
      onOpenOutline: pageAvailable(data, 'outline') ? async (place) => {
        const target = place?.chapter?.key || place?.document?.key || place?.leaf?.key || '';
        if (!target) return;
        await openReviewCoursePage({
          place, data, core, session, learn, nav, targetPage: 'outline',
          prepare: (targetCourse) => keepOutline(data?.root, targetCourse, { target, leafKey: place?.leaf?.key || null }),
        });
      } : undefined,
      onOpenBookSection: pageAvailable(data, 'book') ? async (place) => {
        if (!place?.leaf?.built || !place?.leaf?.key) return;
        await openReviewCoursePage({
          place: place.leaf.course ? { ...place, course: place.leaf.course } : place,
          data, core, session, learn, nav, targetPage: 'book',
          prepare: (targetCourse) => keepBook(data?.root, targetCourse, { target: place.leaf.key }),
        });
      } : undefined,
      onReturnToReading: learn.returnToReading,
    };
  }, [run, data, core, session, nav, set, learn, settingsEntry]);
  const { coach: sessionCoach, continueTo } = session;
  const coachProps = useMemo(() => (
    data && run ? { ...sessionCoach, destination: run.complete ? continueTo(dailyPlan) : undefined } : undefined
  ), [data, run, sessionCoach, continueTo, dailyPlan]);
  const context = useMemo(() => ({
    label: learn.trailLabel,
    onReturn: learn.returnFromContext,
    detour,
    onReturnFromDetour: learn.returnFromDetour,
    kind: learn.trailPage,
    place: learn.trailPlace,
    tourRunning: !!tour.tourStep,
  }), [learn.trailLabel, learn.returnFromContext, detour, learn.returnFromDetour, learn.trailPage, learn.trailPlace, tour.tourStep]);
  const onBoard = React.useCallback(() => { set.setBoardView('today'); nav.navigate('board'); }, [set, nav]);
  if (!run) return null;
  return (
    <>
      <RelatedTasks plan={dailyPlan} runId={run.id} onBoard={onBoard} />
      <Review session={session} data={data} shellTitle={shellTitleOf('review', { run, decks: data?.decks })} feedback={feedback}
        coachProps={coachProps} links={links} context={context} />
    </>
  );
}

function NotesView() {
  const { data, nav, lib, set, shell, learn, settingsEntry, intents, session } = useApp();
  return (
    <BlogNotes key={data.root} data={data} theme={shell.resolvedTheme} onModelSettings={settingsEntry.openModelSettings}
      onRecapSettings={() => { learn.rememberContext(learn.captureContext()); settingsEntry.setSettingsFocus('settings-daily-recap'); nav.show.page('settings'); }}
      initialId={lib.noteInitialId} onSelect={set.setNoteInitialId} onOpenCard={(reference) => learn.openLearningTarget({ kind: 'card', ...reference })}
      onOpenSource={(id, quote) => learn.openLearningTarget({ kind: 'source', id, quote })}
      onPracticeCards={pageAvailable(data, 'review') ? (scope) => practiseRound({ intents, learn, session }, scope) : undefined}
      backLabel={learn.trailLabel} onBack={learn.hasTrail ? learn.returnFromContext : undefined} />
  );
}

function GuidedStudyView() {
  const { data, core, session, lib, set, nav, host } = useApp();
  const started = lib.guidedSession || data?.activeStudySession || null;
  // The session as it is now and its new question's preparation (#547): the main chat starts it, the reviewed question opens here as a round of one.
  const { session: guidedSession, prepState, clearFailure, refresh: readGuidedSession } = useGuidedQuestion({ session: started, call: core.call,
    onReady: (result) => { if (result.run) session.enterRun(result.run, undefined, false, { stayOnGuided: true }); core.refresh(); } });
  const run = session.run;
  const currentCard = run?.card || (run?.entries ? run.entries[run.index]?.card : null);

  const handleReveal = (runId) => {
    if (session.actions?.flipCard) return session.actions.flipCard();
    if (session.actions?.reviewAct) return session.actions.reviewAct('review.reveal');
    return core.act('review.reveal', { runId: runId || run?.id, cardId: currentCard?.id }, (next) => session.enterRun(next, undefined, false, { stayOnGuided: true }));
  };

  // A choice question is answered with the options the learner picked (graded by the card), any other kind with the learner's own grade.
  // The answer moves the progress and the range, which the session reads: read it again at once instead of after the next (possibly slowed) wait.
  const handleAnswer = async (answer) => {
    const args = typeof answer === 'object' && answer ? answer : { grade: answer };
    const done = session.actions?.reviewAct ? await session.actions.reviewAct('review.answer', args)
      : await core.act('review.answer', { runId: run?.id, cardId: currentCard?.id, ...args }, (next) => session.enterRun(next, undefined, false, { stayOnGuided: true }));
    void readGuidedSession();
    return done;
  };

  // Read the session again at once: its reads may have slowed down, and a paused session is not read after that (#564).
  const handlePause = (id) => core.act('study.session.pause', { sessionId: id }, () => { void readGuidedSession(); });
  const handleResume = (id) => core.act('study.session.resume', { sessionId: id }, () => { void readGuidedSession(); });

  const handleEnd = (id) => {
    if (!id) {
      set?.setGuidedSession?.(null);
      nav.navigate('library');
      return undefined;
    }
    return core.act('study.session.end', { sessionId: id }, () => {
      set?.setGuidedSession?.(null);
      nav.navigate('library');
    });
  };

  const handleCancelPrep = (sessionId) => {
    return core.act('study.question.cancel', { sessionId: sessionId || guidedSession?.id });
  };

  const handleNext = (runId) => {
    if (session.actions?.reviewAct) return session.actions.reviewAct('review.move', { direction: 1 });
    return core.act('review.move', { runId: runId || run?.id, direction: 1 }, (next) => session.enterRun(next, undefined, true, { stayOnGuided: true }));
  };

  // 请教主会话 before answering is help the answer got (#542), recorded before it is sent; the receipt is the one the workbench shows when nobody listens.
  const noteAskedTutor = () => session.actions?.noteAssistance?.('askedTutorBeforeAnswer');
  const handleAskTutor = (result) => { core.notify(result?.message || ''); };

  // 改用已有题练习: today's round of the session's course, from the questions it already has.
  const handleFallbackToExisting = () => {
    clearFailure();
    const course = guidedSession?.courseId;
    return core.act('review.start', practiceArgs(undefined, { fresh: false, ...(course ? { course, daily: true } : {}) }), session.enterRun);
  };

  return (
    <GuidedStudy
      session={guidedSession}
      run={session.run}
      prepState={prepState}
      progress={guidedSession?.progress}
      estimate={guidedSession?.estimate}
      cost={guidedSession?.cost}
      modelReady={data?.modelReady !== false && data?.model?.ready !== false}
      courses={data?.courses}
      host={host}
      onPause={handlePause}
      onResume={handleResume}
      onEnd={handleEnd}
      onReveal={handleReveal}
      onAnswer={handleAnswer}
      onNext={handleNext}
      onCancelPrep={handleCancelPrep}
      onFallbackToExisting={handleFallbackToExisting}
      onBeforeAskTutor={noteAskedTutor}
      onAskTutor={handleAskTutor}
    />
  );
}

/** The component of each page that shows through <PageView>. Board and live class are drawn by the shell itself (they keep running or load without a snapshot). */
export const PAGE_VIEWS = {
  library: LibraryView, workflows: WorkflowsView, skeleton: SkeletonView, dashboard: DashboardView, exam: ExamView, wrongbook: WrongBookView, graph: GraphView,
  manage: ManageView, sources: SourcesView, audio: AudioView, tasks: TasksView, generate: GenerateView, draft: DraftView, settings: SettingsView, review: ReviewView, notes: NotesView,
  examprep: ExamPrepView, examcoach: ExamCoachView, outline: OutlineView, book: BookView, guided: GuidedStudyView,
};

/** 备考补习 while the learner has it turned off in Settings (the switch is not a component, so the generic text about components would be wrong). */
function ExamPrepOffPage() {
  const { settingsEntry } = useApp();
  return (
    <section className="page" role="status">
      <PageHeader title={ui('备考补习还没有开启')}
        description={ui('备考补习在设置里被关掉了，要用的话在设置里重新打开；已保存的考点清单仍可阅读。')}
        actions={<Button iconEnd="arrow-right" variant="primary" onClick={() => settingsEntry.openSettings('settings-exam-prep')}>{ui('前往设置')}</Button>} />
    </section>
  );
}

/** What the learner sees when the host has switched the page's components off (备考补习 has its own: its switch is not a component).
    The words say to enable the components in DSH, so the first button is the plugin manager when the host can open it. */
export function DisabledPage({ page }) {
  const { data, nav, host } = useApp();
  if (page === 'examprep' && data?.features?.[pageFlag('examprep')] !== true) return <ExamPrepOffPage />;
  const pluginManager = !!host?.openPluginManager;
  return (
    <section className="page" role="status">
      <PageHeader title={ui('这个页面需要的组件没有启用')} description={ui('在 DSH 插件管理器里启用它们就能继续；你已保存的学习资料都还在。')}
        actions={<>
          {pluginManager && <Button variant="primary" icon="external" onClick={() => host.openPluginManager()}>{ui('打开 DSH 插件管理器')}</Button>}
          <Button iconEnd="arrow-right" variant={pluginManager ? 'secondary' : 'primary'} onClick={() => nav.navigate('settings', { animate: true, keepTrail: false })}>{ui('前往设置')}</Button>
        </>} />
    </section>
  );
}

/** The start page before a library has loaded: which folder and model, and a retry. */
export function StartPage() {
  const { core } = useApp();
  const busy = useStudyBusy();
  return (
    <section className="onboarding">
      <div className="eyebrow">{ui('你的学习空间')}</div>
      <h1>{ui('把资料变成真正会的知识。')}</h1>
      <p className="intro">{ui('学习库还没有打开。它默认放在当前工作区；打不开的话，换一个目录再点「重试」。')}</p>
      <WorkspaceBindingPanel />
      <Button variant="primary" lock={busy} onClick={() => core.refresh().then(() => core.setError(''), (failure) => core.setError(failure.message))}>{ui('重试')}</Button>
    </section>
  );
}

/** The registry's component for a page (ui/pages.js names it, PAGE_VIEWS draws it). */
export function PageView({ page, feedback }) {
  const describe = useDiagnostics(currentStudyHubVersion, currentUpgradeMarker);
  const View = PAGE_VIEWS[page];
  // One boundary for every page, keyed by the page: a page that throws leaves the sidebar and the top bar in place, and another page opens fresh.
  return View ? <PageBoundary key={page} describe={describe}><View feedback={feedback} /></PageBoundary> : null;
}
