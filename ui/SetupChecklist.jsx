import React, { useEffect, useMemo, useState } from "react";
import { ui, uiFormat } from "./i18n.js";
import { Button, Icon } from "./components/index.js";
import { useInjectCss } from "./shared.js";
import { SETUP_STEP_IDS, courseSetup, hasBigBook } from "../lib/course-setup.js";
import css from "./setup-checklist.css";

/* 课程准备: what is done once at the start of a course, as a checklist at the top of the library home (docs/feature-tiers.md).

   The state is derived (lib/course-setup.js): nothing is stored in the library, no step is ticked by hand and no model is
   called. While a course is being set up the checklist is a card; once the first questions exist, or the course is in use, it
   is one quiet line that opens the list; when everything is done it says so once and goes. It never blocks anything: every step
   has one action that reuses an existing page or dialog, and a "稍后" that puts it off (kept per viewer in localStorage, a
   convenience, never in the library). */

const key = (kind, root, course) => `study-setup-${kind}:${root || "local"}:${course ?? ""}`;
/** The steps the learner put off for a course: ids, per library and course. */
export function readSetupLater(root, course) {
  try {
    const value = JSON.parse(localStorage.getItem(key("later", root, course)));
    return Array.isArray(value) ? value.filter((id) => SETUP_STEP_IDS.includes(id)) : [];
  } catch { return []; }
}
export function writeSetupLater(root, course, ids) {
  try {
    if (ids.length) localStorage.setItem(key("later", root, course), JSON.stringify(ids)); else localStorage.removeItem(key("later", root, course));
  } catch { /* the choice still holds this session */ }
}
/** Has the "all done" note been shown for this course? It is shown once. */
export function setupDoneSeen(root, course) {
  try { return localStorage.getItem(key("done", root, course)) === "1"; } catch { return false; }
}
export function markSetupDone(root, course) {
  try { localStorage.setItem(key("done", root, course), "1"); } catch { /* the note may show once more */ }
}

/** The one action of a step: { label, run, disabled }. `on` carries the page's own handlers; a step without a handler is disabled, never a dead button. */
export function stepAction(step, setup, on = {}) {
  const course = setup.course;
  const table = {
    import: [ui("导入资料"), on.import && (() => on.import(course))],
    sources: [step.id === "convert" ? ui("去资料页转换") : ui("去资料页处理"), on.sources],
    index: [ui("打开检索设置"), on.index],
    generate: [ui("用这门课的资料出题"), on.generate && (() => on.generate(course))],
    draft: [ui("检查并发布草稿"), on.draft && (() => on.draft(step.detail.draftId))],
    course: [ui("设置考试信息"), on.course && (() => on.course(step.detail.courseId))],
    skeleton: [ui("生成知识骨架"), on.skeleton],
  };
  const [label, run] = table[step.action] || [ui("打开"), null];
  return { label, run: run || (() => {}), disabled: !run || !!step.blockedBy };
}

/** What a step is called and says: { title, text, hint? } for its current state. */
function stepCopy(step) {
  const done = step.status === "done", d = step.detail || {};
  switch (step.id) {
    case "materials":
      return { title: ui("加入资料"), text: done ? uiFormat("已有 {0} 份资料", [d.documents]) : ui("导入讲义、课件、PDF 或笔记，原文件会保留；之后用它出题。") };
    case "convert":
      return { title: ui("转换长教材并分章"), text: done ? ui("长教材已转换，可以按章节选择。") : uiFormat("「{0}」有 {1} 页，还没有分章。先转换成带页码的文字，再按章节选择。", [d.title, d.pages]) };
    case "index":
      return { title: ui("为大教材建立检索索引"), hint: ui("索引相当于提前给整本书按页编好目录：之后提问和出题只取相关页面，不必把整本书发给 AI。"),
        text: done ? uiFormat("索引已是最新（{0} 页）", [d.pages])
          : !d.installed ? ui("要对整本书提问或出题，先安装检索扩展，再为这门课建立索引。")
            : d.missing ? uiFormat("还有 {0} 页没建好索引。", [d.missing]) : ui("检索扩展已安装，为这门课建立索引即可。") };
    case "originals":
      return { title: ui("补全原文件"), text: uiFormat("{0} 份旧资料只保留了提取文字，没有原文件；重新导入原文件，才能对照原版排版和图表。", [d.count]) };
    case "deck":
      return { title: ui("出第一批题"),
        text: done ? uiFormat("已有 {0} 个题组，可以开始练习", [d.decks])
          : step.blockedBy ? ui("先加入资料，再出题。")
            : d.drafts ? uiFormat("有 {0} 份草稿待检查，发布后就能练习。", [d.drafts])
              : d.needsModel ? ui("选好资料、题型和题数即可。出题需要 AI 模型，页面会告诉你怎么连接。") : ui("选好题型和题数，AI 出题后逐题检查，再由你确认。") };
    case "goal":
      return { title: ui("设定考试日期与目标"), optional: true,
        text: done ? (d.date ? uiFormat("考试日期 {0}", [d.date]) : ui("已记下考试信息")) : ui("写下考试形式和日期，课程标题旁会显示倒计时，批改和模拟考试也会按它来。") };
    case "skeleton":
      return { title: ui("画出知识脉络"), optional: true, text: done ? ui("已有知识骨架") : ui("把这门课的题连成一张图，看清先学什么、哪里薄弱。") };
    default: return { title: step.id, text: "" };
  }
}

