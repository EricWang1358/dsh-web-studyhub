export const COMPANION_JOB_TITLE = '生成交互伴学课';

export const REFUSALS = Object.freeze({
  'companion-course-required': lang => (lang === 'en'
    ? 'Choose or name a course first so the interactive companion has a home.'
    : '请先选择或指定一门课程，以便挂载生成的交互伴学课。'),
  'companion-topic-or-source-required': lang => (lang === 'en'
    ? 'Provide a topic/question prompt or select at least one material to build an interactive companion from.'
    : '请输入伴学主题/困惑描述，或至少勾选一份参考资料。'),
  'companion-source-missing': lang => (lang === 'en'
    ? 'One or more selected materials are no longer in the library; refresh and choose again.'
    : '所选资料中存在已移除条目，请刷新后重选。'),
  'capability-unverified': lang => (lang === 'en'
    ? 'Shared provider quota is not supported for this background build yet.'
    : '当前共享配额通道暂不支持该后台构建任务。'),
  'companion-blueprint-failed': lang => (lang === 'en'
    ? 'The model could not produce a valid interactive lesson blueprint after retrying.'
    : '模型重试后仍未能生成有效的交互伴学分镜蓝图。'),
  'companion-author-failed': lang => (lang === 'en'
    ? 'The model could not complete the interactive lesson slides after retrying.'
    : '模型重试后仍未能完成交互伴学分页内容。'),
  'companion-validation-failed': lang => (lang === 'en'
    ? 'Generated lesson failed structural and pedagogical verification even after repair.'
    : '生成的交互伴学课经自动修复后仍未通过教学结构与公式校验。'),
});

export function stageText(language, stage) {
  const en = language === 'en';
  switch (stage) {
    case 'queued': return en ? 'Waiting in queue' : '排队等待中';
    case 'blueprint': return en ? 'Designing 8-beat pedagogical arc & counterexamples' : '正在设计教学戏剧弧与反例分镜';
    case 'act1': return en ? 'Authoring Act I (warm-up, intuition scene, prediction & flaw-spotting)' : '正在精写上半场（热身、场景、盲猜下注与找茬）';
    case 'act2': return en ? 'Authoring Act II (interactive lab, decision tree, checks & takeaways)' : '正在精写下半场（交互推演、决策树、小测与带走卡）';
    case 'verify': return en ? 'Evaluating formulas & verifying 18 pedagogical invariants' : '正在计算真实公式曲线并执行 18 项结构校验';
    case 'repair': return en ? 'Repairing structural & formula issues' : '正在定向修复结构或公式问题';
    case 'saving': return en ? 'Compiling self-contained HTML & linking to course' : '正在编译独立 HTML 并挂载至课程';
    case 'complete': return en ? 'Interactive companion ready' : '交互伴学课已就绪';
    case 'paused': return en ? 'Paused at checkpoint' : '已在检查点暂停';
    case 'cancelled': return en ? 'Stopped' : '已停止';
    default: return en ? 'Building interactive companion' : '正在生成交互伴学课';
  }
}
