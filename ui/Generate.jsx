import { ui, uiFormat, getUiLanguage } from "./i18n.js";
import React from "react";
import Icon from "./Icon.jsx";
import Ingest from "./Ingest.jsx";
import PdfImport from "./PdfImport.jsx";
import JsonImport from "./JsonImport.jsx";
import { kinds } from "./shared.js";
import CourseField from './CourseField.jsx';
import PageScope, { usePageScope } from './PageScope.jsx';
import { courseForSources, sourceMatchesCourse } from '../lib/source-courses.js';

/* 创建题组视图：从已存资料生成（选资料 → 设定学习方式 → 入队后台任务），
   或切换到对话录题（Ingest，录题启动后把说明词填进对话输入框）。 */
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
}) {
  const [sourceScope, setSourceScope] = usePageScope(data.root, 'generate-sources', data.focus?.course ?? '*');
  const visibleSources = data.sources.filter(source => sourceMatchesCourse(source, sourceScope));
  const generationCourse = gen.course ?? courseForSources({ sources: data.sources }, selectedSources, sourceScope === '*' ? '' : sourceScope);
  const selectedPdfPages = new Set(data.sources.filter((source) => source.document && selectedSources.includes(source.id))
    .map((source) => `${source.document.id || source.id}:${source.document.page || source.id}`)).size;
  // With a single source there is nothing to choose; don't make the learner tick it.
  React.useEffect(() => {
    if (visibleSources.length === 1 && !selectedSources.length)
      setSelectedSources([visibleSources[0].id]);
    // Only on entering the page, so 清空选择 still sticks.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="page">
      <div className="eyebrow">IMPORT → STUDY</div>
      <h1>{ui("导入或补充题目")}</h1>
      <div className="source-mode" role="tablist" aria-label={ui("题目来源")}>
        {[
          ["json", ui("导入 JSON 题组"), ui("外部生成的题目 · 推荐")],
          ["chat", ui("录入已有题目"), ui("刷题软件、错题或截图")],
          ["files", ui("从资料补题"), ui("按需生成少量缺的题")],
        ].map(([id, label, note]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={genSource === id}
            className={genSource === id ? "source-tab active" : "source-tab"}
            onClick={() => setGenSource(id)}
          >
            <strong>{label}</strong>
            <small>{note}</small>
          </button>
        ))}
      </div>
      {genSource === "json" ? (
        <JsonImport data={data} busy={busy} act={act} call={call} openDraft={openDraft} setNotice={setNotice} />
      ) : genSource === "chat" ? (
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
      ) : (
        <>
          <p className="muted">{ui("先选资料，再设定学习目标。生成结果会先进入草稿；发布时逐题检查，通过的题先进入学习库。")}</p>
          <PdfImport data={data} defaultCourse={sourceScope === '*' ? '' : sourceScope} busy={busy} act={act} onImported={(ids) => setSelectedSources(ids)} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act(
                "generate",
                {
                  ...gen,
                  course: generationCourse,
                  count: Number(gen.count),
                  sourceIds: selectedSources,
                },
                (job) => {
                  setPage("library");
                  setNotice(
                    (job.status === "queued"
                      ? uiFormat("已加入队列（前面还有 {0} 个）",[job.queuedBehind])
                      : ui("已开始生成")) +
                      (job.parts > 1 ? uiFormat("，分 {0} 小批出题并审阅",[job.parts]) : "") +
                      ui("。完成后出现在待发布列表。"),
                  );
                },
              );
            }}
          >
            <fieldset>
              <legend>{ui("01 / 选择资料")}</legend>
              <PageScope courses={data.focus?.courses} value={sourceScope} onChange={setSourceScope} />
              <p className="muted">{ui("已选择 ")}{selectedSources.length} / {data.sources.length}{ui(" 份资料")}</p>
              {selectedSources.some(id => !visibleSources.some(source => source.id === id)) && <p className="muted">{ui('已选资料包含其他范围，生成时仍会保留。')}</p>}
              <div className="source-selection">
              {data.sources.length ? (
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
                      <small>{s.text.length.toLocaleString()}{ui(" 字符")}{s.document ? (s.document.extractionVersion === 2 ? ui(" · 排版提取 v2") : ui(" · 旧版提取，建议重新导入")) : ""}{s.document?.sparseText ? ui(" · 文字偏少，核对正文") : ""}{s.document?.warnings?.length ? ui(" · 排版待核对") : ""}</small>
                    </span>
                  </label>
                ))
              ) : (
                <p className="muted">{ui("先添加一份资料。")}</p>
              )}
              </div>
              {!!data.sources.length && <div>
                <button type="button" onClick={() => setSelectedSources(current => [...new Set([...current, ...visibleSources.map(source => source.id)])])}>{ui("选择当前范围")}</button>{" "}
                <button type="button" onClick={() => setSelectedSources([])}>{ui("清空选择")}</button>
              </div>}
              <button
                type="button"
                onClick={() => setModal({ type: "add", course: sourceScope === '*' ? '' : sourceScope })}
              >{ui("＋ 添加资料")}</button>
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
            <div className="quality-note">
              <Icon>✧</Icon>
              <p>{ui("原文引用核验 · 独立质量审阅 · 干扰项逐项解释")}<br />
                <small>{ui("发布时会再次逐题检查；合格题先发布，未通过的题可选择交给后台修复。")}</small>
              </p>
            </div>
            {!data.modelReady && (
              <p className="warning">{ui("当前会话没有可用模型。请在对话输入框选择模型，或在设置中指定生成模型。")}</p>
            )}
            {data.modelReady && !selectedSources.length && (
              <p className="muted">
                {data.sources.length ? ui("在「01 / 选择资料」勾选至少一份资料后即可生成。") : ui("先点「＋ 添加资料」或导入 PDF，再生成。")}
              </p>
            )}
            <button
              className="primary wide"
              disabled={
                busy || !selectedSources.length || !data.modelReady
              }
            >
              {running ? ui("加入生成队列 →") : ui("生成并检查题组 →")}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
