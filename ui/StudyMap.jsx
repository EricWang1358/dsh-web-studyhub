import { ui, uiFormat } from "./i18n.js";
import React, { useContext, useEffect, useRef, useState } from "react";
import { Button, Icon, useToast } from "./components/index.js";
import { useStudy } from "./study-context.jsx";
import { ModelSettingsContext } from "./ModelErrorNote.jsx";
import { dismissJobs, useQuickActions } from "./quick-actions.js";
import { isActiveJob, visibleGenerationJobs } from "./job-visibility.js";
import { modelReadiness } from "./generation-status.js";
import focusCss from "./focus.css";
import homeCss from "./generate-home.css";
import caseCss from "./case-study.css";
import tiersCss from "./home-tiers.css";
import mapCss from "./study-map/study-map.css";
import { useInjectCss } from "./shared.js";
import SetupChecklist from "./SetupChecklist.jsx";
import { EMPTY_PROGRESS, sameScope } from "./study-map/map-model.js";
import { useDeckTree } from "./study-map/useDeckTree.js";
import { useCourseFolders } from "./study-map/useCourseFolders.js";
import { useCourseMastery } from "./study-map/useCourseMastery.js";
import { buildHomePlan } from "./study-map/home-plan.js";
import HomeActivity, { HomeDrafts } from "./study-map/HomeActivity.jsx";
import DeskIntro from "./study-map/DeskIntro.jsx";
import TodayCard from "./study-map/TodayCard.jsx";
import { useRoleDraft } from "./study-map/RoleSuggestion.jsx";
import CatalogHeading from "./study-map/CatalogHeading.jsx";
import CatalogToolbar from "./study-map/CatalogToolbar.jsx";
import TopicGroupReminder from "./study-map/TopicGroupReminder.jsx";
import MergeSuggestions, { useMergeSuggestions } from "./study-map/MergeSuggestions.jsx";
import DeckTree from "./study-map/DeckTree.jsx";
import NotebookDirectory from "./study-map/NotebookDirectory.jsx";
import SelectionBar from "./study-map/SelectionBar.jsx";
import { isAudioJob, JOB_TYPES } from '../lib/job-status.js';

/* The library home: the day's one card, the course heading, generation
   progress and drafts, and the catalogue of decks by course. Each part lives in
   ui/study-map; this component wires the data to them and owns the few
   switches (search, archived, other and parked courses).
   The services (call, act, busy, askInChat, host) come from useStudy(); what is left to pass is the
   library snapshot and the verbs only the app can do:
     actions        { start, resume, manage, removeDeck, openDraft, topUpDraft, retryGeneration, addSource, createManual,
                      importLibrary, generateFromSources, startCourseFlow, onCoachPractice, onWeakPoints, onShowGraph,
                      onCourseSettings, onShowOutline } (see ui/app/page-views.jsx)
     setupHandlers  the 课程准备 checklist's handlers (createSetupHandlers)
     notebooks      the cross-workspace notebook directory (useNotebooks: notebooks, notebookError, publish, unpublish, open,
                    loadNotebooks, search)
     reveal / onRevealed   scroll the progress card into view after a generation starts */
