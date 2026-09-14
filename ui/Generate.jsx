import React from "react";
import Icon from "./Icon.jsx";
import Ingest from "./Ingest.jsx";
import PdfImport from "./PdfImport.jsx";
import JsonImport from "./JsonImport.jsx";
import { kinds } from "./shared.js";

/* 创建题组视图：从已存资料生成（选资料 → 设定学习方式 → 入队后台任务），
   或切换到对话录题（Ingest，录题启动后把说明词填进对话输入框）。 */
export default function Generate({
  data,
  busy,
  running,
  act,
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
  // With a single source there is nothing to choose; don't make the learner tick it.
  React.useEffect(() => {
    if (data.sources.length === 1 && !selectedSources.length)
      setSelectedSources([data.sources[0].id]);
    // Only on entering the page, so 清空选择 still sticks.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="page">
      <div className="eyebrow">SOURCE → UNDERSTANDING</div>
      <h1>创建一组值得练的题</h1>
      <div className="source-mode" role="tablist" aria-label="题目来源">
        {[
          ["files", "从资料生成新题", "导入 PDF、讲义、笔记"],
          ["chat", "导入已有题目", "刷题软件、Canvas 错题或截图"],
          ["json", "JSON 导入", "各题型提示词 · JSON / TXT 文件"],
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
        <JsonImport busy={busy} act={act} setPage={setPage} setNotice={setNotice} />
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
          <p className="muted">
            先选资料，再设定学习目标。生成结果会先进入草稿，经过你的审阅后发布。
          </p>
          <PdfImport busy={busy} act={act} onImported={(ids) => setSelectedSources(ids)} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              act(
                "generate",
                {
                  ...gen,
                  count: Number(gen.count),
                  sourceIds: selectedSources,
                },
                (job) => {
                  setPage("library");
                  setNotice(
                    (job.status === "queued"
                      ? `已加入队列（前面还有 ${job.queuedBehind} 个）`
                      : "已开始生成") +
                      (job.parts > 1 ? `，分 ${job.parts} 小批出题并审阅` : "") +
                      "。完成后出现在待审阅列表。",
                  );
                },
              );
            }}
          >
            <fieldset>
              <legend>01 / 选择资料</legend>
              <p className="muted">已选择 {selectedSources.length} / {data.sources.length} 份资料</p>
              <div className="source-selection">
              {data.sources.length ? (
                data.sources.map((s) => (
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
                      <small>{s.text.length.toLocaleString()} 字符{s.document ? (s.document.extractionVersion === 2 ? " · 排版提取 v2" : " · 旧版提取，建议重新导入") : ""}</small>
                    </span>
                  </label>
                ))
              ) : (
                <p className="muted">先添加一份资料。</p>
              )}
              </div>
              {!!data.sources.length && <div>
                <button type="button" onClick={() => setSelectedSources(data.sources.map((s) => s.id))}>全选</button>{" "}
                <button type="button" onClick={() => setSelectedSources([])}>清空选择</button>
              </div>}
              <button
                type="button"
                onClick={() => setModal({ type: "add" })}
              >
                ＋ 添加资料
              </button>
            </fieldset>
            <fieldset>
              <legend>02 / 学习方式</legend>
              <div className="kind-grid">
                {Object.entries({ mixed: "测验 + 闪卡", ...kinds }).map(([id, label]) => (
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
              <p className="muted">“测验 + 闪卡”将总题数分配为一半单选、一半闪卡（奇数多一道单选），合并为一个待审题组。</p>
              <label>题组名称（可选）<input value={gen.title || ""} onChange={(e) => setGen({ ...gen, title: e.target.value })} placeholder="例如 SWE5001 · Solution Architecture" /></label>
              <div className="three-col">
                <label>
                  题数
                  <input
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
                <label>
                  难度
                  <select
                    value={gen.difficulty}
                    onChange={(e) =>
                      setGen({ ...gen, difficulty: e.target.value })
                    }
                  >
                    <option value="mixed">混合</option>
                    <option value="foundation">基础理解</option>
                    <option value="application">应用迁移</option>
                    <option value="advanced">深入辨析</option>
                  </select>
                </label>
                <label>
                  语言
                  <select
                    value={gen.language}
                    onChange={(e) =>
                      setGen({ ...gen, language: e.target.value })
                    }
                  >
                    <option>中文</option>
                    <option>English</option>
                    <option>中英双语</option>
                  </select>
                </label>
              </div>
              <label>
                这次想练什么？
                <textarea
                  rows={3}
                  value={gen.focus}
                  onChange={(e) =>
                    setGen({ ...gen, focus: e.target.value })
                  }
                  placeholder="例如：区分相似模式，重点练习工程场景中的取舍"
                />
              </label>
              <label>
                目标岗位 / 面试方向（可选）
                <input
                  value={gen.role}
                  onChange={(e) =>
                    setGen({ ...gen, role: e.target.value })
                  }
                  placeholder="例如：后端工程师 · 系统设计"
                />
              </label>
            </fieldset>
            <div className="quality-note">
              <Icon>✧</Icon>
              <p>
                原文引用核验 · 独立质量审阅 · 干扰项逐项解释
                <br />
                <small>
                  质量检查帮助发现问题；发布前仍可逐题检查与修改。
                </small>
              </p>
            </div>
            {!data.modelReady && (
              <p className="warning">
                当前会话没有可用模型。请在对话输入框选择模型，或在设置中指定生成模型。
              </p>
            )}
            {data.modelReady && !selectedSources.length && (
              <p className="muted">
                {data.sources.length ? "在「01 / 选择资料」勾选至少一份资料后即可生成。" : "先点「＋ 添加资料」或导入 PDF，再生成。"}
              </p>
            )}
            <button
              className="primary wide"
              disabled={
                busy || !selectedSources.length || !data.modelReady
              }
            >
              {running ? "加入生成队列 →" : "生成并检查题组 →"}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
