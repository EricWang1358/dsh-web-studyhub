import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import React from "react";
import Icon from "./Icon.jsx";
import Ingest from "./Ingest.jsx";
import JsonImport from "./JsonImport.jsx";
import { kinds, useInjectCss } from "./shared.js";
import CourseField from './CourseField.jsx';
import PageScope, { usePageScope } from './PageScope.jsx';
import { courseForSources, sourceMatchesCourse } from '../lib/source-courses.js';
import { Banner, Button, EmptyState, PageHeader, SetupRequired } from './components/index.js';
import { documentCount, freshGeneration, generationStartedNotice, modelReadiness } from './generation-status.js';
import homeCss from './generate-home.css';

/* SEAM(WP3 SourcePicker): this checklist is the stand-in for <SourcePicker>
   (ui/SourcePicker.jsx, grouped by document). Swap it at integration and keep
   the contract: sources in scope, selected ids, setSelectedSources. */
function SourceChecklist({ sources, visibleSources, selectedSources, setSelectedSources }) {
  return <div className="source-selection">
    {sources.length ? (
      visibleSources.map((s) => (
        <label className="source-choice" key={s.id}>
          <input
            type="checkbox"
            checked={selectedSources.includes(s.id)}
            onChange={(e) =>
              setSelectedSources((v) =>
                e.target.checked
                  ? [...v, s.id]
                  : v.filter((x) => x !== s.id),
              )
            }
          />
          <span>
            {s.title}
            <small>{s.courses?.join(' · ') || ui('未分类')}{s.coursesInferred ? ui(' · 推断归属') : ''}</small>
            {/* P22: only PDF pages have an extraction version; Markdown/HTML documents are never "legacy". */}
            <small>{s.text.length.toLocaleString()}{ui(" 字符")}{s.document && (!s.document.format || s.document.format === 'pdf') ? (s.document.extractionVersion === 2 ? ui(" · 排版提取 v2") : ui(" · 旧版提取，建议重新导入")) : ""}{s.document?.sparseText ? ui(" · 文字偏少，核对正文") : ""}{s.document?.warnings?.length ? ui(" · 排版待核对") : ""}</small>
          </span>
        </label>
      ))
    ) : (
      <p className="muted">{ui("先添加一份资料。")}</p>
    )}
  </div>;
}

/* 创建题组 (D1): generating from the learner's own materials comes first;
   importing questions that already exist is the second way in. Generation is
   gated on a usable model before any effort goes into the form (P14). */
