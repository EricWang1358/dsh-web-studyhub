import { ui, uiFormat } from "./i18n.js";
import { ingestPrompt } from "./agent-prompts/ingest.js";
import { useStudy } from "./study-context.jsx";
import React from "react";
import Ingest from "./Ingest.jsx";
import JsonImport from "./JsonImport.jsx";
import { kinds, useInjectCss } from "./shared.js";
import CourseField from './CourseField.jsx';
import { courseNamesOf, usePageScope } from './PageScope.jsx';
import SourcePicker from './SourcePicker.jsx';
import useIndexCoverage from './use-index-coverage.js';
import GenerationPath from './GenerationPath.jsx';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { courseForSources, sourceMatchesCourse } from '../lib/source-courses.js';
import { Button, Chip, Disclosure, EmptyState, Icon, IconButton, InlineMessage, PageHeader, SegmentedControl, TabPanel, Tabs } from './components/index.js';
import ModelSetupGate from './ModelSetupGate.jsx';
import { documentCount, freshGeneration, generationStartedNotice, modelReadiness } from './generation-status.js';
import GenerateAssist from './GenerateAssist.jsx';
import { TokenEstimate } from './TokenUsage.jsx';
import LargeDocumentCard from './LargeDocumentCard.jsx';
import RetrievalPanel from './RetrievalPanel.jsx';
import { generateAdvice, retrievalReady } from './large-document-advice.js';
import { useRetrievalStatus } from './retrieval-status.js';
import {
  COUNT_MAX, COUNT_MIN, COUNT_PRESETS, DIFFICULTIES, KINDS, LANGUAGES, appendFocus, applySuggestion, clampCount, courseHasCaseExam,
  NOTATION_CHOICES, difficultyNote, estimateMinutes, generationRequest, kindNote, notationNote, roleOpenByDefault, selectionStats, stepCount, suggestCount, summaryLine,
} from './generate-form.js';
import homeCss from './generate-home.css';
import formCss from './generate-form.css';
import CaseCreate from './CaseCreate.jsx';
import ReferenceQuestions from './ReferenceQuestions.jsx';
import { referenceSelection } from './reference-questions.js';
import { useLiveEffect } from './use-async.js';

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
}) {
  useInjectCss(homeCss, "study-generate-home");
  const { notify, call, busy, act, askInChat } = useStudy();
  useInjectCss(formCss, "study-generate-form");
  const [sourceScope, setSourceScope] = usePageScope(data.root, 'generate-sources', data.focus?.course ?? '*');
  // Whether each material's search index is built: the picker rows say so (and follow a running build).
  const [indexCoverage] = useIndexCoverage(call);
  const known = courseNamesOf(data);
  const visibleSources = data.sources.filter(source => sourceMatchesCourse(source, sourceScope, known));
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
  const openImport = () => setModal({ type: "add", course: sourceScope === '*' ? '' : sourceScope });
  const openReferenceImport = onReferenceImported => setModal({ type: 'add', course: generationCourse,
    referenceQuestions: true, ...(onReferenceImported ? { onReferenceImported } : {}) });
  const openSettings = () => (openModelSettings ? openModelSettings() : setPage?.("settings"));
  // With a single document (one PDF is several page sources) there is nothing to choose; don't make the learner tick it.
  React.useEffect(() => {
    const documents = groupSourcesByDocument(visibleSources.filter(source => !referenceSourceIds.includes(source.id)));
    if (documents.length === 1 && !selectedSources.length)
      setSelectedSources(documents[0].sourceIds);
    // Only on entering the page, so 清空选择 still sticks.
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
  const suggestedCount = suggestCount(stats);
  const caseExam = courseHasCaseExam((data.courses || []).find((course) => course?.name === generationCourse));
  const summary = summaryLine({ ...stats, count: gen.count, difficulty: gen.difficulty, language: gen.language, minutes: estimateMinutes(data.jobs, gen.count) });
  return (
    <section className="page generate-page">
      <PageHeader eyebrow={ui("创建题组")} title={ui("出一组新题")}
        description={ui("用你的资料让 AI 出题，逐题检查后再发布；已经有现成的题目，也可以直接导入。")} />
      <Tabs id="generate" className="source-mode" itemClassName="source-tab" label={ui("创建方式")} value={current} onChange={setGenSource}
        items={tabs.map((tab) => ({ value: tab.id, label: tab.label, note: tab.note, attrs: tab.attrs }))} />
      <TabPanel id="generate" value={current} selected={current} className="generate-panel" tabIndex={undefined}>
      {current === "json" ? (
        <JsonImport data={data} openDraft={openDraft} />
      ) : current === "case" ? (
        <CaseCreate data={data} openImport={openImport} openReferenceImport={openReferenceImport} openSettings={openSettings} onCourseSettings={onCourseSettings}
          initial={caseInitial} onStarted={() => (onStarted ? onStarted() : setPage("library"))} />
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
          <p className="muted">{ui("先选资料，再设定学习目标。生成结果会先进入草稿；发布时逐题检查，通过的题先进入学习库。")}</p>
          <form onSubmit={submit}>
            <fieldset data-tour="generate-sources">
              <legend>{ui("01 / 选择资料")}</legend>
              {/* One row per document with its pages on demand; counts are in documents (WP3, P18). */}
              <SourcePicker sources={evidenceSources} selected={selectedSources} onChange={setSelectedSources} indexCoverage={indexCoverage}
                courses={data.focus?.courses} scope={sourceScope} onScopeChange={setSourceScope} disabled={busy} />
              <div className="generate-sources-actions">
                {/* The one way to add material from here: the shared import dialog (WP3). */}
                <Button variant="link" icon="upload" onClick={openImport}>{ui("导入资料")}</Button>
              </div>
              {advice.tooBig && !retrievalReady(retrieval) && <LargeDocumentCard reason="selection" detail={{ chars: advice.chars }} retrieval={retrieval} onOpenSettings={() => setPage?.("settings")}
                call={call} courses={data.focus?.courses} defaultCourse={generationCourse} />}
              {retrievalReady(retrieval) && (advice.willRetrieve || advice.needsTopic) && <RetrievalPanel advice={advice} sourceIds={selectedSources}
                focus={gen.focus} course={generationCourse} onApply={setSelectedSources} disabled={busy} />}
              {/* 分步生成路径: a selection too big for one generation, cut into chapters/steps (the AI can name and order them, or the learner shapes them in the chat). */}
              <GenerationPath sources={data.sources} selectedIds={selectedSources} gen={gen} course={generationCourse} goal={goal}
                indexCoverage={indexCoverage} disabled={busy || !model.ready || !!referenceState.reason} onSettings={openSettings}
                onUseStep={(step) => { setSelectedSources(step.sourceIds); setGen({ ...gen, count: step.count, ...(step.focus ? { focus: step.focus } : {}) }); }}
                onQueued={() => { setGen(current => freshGeneration(current, data.settings?.generation)); setPage("library"); }} />
            </fieldset>
            <fieldset className="generate-form" data-tour="generate-options">
              <legend>{ui("02 / 学习方式")}</legend>
              <CourseField courses={data.focus?.courses} value={generationCourse} onChange={course => setGen({ ...gen, course })} />
              {!generationCourse && selectedSources.length > 0 && <p className="muted">{ui('当前生成结果将归为未分类；可在上方指定课程。')}</p>}
              {caseExam && <p className="generate-case-hint">{ui("这门课考案例题，可以切到「案例分析题」出题。")}{" "}
                <Button variant="link" onClick={() => setGenSource("case")}>{ui("切到案例分析题")}</Button></p>}
              <div className="generate-rows">
                <FormRow label={ui("题型")}>
                  <SegmentedControl label={ui("题型")} className="generate-kind" value={gen.kind}
                    options={KINDS.map((id) => ({ value: id, label: id === "mixed" ? ui("测验 + 闪卡") : kinds[id] }))}
                    onChange={(kind) => setGen({ ...gen, kind })} />
                  <p className="generate-note">{kindNote(gen.kind)}</p>
                </FormRow>
                <FormRow label={ui("题数")} htmlFor="generate-count">
                  <div className="generate-count">
                    <div className="generate-stepper" role="group" aria-label={ui("题数")}>
                      <IconButton icon="minus" size="sm" label={ui("减少题数")} disabled={clampCount(gen.count) <= COUNT_MIN} onClick={() => setGen({ ...gen, count: stepCount(gen.count, -1) })} />
                      <input id="generate-count" type="number" min={COUNT_MIN} max={COUNT_MAX} inputMode="numeric" required value={gen.count}
                        onChange={(e) => setGen({ ...gen, count: e.target.value })}
                        onBlur={(e) => setGen({ ...gen, count: clampCount(e.target.value) })} />
                      <IconButton icon="plus" size="sm" label={ui("增加题数")} disabled={clampCount(gen.count) >= COUNT_MAX} onClick={() => setGen({ ...gen, count: stepCount(gen.count, 1) })} />
                    </div>
                    <div className="generate-presets" role="group" aria-label={ui("常用题数")}>
                      {COUNT_PRESETS.map((preset) => (
                        <Chip key={preset} className="generate-preset" selected={Number(gen.count) === preset}
                          onClick={() => setGen({ ...gen, count: preset })}>{preset}</Chip>
                      ))}
                      {suggestedCount && suggestedCount !== Number(gen.count) && (
                        <Chip className="generate-hint" title={ui("按资料大小估算，点一下采用")}
                          onClick={() => setGen({ ...gen, count: suggestedCount })}>{uiFormat("建议 {0} 题", [suggestedCount])}</Chip>
                      )}
                    </div>
                  </div>
                </FormRow>
                <FormRow label={ui("难度")}>
                  <SegmentedControl label={ui("难度")} value={gen.difficulty} options={DIFFICULTIES.map(({ value, label }) => ({ value, label }))}
                    onChange={(difficulty) => setGen({ ...gen, difficulty })} />
                  <p className="generate-note">{difficultyNote(gen.difficulty)}</p>
                </FormRow>
                <FormRow label={ui("语言")}>
                  <SegmentedControl label={ui("语言")} size="sm" value={gen.language} options={LANGUAGES.map(({ value, label }) => ({ value, label }))}
                    onChange={(language) => setGen({ ...gen, language })} />
                </FormRow>
                <FormRow label={ui("这次想练什么？")} htmlFor="generate-focus">
                  <textarea id="generate-focus" ref={focusBox} className="generate-focus" rows={2} value={gen.focus}
                    onChange={(e) => setGen({ ...gen, focus: e.target.value })}
                    placeholder={ui("例如：区分相似模式，重点练习工程场景中的取舍")} />
                  <GenerateAssist ready={model.ready} phase={assist.phase} result={assist.result} applied={assist.applied} focus={gen.focus} disabled={busy}
                    estimate={<TokenEstimate enabled={model.ready && selectedSources.length > 0}
                      request={{ feature: 'suggest', sourceIds: selectedSources, course: generationCourse, ...(goal ? { goal } : {}) }} />}
                    onAsk={askAssist} onSettings={openSettings}
                    onPick={(item) => setGen({ ...gen, focus: appendFocus(gen.focus, item) })}
                    onApply={() => { setGen(applySuggestion(gen, assist.result)); setAssist({ ...assist, applied: true }); }} />
                </FormRow>
              </div>
              <ReferenceQuestions sources={data.sources} selected={referenceSourceIds} evidenceIds={selectedSources}
                limits={gen.referenceLimits} onLimitsChange={referenceLimits => setGen({ ...gen, referenceLimits })}
                format={gen.referenceFormat} onFormatChange={referenceFormat => setGen({ ...gen, referenceFormat })}
                onChange={ids => setGen({ ...gen, referenceSourceIds: ids })} onImport={() => openReferenceImport()}
                courses={data.focus?.courses} busy={busy} />
              {selectedPdfPages > Number(gen.count) && <InlineMessage tone="warning">{uiFormat("已选 {0} 页 PDF，计划生成 {1} 题。题数少于页数，不能保证逐页考察；可缩小页码范围或分批出题。", [selectedPdfPages, gen.count])}</InlineMessage>}
              <Disclosure className="generate-more" summary={ui("更多选项")} meta={ui("题组名称、公式写法、目标岗位")} defaultOpen={roleOpenByDefault({ goal, focus: data.focus, role: gen.role })}>
                <div className="generate-rows">
                  <FormRow label={ui("公式写法")}>
                    <SegmentedControl label={ui("公式写法")} size="sm" value={gen.notation ?? 'auto'} options={NOTATION_CHOICES.map(({ value, label }) => ({ value, label }))}
                      onChange={(notation) => setGen({ ...gen, notation })} />
                    <p className="generate-note">{notationNote()}</p>
                  </FormRow>
                  <FormRow label={ui("题组名称（可选）")} htmlFor="generate-title">
                    <input id="generate-title" value={gen.title || ""} onChange={(e) => setGen({ ...gen, title: e.target.value })} placeholder={ui("例如 SWE5001 · Solution Architecture")} />
                  </FormRow>
                  <FormRow label={ui("目标岗位 / 面试方向（可选）")} htmlFor="generate-role">
                    <input id="generate-role" value={gen.role} onChange={(e) => setGen({ ...gen, role: e.target.value })} placeholder={ui("例如：后端工程师 · 系统设计")} />
                  </FormRow>
                </div>
              </Disclosure>
            </fieldset>
            <div className="generate-submit" data-tour="generate-summary">
              <div className="quality-note">
                <Icon name="sparkle" />
                <p>{ui("原文引用核验 · 独立质量审阅 · 干扰项逐项解释")}<br />
                  <small>{ui("发布时会再次逐题检查；合格题先发布，未通过的题可选择交给后台修复。")}</small>
                </p>
              </div>
              {summary && <p className="generate-summary" role="status">{summary}</p>}
              {/* What the run is expected to use, from the real prompts of the pipeline (WP27). */}
              <TokenEstimate enabled={selectedSources.length > 0 && !referenceState.reason}
                request={{ feature: 'generate', sourceIds: selectedSources, referenceSourceIds, referenceLimits: gen.referenceLimits, referenceFormat: gen.referenceFormat, count: clampCount(gen.count), kind: gen.kind, difficulty: gen.difficulty, language: gen.language,
                  course: generationCourse, ...(reasoningEffort ? { reasoningEffort } : {}) }} />
              {model.ready ? <>
                {!selectedSources.length && <p className="muted">{ui("在「01 / 选择资料」勾选至少一份资料后即可生成。")}</p>}
                {advice.blocked && <InlineMessage tone="warning">{advice.needsTopic ? ui("所选资料太大。先在「这次想练什么？」写下主题，再生成。")
                  : ui("所选资料超过一次生成的上限。请按章节缩小选择，或按上面的建议用检索工具。")}</InlineMessage>}
                {running && <p className="muted">{ui("已有出题任务在进行，新的会排在它后面。")}</p>}
                <Button variant="primary" type="submit" icon="sparkle" busy={busy} disabled={!selectedSources.length || advice.blocked || !!referenceState.reason}
                  data-tour="generate-submit" data-usage="generate.submit">
                  {running ? ui("加入生成队列 →") : ui("生成并检查题组 →")}
                </Button>
              </> : (
                /* P14: no usable model, so there is nothing to click into a 20-second failure. */
                <ModelSetupGate variant="block" feature="generate" model={model} onOpenSettings={openSettings} data-tour="generate-submit" />
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