function Step({ step, index, setup, on, busy, next, onLater }) {
  const copy = stepCopy(step), action = stepAction(step, setup, on);
  const done = step.status === "done";
  return (
    <li className="setup-step" data-step={step.id} data-status={step.status} data-next={next ? "true" : undefined}>
      <span className="setup-mark" aria-hidden="true">{done ? <Icon name="check" size={14} /> : index + 1}</span>
      <div className="setup-body">
        <strong className="setup-title" title={copy.hint}>{copy.title}{copy.optional && <span className="setup-optional">{ui("可选")}</span>}</strong>
        <small className="setup-text">{copy.text}</small>
      </div>
      {!done && (
        <div className="setup-actions">
          <Button size="sm" variant="secondary" disabled={busy || action.disabled} onClick={action.run}>{action.label}</Button>
          <Button size="sm" variant="link" onClick={() => onLater(step.id)}>{ui("稍后")}</Button>
        </div>
      )}
    </li>
  );
}

/**
 * @param data      the library snapshot
 * @param call      host call, only used to read what the search extension reports (when the course has a big book)
 * @param on        { import(course), sources(), index(), generate(course), draft(id), course(id), skeleton() }
 * For previews and tests: later, initialOpen, doneSeen, retrieval.
 */
export default function SetupChecklist({ data, call, busy = false, on = {}, later: laterProp, initialOpen = false, doneSeen: doneSeenProp, retrieval: retrievalProp = null }) {
  useInjectCss(css, "study-setup-checklist");
  const root = data?.root, course = data?.focus?.course;
  const [later, setLater] = useState(() => laterProp ?? readSetupLater(root, course));
  const [open, setOpen] = useState(initialOpen);
  const [hidden, setHidden] = useState(false);
  const [seen] = useState(() => doneSeenProp ?? setupDoneSeen(root, course));
  const [retrieval, setRetrieval] = useState(retrievalProp);
  const bigBook = useMemo(() => hasBigBook(data, course), [data?.sources, data?.focus?.courses, course]); // eslint-disable-line react-hooks/exhaustive-deps

  // Whether the big book has an index is asked of the search extension, once, and only when there is a big book.
  useEffect(() => {
    if (!bigBook || typeof call !== "function" || retrievalProp || !course) return undefined;
    let live = true;
    (async () => {
      const status = await Promise.resolve(call("retrieval.status", {})).catch(() => null);
      const plan = status?.extension?.installed && status?.companion?.running ? await Promise.resolve(call("retrieval.index.plan", { course })).catch(() => null) : null;
      if (live) setRetrieval(status ? { status, plan } : null);
    })();
    return () => { live = false; };
  }, [bigBook, course]); // eslint-disable-line react-hooks/exhaustive-deps

  const setup = courseSetup(data, { retrieval, dismissed: later });
  useEffect(() => { if (setup.mode === "done" && !seen) markSetupDone(root, course); }, [setup.mode, seen, root, course]);
  if (setup.mode === "none" || hidden) return null;

  if (setup.mode === "done") {
    if (seen) return null;
    return (
      <div className="setup-done" data-setup-checklist="" data-mode="done" role="status">
        <Icon name="success" size={18} />
        <span>{ui("课程准备已完成")}</span>
        <Button size="sm" variant="link" onClick={() => setHidden(true)}>{ui("知道了")}</Button>
      </div>
    );
  }

  const putOff = (id) => { const next = [...new Set([...later, id])]; setLater(next); writeSetupLater(root, course, next); };
  const restore = () => { setLater([]); writeSetupLater(root, course, []); };
  const active = setup.steps.filter((step) => step.status !== "later");
  const first = setup.mode === "full" ? active.find((step) => step.status === "todo" && step.required) : null;
  const name = course === "" ? ui("未分类课程") : course;
  const list = (
    <>
      <ol className="setup-steps">
        {active.map((step, index) => <Step key={step.id} step={step} index={index} setup={setup} on={on} busy={busy} next={step === first} onLater={putOff} />)}
      </ol>
      {later.length > 0 && <p className="setup-later"><Button size="sm" variant="link" onClick={restore}>{uiFormat("恢复已推后的 {0} 项", [later.length])}</Button></p>}
    </>
  );

  if (setup.mode === "chip") {
    return (
      <section className="setup-chip" data-setup-checklist="" data-mode="chip" aria-label={ui("课程准备")}>
        <Button size="sm" className="setup-chip-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}
          title={uiFormat("{0} · 每门课开头做一次的准备", [name])}>
          {open ? uiFormat("课程准备 {0}/{1} · 收起", [setup.done, setup.total]) : uiFormat("课程准备 {0}/{1} · 查看", [setup.done, setup.total])}
        </Button>
        {open && list}
      </section>
    );
  }
  return (
    <section className="setup-card" data-setup-checklist="" data-mode="full" aria-label={ui("课程准备")}>
      <header className="setup-head">
        <div>
          <span className="eyebrow">{ui("课程准备")} · {name}</span>
          <h2 className="setup-heading">{uiFormat("{0}/{1} 项已完成", [setup.done, setup.total])}</h2>
        </div>
        <p className="setup-lead">{ui("每门课开头做一次，之后每天只需要打开今日学习。不做也不影响练习。")}</p>
      </header>
      {list}
    </section>
  );
}