export default function Generate({
  data,
  busy,
  running,
  act,
  call,
  openDraft,
  setPage,
  setNotice,
  genSource,
  setGenSource,
  gen,
  setGen,
  selectedSources,
  setSelectedSources,
  setModal,
  askInChat,
  canChat = false,
  openModelSettings,
  onStarted,
}) {
  useInjectCss(homeCss, "study-generate-home");
  const [sourceScope, setSourceScope] = usePageScope(data.root, 'generate-sources', data.focus?.course ?? '*');
  const visibleSources = data.sources.filter(source => sourceMatchesCourse(source, sourceScope));
  const generationCourse = gen.course ?? courseForSources({ sources: data.sources }, selectedSources, sourceScope === '*' ? '' : sourceScope);
  const selectedPdfPages = new Set(data.sources.filter((source) => source.document && selectedSources.includes(source.id))
    .map((source) => `${source.document.id || source.id}:${source.document.page || source.id}`)).size;
  const model = modelReadiness(data);
  const openImport = () => setModal({ type: "add", course: sourceScope === '*' ? '' : sourceScope });
  const openSettings = () => (openModelSettings ? openModelSettings() : setPage?.("settings"));
  // With a single source there is nothing to choose; don't make the learner tick it.
  React.useEffect(() => {
    if (visibleSources.length === 1 && !selectedSources.length)
      setSelectedSources([visibleSources[0].id]);
    // Only on entering the page, so 清空选择 still sticks.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const tabs = [
    { id: "files", label: ui("用资料出题"), note: ui("AI 按你的资料出题，并逐题检查"), icon: "sparkle", tour: "generate-from-sources" },
    { id: "json", label: ui("导入 JSON 题组"), note: ui("已有题目，或外部 AI 生成的题"), icon: "file" },
    // Recording into the conversation needs a chat that can take it (plan C3).
    ...(canChat ? [{ id: "chat", label: ui("在对话里录题"), note: ui("刷题软件、错题或截图") }] : []),
  ];
  const current = tabs.some((tab) => tab.id === genSource) ? genSource : "files";
  function moveTab(event, index) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    setGenSource(next.id);
    event.currentTarget.parentElement?.querySelector(`#generate-tab-${next.id}`)?.focus();
  }
  function submit(event) {
    event.preventDefault();
    if (!model.ready || busy || !selectedSources.length) return;
    const materials = documentCount(data.sources.filter((source) => selectedSources.includes(source.id)));
    act("generate", { ...gen, course: generationCourse, count: Number(gen.count), sourceIds: selectedSources }, (job) => {
      // Confirm with the deck's name, start the next deck from a clean form (P27),
      // and land where the progress card is (P26).
      setNotice(generationStartedNotice(job, gen, materials));
      setGen(freshGeneration);
      if (onStarted) onStarted(job);
      else setPage("library");
    });
  }
  const gateWhy = model.reason === "no-credential"
    ? model.label ? uiFormat("已选择「{0}」，但还没有可用的 API Key。出题要用它调用模型。", [model.label])
      : ui("已选择模型，但还没有可用的 API Key。出题要用它调用模型。")
    : model.reason === "no-route" ? ui("还没有选择用来出题的 AI 模型。配置好之后回到这里，已填的内容会保留。")
      : ui("出题需要一个可用的 AI 模型。配置好之后回到这里，已填的内容会保留。");
  return (
    <section className="page generate-page">
      <PageHeader eyebrow={ui("创建题组")} title={ui("出一组新题")}
        description={ui("用你的资料让 AI 出题，逐题检查后再发布；已经有现成的题目，也可以直接导入。")} />
      <div className="source-mode" role="tablist" aria-label={ui("创建方式")}>
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`generate-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={current === tab.id}
            aria-controls="generate-panel"
            tabIndex={current === tab.id ? 0 : -1}
            className={current === tab.id ? "source-tab active" : "source-tab"}
            data-tour={tab.tour}
            onClick={() => setGenSource(tab.id)}
            onKeyDown={(event) => moveTab(event, index)}
          >
            <strong>{tab.label}</strong>
            <small>{tab.note}</small>
          </button>
        ))}
      </div>
      <div className="generate-panel" role="tabpanel" id="generate-panel" aria-labelledby={`generate-tab-${current}`}>
      {current === "json" ? (
        <JsonImport data={data} busy={busy} act={act} call={call} openDraft={openDraft} setNotice={setNotice} />
      ) : current === "chat" ? (
        <Ingest
          data={data}
          busy={busy}
          start={(config) =>
            act("ingest.start", config, (mode) => {
              const kindText = {
                auto: "自动识别（有选项的保持单选/多选，没有选项的做成问答闪卡）",
                flashcard: "一律闪卡",
                quiz: "一律单选 MQ",
                multi: "一律多选",
                open: "一律开放问答",
              }[mode.kind];
              const mistakeText = {
                auto: "我标明自己选错的记为错题",
                all: "这批全部当错题",
                none: "都不记为错题",
              }[mode.mistakes];
              askInChat(
                getUiLanguage() === "en" ? [
                  'Start recording questions: use study_workspace ingest to add questions I paste in this conversation (including quiz apps, Canvas mistakes and screenshots) directly to my study library without asking for confirmation again.',
                  `- Deck: “${mode.deckTitle}”${mode.folder ? ` (folder: ${mode.folder})` : ''}`,
                  `- Question type: ${{ auto: 'Preserve single/multiple-choice questions when options are present; otherwise create Q&A flashcards.', flashcard: 'Create Q&A flashcards.', quiz: 'Create single-choice questions; add distractors where options are missing.', multi: 'Create multiple-choice questions.', open: 'Create open-response questions with grading criteria.' }[mode.kind]}`,
                  `- Mistakes: ${{ auto: 'Only mark questions I explicitly identify as answered incorrectly.', all: 'Mark every question in this batch as a mistake.', none: 'Do not mark any questions as mistakes.' }[mode.mistakes]}`,
                  '- Preserve the original language of questions, options and answers. Reply in English.',
                  '- For screenshots, transcribe questions, options and answers before importing. Large batches may be split.',
                  '- If I paste a lecture PDF rather than existing questions, import its pages with source.import, then use generate to create a draft under the deck name above. Do not record lecture material as mistakes.',
                  '- After each batch, briefly report the imported count, duplicates, failures with reasons, and inferred answers that need checking.',
                  '- When I say “stop recording”, call ingest.stop.',
                  'First batch of questions:', ''
                ].join('\n') :
                "开始录题：接下来这段对话里我贴的题目（刷题软件、Canvas 错题记录、截图都可能），请都用 study_workspace 的 ingest 直接录入学习库，不用再问我确认。\n" +
                  "- 题组：「" + mode.deckTitle + "」" + (mode.folder ? "（目录 " + mode.folder + "）" : "") + "\n" +
                  "- 题型：" + kindText + "\n" +
                  "- 错题：" + mistakeText + "\n" +
                  "- 截图请先逐字转写题目、选项和答案再录入；一次贴很多题时可以分批。\n" +
                  "- 如果我贴的是讲义 PDF 而不是现成题目，请用 source.import 按页导入，再用 generate 生成新题草稿，沿用上述题组名称；不要把讲义当错题录入。\n" +
                  "- 每批录完简短告诉我：录入几道、哪些重复、哪些没录成功及原因、哪些答案是推断的需要我核对。\n" +
                  "- 我说「停止录题」时调用 ingest.stop。\n" +
                  "第一批题目：\n",
              );
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
          {!model.ready && <Banner tone="warning" title={ui("还没有可用的 AI 模型")}
            action={{ label: ui("打开模型设置"), onClick: openSettings }}>
            {ui("可以先选好资料和题型；生成前需要先配置模型。")}
          </Banner>}
          <p className="muted">{ui("先选资料，再设定学习目标。生成结果会先进入草稿；发布时逐题检查，通过的题先进入学习库。")}</p>
          <form onSubmit={submit}>
            <fieldset>
              <legend>{ui("01 / 选择资料")}</legend>
              <PageScope courses={data.focus?.courses} value={sourceScope} onChange={setSourceScope} />
              <p className="muted">{ui("已选择 ")}{selectedSources.length} / {data.sources.length}{ui(" 份资料")}</p>
              {selectedSources.some(id => !visibleSources.some(source => source.id === id)) && <p className="muted">{ui('已选资料包含其他范围，生成时仍会保留。')}</p>}
              <SourceChecklist sources={data.sources} visibleSources={visibleSources}
                selectedSources={selectedSources} setSelectedSources={setSelectedSources} />
              <div className="generate-sources-actions">
                <button type="button" onClick={() => setSelectedSources(current => [...new Set([...current, ...visibleSources.map(source => source.id)])])}>{ui("选择当前范围")}</button>
                <button type="button" onClick={() => setSelectedSources([])}>{ui("清空选择")}</button>
                {/* The one way to add material from here: the shared import dialog (WP3). */}
                <Button variant="link" icon="upload" onClick={openImport}>{ui("导入资料")}</Button>
              </div>
            </fieldset>
            <fieldset>
              <legend>{ui("02 / 学习方式")}</legend>
              <div className="kind-grid">
                {Object.entries({ mixed: ui("测验 + 闪卡"), ...kinds }).map(([id, label]) => (
                  <button
                    type="button"
                    key={id}
                    aria-pressed={gen.kind === id}
                    className={gen.kind === id ? "kind selected" : "kind"}
                    onClick={() => setGen({ ...gen, kind: id })}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="muted">{ui("“测验 + 闪卡”将总题数分配为一半单选、一半闪卡（奇数多一道单选），合并为一个待审题组。")}</p>
              <label>{ui("题组名称（可选）")}<input value={gen.title || ""} onChange={(e) => setGen({ ...gen, title: e.target.value })} placeholder={ui("例如 SWE5001 · Solution Architecture")} /></label>
              <CourseField courses={data.focus?.courses} value={generationCourse} onChange={course => setGen({ ...gen, course })} />
              {!generationCourse && selectedSources.length > 0 && <p className="muted">{ui('当前生成结果将归为未分类；可在上方指定课程。')}</p>}
              <div className="three-col">
                <label>{ui("题数")}<input
                    type="number"
                    min="1"
                    max="30"
                    required
                    value={gen.count}
                    onChange={(e) =>
                      setGen({ ...gen, count: e.target.value })
                    }
                  />
                </label>
                <label>{ui("难度")}<select
                    value={gen.difficulty}
                    onChange={(e) =>
                      setGen({ ...gen, difficulty: e.target.value })
                    }
                  >
                    <option value="mixed">{ui("混合")}</option>
                    <option value="foundation">{ui("基础理解")}</option>
                    <option value="application">{ui("应用迁移")}</option>
                    <option value="advanced">{ui("深入辨析")}</option>
                  </select>
                </label>
                <label>{ui("语言")}<select
                    value={gen.language}
                    onChange={(e) =>
                      setGen({ ...gen, language: e.target.value })
                    }
                  >
                    <option value={"中文"}>{ui("中文")}</option>
                    <option>English</option>
                    <option value={"中英双语"}>{ui("中英双语")}</option>
                  </select>
                </label>
              </div>
              {selectedPdfPages > Number(gen.count) && <p className="warning" role="status">{ui("已选 ")}{selectedPdfPages}{ui(" 页 PDF，计划生成 ")}{gen.count}{ui(" 题。题数少于页数，不能保证逐页考察；可缩小页码范围或分批出题。")}</p>}
              <label>{ui("这次想练什么？")}<textarea
                  rows={3}
                  value={gen.focus}
                  onChange={(e) =>
                    setGen({ ...gen, focus: e.target.value })
                  }
                  placeholder={ui("例如：区分相似模式，重点练习工程场景中的取舍")}
                />
              </label>
              <label>{ui("目标岗位 / 面试方向（可选）")}<input
                  value={gen.role}
                  onChange={(e) =>
                    setGen({ ...gen, role: e.target.value })
                  }
                  placeholder={ui("例如：后端工程师 · 系统设计")}
                />
              </label>
            </fieldset>
            <div className="generate-submit">
              <div className="quality-note">
                <Icon>✧</Icon>
                <p>{ui("原文引用核验 · 独立质量审阅 · 干扰项逐项解释")}<br />
                  <small>{ui("发布时会再次逐题检查；合格题先发布，未通过的题可选择交给后台修复。")}</small>
                </p>
              </div>
              {model.ready ? <>
                {!selectedSources.length && <p className="muted">{ui("在「01 / 选择资料」勾选至少一份资料后即可生成。")}</p>}
                {running && <p className="muted">{ui("已有出题任务在进行，新的会排在它后面。")}</p>}
                <Button variant="primary" type="submit" icon="sparkle" busy={busy} disabled={!selectedSources.length}
                  data-tour="generate-submit">
                  {running ? ui("加入生成队列 →") : ui("生成并检查题组 →")}
                </Button>
              </> : (
                /* P14: no usable model, so there is nothing to click into a 20-second failure. */
                <SetupRequired data-tour="generate-submit" icon="model" title={ui("先配置一个 AI 模型")} why={gateWhy}
                  steps={[{ text: ui("打开模型设置，选择一个服务商") }, { text: ui("填入这个服务商的 API Key") },
                    { text: ui("回到这里，点「生成并检查题组」") }]}
                  primary={{ label: ui("打开模型设置"), icon: "model", onClick: openSettings }} />
              )}
            </div>
          </form>
        </>
      )}
      </div>
    </section>
  );
}
