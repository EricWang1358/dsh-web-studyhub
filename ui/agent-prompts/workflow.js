import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';
import { listText } from './message.js';

/* The messages of the learning-flow pages (Workflows.jsx, WorkflowPortal.jsx) that hand work to the conversation (ui-consistency #124). Each returns the
   parts of one message (ui/agent-prompts/message.js). They are the contract with the agent: study_workspace workflow.context / workflow.save /
   workflow.session.material and skeleton.context / skeleton.save, and their payload shapes, live here and nowhere else. Every sentence is one catalogue
   key (ui/locales/en.agent.json). Flow, step and topic names read from the library are name spans or sit in a data fence; the learner's own words sit in
   a request fence. */

const DESIGN_ASK = {
  adjust: ['帮我调整学习流 {0}，先问问我想改哪里。', '帮我调整学习流 {0}：'],
  create: ['帮我设计一条适合我的学习流，先问问我想怎么学。', '帮我设计一条学习流：'],
};
const DESIGN_SAVE = '保存：用 workflow.save 保存完整流程，更新已有流程时带最新的 id/version，最多保存五条；流程可以有目标、骨架、讲解、复述、练习、总结，设有意义的 next/retry 分支。';
const DESIGN_NEVER = '不要：代替我作答或评定掌握；修改已经开始的学习副本；让闪卡、知识骨架等独立功能不能用。';

/** Design or adjust a learning flow with the conversation. input: { template (the flow being adjusted, or null), wish (the learner's words) }. */
export function workflowDesignPrompt({ template = null, wish = '' }, language = getUiLanguage()) {
  const typed = String(wish ?? '').trim();
  return {
    ask: template ? say(language, DESIGN_ASK.adjust[typed ? 1 : 0], [nameData(template.title)]) : say(language, DESIGN_ASK.create[typed ? 1 : 0]),
    request: typed,
    first: say(language, '用 study_workspace 的 workflow.context 读组件规范、已有学习流和主题'),
    notes: [
      template ? say(language, '目标：流程 id {0}，我看到的是 version {1}；先重新读取最新版本，若已有新的修改，先跟我说明差异，避免覆盖。', [template.id, template.version])
        : say(language, '新建：默认模板只是参考；弄清我的需求后再创建。'),
      say(language, DESIGN_SAVE),
      say(language, DESIGN_NEVER),
      template ? say(language, '做完：说明调整了哪些步骤。') : say(language, '做完：说明这条学习流的步骤。'),
    ],
  };
}

/**
 * Ask for a knowledge skeleton of the scope the learner picked before starting a flow.
 * input: { topic (what the learner typed), topicNames (the library topics picked, used when nothing was typed), workflowTitle, scope }.
 * What the learner typed and up to four picked names stay in the sentence (name spans); more names sit in a data fence, the scope in another.
 */
export function workflowSkeletonPrompt({ topic = '', topicNames = [], workflowTitle = '', scope = [] }, language = getUiLanguage()) {
  const typed = String(topic ?? '').trim();
  const inline = typed ? nameData(typed) : topicNames.length && topicNames.length <= 4 ? listText(language, topicNames.map(nameData)) : '';
  const flow = nameData(workflowTitle);
  return {
    ask: inline ? say(language, '我马上要按学习流 {0} 开始学 {1}，先帮我生成一份知识骨架。', [flow, inline])
      : say(language, '我马上要按学习流 {0} 开始学已选的题目，先帮我生成一份知识骨架。', [flow]),
    first: say(language, '用 study_workspace 的 skeleton.context {"scope": 下面 data scope 里的 JSON} 读题目与引用证据；需要更多依据时用 source.search'),
    notes: [
      say(language, '组织：依据资料组织概念、关键特征、层级与关系；同一概念合并，线性过程与分支讲清楚，不相关的连通分量保持分开；补充知识要明确标注。'),
      say(language, '保存：用 skeleton.save 保存一份新骨架，payload 为 {skeleton:{title,scope,overview,classNote,nodes:[{id,term,meaning,attributes,parent?,cards:[{deckId,cardId}]}],relations:[{from,to,type,note?}],sequences:[]}}；type 用 part-of/causes/contrasts/prerequisite/example-of/related；动态过程需要时补充 sequences。'),
      say(language, '不要：修改题目、学习流或已有骨架，或代替我进入学习。'),
      say(language, '做完：告诉我骨架名称，我会在当前页面关联它。'),
    ],
    data: [...(!typed && topicNames.length > 4 ? [['主题列表', topicNames.join('\n')]] : []), ['scope', JSON.stringify(scope)]],
  };
}

