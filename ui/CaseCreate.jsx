import React, { useEffect, useMemo, useRef, useState } from "react";
import { ui, uiFormat } from "./i18n.js";
import { useInjectCss } from "./shared.js";
import CourseField from "./CourseField.jsx";
import SourcePicker from "./SourcePicker.jsx";
import ReferenceQuestions from './ReferenceQuestions.jsx';
import { importedReferences, referenceSelection } from './reference-questions.js';
import { Button, SegmentedControl, IconButton, useToast } from "./components/index.js";
import ModelSetupGate from "./ModelSetupGate.jsx";
import { modelReadiness, generationFormDefaults, syncGenerationDefaults } from "./generation-status.js";
import { TokenEstimate } from "./TokenUsage.jsx";
import { courseProfileFromState, DEFAULT_MINUTES_PER_MARK, countWords } from "../lib/case-study.js";
import css from "./case-study.css";
import { useStudy } from "./study-context.jsx";

/* 创建题组 › 案例分析题 (WP12). The course comes first: its profile proposes
   the examiner-guidance material, the focus topics and the marks. Three ways
   in: a new case from the course materials, a case in the style of a pasted
   past paper, or the learner's own case and questions (with answers to grade
   now). Everything goes through `generate` with kind 'case'. */

const blankQuestion = () => ({ prompt: "", marks: 10, answer: "" });

