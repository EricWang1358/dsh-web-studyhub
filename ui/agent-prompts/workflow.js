import { getUiLanguage } from '../i18n.js';
import { fenceData, say } from './say.js';

/* The prompts of the learning-flow pages (Workflows.jsx, WorkflowPortal.jsx) that hand work to the conversation (ui-consistency #124).
   They are the contract with the agent: study_workspace workflow.context / workflow.save / workflow.session.material and
   skeleton.context / skeleton.save, and their payload shapes, live here and nowhere else. Every sentence is one catalogue key
   (ui/locales), so the English is the same text the pages always sent. Topic names read from the library are data and sit in a fence. */

const DESIGN_HEAD = '请帮我{0}。{1}\n';
const DESIGN_TAIL = '先用 study_workspace 的 workflow.context 读取组件规范、已有学习流和主题。最多保存五条，保持闪卡、知识骨架等独立功能可用。\n';
const DESIGN_EXISTING = '目标流程 id: {0}，我当前看到的 version: {1}。先重新读取最新版本；若已有新的修改，先向我说明差异，避免覆盖。\n';
const DESIGN_NEW = '默认模板只是参考；在明确我的需求后创建。\n';
const DESIGN_SAVE = '用 workflow.save 保存完整流程，更新已有流程需带最新 id/version。流程可包含目标、骨架、讲解、复述、练习、总结，设置有意义的 next/retry 分支。不要代替我作答或评定掌握。不要修改已经开始的学习副本。保存后说明调整了哪些步骤。';

/** Design or adjust a learning flow with the conversation. input: { template (the flow being adjusted, or null), wish }. */
export function workflowDesignPrompt({ template = null, wish = '' }, language = getUiLanguage()) {
  return say(language, DESIGN_HEAD, [
    template ? say(language, '调整学习流「{0}」', [template.title]) : say(language, '设计一条个性化学习流'),
    wish ? say(language, '我的要求：{0}', [wish]) : say(language, '先了解我想怎样学习，再组合合适的组件。'),
  ]) + say(language, DESIGN_TAIL)
    + (template ? say(language, DESIGN_EXISTING, [template.id, template.version]) : say(language, DESIGN_NEW))
    + say(language, DESIGN_SAVE);
}

const SKELETON_HEAD = '请为我即将开始的学习生成一份知识骨架。\n学习主题：';
const SKELETON_FLOW = '\n学习流：';
const SKELETON_SCOPE = '\n已选题目范围 scope：';
const SKELETON_CONTEXT = '使用给定 scope，先调用 study_workspace 的 skeleton.context 获取题目与引用证据，需要更多依据时用 source.search。\n';
const SKELETON_SHAPE = '依据资料组织概念、关键特征、层级与关系；同一概念合并，线性过程与分支讲清楚，不相关的连通分量保持分开。补充知识要明确标注。\n';
const SKELETON_SAVE = '调用 skeleton.save 保存一份新骨架，payload 为 {skeleton:{title,scope,overview,classNote,nodes:[{id,term,meaning,attributes,parent?,cards:[{deckId,cardId}]}],relations:[{from,to,type,note?}],sequences:[]}}。type 使用 part-of/causes/contrasts/prerequisite/example-of/related；动态过程需要时补充 sequences。\n';
const SKELETON_ONLY = '仅生成骨架，不修改题目、学习流或已有骨架，不代替我进入学习。保存后告诉我骨架名称，我会在当前页面关联它。';

/**
 * Ask for a knowledge skeleton of the scope the learner picked before starting a flow.
 * input: { topic (what the learner typed), topicNames (the library topics picked, used when nothing was typed), workflowTitle, scope }.
 */
export function workflowSkeletonPrompt({ topic = '', topicNames = [], workflowTitle = '', scope = [] }, language = getUiLanguage()) {
  const typed = String(topic).trim();
  const fenced = !typed && topicNames.length ? `\n${fenceData('主题', topicNames.join('、'), language)}` : '';
  return say(language, SKELETON_HEAD) + typed + fenced
    + say(language, SKELETON_FLOW) + workflowTitle
    + say(language, SKELETON_SCOPE) + JSON.stringify(scope) + '\n'
    + say(language, SKELETON_CONTEXT) + say(language, SKELETON_SHAPE) + say(language, SKELETON_SAVE) + say(language, SKELETON_ONLY);
}

/** What each kind of step asks the conversation for: the button label and the request (a goal step wants goal options, not an audit). */
export const WORKFLOW_HANDOFF = Object.freeze({
  overview: { label: '请主对话帮我把目标说具体', ask: '请帮我把这次的学习目标说具体：结合本次范围，给我 2–3 个可选的目标句（学完后我能说清或做到什么），每句配一个适合当主攻的例子，由我挑选或改写。不要替我写进回答，也不要做覆盖检查或列清单。' },
  skeleton: { label: '请主对话帮我理清概念关系', ask: '请帮我理清本次范围里概念之间的关系：一条先学后学的主线、谁属于谁、因果和容易混淆的对比，写成能顺着读的结构说明。' },
  lesson: { label: '请主对话帮我讲清楚', ask: '请提供清楚、连贯的讲解和一个可以推演的例子。' },
  recall: { label: '请主对话通过追问帮我补全', ask: '请检查我的复述是否漏了关键条件，用追问引导我自己补全。' },
  practice: { label: '请主对话帮我弄懂做错的题', ask: '请帮我弄懂本步练习里做错或拿不准的题：为什么是这个答案，容易错在哪里。' },
  reflection: { label: '请主对话帮我回顾', ask: '请根据本次学习记录帮我回顾：哪些已经讲清、哪些还需要补、下次先做什么。由我决定写进回顾的内容。' },
});

const STEP_HEAD = '请帮助我学习「{0}」的「{1}」这一步。{2}\n';
const STEP_CONTEXT = '先用 study_workspace 的 workflow.context，payload 为 {0}，读取本次学习、当前步骤、这一步已有的材料、我的笔记和可用资料。当前看到的 version 是 {1}，保存前以重新读取的最新版本为准。\n';
const STEP_MATERIAL = '必要时用 source.search 查证，区分已有资料与补充知识。用 workflow.session.material 保存到这一步：默认 mode 为 append，追加在已有材料之后，不要重复已有内容；要改已有段落用 mode "edit" 和 edits:[{find,replace}]（find 是原文中唯一的一段）；除非我明确要求重写，不要用 replace。最近 10 版会保留。不能写我的回答、代我完成步骤或评定我是否掌握。称呼步骤用标题，不要用 step-2 这类内部 ID。\n';
const STEP_RECALL = '当前是主动复述：先以问题指出缺口，不要直接给出完整参考答案。补充内容会由我主动展开。';
const STEP_OTHER = '内容请连起概念、例子和条件，避免只罗列名词。缺少依据时明确说明。';

/** Ask the conversation for help with the current step of a running session. input: { session ({ id, version, topic }), step ({ title, kind }), wish }. */
export function workflowStepPrompt({ session, step, wish = '' }, language = getUiLanguage()) {
  const handoff = WORKFLOW_HANDOFF[step.kind] || WORKFLOW_HANDOFF.lesson;
  return say(language, STEP_HEAD, [session.topic, step.title, wish ? say(language, '我的要求：{0}', [wish]) : say(language, handoff.ask)])
    + say(language, STEP_CONTEXT, [JSON.stringify({ sessionId: session.id }), session.version])
    + say(language, STEP_MATERIAL)
    + say(language, step.kind === 'recall' ? STEP_RECALL : STEP_OTHER);
}