/** What each kind of step asks the conversation for: the label of its fold, and the learner's request (a goal step wants goal options, not an audit). */
export const WORKFLOW_HANDOFF = Object.freeze({
  overview: { label: '请主会话帮我把目标说具体', ask: '帮我把这次的学习目标说具体：给我 2–3 个可选的目标句（学完后我能说清或做到什么），每句配一个适合当主攻的例子，由我挑选或改写。' },
  skeleton: { label: '请主会话帮我理清概念关系', ask: '帮我理清这次范围里概念之间的关系：一条先学后学的主线、谁属于谁、因果和容易混淆的对比，写成能顺着读的结构说明。' },
  lesson: { label: '请主会话帮我讲清楚', ask: '帮我讲清楚，再给一个可以一步步推演的例子。' },
  recall: { label: '请主会话通过追问帮我补全', ask: '帮我看看我的复述漏了哪些关键条件，用追问引导我自己补全。' },
  practice: { label: '请主会话帮我弄懂做错的题', ask: '帮我弄懂这一步练习里做错或拿不准的题：为什么是这个答案，容易错在哪里。' },
  reflection: { label: '请主会话帮我回顾', ask: '帮我回顾这次学习：哪些已经讲清、哪些还需要补、下次先做什么；写进回顾的内容由我决定。' },
});

/** Ask the conversation for help with the current step of a running session. input: { session ({ id, version, topic }), step ({ title, kind }), wish }. */
export function workflowStepPrompt({ session, step, wish = '' }, language = getUiLanguage()) {
  const handoff = WORKFLOW_HANDOFF[step.kind] || WORKFLOW_HANDOFF.lesson, typed = String(wish ?? '').trim();
  const where = [nameData(session.topic), nameData(step.title)];
  return {
    ask: typed ? say(language, '我在学 {0} 的 {1} 这一步：', where) : say(language, '我在学 {0} 的 {1} 这一步，{2}', [...where, say(language, handoff.ask)]),
    request: typed,
    first: say(language, '用 study_workspace 的 workflow.context {0} 读本次学习、当前步骤、这一步已有的材料、我的笔记和可用资料；我看到的是 version {1}，保存前以重新读到的最新版本为准',
      [JSON.stringify({ sessionId: session.id }), session.version]),
    notes: [
      say(language, '写入：用 workflow.session.material 保存到这一步，默认 mode 为 append（接在已有材料之后，不重复已有内容）；要改已有段落用 mode "edit" 和 edits:[{find,replace}]（find 是原文中唯一的一段）；除非我明确要求重写，不用 replace；最近 10 版会保留。'),
      say(language, '依据：必要时用 source.search 查证，分清已有资料与补充知识；缺少依据时明确说明。'),
      step.kind === 'recall' ? say(language, '复述：先用问题指出缺口，不要直接给出完整参考答案；补充内容由我主动展开。')
        : say(language, '内容：连起概念、例子和条件，不要只罗列名词。'),
      say(language, '不要：写我的回答、代我完成步骤或评定我是否掌握{0}；称呼步骤用标题，不用 step-2 这类内部 ID。',
        [step.kind === 'overview' ? say(language, '；不替我写进回答，不做覆盖检查，不列清单') : '']),
    ],
  };
}
