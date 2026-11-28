import { ui, uiFormat } from "./i18n.js";
import { useHandOff } from "./hand-off/use-hand-off.js";
import { useStudy } from "./study-context.jsx";
import React from "react";
import Ingest from "./Ingest.jsx";
import JsonImport from "./JsonImport.jsx";
import { useInjectCss } from "./shared.js";
import { pageAvailable } from "./capabilities.js";
import KindPicker from "./KindPicker.jsx";
import CourseField from './CourseField.jsx';
import { courseNamesOf, usePageScope } from './PageScope.jsx';
import SourcePicker from './SourcePicker.jsx';
import { openIndexBuilder } from './index-focus.js';
import useIndexCoverage from './use-index-coverage.js';
import GenerationPath from './GenerationPath.jsx';
import TooBigChoice, { FocusHelp } from './TooBigChoice.jsx';
import { useGenerationPath } from './use-generation-path.js';
import { MODES, availableModes, effectiveMode, pathSummary, showsChoice } from './too-big-choice.js';
import { courseForSources } from '../lib/source-courses.js';
import { generationRulesOf } from '../lib/courses.js';
import { Button, Disclosure, EmptyState, Hint, Icon, InlineMessage, PageHeader, SegmentedControl, Tooltip, addSourceAction } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { freshGeneration, generationFormDefaults, modelReadiness } from './generation-status.js';
import { startGeneration } from './generate-start.js';
import GenerateAssist from './GenerateAssist.jsx';
import { TokenEstimate, TokenEstimateView, useUsageEstimate } from './TokenUsage.jsx';
import { callsText } from './token-usage.js';
import { useStickyRoom } from './use-sticky-room.js';
import CoverageStrength, { MaterialsForecast, PlanCaps } from './coverage/CoverageStrength.jsx';
import { autoLine } from './coverage/copy.js';
import { openingLine, openingSelection, openingStands } from './generate-opening.js';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import RetrievalPanel from './RetrievalPanel.jsx';
import { generateAdvice, retrievalReady } from './large-document-advice.js';
import { useRetrievalStatus } from './retrieval-status.js';
import {
  DIFFICULTIES, LANGUAGES, LEARNER_LEVELS, appendFocus, applySuggestion, autoOf, customCountOf, courseHasCaseExam, coverageStructure,
  NOTATION_CHOICES, caseEvidence, chosenOptions, difficultyNote, estimateMinutes, estimateRequestOf, importDialog, kindNote, kindsOfForm, kindsPatch, extraValuesOf, learnerLevelNote, moreValuesOf, notationNote, roleOpenByDefault, selectionStats, summaryLine,
} from './generate-form.js';
import { DEFAULT_LEVEL, levelOf } from '../lib/coverage-strength.js';
import { writesInOnePass } from '../lib/one-pass/route.js';
import { DEPTHS, depthApplies, depthOf, performanceOfDepth, presetCell } from '../lib/contexts/generation/presets.js';
import { depthOffReason, matrixColumns } from './presets/copy.js';
import { PresetPicker } from './presets/Presets.jsx';
import { deferredView } from './deferred-view.jsx';
import { MATRIX_CELLS, PRESET_CELLS, cellCosts, pricesCells } from './presets/cost.js';
import { useCellEstimates } from './presets/use-cell-estimates.js';
import homeCss from './generate-home.css';
import formCss from './generate-form.css';
import focusIntakeCss from './focus-intake.css';
import CaseCreate from './CaseCreate.jsx';
import ReferenceQuestions from './ReferenceQuestions.jsx';
import GenerationTransparency, { EffectiveRequirementsStrip } from './GenerationTransparency.jsx';
import { FormGroup, FormRow } from './generate-rows.jsx';
import { referenceSelection } from './reference-questions.js';
import { useLiveEffect } from './use-async.js';
import { settingsSectionOr } from './settings-groups.js';

// 出题深度 and the matrix of rough costs stand in 更多选项, shut when the page opens: they arrive after the first screen, not with the workspace's first load
// (tests/workspace-closure-pages.test.mjs). Nothing holds their place while the chunk comes: the fold is shut by then, or opens on a row that fills in.
const PresetsFold = deferredView(() => import('./presets/PresetsFold.jsx'), { loading: () => null });

/* 创建题组 (D1): generating from the learner's own materials comes first;
   importing questions that already exist is the second way in. Generation is
   gated on a usable model before any effort goes into the form (P14). */