export default function StudyMap({ data, actions = {}, setupHandlers, notebooks, reveal, onRevealed, children }) {
  const { call, act, busy, askInChat, host } = useStudy();
  const toast = useToast();
  const quick = useQuickActions();
  const openModelSettings = useContext(ModelSettingsContext) || undefined;
  const canChat = host.capabilities?.chat ?? !!host.askInChat;
  const { start, resume, manage, removeDeck, openDraft, topUpDraft, retryGeneration, addSource, createManual, importLibrary,
    generateFromSources, startCourseFlow, onCoachPractice, onWeakPoints, onShowGraph, onCourseSettings, onShowOutline } = actions;
  const endRun = (runId) => act("review.end", { runId });
  const restoreDeck = (id) => act("deck.archive", { id, archived: false }, () => toast.success(ui("题组已恢复。")));
  const cancelJob = (jobId) => act("job.cancel", jobId ? { jobId } : { all: true });
  const dismissJob = (jobId, alsoIds) => dismissJobs(quick, jobId, alsoIds);
  const onFocus = (next) => act("focus.set", next);
  const suggestRole = (args) => call("focus.suggest", args);
  const suggestMerges = (args) => call("deck.merge.suggest", args);
  const mergeDecks = (args) => act("deck.merge", args, null, { rethrow: true });
  useInjectCss(focusCss, "study-focus");
  useInjectCss(homeCss, "study-generate-home");
  useInjectCss(caseCss, "study-case-workspace");
  useInjectCss(tiersCss, "study-home-tiers");
  useInjectCss(mapCss, "study-map");
  const pageRef = useRef(null), activityRef = useRef(null);
  // After a generation starts, land with its progress card in view (P26).
  useEffect(() => {
    if (!reveal) return;
    pageRef.current?.scrollIntoView?.({ block: "start" });
    onRevealed?.();
  }, [reveal]); // eslint-disable-line react-hooks/exhaustive-deps
  const [search, setSearch] = useState(""),
    [showOtherCourses, setShowOtherCourses] = useState(false),
    [showParked, setShowParked] = useState(false),
    [showArchived, setShowArchived] = useState(false);
  const tree = useDeckTree(data.root, data.decks);
  const merge = useMergeSuggestions({ suggestMerges, mergeDecks, course: data.focus?.course });
  const role = useRoleDraft(data.focus?.role);
  const query = search.trim().toLowerCase();
  const folders = useCourseFolders(data, { query, showArchived, showOtherCourses, showParked });
  const progress = data.progress || EMPTY_PROGRESS, runs = data.runs || [];
  const mastery = useCourseMastery(data, progress);
  const runFor = (scope) => runs.find((run) => run.mode === "path" && sameScope(run.scope, scope));
  // Audio imports and PDF conversions report progress in the Sources page, not among question generations.
  const jobs = (data.jobs || []).filter((job) => !isAudioJob(job) && job.type !== JOB_TYPES.PDF_CONVERT && job.type !== JOB_TYPES.TRANSLATION && job.type !== JOB_TYPES.COACH_DAILY);
  const activeJobs = jobs.filter((job) => isActiveJob(job) && job.type !== JOB_TYPES.DRAFT_PUBLISH);
  // Top of the home: what is still running first, then the newest finished cards.
  const shown = visibleGenerationJobs(jobs);
  const visibleJobs = [...shown.filter(isActiveJob), ...shown.filter((job) => !isActiveJob(job)).reverse()];
  const revealActivity = () => (activityRef.current || pageRef.current)?.scrollIntoView?.({ block: "start", behavior: "smooth" });
  const home = buildHomePlan({ data, today: data.today || { due: 0, weak: 0, new: 0, size: 0 }, runs, runFor, activeJobs, inFocus: folders.inFocus, canChat, revealActivity,
    actions: { start, resume, openDraft, addSource, importLibrary, askInChat, generateFromSources, startCourseFlow, onCoachPractice, onWeakPoints } });
  const drafts = data.drafts || [];
  const showNotebooks = data.decks.length > 0 || (notebooks?.notebooks?.notebooks || []).some((notebook) => !notebook.current);
  const selectedRun = tree.scope.length ? runFor(tree.scope) : null;
  const deckActions = { start, resume, manage, askInChat, restoreDeck, removeDeck };
  return (
    <section className="page library-page map-page" ref={pageRef}>
      {children}
      <HomeActivity sectionRef={activityRef} jobs={visibleJobs} drafts={drafts} data={data} modelReady={modelReadiness(data).ready}
        start={start} manage={manage} openDraft={openDraft} openAgent={host.openAgent} cancelJob={cancelJob} dismissJob={dismissJob}
        retryGeneration={retryGeneration} openModelSettings={openModelSettings} topUpDraft={topUpDraft} />
      {/* 课程准备: what is done once per course, above the day's work while it is open and one quiet line after. */}
      <SetupChecklist key={`${data.root}:${data.focus?.course ?? ""}`} data={data} on={setupHandlers} />
      <div className={"desk" + (home.plan.kind === "empty" ? " is-empty" : "")} data-tour="home-hero">
        <DeskIntro data={data} home={home} mastery={mastery} role={role} busy={busy} start={start} resume={resume} endRun={endRun}
          onFocus={onFocus} onCourseSettings={onCourseSettings} onShowOutline={onShowOutline} suggestRole={suggestRole} />
        <TodayCard plan={home.plan} todayLabel={home.todayLabel} busy={busy} />
      </div>
      {/* 待发布 is folded and sits under the day's work, not above it. */}
      <HomeDrafts drafts={drafts} data={data} modelReady={modelReadiness(data).ready} openDraft={openDraft} topUpDraft={topUpDraft} />
      <CatalogHeading count={data.decks.filter((deck) => !!deck.archived === showArchived).length} showArchived={showArchived} hasDecks={data.decks.length > 0}
        hasSources={data.sources.length > 0} course={data.focus?.course} merge={merge} busy={busy} slain={data.decks.find((deck) => deck.systemKind === "slain")}
        addSource={addSource} createManual={createManual} importLibrary={importLibrary} manage={manage} onShowGraph={onShowGraph}
        onShowOutline={home.route?.chapters?.length ? onShowOutline : undefined} />
      <TopicGroupReminder grouping={data.topicGrouping} root={data.root} askInChat={askInChat} />
      <MergeSuggestions merge={merge} busy={busy} />
      {data.decks.length > 0 && <CatalogToolbar search={search} onSearch={setSearch} showArchived={showArchived}
        onToggleArchived={() => { setShowArchived((value) => !value); tree.clearSelection(); }} />}
      {showArchived && <p className="muted archive-explanation">{ui('已归档题组不参与学习。恢复后可继续学习；永久删除会保留原始资料和作答记录。')}</p>}
      {folders.visible.length ? (
        <DeckTree data={data} folders={folders.shownFolders} tree={tree} query={query} showArchived={showArchived} singleCourse={folders.singleCourse}
          inFocus={folders.inFocus} parkedByName={folders.parkedByName} progress={progress} runFor={runFor} busy={busy} actions={deckActions} />
      ) : data.decks.length ? (
        <p className="muted map-empty">{ui("没有符合条件的题组。")}</p>
      ) : (
        // The desk above already says what to do first; the catalogue only explains itself.
        <p className="muted map-empty">{ui("发布第一组题后，这里会按课程列出题组和掌握度。")}</p>
      )}
      {folders.otherCourseCount > 0 && <Button variant="quiet" size="sm" className="show-other-courses" onClick={() => setShowOtherCourses(true)}>{uiFormat("查看其他课程 · {0}", [folders.otherCourseCount])}</Button>}
      {folders.parkedFolders.length > 0 && !query && <Button variant="quiet" size="sm" className="show-other-courses parked-toggle" aria-expanded={showParked}
        icon={<Icon name="caret" size={14} className="sh-caret" />}
        onClick={() => setShowParked((value) => !value)}>{uiFormat("未激活的课程 ({0})", [folders.parkedFolders.length])}</Button>}
      {/* Cross-workspace notebooks are for people with decks, or with notebooks elsewhere (P12). */}
      {showNotebooks && <NotebookDirectory notebooks={notebooks?.notebooks} error={notebooks?.notebookError} busy={busy} onPublish={notebooks?.publish}
        onUnpublish={notebooks?.unpublish} onOpen={notebooks?.open} refresh={notebooks?.loadNotebooks} onSearch={notebooks?.search} />}
      <SelectionBar scope={tree.scope} run={selectedRun} busy={busy} onClear={tree.clearSelection} onShowGraph={onShowGraph} onStart={start} onResume={resume} />
    </section>
  );
}
