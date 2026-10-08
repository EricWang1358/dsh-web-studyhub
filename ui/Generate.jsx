import { ui, uiFormat } from "./i18n.js";
import { ingestPrompt } from "./agent-prompts/ingest.js";
import { useStudy } from "./study-context.jsx";
import React from "react";
import Ingest from "./Ingest.jsx";
import JsonImport from "./JsonImport.jsx";
import { useInjectCss } from "./shared.js";
import KindPicker from "./KindPicker.jsx";
import CourseField from './CourseField.jsx';
import { courseNamesOf, usePageScope } from './PageScope.jsx';
import SourcePicker from './SourcePicker.jsx';
import useIndexCoverage from './use-index-coverage.js';
import GenerationPath from './GenerationPath.jsx';
import TooBigChoice, { FocusHelp } from './TooBigChoice.jsx';
import { useGenerationPath } from './use-generation-path.js';
import { MODES, availableModes, effectiveMode, pathSummary, showsChoice } from './too-big-choice.js';
import { courseForSources } from '../lib/source-courses.js';
import { Button, Disclosure, EmptyState, Hint, Icon, InlineMessage, PageHeader, SegmentedControl, TabPanel, Tabs, Tooltip } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { documentCount, freshGeneration, generationFormDefaults, generationStartedNotice, modelReadiness } from './generation-status.js';
import GenerateAssist from './GenerateAssist.jsx';
import { TokenEstimate, TokenEstimateView, useUsageEstimate } from './TokenUsage.jsx';
import CoverageStrength from './coverage/CoverageStrength.jsx';
import { autoLine } from './coverage/copy.js';
import { openingLine, openingSelection, openingStands } from './generate-opening.js';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import RetrievalPanel from './RetrievalPanel.jsx';
import { generateAdvice, retrievalReady } from './large-document-advice.js';
import { useRetrievalStatus } from './retrieval-status.js';
import {
  DIFFICULTIES, LANGUAGES, appendFocus, applySuggestion, autoOf, customCountOf, courseHasCaseExam, coverageStructure,
  NOTATION_CHOICES, caseEvidence, difficultyNote, estimateMinutes, generationRequest, importDialog, kindNote, kindsOfForm, kindsPatch, moreValuesOf, notationNote, planLine, roleOpenByDefault, selectionStats, summaryLine,
} from './generate-form.js';
import { DEFAULT_LEVEL, levelOf } from '../lib/coverage-strength.js';
import homeCss from './generate-home.css';
import formCss from './generate-form.css';
import CaseCreate from './CaseCreate.jsx';
import ReferenceQuestions from './ReferenceQuestions.jsx';
import { referenceSelection } from './reference-questions.js';
import { useLiveEffect } from './use-async.js';
import { settingsSectionOr } from './settings-groups.js';

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
  const { notify, call, busy, act, askInChat, openSettings: openSettingsSection } = useStudy();
  useInjectCss(formCss, "study-generate-form");
  const [sourceScope, setSourceScope] = usePageScope(data.root, 'generate-sources', data.focus?.course ?? '*');
  // Whether each material's search index is built: the picker rows say so (and follow a running build).
  const [indexCoverage, , indexStatus] = useIndexCoverage(call);
  const known = courseNamesOf(data);
  const referenceSourceIds = gen.referenceSourceIds || [];
  const referenceState = referenceSelection(data.sources, referenceSourceIds, selectedSources, gen.referenceLimits, gen.referenceFormat);
  const evidenceSources = data.sources.filter(source => !referenceSourceIds.includes(source.id));
  const generationCourse = gen.course ?? courseForSources({ sources: data.sources }, selectedSources, sourceScope === '*' ? '' : sourceScope, known);
  const stats = React.useMemo(() => selectionStats(data.sources, selectedSources), [data.sources, selectedSources]);
  const selectedPdfPages = stats.pages;
  const model = modelReadiness(data);
  // 大教材 (WP28): what DSH can search with, read once, and what this page does with a selection of this size.
  const { data: retrieval } = useRetrievalStatus({ initialData: initialRetrieval ?? undefined, enabled: !initialRetrieval });
  const advice = generateAdvice({ sources: data.sources, selectedIds: selectedSources, focus: gen.focus, retrieval });
  // The learner's goal tells whether the target role belongs on the form; read once, quietly.
  const [goal, setGoal] = React.useState('');
  useLiveEffect((live) => {
    Promise.resolve(call?.('coach.profile', {})).then((profile) => { if (live() && typeof profile?.goal === 'string') setGoal(profile.goal); }, () => {});
  }, []);
  // 帮我想想: asked on click only; a result belongs to the sources and course it was asked for.
  const [assist, setAssist] = React.useState({ phase: 'idle', result: null, applied: false });
  const assistToken = React.useRef(0);
  const selectionKey = `${generationCourse}|${selectedSources.join(',')}`;
  React.useEffect(() => { assistToken.current += 1; setAssist({ phase: 'idle', result: null, applied: false }); }, [selectionKey]);
  // 分步出题: the plan of steps and what it does live in one hook so the form's own button can queue it; the choice of how to go on is this page's (TooBigChoice).
  const path = useGenerationPath({ sources: data.sources, selectedIds: selectedSources, gen, course: generationCourse, goal, indexCoverage,
    onQueued: () => { setGen(current => freshGeneration(current, data.settings?.generation)); setPage("library"); } });
  const [chosenMode, setChosenMode] = React.useState(initialGenerationMode);
  const modes = availableModes({ advice, pathReady: path.available, retrieval });
  const mode = effectiveMode(chosenMode, modes, advice);
  const choice = showsChoice(modes, advice);
  const pathMode = choice && mode === MODES.path, retrievalMode = choice && mode === MODES.retrieval;
  // 更多选项 holds every optional choice; it stays shut unless the form carries one (something typed, a choice that is not the saved default) or the way on needs a topic, so nothing set is hidden.
  const saved = React.useMemo(() => generationFormDefaults(data.settings?.generation), [data.settings?.generation]);
  const [moreChoice, setMoreChoice] = React.useState(null);
  const foldOpen = moreChoice ?? (moreValuesOf(gen, saved) || roleOpenByDefault({ goal, focus: data.focus, role: gen.role }) || retrievalMode);
  const setMoreOpen = (open) => setMoreChoice(open);
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
    try { result = await call('generate.suggest', { sourceIds: selectedSources, course: generationCourse, ...(goal ? { goal } : {}) }); }
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
  const [opening, setOpening] = React.useState(null);
  React.useEffect(() => {
    if (selectedSources.length) return;
    const found = openingSelection(data, { scope: sourceScope, known, exclude: referenceSourceIds });
    if (!found.sourceIds.length) return;
    setSelectedSources(found.sourceIds);
    setOpening(found);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = [
    { id: "files", label: ui("用资料出题"), note: ui("AI 按你的资料出题，并逐题检查"), icon: "sparkle", attrs: { "data-tour": "generate-from-sources" } },
    { id: "json", label: ui("导入 JSON 题组"), note: ui("已有题目，或外部 AI 生成的题"), icon: "file" },
    // Case-study papers (WP12): a long case with open questions, graded criterion by criterion.
    { id: "case", label: ui("案例分析题"), note: ui("长案例 + 开放题，按评分标准逐项批改"), icon: "file", attrs: { "data-tour": "generate-case" } },
    // Recording into the conversation needs a chat that can take it (plan C3).
    ...(canChat ? [{ id: "chat", label: ui("在对话里录题"), note: ui("刷题软件、错题或截图") }] : []),
  ];
  const current = tabs.some((tab) => tab.id === genSource) ? genSource : "files";
  function submit(event) {
    event.preventDefault();
    if (pathMode) { if (model.ready && !busy && !path.queueing && path.included.length && !referenceState.reason) path.queue(); return; }
    if (!model.ready || busy || !selectedSources.length || advice.blocked || referenceState.reason) return;
    const materials = documentCount(data.sources.filter((source) => selectedSources.includes(source.id)));
    act("generate", generationRequest(gen, { course: generationCourse, sourceIds: selectedSources }), (job) => {
      // Confirm with the deck's name, start the next deck from a clean form (P27),
      // and land where the progress card is (P26).
      notify(generationStartedNotice(job, gen, materials));
      setGen(current => freshGeneration(current, data.settings?.generation));
      if (onStarted) onStarted(job);
      else setPage("library");
    });
  }
  // The case form opens with the materials ticked on this tab (its own selection when it comes from the reader): the learner already chose them, and the form says so.
  const carried = caseEvidence(data.sources, referenceSourceIds).filter((source) => selectedSources.includes(source.id)).map((source) => source.id);
  const caseStart = caseInitial?.sourceIds ? caseInitial : { ...(carried.length ? { sourceIds: carried, broughtOver: carried.length, ...(generationCourse ? { course: generationCourse } : {}) } : {}), ...caseInitial };
  const caseExam = courseHasCaseExam((data.courses || []).find((course) => course?.name === generationCourse));
  // What the chosen 覆盖强度 means for the chosen materials: the backend's plan, priced from the real prompts (lib/token-estimate.js), asked once the choice settles.
  const level = levelOf(gen.coverageLevel ?? DEFAULT_LEVEL), custom = customCountOf(gen);
  const estimateRequest = { feature: 'generate', sourceIds: selectedSources, referenceSourceIds, referenceLimits: gen.referenceLimits, referenceFormat: gen.referenceFormat, coverageLevel: level,
    ...(custom ? { count: custom } : {}), kind: gen.kind, kinds: kindsOfForm(gen), difficulty: gen.difficulty, language: gen.language, course: generationCourse, ...(reasoningEffort ? { reasoningEffort } : {}) };
  const planned = useUsageEstimate(call, estimateRequest, { enabled: selectedSources.length > 0 && !referenceState.reason && !pathMode });
  const plannedCoverage = planned.status === 'ready' ? planned.estimate?.coverage : null, plannedGoal = plannedCoverage?.goal ?? null;
  // A summary promises questions: not for a button that is off (the reason is said below), and for the steps it is their own total.
  const blocked = !pathMode && advice.blocked;
  const summary = pathMode ? pathSummary(path.included) : blocked ? '' : summaryLine({ ...stats, count: plannedGoal, difficulty: gen.difficulty, language: gen.language, minutes: plannedGoal ? estimateMinutes(data.jobs, plannedGoal) : null });
  return (
    <section className="page generate-page">
      <PageHeader eyebrow={ui("创建题组")} title={ui("出一组新题")}
        description={ui("用你的资料让 AI 出题；已经有现成的题目，也可以直接导入。")} />
      <Tabs id="generate" className="source-mode" itemClassName="source-tab" label={ui("创建方式")} value={current} onChange={setGenSource}
        items={tabs.map((tab) => ({ value: tab.id, label: tab.label, note: tab.note, attrs: tab.attrs }))} />
      <TabPanel id="generate" value={current} selected={current} className="generate-panel" tabIndex={undefined}>
      {current === "json" ? (
        <JsonImport data={data} openDraft={openDraft} />
      ) : current === "case" ? (
        <CaseCreate data={data} openImport={openImport} openReferenceImport={openReferenceImport} openSettings={openSettings} onCourseSettings={onCourseSettings}
          initial={caseStart} onStarted={() => (onStarted ? onStarted() : setPage("library"))} />
      ) : current === "chat" ? (
        <Ingest
          data={data}
          busy={busy}
          onOpenSettings={openSettings}
          start={(config) =>
            act("ingest.start", config, (mode) => {
              askInChat(ingestPrompt({ deckTitle: mode.deckTitle, folder: mode.folder, kind: mode.kind, mistakes: mode.mistakes }));
            })
          }
        />
      ) : !data.sources.length ? (
        <EmptyState icon="file" title={ui("先添加一份资料")}
          description={ui("讲义、笔记、PDF 或网页都可以。AI 只根据你添加的资料出题，并标出每道题的出处。")}
          primary={{ label: ui("添加资料"), icon: "upload", onClick: openImport }}
          secondary={{ label: ui("已有题目？导入 JSON 题组"), onClick: () => setGenSource("json") }} />
      ) : (
        <>
          <ModelSetupGate variant="banner" feature="generate" model={model} onOpenSettings={openSettings} />
          <p className="muted">{ui("选好资料就能生成。生成结果先进入草稿，你看过再发布。")}</p>
          <form onSubmit={submit}>
            <fieldset data-tour="generate-sources">
              <legend>{ui("01 / 选择资料")}</legend>
              {/* Why these are ticked (only while the ticks are still the ones the page opened with). */}
              {openingStands(opening, selectedSources) && <p className="generate-opening muted" data-opening-reason>{openingLine(opening.reason)}</p>}
              {/* One row per document with its pages on demand; counts are in documents (WP3, P18). */}
              <SourcePicker sources={evidenceSources} selected={selectedSources} onChange={setSelectedSources} indexCoverage={indexCoverage} indexSlot={indexStatus !== "unavailable"}
                courses={data.focus?.courses} scope={sourceScope} onScopeChange={setSourceScope} disabled={busy} />
              <div className="generate-sources-actions">
                {/* The one way to add material from here: the shared import dialog (WP3). */}
                <Button variant="link" icon="upload" onClick={openImport}>{ui("导入资料")}</Button>
              </div>
              {/* A selection too big for one generation: ONE block with the ways on (steps / pages by topic), only the chosen one drawn; with no search tool the old card is a fold under it. */}
              {choice && <TooBigChoice advice={advice} stats={stats} modes={modes} mode={mode} onMode={setChosenMode} disabled={busy}
                card={advice.tooBig && !retrievalReady(retrieval) ? <LargeDocumentCard reason="selection" detail={{ chars: advice.chars }} retrieval={retrieval} onOpenSettings={openLargeDocumentSettings}
                  call={call} courses={data.focus?.courses} defaultCourse={generationCourse} /> : null}>
                {pathMode && <GenerationPath path={path} disabled={busy || !model.ready || !!referenceState.reason} onSettings={openSettings} onUseStep={narrowToStep} />}
                {retrievalMode && <RetrievalPanel advice={advice} sourceIds={selectedSources} focus={gen.focus} course={generationCourse} onApply={setSelectedSources} disabled={busy} />}
              </TooBigChoice>}
            </fieldset>
            <fieldset className="generate-form" data-tour="generate-options">
              <legend>{ui("02 / 学习方式")}</legend>
              {/* The main path says what will be made in one line; every choice behind it is in 更多选项, and the defaults of the ones that have one are in the settings. */}
              <div className="generate-plan" data-generate-plan>
                <p className="generate-plan__line">{planLine({ kinds: kindsOfForm(gen), level, custom: !!custom, course: generationCourse })}</p>
                <Button variant="link" size="sm" data-open-settings="settings-generation" onClick={openGenerationSettings}>{ui("前往设置")}</Button>
              </div>
              {caseExam && <p className="generate-case-hint">{ui("这门课考案例题，可以切到「案例分析题」出题。")}{" "}
                <Button variant="link" onClick={() => setGenSource("case")}>{ui("切到案例分析题")}</Button></p>}
              <Disclosure className="generate-more" summary={ui("更多选项")} meta={ui("题型、覆盖强度、难度、语言、课程、想练什么")} open={foldOpen} onToggle={setMoreOpen}>
                <CourseField courses={data.focus?.courses} value={generationCourse} onChange={course => setGen({ ...gen, course })} />
                <div className="generate-rows">
                  <FormRow label={ui("题型")}>
                    <KindPicker className="generate-kind" value={kindsOfForm(gen)} onChange={(list) => setGen({ ...gen, ...kindsPatch(list) })} />
                    <p className="generate-note">{kindNote(kindsOfForm(gen))}</p>
                  </FormRow>
                  {!pathMode && <FormRow label={ui("覆盖强度")}>
                    <CoverageStrength compact level={level} customCount={gen.customCount ?? ''} state={planned} stats={stats} enabled={selectedSources.length > 0 && !referenceState.reason} disabled={busy}
                      onLevel={(coverageLevel) => setGen({ ...gen, coverageLevel })} onCustom={(customCount) => setGen({ ...gen, customCount })}
                      auto={autoOf({ ...gen, coverageLevel: level })} onAuto={(autoComplete) => setGen({ ...gen, autoComplete })}
                      budget={gen.tokenBudget ?? ''} onBudget={(tokenBudget) => setGen({ ...gen, tokenBudget })} />
                  </FormRow>}
                  <FormRow label={ui("难度")}>
                    <SegmentedControl label={ui("难度")} value={gen.difficulty} options={DIFFICULTIES.map(({ value, label }) => ({ value, label }))}
                      onChange={(difficulty) => setGen({ ...gen, difficulty })} />
                    <p className="generate-note">{difficultyNote(gen.difficulty)}</p>
                  </FormRow>
                  <FormRow label={ui("语言")}>
                    <SegmentedControl label={ui("语言")} size="sm" value={gen.language} options={LANGUAGES.map(({ value, label }) => ({ value, label }))}
                      onChange={(language) => setGen({ ...gen, language })} />
                  </FormRow>
                  <FormRow label={ui("公式写法")}>
                    <SegmentedControl label={ui("公式写法")} size="sm" value={gen.notation ?? 'auto'} options={NOTATION_CHOICES.map(({ value, label }) => ({ value, label }))}
                      onChange={(notation) => setGen({ ...gen, notation })} />
                    <p className="generate-note">{notationNote()}</p>
                  </FormRow>
                  <FormRow label={ui("这次想练什么？")} htmlFor="generate-focus">
                    <textarea id="generate-focus" ref={focusBox} className="generate-focus" rows={2} value={gen.focus}
                      onChange={(e) => setGen({ ...gen, focus: e.target.value })}
                      placeholder={ui("例如：区分相似模式，重点练习工程场景中的取舍")} />
                    {(pathMode || retrievalMode) && <FocusHelp mode={mode} />}
                    <GenerateAssist ready={model.ready} phase={assist.phase} result={assist.result} applied={assist.applied} focus={gen.focus} disabled={busy}
                      estimate={<TokenEstimate enabled={model.ready && selectedSources.length > 0}
                        request={{ feature: 'suggest', sourceIds: selectedSources, course: generationCourse, ...(goal ? { goal } : {}) }} />}
                      onAsk={askAssist} onSettings={openSettings}
                      onPick={(item) => setGen({ ...gen, focus: appendFocus(gen.focus, item) })}
                      onApply={() => { setGen(applySuggestion(gen, assist.result)); setAssist({ ...assist, applied: true }); }} />
                  </FormRow>
                  <FormRow label={ui("题组名称（可选）")} htmlFor="generate-title">
                    <input id="generate-title" value={gen.title || ""} onChange={(e) => setGen({ ...gen, title: e.target.value })} placeholder={ui("例如 SWE5001 · Solution Architecture")} />
                  </FormRow>
                  <FormRow label={ui("目标岗位 / 面试方向（可选）")} htmlFor="generate-role">
                    <input id="generate-role" value={gen.role} onChange={(e) => setGen({ ...gen, role: e.target.value })} placeholder={ui("例如：后端工程师 · 系统设计")} />
                  </FormRow>
                </div>
                <ReferenceQuestions sources={data.sources} selected={referenceSourceIds} evidenceIds={selectedSources}
                  limits={gen.referenceLimits} onLimitsChange={referenceLimits => setGen({ ...gen, referenceLimits })}
                  format={gen.referenceFormat} onFormatChange={referenceFormat => setGen({ ...gen, referenceFormat })}
                  onChange={ids => setGen({ ...gen, referenceSourceIds: ids })} onImport={() => openReferenceImport()}
                  courses={data.focus?.courses} busy={busy} />
              </Disclosure>
              {!pathMode && custom && selectedPdfPages > custom && <InlineMessage tone="warning">{uiFormat("已选 {0} 页 PDF，计划生成 {1} 题。题数少于页数，不能保证逐页考察；可缩小页码范围、取消自定义题数，或按覆盖强度出题。", [selectedPdfPages, custom])}</InlineMessage>}
            </fieldset>
            <div className="generate-submit" data-tour="generate-summary">
              <div className="quality-note">
                <Icon name="sparkle" />
                <p>{ui("原文引用核验 · 独立质量审阅 · 干扰项逐项解释")}<br />
                  <small>{ui("出题时已逐题核验并审阅；发布前想再检查一遍，在草稿页点「保存并校验」。")}</small>
                </p>
              </div>
              {summary && <p className="generate-summary" role="status">{summary}</p>}
              {/* The plan, said once: the tokens and calls it costs, how many rounds, and whether the rest goes on by itself (the count is the line above's). */}
              {!pathMode && !blocked && selectedSources.length > 0 && !referenceState.reason && <div className="generate-estimate" data-generate-estimate>
                <TokenEstimateView state={planned} lead={coverageStructure(plannedCoverage)} tight />
                {plannedCoverage?.rounds > 1 && <p className="generate-note" data-coverage-auto-note>{autoLine(autoOf({ ...gen, coverageLevel: level }), plannedCoverage.rounds,
                  plannedCoverage.leaves > 0 && Number.isFinite(plannedCoverage.firstRoundSections) ? { level: plannedCoverage.level, percent: Math.round(plannedCoverage.firstRoundSections / plannedCoverage.leaves * 100) } : undefined)}</p>}
              </div>}
              {model.ready ? <>
                {!selectedSources.length && <p className="muted">{ui("在「01 / 选择资料」勾选至少一份资料后即可生成。")}</p>}
                {/* Why the button is off, once: with pages picked by topic the panel above already says the topic is missing, so here it is only what to do. */}
                {blocked && (retrievalMode ? <Hint>{ui("写下主题后才能生成。")}</Hint>
                  : <InlineMessage tone="warning">{ui("所选资料超过一次生成的上限。请按章节缩小选择，或按上面的建议用检索工具。")}</InlineMessage>)}
                {running && <p className="muted">{ui("已有出题任务在进行，新的会排在它后面。")}</p>}
                {pathMode ? <>
                  <Tooltip layer placement="top-start" content={ui("每一步是一个独立的出题任务，按顺序排队；先做完的一步就可以先练。")}>
                    <Button variant="primary" type="submit" icon="sparkle" busy={path.queueing} disabled={busy || !path.included.length || !!referenceState.reason}
                      data-tour="generate-submit" data-usage="generate.path-queue">
                      {uiFormat("按路径逐步出题 · {0} 步依次排队", [path.included.length])}
                    </Button>
                  </Tooltip>
                  {path.groups.length > 0 && <InlineMessage tone="warning" boxed title={uiFormat("有 {0} 步没能开始", [path.report.failed.length])}>
                    {path.groups.map(group => <p key={group.message} className="gen-path__failure">{group.message}{" "}<small>{group.steps.length > 3
                      ? uiFormat("（{0} 等 {1} 步）", [group.steps.slice(0, 3).join("、"), group.steps.length]) : uiFormat("（{0}）", [group.steps.join("、")])}</small></p>)}
                  </InlineMessage>}
                </> : (
                  <Button variant="primary" type="submit" icon="sparkle" busy={busy} disabled={!selectedSources.length || advice.blocked || !!referenceState.reason}
                    data-tour="generate-submit" data-usage="generate.submit">
                    {running ? ui("加入生成队列 →") : ui("生成并检查题组 →")}
                  </Button>
                )}
              </> : (
                /* P14: no usable model, so there is nothing to click into a 20-second failure; the banner on top says why. */
                <Button variant="primary" type="submit" icon="sparkle" disabled data-tour="generate-submit">{ui("生成并检查题组 →")}</Button>
              )}
            </div>
          </form>
        </>
      )}
      </TabPanel>
    </section>
  );
}

/* One label-left row of the form: the label column on wide panes, stacked on narrow ones. */
function FormRow({ label, htmlFor, children }) {
  return (
    <div className="generate-row">
      {htmlFor ? <label className="generate-row__label" htmlFor={htmlFor}>{label}</label> : <div className="generate-row__label">{label}</div>}
      <div className="generate-row__control">{children}</div>
    </div>
  );
}
