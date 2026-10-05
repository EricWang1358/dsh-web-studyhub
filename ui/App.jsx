/* StudyHub for DeepSeek Harness (DSH): the workbench page.
   Contributed by ericwang1358 (https://github.com/EricWang1358).
   App composes: its hooks (ui/app/use-*.js, ui/review/useReviewSession.js) own the state and the verbs, the shell parts
   (ui/app/App*.jsx) draw the sidebar, top bar and dialogs, and ui/app/page-views.jsx maps each page of ui/pages.js to its component. */
import React, { useMemo, useRef } from 'react';
import { LiveClass } from './workspace-views.jsx';
import { pageAvailable } from './capabilities.js';
import { ui, useUiLanguage } from './i18n.js';
import Tour from './tour/Tour.jsx';
import Board, { useBoard } from './Board.jsx';
import DailyPlan from './DailyPlan.jsx';
import ShortcutHelp from './ShortcutHelp.jsx';
import ActionFeedback, { useNotice, reviewNoticeScope } from './ActionFeedback.jsx';
import { useDailyPlan } from './daily-plan.js';
import { dueSummary } from '../lib/board-model.js';
import { appearanceStyle } from './appearance-prefs.js';
import { scienceVars } from './science-settings.js';
import { SciencePreferencesContext } from './SciencePreferences.jsx';
import { CourseActiveProvider } from './CourseActive.jsx';
import { QuickActionsContext } from './quick-actions.js';
import { ToastContext } from './components/Feedback.jsx';
import { LoadingState } from './components/Loading.jsx';
import { StudyServicesContext } from './study-context.jsx';
import { ModelSettingsContext } from './ModelErrorNote.jsx';
import { useInjectCss } from './shared.js';
import sideGroupsCss from './side-groups.css';
import quickCss from './quick-actions.css';
import coachCss from './coach.css';
import libraryChipCss from './library-chip.css';
import localeCss from './language.css';
import { AppContext } from './app/app-context.js';
import { useAppShell } from './app/use-app-shell.js';
import { useAppCore } from './app/use-app-core.js';
import { useLibraryReset, useLibraryState } from './app/library-state.js';
import { useNavigation } from './app/use-navigation.js';
import { useLearningNavigation } from './app/use-learning-navigation.js';
import { useIntents } from './app/use-intents.js';
import { useDrafts } from './app/use-drafts.js';
import { useInbox } from './app/use-inbox.js';
import { useNotebooks } from './app/use-notebooks.js';
import { useSettingsEntry } from './app/use-settings-entry.js';
import { useSourceImport } from './app/use-source-import.js';
import { useSelectionNotices } from './app/use-selection-notices.js';
import { useHostLinks } from './app/use-host-links.js';
import { useTour } from './app/use-tour.js';
import { freshGeneration, initialGeneration, useLibraryConnection } from './app/use-library-connection.js';
import { useReviewSession } from './review/useReviewSession.js';
import { shellTitleOf } from './app/shell-title.js';
import AppSidebar from './app/AppSidebar.jsx';
import AppTopbar from './app/AppTopbar.jsx';
import AppModalHost, { readerOpen } from './app/AppModalHost.jsx';
import { ContextReturn, IngestBanner, StorageIssuesBanner } from './app/AppBanners.jsx';
import { DisabledPage, PageView, StartPage } from './app/page-views.jsx';

export { LibraryChip, libraryFolderName } from './app/AppTopbar.jsx';

const LANG_ATTR = { en: 'en', zh: 'zh-CN' };