export default function Generate({
  data,
  running,
  openDraft,
  setPage,
  genSource,
  setGenSource,
  gen,
  setGen,
  selectedSources,
  setSelectedSources,
  setModal,
  canChat = false,
  openModelSettings,
  onStarted,
  caseInitial,
  onCourseSettings,
  reasoningEffort = '',
  initialRetrieval = null,
  initialGenerationMode = null,
}) {
  useInjectCss(homeCss, "study-generate-home");
  const { notify, call, busy, act, openSettings: openSettingsSection, openModal } = useStudy();
  const { send } = useHandOff();
  useInjectCss(formCss, "study-generate-form");
  useInjectCss(focusIntakeCss, "study-focus-intake");
  const [sourceScope, setSourceScope] = usePageScope(data.root, 'generate-sources', data.focus?.course ?? '*');
  // Whether each material's search index is built: the picker rows say so (and follow a running build). The page is drawn at once, as any page; while the answer is on
  // its way every row holds the badge's slot, and it keeps that column's width after, badge or none; its facts are one line either way, so no row moves (#1084).
  const [indexCoverage, , indexStatus] = useIndexCoverage(call);
  const known = courseNamesOf(data);
  const activeSourceIds = React.useMemo(
    () => new Set((data.sources || []).filter((source) => source && !source.archived && !source.historical).map((source) => source.id)),
    [data.sources],
  );
  const validSelectedSources = React.useMemo(
    () => selectedSources.filter((id) => activeSourceIds.has(id)),
    [selectedSources, activeSourceIds],
  );
  // Prune archived/deleted source IDs whenever the snapshot's sources list refreshes (without racing a just-imported selection before refresh lands).
  const prevSourcesRef = React.useRef(data.sources);
  React.useEffect(() => {
    if (prevSourcesRef.current === data.sources) return;
    prevSourcesRef.current = data.sources;
    setSelectedSources((current) => {
      if (!Array.isArray(current) || !current.length) return current;
      const next = current.filter((id) => activeSourceIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [data.sources, activeSourceIds, setSelectedSources]);
  const referenceSourceIds = gen.referenceSourceIds || [];
  const referenceState = referenceSelection(data.sources, referenceSourceIds, validSelectedSources, gen.referenceLimits, gen.referenceFormat);
  const evidenceSources = data.sources.filter(source => !referenceSourceIds.includes(source.id));
  const generationCourse = gen.course ?? courseForSources({ sources: data.sources }, validSelectedSources, sourceScope === '*' ? '' : sourceScope, known);
  const stats = React.useMemo(() => selectionStats(data.sources, validSelectedSources), [data.sources, validSelectedSources]);
  const selectedPdfPages = stats.pages;
  const model = modelReadiness(data);
  // 大教材 (WP28): what DSH can search with, read once, and what this page does with a selection of this size.
  const { data: retrieval } = useRetrievalStatus({ initialData: initialRetrieval ?? undefined, enabled: !initialRetrieval });
  const advice = generateAdvice({ sources: data.sources, selectedIds: validSelectedSources, focus: gen.focus, retrieval });
  // The learner's goal tells whether the target role belongs on the form; read once, quietly.
  const [goal, setGoal] = React.useState('');
  useLiveEffect((live) => {
    Promise.resolve(call?.('coach.profile', {})).then((profile) => { if (live() && typeof profile?.goal === 'string') setGoal(profile.goal); }, () => {});
  }, []);
  // 帮我想想: asked on click only; a result belongs to the sources and course it was asked for.
  const [assist, setAssist] = React.useState({ phase: 'idle', result: null, applied: false });
  const assistToken = React.useRef(0);
  const selectionKey = `${generationCourse}|${validSelectedSources.join(',')}`;
  React.useEffect(() => { assistToken.current += 1; setAssist({ phase: 'idle', result: null, applied: false }); }, [selectionKey]);
  // 分步出题: the plan of steps and what it does live in one hook so the form's own button can queue it; the choice of how to go on is this page's (TooBigChoice).
  const path = useGenerationPath({ sources: data.sources, selectedIds: validSelectedSources, gen, course: generationCourse, goal, indexCoverage,
    onQueued: () => { setGen(current => freshGeneration(current, data.settings?.generation)); setPage("library"); },
    onGoLibrary: () => setPage("library") });
  const [chosenMode, setChosenMode] = React.useState(initialGenerationMode);
  const modes = availableModes({ advice, pathReady: path.available, retrieval });
  const mode = effectiveMode(chosenMode, modes, advice);
  const choice = showsChoice(modes, advice);
  const pathMode = choice && mode === MODES.path, retrievalMode = choice && mode === MODES.retrieval;
  // 更多选项 holds every optional choice; it stays shut unless the form carries one (something typed, a choice that is not the saved default) or the way on needs a topic, so nothing set is hidden.
  const saved = React.useMemo(() => generationFormDefaults(data.settings?.generation), [data.settings?.generation]);
  // Shut, it still says the choices a run will use that are not the plain defaults (a difficulty, a language, a formula style), saved ones included (#1082).
  const chosen = chosenOptions(gen, generationFormDefaults());
  const [moreChoice, setMoreChoice] = React.useState(null);
  const [courseOpen, setCourseOpen] = React.useState(false);

  const activeCourseRecord = (data.courses || []).find((course) => course?.name === generationCourse);
  const foldOpen = moreChoice ?? (moreValuesOf(gen, saved) || roleOpenByDefault({ goal, focus: data.focus, course: activeCourseRecord, role: gen.role }) || retrievalMode);
  const setMoreOpen = (open) => setMoreChoice(open);
  // 额外要求 inside it: shut unless a quota or a module is already set, so nothing set is hidden.
  const [extraChoice, setExtraChoice] = React.useState(null);
  const extraOpen = extraChoice ?? extraValuesOf(gen);
  const setExtraOpen = (open) => setExtraChoice(open);
  // The steps' buttons: 只出这一步 narrows the selection to the step and goes back to the ordinary form with the step's own count.
  const narrowToStep = (step) => { setSelectedSources(step.sourceIds); setGen({ ...gen, customCount: String(step.count), ...(step.focus ? { focus: step.focus } : {}) }); setChosenMode(MODES.single); };
  const focusBox = React.useRef(null);
  React.useEffect(() => {
    const box = focusBox.current;
    if (!box) return;
    box.style.height = 'auto';
    box.style.height = `${Math.min(box.scrollHeight + 2, 220)}px`;
  }, [gen.focus]);
  async function askAssist() {
    const token = ++assistToken.current;
    setAssist({ phase: 'loading', result: null, applied: false });
    let result;
    try { result = await call('generate.suggest', { sourceIds: validSelectedSources, course: generationCourse, ...(goal ? { goal } : {}) }); }
    catch (error) { result = { source: 'local', focus: [], unavailable: { reason: 'failed', message: String(error?.message || '') } }; }
    if (token === assistToken.current) setAssist({ phase: 'done', result, applied: false });
  }
  // `options` ({ course, onImported }) is for a tab that takes the new materials itself (案例分析题); a click passes an event, which means neither.
  const openImport = (options) => setModal(importDialog(options?.course ?? (sourceScope === '*' ? '' : sourceScope), options));
  const openReferenceImport = onReferenceImported => setModal({ type: 'add', course: generationCourse,
    referenceQuestions: true, ...(onReferenceImported ? { onReferenceImported } : {}) });
  const openSettings = () => (openModelSettings ? openModelSettings() : setPage?.("settings"));
  // The long-document card's links: the search extension (检索设置) or the PDF converter's own section, not the top of 设置.
  const openLargeDocumentSettings = (section) => (openSettingsSection ? openSettingsSection(settingsSectionOr(section, 'settings-extensions')) : setPage?.("settings"));
  // 前往设置 on the form's line: the defaults of the types, the strength, the difficulty and the language are 设置 › 出题偏好.
  const openGenerationSettings = () => (openSettingsSection ? openSettingsSection(settingsSectionOr('settings-generation', 'settings-generation')) : setPage?.("settings"));
  // The page opens filled in (ui/generate-opening.js): with nothing ticked yet (the sidebar entry; the home and the checklist tick their own) the current course's documents that have no question
  // are ticked and one line says why; one document (a PDF is several page sources) is ticked because there is nothing to choose. Only on entering the page, so 清空选择 still sticks.
  // Before the first paint (a layout effect): the page is drawn at once, and the line and the ticks are in its first frame, never a line that pushes the list down (#1084).
  const [opening, setOpening] = React.useState(null);
  React.useLayoutEffect(() => {
    if (validSelectedSources.length) return;
    const found = openingSelection(data, { scope: sourceScope, known, exclude: referenceSourceIds });
    if (!found.sourceIds.length) return;
    setSelectedSources(found.sourceIds);
    setOpening(found);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = [
    { id: "files", label: ui("用资料出题"), note: ui("AI 按你的资料出题，并逐题检查"), attrs: { "data-tour": "generate-from-sources" } },
    { id: "json", label: ui("导入 JSON 题组"), note: ui("已有题目，或外部 AI 生成的题"), attrs: { "data-tour": "generate-json" } },
    // Case-study papers (WP12): a long case with open questions, graded criterion by criterion.
    { id: "case", label: ui("案例分析题"), note: ui("长案例 + 开放题，按评分标准逐项批改"), attrs: { "data-tour": "generate-case" } },
    // Recording into the conversation needs a chat that can take it (plan C3).
    ...(canChat ? [{ id: "chat", label: ui("在主会话里录题"), note: ui("题册、刷题软件、错题或截图") }] : []),
  ];
  const current = tabs.some((tab) => tab.id === genSource) ? genSource : "files";
  const wayNoteId = React.useId();
  const invalidQuota = Boolean(gen.kindCounts && typeof gen.kindCounts === "object" && !Array.isArray(gen.kindCounts)
    && kindsOfForm(gen).length >= 2 && kindsOfForm(gen).reduce((sum, k) => sum + (Number(gen.kindCounts?.[k]) || 0), 0) < 1);
  function submit(event) {
    event.preventDefault();
    if (pathMode) { if (model.ready && !busy && !path.queueing && path.included.length && !referenceState.reason) path.queue(); return; }
    if (!model.ready || busy || !validSelectedSources.length || advice.blocked || referenceState.reason || invalidQuota) return;
    // Land where the progress card is (P26).
    startGeneration({ act, notify, setGen, data, gen, course: generationCourse, sourceIds: validSelectedSources,
      then: (job) => (onStarted ? onStarted(job) : setPage("library")) });
  }
  // The case form opens with the materials ticked on this tab (its own selection when it comes from the reader): the learner already chose them, and the form says so.
  const carried = caseEvidence(data.sources, referenceSourceIds).filter((source) => validSelectedSources.includes(source.id)).map((source) => source.id);
  const caseStart = caseInitial?.sourceIds ? caseInitial : { ...(carried.length ? { sourceIds: carried, broughtOver: carried.length, ...(generationCourse ? { course: generationCourse } : {}) } : {}), ...caseInitial };

  const activeFocusCount = activeCourseRecord?.focusTopics?.length || 0;
  const openFocusDialog = () => (setModal || openModal)?.({ type: 'focusIntake', course: generationCourse || '' });
  const caseExam = courseHasCaseExam(activeCourseRecord);
  // What the chosen 覆盖强度 means for the chosen materials: the backend's plan, priced from the real prompts (lib/token-estimate.js), asked once the choice settles.
  const level = levelOf(gen.coverageLevel ?? DEFAULT_LEVEL), custom = customCountOf(gen);
  // 出题方式 (lib/contexts/generation/presets.js): the form's cell is its 覆盖强度 and its 出题深度 (the saved one until the learner picks; a pick is sent with this run only),
  // and the typed number of questions when there is one (then it is no preset: 自定义, said with that number).
  const depth = gen.depth ?? depthOf(data.settings?.generation), cell = { density: level, depth, count: custom };
  const applies = depthApplies({ kind: gen.kind, kinds: kindsOfForm(gen) });
  // The form's own request (a form without a depth of its own sends none, and the backend reads the saved one, as the run does).
  const estimateRequest = estimateRequestOf(gen, { course: generationCourse, sourceIds: validSelectedSources, reasoningEffort });
  // Whether the run will be written in one pass (the depth, and the kinds chosen here): the level's words say that strategy's density.
  const onePass = writesInOnePass({ ...estimateRequest, performance: performanceOfDepth(depth) });
  const planned = useUsageEstimate(call, estimateRequest, { enabled: validSelectedSources.length > 0 && !referenceState.reason && !pathMode });
  const plannedCoverage = planned.status === 'ready' ? planned.estimate?.coverage : null, plannedGoal = plannedCoverage?.goal ?? null;
  // A summary promises questions: not for a button that is off (the reason is said below), and for the steps it is their own total.
  const blocked = !pathMode && advice.blocked;
  const formBlocked = blocked || (!pathMode && invalidQuota) || Boolean(referenceState.reason);
  // The rough cost of each preset (and, with 更多选项 open, of every cell of the matrix), read from the estimate of each cell for these materials (ui/presets/cost.js).
  const priced = foldOpen ? MATRIX_CELLS : PRESET_CELLS;
  const pricing = pricesCells({ applies, sources: validSelectedSources.length, count: custom, held: pathMode || formBlocked });
  const cellEstimates = useCellEstimates(call, estimateRequest, priced, { enabled: pricing });
  const costs = pricing ? cellCosts(cellEstimates, priced) : null;
  const pickPreset = (id) => { const chosen = presetCell(id); if (chosen) setGen({ ...gen, coverageLevel: chosen.density, customCount: '', depth: chosen.depth }); };
  const summary = pathMode ? (referenceState.reason ? '' : pathSummary(path.included)) : formBlocked ? '' : summaryLine({ ...stats, count: plannedGoal, low: plannedCoverage?.goalLow ?? null, difficulty: gen.difficulty, language: gen.language, minutes: plannedGoal ? estimateMinutes(data.jobs, plannedGoal) : null }, { choices: false });
  // The plan is priced for these materials: the tokens in the bar, the rest of the plan under it.
  const estimating = !pathMode && !formBlocked && validSelectedSources.length > 0;
  const barRoom = useStickyRoom('--generate-bar-room');
  return (
    <section className="page generate-page">
      <PageHeader className="generate-header" title={ui("出一组新题")}
        description={ui("用你的资料让 AI 出题；已经有现成的题目，也可以直接导入。")}
        actions={pageAvailable(data, 'examcoach') ? <Button iconEnd="arrow-right" variant="quiet" className="sh-btn--flush-start sh-btn--flush-end" onClick={() => setPage?.('examcoach')}>{ui("去教练先校准考法")}</Button> : undefined} />
      {/* The ways in are the app's one segmented control (#1700), so the chosen one looks chosen. What the chosen way does describes the group; the row measures
          its own width (generate-home.css) and a narrow one says that line once under it (#575). */}
      <div className="source-mode-frame">
        <SegmentedControl className="source-mode" label={ui("创建方式")} wrap value={current} onChange={setGenSource} aria-describedby={wayNoteId}
          options={tabs.map((tab) => ({ value: tab.id, label: tab.label, attrs: tab.attrs }))} />
        <p className="source-mode-note" id={wayNoteId}>{tabs.find((tab) => tab.id === current)?.note}</p>
      </div>
      <div className="generate-panel">
      {current === "json" ? (
        <JsonImport data={data} openDraft={openDraft} />
      ) : current === "case" ? (
        <CaseCreate data={data} openImport={openImport} openReferenceImport={openReferenceImport} openSettings={openSettings} onCourseSettings={onCourseSettings}
          initial={caseStart} onStarted={() => (onStarted ? onStarted() : setPage("library"))} />
      ) : current === "chat" ? (
        <Ingest
          data={data}
          onOpenSettings={openSettings}
          start={(config) =>
            // Recording mode first (a write), then the hand-off says so and fills the chat's box (never sends).
            act("ingest.start", config, (mode) => send("ingest.start", { deckTitle: mode.deckTitle, folder: mode.folder, kind: mode.kind, mistakes: mode.mistakes }, { said: "已进入录题模式。" }))
          }
        />
      ) : !data.sources.length ? (
        <EmptyState icon="file" title={ui("还没有资料")}
          description={ui("导入讲义、笔记、PDF 或网页，它们会列在这里；AI 只根据你选中的资料出题，并标出每道题的出处。")}
          primary={addSourceAction(openImport)}
          secondary={{ label: ui("已有题目？导入 JSON 题组"), onClick: () => setGenSource("json") }} />
      ) : (
        <>
          <ModelSetupGate variant="banner" feature="generate" className="generate-gate" model={model} onOpenSettings={openSettings} />
          <form onSubmit={submit}>
            <fieldset data-tour="generate-sources">
              <legend>{ui("01 / 选择资料")}</legend>
              {/* Why these are ticked (only while the ticks are still the ones the page opened with). */}
              {openingStands(opening, validSelectedSources) && <p className="generate-opening muted" data-opening-reason>{openingLine(opening.reason)}</p>}
              {/* One row per document with its pages on demand; counts are in documents (WP3, P18). */}
              {/* 添加资料 under the list is the one way to add material from here (the shared import dialog, WP3); the index line shares its line. */}
              <SourcePicker sources={evidenceSources} selected={validSelectedSources} onChange={setSelectedSources} indexCoverage={indexCoverage} indexPending={indexStatus === 'loading'}
                courses={data.focus?.courses} scope={sourceScope} onScopeChange={setSourceScope}
                materialFolders={data.materialFolders ?? data.settings?.materialFolders} modelReady={model.ready}
                disabled={busy} onAdd={openImport}
                onIndex={(course) => openIndexBuilder(openLargeDocumentSettings, course)} />
              {/* A selection too big for one generation: ONE block with the ways on (steps / pages by topic), only the chosen one drawn; with no search tool the old card is a fold under it. */}
              {choice && <TooBigChoice advice={advice} stats={stats} modes={modes} mode={mode} onMode={setChosenMode} disabled={busy}
                card={advice.tooBig && !retrievalReady(retrieval) ? <LargeDocumentCard reason="selection" detail={{ chars: advice.chars }} retrieval={retrieval} onOpenSettings={openLargeDocumentSettings}
                  runnable courses={data.focus?.courses} defaultCourse={generationCourse} /> : null}>
                {pathMode && <GenerationPath path={path} disabled={busy || !model.ready || !!referenceState.reason} onSettings={openSettings} onUseStep={narrowToStep} />}
                {retrievalMode && <RetrievalPanel advice={advice} sourceIds={validSelectedSources} focus={gen.focus} course={generationCourse} onApply={setSelectedSources} disabled={busy} />}
              </TooBigChoice>}
            </fieldset>
            <fieldset className="generate-form" data-tour="generate-options">
              <legend>{ui("02 / 学习方式")}</legend>
              {/* The main path: what to make (题型), how completely (覆盖强度, with 自定义 as its fourth choice, #664) and which course the new deck goes into; everything else is behind 更多选项, in groups. */}
              <div className="generate-rows generate-rows--main">
                <FormRow label={ui("题型")} data-tour="generate-kinds">
                  <KindPicker className="generate-kind" value={kindsOfForm(gen)} onChange={(list) => setGen((prev) => {
                    const patch = kindsPatch(list, prev.kindCounts);
                    const next = { ...prev, kind: patch.kind, kinds: patch.kinds };
                    if (patch.kindCounts) next.kindCounts = patch.kindCounts;
                    else delete next.kindCounts;
                    return next;
                  })} />
                  <p className="generate-note">{kindNote(kindsOfForm(gen), undefined, gen.kindCounts)}</p>
                </FormRow>
                {/* 出题方式: three presets of 覆盖强度 × 出题深度 (lib/contexts/generation/presets.js); the two axes themselves are in 更多选项. */}
                {!pathMode && <FormRow label={ui("出题方式")} data-tour="generate-preset">
                  <PresetPicker cell={cell} applies={applies} costs={costs} disabled={busy} onPick={pickPreset} />
                </FormRow>}
                {/* One course field: 课程范围 above only filters the list of materials. Where the new deck goes follows it (and the ticked materials) and is one more row
                    here (#1702); 更改 opens the field for the rare other choice (#665). Its links are in ink: the accent is the one primary button's. */}
                <FormRow label={ui("新题组放进的课程")} data-tour="generate-course" data-generate-plan="">
                  <div className="generate-plan__line">
                    <span className="generate-plan__course">{generationCourse || ui("未分类")}</span>
                    <Button variant="link" size="sm" className="sh-btn--ink" aria-expanded={courseOpen} onClick={() => setCourseOpen(open => !open)}>{courseOpen ? ui("收起") : ui("更改")}</Button>
                    <Button iconEnd="arrow-right" variant="link" size="sm" className="sh-btn--ink" data-open-settings="settings-generation" onClick={openGenerationSettings}>{ui("前往设置")}</Button>
                  </div>
                  {courseOpen && <div className="generate-course"><CourseField courses={data.focus?.courses} label={ui("课程名称")} value={generationCourse} onChange={course => setGen({ ...gen, course })} /></div>}
                  {caseExam && <p className="generate-note generate-plan__hint">{ui("这门课考案例题，可以切到「案例分析题」出题。")}{" "}
                    <Button variant="link" size="sm" className="sh-btn--ink" onClick={() => setGenSource("case")}>{ui("切到案例分析题")}</Button></p>}
                </FormRow>
              </div>
              {/* Shut, its summary says the choices that are not the defaults, each whole (they wrap after a 「·」, ui/generate-form.css); open, its hint on one line,
                  as with none chosen, and the choices are not drawn: a choice picked inside the open fold moves nothing (round 7). */}
              <Disclosure className="generate-more" bodyClassName="generate-more__body" data-tour="generate-more" summary={ui("更多选项")} open={foldOpen} onToggle={setMoreOpen}
                meta={chosen.length ? <span className="generate-more__meta"><span className="generate-more__hint">{ui("题量、想练什么、难度、花费、额外要求")}</span><span className="generate-more__choices">{chosen.map((choice, at) => <React.Fragment key={at}>{at ? " " : ""}<span className="generate-more__choice">{at < chosen.length - 1 ? `${choice} ·` : choice}</span></React.Fragment>)}</span></span>
                  : ui("题量、想练什么、难度、花费、额外要求")}>
                {/* The matrix of 出题方式: the 覆盖强度 (with 自定义 and 自动补到完整), the depth, and the rough cost of every combination. */}
                {!pathMode && <FormGroup title={ui("出题方式与题量")}>
                  <FormRow label={ui("覆盖强度")} data-tour="generate-coverage">
                    <CoverageStrength compact part="choice" level={level} customCount={gen.customCount ?? ''} state={planned} stats={stats} enabled={validSelectedSources.length > 0 && !referenceState.reason} disabled={busy} onePass={onePass}
                      onChoice={(patch) => setGen({ ...gen, ...patch })} onCustom={(customCount) => setGen({ ...gen, customCount })}
                      auto={autoOf({ ...gen, coverageLevel: level })} onAuto={(autoComplete) => setGen({ ...gen, autoComplete })} />
                  </FormRow>
                  <FormRow label={ui("出题深度")} data-tour="generate-depth">
                    <PresetsFold depth={depth} depths={DEPTHS} applies={applies} offReason={depthOffReason()} disabled={busy} onDepth={(value) => setGen({ ...gen, depth: value })}
                      costs={foldOpen ? costs : null} cell={cell} columns={matrixColumns()} />
                  </FormRow>
                </FormGroup>}
                <FormGroup title={ui("想练什么")}>
                  <FormRow label={ui("这次想练什么？")} htmlFor="generate-focus" data-tour="generate-focus">
                    <textarea id="generate-focus" ref={focusBox} className="generate-focus generate-row__input" rows={2} value={gen.focus}
                      onChange={(e) => setGen({ ...gen, focus: e.target.value })}
                      placeholder={ui("例如：区分相似模式，重点练习工程场景中的取舍")} />
                    {(pathMode || retrievalMode) && <FocusHelp mode={mode} />}
                    <GenerateAssist ready={model.ready} phase={assist.phase} result={assist.result} applied={assist.applied} focus={gen.focus} disabled={busy}
                      estimate={<TokenEstimate pieces enabled={model.ready && selectedSources.length > 0}
                        request={{ feature: 'suggest', sourceIds: selectedSources, course: generationCourse, ...(goal ? { goal } : {}) }} />}
                      onAsk={askAssist} onSettings={openSettings}
                      onPick={(item) => setGen({ ...gen, focus: appendFocus(gen.focus, item) })}
                      onApply={() => { setGen(applySuggestion(gen, assist.result)); setAssist({ ...assist, applied: true }); }} />
                  </FormRow>
                  <div className="generate-focus-bar" data-generate-focus>
                    <p className="generate-focus-bar__text">
                      {activeFocusCount > 0
                        ? uiFormat("当前课程已设 {0} 个重点知识点：相关章节自动提高题量配额，重点题加深为应用 / 进阶难度。", [activeFocusCount])
                        : ui("手上有老师划的重点图或范围？先录入重点，出题会自动提高重点占比并加深难度。")}
                    </p>
                    <Button variant="link" size="sm" className="sh-btn--ink" lock={busy} onClick={openFocusDialog}>
                      {activeFocusCount > 0 ? ui("修改重点") : ui("录入重点…")}
                    </Button>
                  </div>
                  <ReferenceQuestions sources={data.sources} selected={referenceSourceIds} evidenceIds={selectedSources}
                    limits={gen.referenceLimits} onLimitsChange={referenceLimits => setGen({ ...gen, referenceLimits })}
                    format={gen.referenceFormat} onFormatChange={referenceFormat => setGen({ ...gen, referenceFormat })}
                    onChange={ids => setGen({ ...gen, referenceSourceIds: ids })} onImport={() => openReferenceImport()}
                    courses={data.focus?.courses} />
                </FormGroup>
                <FormGroup title={ui("难度与语言")}>
                  <FormRow label={ui("难度")} data-tour="generate-difficulty">
                    <SegmentedControl className="generate-seg" label={ui("难度")} value={gen.difficulty} options={DIFFICULTIES.map(({ value, label }) => ({ value, label }))}
                      onChange={(difficulty) => setGen({ ...gen, difficulty })} />
                    <p className="generate-note">{difficultyNote(gen.difficulty)}</p>
                  </FormRow>
                  <FormRow label={ui("学习者基础")} data-tour="generate-learner-level">
                    <Tooltip content={ui("可选：按当前基础调整出题重点；选择「零基础」时会在出题后额外扫描 1 次并补最多 6 张前置概念卡（计入用量估算）。")} placement="top-start">
                      <SegmentedControl className="generate-seg" label={ui("学习者基础")} value={gen.learnerLevel ?? ''} options={LEARNER_LEVELS.map(({ value, label }) => ({ value, label }))}
                        onChange={(learnerLevel) => setGen({ ...gen, learnerLevel })} />
                    </Tooltip>
                    <p className="generate-note">{learnerLevelNote(gen.learnerLevel ?? '')}</p>
                  </FormRow>
                  <FormRow label={ui("语言")} data-tour="generate-language">
                    <SegmentedControl className="generate-seg" label={ui("语言")} value={gen.language} options={LANGUAGES.map(({ value, label }) => ({ value, label }))}
                      onChange={(language) => setGen({ ...gen, language })} />
                  </FormRow>
                  <FormRow label={ui("公式写法")} data-tour="generate-notation">
                    <SegmentedControl className="generate-seg" label={ui("公式写法")} value={gen.notation ?? 'auto'} options={NOTATION_CHOICES.map(({ value, label }) => ({ value, label }))}
                      onChange={(notation) => setGen({ ...gen, notation })} />
                    <p className="generate-note">{notationNote()}</p>
                  </FormRow>
                </FormGroup>
                <FormGroup title={ui("题组信息")}>
                  <FormRow label={ui("题组名称（可选）")} htmlFor="generate-title">
                    <input id="generate-title" className="generate-row__input" value={gen.title || ""} onChange={(e) => setGen({ ...gen, title: e.target.value })} placeholder={ui("例如：数据库 · 索引与事务")} />
                  </FormRow>
                  {/* For interview preparation only: folded away unless the learner's goal is an interview or a role is already typed (#666). */}
                  <Disclosure className="generate-role" bodyClassName="generate-fold__body" summary={ui("面试方向（可选）")} meta={ui("目标岗位")} defaultOpen={roleOpenByDefault({ goal, focus: data.focus, course: activeCourseRecord, role: gen.role })}>
                    <FormRow label={ui("目标岗位 / 面试方向（可选）")} htmlFor="generate-role" data-tour="generate-role">
                      <input id="generate-role" className="generate-row__input" value={gen.role} onChange={(e) => setGen({ ...gen, role: e.target.value })} placeholder={ui("例如：后端工程师 · 系统设计")} />
                    </FormRow>
                  </Disclosure>
                </FormGroup>
                {!pathMode && <FormGroup title={ui("高级")}>
                  <CoverageStrength compact part="spend" level={level} customCount={gen.customCount ?? ''} state={planned} stats={stats} enabled={selectedSources.length > 0 && !referenceState.reason} disabled={busy}
                    budget={gen.tokenBudget ?? ''} onBudget={(tokenBudget) => setGen({ ...gen, tokenBudget })} />
                  {/* Quotas per question type and the learner's own wording for how to ask (lib/generation-modules.js): shut unless the form carries one. */}
                  <Disclosure className="generate-extra" bodyClassName="generate-fold__body" data-tour="generate-extra" summary={ui("额外要求（可选）")} meta={ui("各题型题数、补充要求")} open={extraOpen} onToggle={setExtraOpen}>
                    <GenerationTransparency gen={gen} setGen={setGen} sourceIds={selectedSources} sources={data.sources} plannedGoal={plannedGoal}
                      focusCount={activeFocusCount} rules={generationRulesOf(data, generationCourse)} />
                  </Disclosure>
                </FormGroup>}
              </Disclosure>
              {!pathMode && custom && selectedPdfPages > custom && <InlineMessage tone="warning">{uiFormat("已选 {0} 页 PDF，计划生成 {1} 题。题数少于页数，不能保证逐页考察；可缩小页码范围、取消自定义题数，或按覆盖强度出题。", [selectedPdfPages, custom])}</InlineMessage>}
            </fieldset>
            {/* The DOM is the order it is seen (#1082): the count and what it costs, the one button and why it is off; then what the run asks for and how it goes on;
                then the note about the checks. The bar is a child of the form, so it can stay at the bottom of the view while its place is further down
                (ui/generate-home.css). Its two lines are there whatever is ticked (with nothing ticked the first says what to do), so the bar keeps one height and the
                button one place; the tokens are in it, where the tour's step about the cost lights them. */}
            <div className="generate-submit" data-generate-bar data-tour="generate-summary" ref={barRoom}>
              <div className="generate-submit__lines">
                {/* Whole pieces (「·」 between them): a line too narrow for all of them leaves the last ones out, never half a word (#1082). */}
                {summary ? <p className="generate-summary" role="status">{summary.split(' · ').map((piece, at) => <React.Fragment key={at}>{at ? ' ' : ''}<span className="generate-summary__piece">{at ? `· ${piece}` : piece}</span></React.Fragment>)}</p>
                  : <p className="muted generate-submit__note" role="status">{model.ready && !validSelectedSources.length ? ui("先在「01 / 选择资料」勾选资料。") : ""}</p>}
                {!pathMode && <div className="generate-submit__cost" data-generate-estimate>
                  {estimating && <TokenEstimateView state={planned} totalOnly pieces />}
                </div>}
              </div>
              {!model.ready ? (
                /* P14: no usable model, so there is nothing to click into a 20-second failure; the banner on top says why. */
                <Button variant="primary" type="submit" icon="sparkle" className="generate-submit__btn" disabled data-tour="generate-submit">{ui("生成并检查题组")}</Button>
              ) : pathMode ? (
                <Tooltip layer placement="top-start" anchorClassName="generate-submit__btn" content={ui("每一步是一个独立的出题任务，按顺序排队；先做完的一步就可以先练。")}>
                  <Button variant="primary" type="submit" icon="sparkle" busy={path.queueing} disabled={busy || !path.included.length || !!referenceState.reason}
                    data-tour="generate-submit" data-usage="generate.path-queue">
                    {uiFormat("按路径逐步出题 · {0} 步依次排队", [path.included.length])}
                  </Button>
                </Tooltip>
              ) : (
                <Button variant="primary" type="submit" icon="sparkle" className="generate-submit__btn" busy={busy} disabled={!validSelectedSources.length || advice.blocked || !!referenceState.reason || invalidQuota}
                  data-tour="generate-submit" data-usage="generate.submit">
                  {running ? ui("加入生成队列") : ui("生成并检查题组")}
                </Button>
              )}
              {/* Why the button is off, once: with pages picked by topic the panel above already says the topic is missing, so here it is only what to do. */}
              {model.ready && blocked && (retrievalMode ? <Hint>{ui("写下主题后才能生成。")}</Hint>
                : <InlineMessage tone="warning">{ui("所选资料超过一次生成的上限。请按章节缩小选择，或按上面的建议用检索工具。")}</InlineMessage>)}
              {model.ready && !blocked && !pathMode && invalidQuota && (
                <InlineMessage tone="warning">{ui("请到「更多选项 › 额外要求」为至少一种题型分配 1 道题。")}</InlineMessage>
              )}
              {model.ready && !blocked && referenceState.reason && (
                <InlineMessage tone="warning">{referenceState.reason}</InlineMessage>
              )}
              {model.ready && running && <p className="muted generate-submit__note">{ui("已有出题任务在进行，新的会排在它后面。")}</p>}
            </div>
            <div className="generate-run" data-generate-run>
              {model.ready && pathMode && path.groups.length > 0 && <InlineMessage tone="warning" boxed title={uiFormat("有 {0} 步没能开始", [path.report.failed.length])}>
                {path.groups.map(group => <p key={group.message} className="gen-path__failure">{group.message}{" "}<small>{group.steps.length > 3
                  ? uiFormat("（{0} 等 {1} 步）", [group.steps.slice(0, 3).join("、"), group.steps.length]) : uiFormat("（{0}）", [group.steps.join("、")])}</small></p>)}
              </InlineMessage>}
              {!pathMode && validSelectedSources.length > 0 && <EffectiveRequirementsStrip gen={gen} focusCount={activeFocusCount} referenceCount={referenceSourceIds.length} ruleCount={generationRulesOf(data, generationCourse).length} />}
              {/* The rest of the plan, said once: how much it covers, in how many rounds and model calls (the ⓘ has the stages), and whether the rest goes on by
                  itself (the count and the tokens are the bar's). */}
              {estimating && <div className="generate-estimate" data-generate-coverage>
                <TokenEstimateView state={planned} lead={coverageStructure(plannedCoverage)} summary={estimate => callsText(estimate.calls)} warn={false} tight />
                <MaterialsForecast coverage={plannedCoverage} />
                <PlanCaps coverage={plannedCoverage} />
                {plannedCoverage?.rounds > 1 && <p className="generate-note" data-coverage-auto-note>{autoLine(autoOf({ ...gen, coverageLevel: level }), plannedCoverage.rounds,
                  plannedCoverage.leaves > 0 && Number.isFinite(plannedCoverage.firstRoundSections) ? { level: plannedCoverage.level, percent: Math.round(plannedCoverage.firstRoundSections / plannedCoverage.leaves * 100) } : undefined)}</p>}
              </div>}
              <div className="quality-note generate-quality">
                <Icon name="sparkle" />
                <p><span className="generate-quality__lead">{ui("原文引用核验 · 独立质量审阅 · 干扰项逐项解释")}</span>{" "}
                  <small>{ui("出题时已逐题核验并审阅；生成结果先进入草稿，你看过再发布；想再检查一遍，在草稿页点「保存并校验」。")}</small>
                </p>
              </div>
            </div>
          </form>
        </>
      )}
      </div>
    </section>
  );
}