export default function CaseCreate({ data, onStarted, openImport, openReferenceImport, openSettings, onCourseSettings, initial = {} }) {
  const { busy, act, call } = useStudy();
  useInjectCss(css, "study-case-workspace");
  const model = modelReadiness(data);
  const toast = useToast();
  const [mode, setMode] = useState(initial.mode || "new");
  const [course, setCourse] = useState(initial.course ?? (data.focus?.course && data.focus.course !== "*" ? data.focus.course : ""));
  const [sourceIds, setSourceIds] = useState(initial.sourceIds || []);
  const [referenceSourceIds, setReferenceSourceIds] = useState(initial.referenceSourceIds || []);
  const [referenceLimits, setReferenceLimits] = useState(initial.referenceLimits);
  const [referenceFormat, setReferenceFormat] = useState(initial.referenceFormat);
  // The course profile (WP13) from the snapshot's course records; guidance and focus topics are the course's.
  const profile = useMemo(() => courseProfileFromState({ courses: data.courses }, course), [data.courses, course]);
  const evidenceIds = [...sourceIds, ...profile.guidanceSourceIds];
  const referenceState = referenceSelection(data.sources, referenceSourceIds, evidenceIds, referenceLimits, referenceFormat);
  const defaults = { totalMarks: profile.exam.totalMarks || 20, language: generationFormDefaults(data.settings?.generation).language };
  const [form, setForm] = useState(() => ({ questions: 2, ...defaults, title: "", styleText: "" }));
  const inherited = useRef({ course, ...defaults });
  const [pasted, setPasted] = useState({ title: "", scenario: "", questions: [blankQuestion()] });
  const courseRecord = (data.courses || []).find((item) => item.name === course);
  const [passage, setPassage] = useState(initial.focus || "");
  useEffect(() => {
    const before = inherited.current;
    inherited.current = { course, ...defaults };
    // Selecting a course adopts its marks; a later snapshot only updates untouched defaults.
    setForm(current => syncGenerationDefaults(before.course === course ? current : { ...current, totalMarks: defaults.totalMarks }, before, defaults));
  }, [course, defaults.totalMarks, defaults.language]); // eslint-disable-line react-hooks/exhaustive-deps
  const answered = pasted.questions.filter((question) => question.answer.trim()).length;
  const ready = mode === "import"
    ? countWords(pasted.scenario) >= 40 && pasted.questions.every((question) => question.prompt.trim().length >= 5 && Number(question.marks) > 0)
    : sourceIds.length > 0 && !referenceState.reason && (mode !== "style" || form.styleText.trim().length >= 80);
  function submit(event) {
    event.preventDefault();
    if (!model.ready || busy || !ready) return;
    const shared = { kind: "case", course, language: form.language, ...(passage ? { focus: passage } : {}) };
    const args = mode === "import"
      ? { ...shared, title: pasted.title.trim() || undefined, scenario: pasted.scenario, sourceIds,
        questions: pasted.questions.map((question) => ({ prompt: question.prompt.trim(), marks: Number(question.marks) })),
        answers: pasted.questions.map((question) => question.answer) }
      : { ...shared, title: form.title.trim() || undefined, sourceIds, referenceSourceIds, referenceLimits, referenceFormat, questions: Number(form.questions), totalMarks: Number(form.totalMarks),
        ...(mode === "style" ? { styleText: form.styleText } : {}) };
    act("generate", args, () => {
      toast.success(mode === "import"
        ? answered ? uiFormat("已开始导入案例并批改你的 {0} 个回答；结果会进信箱。", [answered]) : ui("已开始导入案例；评分标准写好后草稿出现在学习库。")
        : ui("已开始出一套案例题：写案例、出题、独立审阅。完成后草稿出现在学习库。"));
      onStarted?.();
    });
  }
  const setQuestion = (index, patch) => setPasted((current) => ({ ...current, questions: current.questions.map((question, at) => at === index ? { ...question, ...patch } : question) }));
  return (
    <form className="case-create" onSubmit={submit} data-tour="case-create">
      <SegmentedControl label={ui("案例来源")} value={mode} onChange={setMode} options={[
        { value: "new", label: ui("用资料出新案例") }, { value: "style", label: ui("仿照真题出题") }, { value: "import", label: ui("粘贴题目直接批改") }]} />
      <fieldset>
        <legend>{ui("01 / 课程与资料")}</legend>
        <CourseField courses={data.focus?.courses} value={course} onChange={setCourse} label={ui("所属课程")} />
        {/* The course owns the exam profile, examiner guidance and focus topics (WP13); they are edited in its settings. */}
        <div className="case-create__profile">
          <p className="muted">{uiFormat("按课程的考试设置：每分约 {0} 分钟{1}{2}。", [profile.exam.minutesPerMark || DEFAULT_MINUTES_PER_MARK,
            profile.guidanceSourceIds.length ? uiFormat("，评分说明 {0} 份", [profile.guidanceSourceIds.length]) : ui("，还没有评分说明"),
            profile.focusTopics.length ? uiFormat("，重点主题：{0}", [profile.focusTopics.join("、")]) : ""])}</p>
          {courseRecord && onCourseSettings
            ? <Button size="sm" variant="link" onClick={() => onCourseSettings(courseRecord.id)}>{ui("修改课程的考试设置、评分说明和重点主题")}</Button>
            : <small className="muted">{ui("选好课程后，可以在课程设置里指定评分说明资料和重点主题。")}</small>}
        </div>
        <SourcePicker sources={data.sources.filter((source) => !referenceSourceIds.includes(source.id) && !/^(案例：|Case: )/.test(source.title || ""))} selected={sourceIds} onChange={setSourceIds}
          courses={data.focus?.courses} onAdd={openImport} disabled={busy} />
        <p className="muted">{mode === "import" ? ui("可选：勾选课程资料，评分标准会用到其中的概念。") : ui("勾选要考查的课程资料；案例和题目都基于这些概念。")}</p>
        {passage && mode !== "import" && <div className="case-create__passage">
          <strong>{ui("围绕这段资料出题")}</strong>
          <blockquote>{passage}</blockquote>
          <Button size="sm" variant="quiet" onClick={() => setPassage("")}>{ui("不限定段落")}</Button>
        </div>}
      </fieldset>
      {mode !== 'import' && <ReferenceQuestions sources={data.sources} selected={referenceSourceIds} evidenceIds={evidenceIds}
        limits={referenceLimits} onLimitsChange={setReferenceLimits}
        format={referenceFormat} onFormatChange={setReferenceFormat}
        courses={data.focus?.courses} busy={busy} onChange={setReferenceSourceIds}
        onImport={() => openReferenceImport?.(ids => {
          setReferenceSourceIds(current => importedReferences(current, ids).referenceSourceIds);
          setSourceIds(current => importedReferences([], ids, current).sourceIds);
        })} />}
      {mode === "import" ? (
        <fieldset>
          <legend>{ui("02 / 案例与题目")}</legend>
          <label>{ui("案例标题（可选）")}<input value={pasted.title} maxLength={120} onChange={(event) => setPasted({ ...pasted, title: event.target.value })} /></label>
          <label>{ui("案例原文")}<textarea rows={10} value={pasted.scenario} maxLength={24000}
            onChange={(event) => setPasted({ ...pasted, scenario: event.target.value })} placeholder={ui("粘贴完整的案例，段落之间空一行。")} /></label>
          <div className="case-create__questions">
            {pasted.questions.map((question, index) => (
              <div key={index} className="case-create__question">
                <label>{uiFormat("第 {0} 题", [index + 1])}<textarea rows={2} value={question.prompt} onChange={(event) => setQuestion(index, { prompt: event.target.value })} /></label>
                <label>{ui("分值")}<input type="number" min={0.5} max={100} step={0.5} value={question.marks} onChange={(event) => setQuestion(index, { marks: event.target.value })} /></label>
                {pasted.questions.length > 1 ? <IconButton icon="close" label={ui("删除这道题")}
                  onClick={() => setPasted({ ...pasted, questions: pasted.questions.filter((_, at) => at !== index) })} /> : <span />}
                <label className="case-create__answer">{ui("我的回答（可选，填了就立即批改）")}
                  <textarea rows={4} value={question.answer} onChange={(event) => setQuestion(index, { answer: event.target.value })} /></label>
              </div>
            ))}
            {pasted.questions.length < 8 && <Button variant="link" icon="plus" onClick={() => setPasted({ ...pasted, questions: [...pasted.questions, blankQuestion()] })}>{ui("添加一道题")}</Button>}
          </div>
        </fieldset>
      ) : (
        <fieldset>
          <legend>{ui("02 / 试卷")}</legend>
          {mode === "style" && <label>{ui("往年真题（只作风格模板，不会照抄）")}
            <textarea rows={8} value={form.styleText} maxLength={60000} onChange={(event) => setForm({ ...form, styleText: event.target.value })}
              placeholder={ui("粘贴一份往年案例题。AI 只学它的结构、篇幅和提问方式，案例的公司、人物和数字都会重新编写。")} /></label>}
          <div className="case-create__grid">
            <label>{ui("题数")}<input type="number" min={1} max={5} value={form.questions} onChange={(event) => setForm({ ...form, questions: event.target.value })} /></label>
            <label>{ui("总分")}<input type="number" min={4} max={100} value={form.totalMarks} onChange={(event) => setForm({ ...form, totalMarks: event.target.value })} /></label>
            <label>{ui("语言")}<select value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })}>
              <option value="中文">{ui("中文")}</option><option value="English">English</option><option value="中英双语">{ui("中英双语")}</option></select></label>
          </div>
          <label>{ui("题组名称（可选）")}<input value={form.title} maxLength={120} onChange={(event) => setForm({ ...form, title: event.target.value })} /></label>
          <p className="muted">{uiFormat("按每分约 {0} 分钟，这套题建议作答 {1} 分钟。", [profile?.exam.minutesPerMark || DEFAULT_MINUTES_PER_MARK,
            Math.round((Number(form.totalMarks) || 0) * (profile?.exam.minutesPerMark || DEFAULT_MINUTES_PER_MARK))])}</p>
        </fieldset>
      )}
      <div className="case-create__foot">
        <p className="muted">{ui("案例会存为一份资料；题目附评分标准和参考答案，进入草稿供你检查后发布。")}</p>
        {/* What writing the paper is expected to use (WP27); a pasted case is priced from its own text. */}
        <TokenEstimate call={call} enabled={ready} request={mode === "import"
          ? { feature: "case", course, language: form.language, sourceIds, scenario: pasted.scenario,
            questions: pasted.questions.map((question) => ({ prompt: question.prompt.trim(), marks: Number(question.marks) })) }
          : { feature: "case", course, language: form.language, sourceIds, referenceSourceIds, referenceLimits, referenceFormat, questions: Number(form.questions), totalMarks: Number(form.totalMarks),
            ...(passage ? { focus: passage } : {}), ...(mode === "style" ? { styleText: form.styleText } : {}) }} />
        {model.ready ? (
          <Button type="submit" variant="primary" icon="sparkle" busy={busy} disabled={!ready} data-tour="generate-submit" data-usage="generate.submit">
            {mode === "import" ? answered ? ui("导入并批改 →") : ui("导入案例 →") : ui("出一套案例题 →")}
          </Button>
        ) : (
          <ModelSetupGate variant="block" feature="case" model={model} onOpenSettings={openSettings} />
        )}
      </div>
    </form>
  );
}