/** One empty host for previews and tests, so the services and model-settings contexts keep a stable value across renders. */
const NO_HOST = Object.freeze({});
export default function App({ call: transportCall, host = NO_HOST }) {
  const language = useUiLanguage();
  useInjectCss(localeCss, 'study-language');
  useInjectCss(sideGroupsCss, 'study-side-groups');
  useInjectCss(coachCss, 'study-coach');
  useInjectCss(libraryChipCss, 'study-library-chip');
  useInjectCss(quickCss, 'study-quick-actions');
  const shell = useAppShell();
  const core = useAppCore(transportCall, host);
  const [lib, set] = useLibraryState({ gen: initialGeneration(host, language) });
  const handle = { state: lib, set };
  const late = useRef({});
  const nav = useNavigation({ core, lib: handle, motion: shell.motion, rootRef: shell.rootRef });
  const session = useReviewSession({ core, nav, modalOpen: !!lib.modal, host, rootRef: shell.rootRef, late });
  const resetLibraryState = useLibraryReset({ core, libApi: set, nav, session, defaultGen: () => freshGeneration(core.refs.dataRef.current?.settings) });
  const connection = useLibraryConnection({ core, libApi: set, resetLibraryState, session, nav, host, language });
  const { data } = connection;
  const [notice, setNotice] = useNotice(reviewNoticeScope(connection.binding.root, nav.page, session.run));
  core.refs.noticeRef.current = setNotice;
  const learn = useLearningNavigation({ core, lib: handle, nav, session, rootRef: shell.rootRef });
  const intents = useIntents({ core, lib: handle, nav, session, learn });
  late.current.resume = intents.resumeOrStart;
  const drafts = useDrafts({ core, lib: handle, nav, data });
  const inbox = useInbox({ core, lib: handle, nav, session, learn, data });
  const settingsEntry = useSettingsEntry({ nav, host });
  const notebooks = useNotebooks({ core, lib: handle, nav, host, root: connection.binding.root });
  const sources = useSourceImport({ core, lib: handle, nav, drafts, intents, data });
  const tour = useTour({ core, lib: handle, nav, session, drafts, intents, data, rootRef: shell.rootRef });
  const selectionNotices = useSelectionNotices({ core, learn, data });
  const { courseActive } = useHostLinks({ host, core, nav, session, learn, rootRef: shell.rootRef, data, loading: connection.loading });
  const boardState = useBoard(core.call, nav.page === 'board');
  // Cards due today or overdue light the badge, so a deadline shows from any page.
  const board = { state: boardState, count: boardState.board?.columns.reduce((total, column) => total + (column.done ? 0 : column.cardIds.length), 0),
    due: boardState.board ? dueSummary(boardState.board) : { overdue: 0, today: 0 } };
  const dailyPlan = useDailyPlan({ call: core.call, root: data && pageAvailable(data, 'review') ? data.root : null, navigation: () => core.refs.navigation.current,
    progressKey: session.run ? `${session.run.id}:${session.run.answered}:${session.run.complete}` : '',
    visible: ['library', 'board', 'review', 'workflows'].includes(nav.page) || readerOpen(lib.modal),
    onLaunch: async (result) => { if (result.run) session.enterRun(result.run); else if (result.studyRef) await learn.openBoardReference(result.studyRef); },
    onChanged: () => boardState.refresh({ force: true }) });

  const study = useMemo(() => ({ call: core.call, act: core.act, busy: core.busy, notify: core.notify, askInChat: core.askInChat, host,
    openSettings: settingsEntry.openSettings, navigate: nav.navigate, openModal: set.setModal }),
  [core.call, core.act, core.busy, core.notify, core.askInChat, host, settingsEntry.openSettings, nav.navigate, set.setModal]);
  const app = { language, host, data, canChat: host.capabilities?.chat ?? !!host.askInChat, connection, core, shell, nav, lib, set, session, learn, intents, drafts,
    notebooks, inbox, sources, tour, settingsEntry, dailyPlan, board, selectionNotices, resetLibraryState };

  if (connection.loading) return <div className="study-app"><LoadingState className="app-loading" label={connection.connecting || ui('正在打开学习工作区…')} /></div>;
  const { run } = session, page = nav.page;
  const feedback = <ActionFeedback error={core.error} notice={notice} busy={core.busy} onCloseError={() => core.setError('')} onCloseNotice={() => setNotice('')} />;
  return (
    <SciencePreferencesContext.Provider value={shell.sciencePrefs}>
      <QuickActionsContext.Provider value={core.quickApi}>
        <CourseActiveProvider value={courseActive}>
          <ToastContext.Provider value={core.toast}>
            <StudyServicesContext.Provider value={study}>
            <ModelSettingsContext.Provider value={settingsEntry.openModelSettings}>
              <AppContext.Provider value={app}>
                <div className="study-app" {...shell.appearanceAttrs} style={{ ...scienceVars(shell.sciencePrefs), ...appearanceStyle(shell.appearance) }}
                  lang={LANG_ATTR[language]} ref={shell.attachRoot} data-usage-area={page} tabIndex={-1}
                  onPointerDown={(event) => { if (!event.target.closest('button,input,textarea,select,a')) shell.rootRef.current?.focus(); }}>
                  <AppSidebar />
                  <main className={nav.pageTarget ? 'is-leaving' : undefined}>
                    <AppTopbar title={shellTitleOf(page, { run, decks: data?.decks })} />
                    <IngestBanner />
                    <StorageIssuesBanner />
                    <ContextReturn />
                    {data && pageAvailable(data, 'live') && <LiveClass key={connection.binding.root} data={data} call={core.call} visible={page === 'live'}
                      onSettings={() => nav.navigate('settings')} onSources={() => nav.navigate('sources')}
                      onJobs={() => { void core.refresh().catch((failure) => core.setError(failure.message)); }} />}
                    {page === 'board' ? (
                      <Board state={boardState} library={data} onOrigin={host.openWorkspaceNotebook} studyRef={lib.boardStudyRef}
                        dailyPlan={data && pageAvailable(data, 'review') ? <DailyPlan key={`${data.root}:${dailyPlan.date}`} plan={dailyPlan}
                          modelReady={data.model?.ready !== false} openModelSettings={settingsEntry.openModelSettings} /> : null}
                        onClearStudyRef={() => set.setBoardStudyRef(null)} onStudyRef={learn.openBoardReference} />
                    ) : !data ? <StartPage />
                      : !pageAvailable(data, page) ? <DisabledPage />
                        : <PageView page={page} feedback={feedback} />}
                    {/* Page toasts stick to the bottom of the view: the top-right is where every PageHeader keeps its actions. */}
                    {!(page === 'review' && run && !run.complete) && feedback}
                  </main>
                  {session.shortcutHelp && <ShortcutHelp page={page} onClose={session.actions.closeShortcutHelp} />}
                  {tour.tourStep && data && (
                    <Tour steps={tour.tourSteps} stepId={tour.tourStep} rootRef={shell.rootRef} model={tour.modelState} sampleLoaded={!data.sample || !!data.sample.loaded}
                      busy={tour.sampleBusy} onEnter={tour.enterTourStep} onMove={tour.moveTour} onClose={tour.closeTour} onFinish={tour.finishTour}
                      onLoadSample={data.sample ? tour.loadSampleInTour : undefined} onBrowse={() => tour.moveTour(1)}
                      onImport={() => tour.endTour({ then: tour.openFirstImport })}
                      onRemoveSample={data.sample?.loaded ? () => tour.endTour({ then: () => tour.setRemovingSample(true) }) : undefined} />
                  )}
                  <AppModalHost />
                </div>
              </AppContext.Provider>
            </ModelSettingsContext.Provider>
            </StudyServicesContext.Provider>
          </ToastContext.Provider>
        </CourseActiveProvider>
      </QuickActionsContext.Provider>
    </SciencePreferencesContext.Provider>
  );
}
