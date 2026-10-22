import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';
import { partsOf } from './message.js';
import { installCommand } from '../archify.js';

/* The knowledge-skeleton page's hand-offs to the conversation (ui-consistency #124): make a skeleton of picked topics, extend a saved one, or draw it with
   Archify. Each returns the parts of one message (ui/agent-prompts/message.js). The tool names (study_workspace skeleton.context / skeleton.get /
   skeleton.save / skeleton.patch / skeleton.diagram.attach, card.search, source.search, capture, card.link, card.update) and payload shapes live here and
   nowhere else. Every sentence is one catalogue key (ui/locales/en.agent.json). The skeleton, concept and topic names are read from the library: they are
   name spans in the learner's sentence or sit in a data fence; the scope JSON the chat passes on as it is sits in a data fence too. */

/** What the learner asked of one concept: [the sentence when nothing was typed, the sentence their typed words follow]. */
const EXTEND_ASK = {
  enrich: ['帮我在知识骨架 {0} 里补充或修正 {1}：含义、关键特征、和其他概念的关系是否准确完整。', '帮我在知识骨架 {0} 里补充或修正 {1}：'],
  cards: ['帮我给知识骨架 {0} 里的 {1} 补几道能真正练到它的题（理解、辨析或场景应用，不要只背名词）。', '帮我给知识骨架 {0} 里的 {1} 补几道能真正练到它的题：'],
};
const CONTRAST = '帮我在知识骨架 {0} 里把 {1} 和 {2} 对比清楚：关键差异和容易混的地方。';
const EXTEND_FREE = '帮我按下面的要求扩展知识骨架 {0}：';
const EXTEND_NOTES = [
  '新概念：先用 card.search 查题库、source.search 查资料依据；再用 skeleton.patch 的 node.add 加节点（meaning 依据资料，资料里没有的写明是补充知识），挂到合适的上位概念（parent），attributes 写 2–5 条关键特征，让差异在类图里一眼可见。',
  '关系：用 relation.add 加关系（对比用 contrasts，note 写一句最关键的差异；因果用 causes；前置用 prerequisite）；有动态过程的差异可以用 sequence.add 补一条时序。',
  '补题：题库里没有能练到这个概念或这层关系的题时，用 capture 加题（对比、辨析优先 kind: "quiz"，deckId 用骨架里相关题所在的题组），再用 skeleton.patch 的 node.cards 挂到对应节点；有前置关系的题用 card.link 关联。',
  '提交：所有修改都用 skeleton.patch 增量提交（ops 可以一次提交多步，note 写一句这次改了什么），不要整份重写；面板会实时刷新并高亮变化。',
  '做完：用几句话告诉我加了什么、补了哪些题。',
];

/** Extend one saved skeleton incrementally (new concepts, relations, cards). input: { skeleton ({ id, title }), nodeId, term, intent, text }. */
export function extendSkeletonPrompt({ skeleton, nodeId, term, intent, text }, language = getUiLanguage()) {
  const outline = nameData(skeleton.title), typed = String(text ?? '').trim();
  let ask, request = '';
  if (intent === 'contrast') ask = say(language, CONTRAST, [outline, nameData(term), nameData(text)]);
  else if (EXTEND_ASK[intent]) { ask = say(language, EXTEND_ASK[intent][typed ? 1 : 0], [outline, nameData(term)]); request = typed; }
  else { ask = say(language, EXTEND_FREE, [outline]); request = typed; }
  return {
    ask, request,
    first: say(language, '用 study_workspace 的 skeleton.get {0} 读当前骨架；需要的概念已经在骨架里就复用它的节点', [JSON.stringify({ id: skeleton.id })]),
    notes: [
      say(language, '位置：骨架 id {0}{1}。', [skeleton.id, nodeId ? say(language, ' · 从节点 {0} 出发', [nodeId]) : '']),
      ...EXTEND_NOTES.map(line => say(language, line)),
    ],
  };
}

const DESIGN_NOTES = [
  '图：会画成可交互的 UML 类图 + 时序图，并配文字阐述。',
  '类图（nodes + relations）：每个名词一个类，写一句 meaning 和 2–5 条 attributes；「是一种」用 parent，「是…的组成部分」用 part-of，「导致」用 causes，「学它之前要懂」用 prerequisite，「是…的例子」用 example-of，容易混的用 contrasts；不同题组里的同一个名词合并成一个节点，挂上对应题目的 {deckId, cardId}；classNote 讲清这张图怎么读。',
  '时序图（sequences，最多 4 条）：画动态过程（故障如何一步步传导、请求如何流转、机制如何生效）；participants 能对应节点就填 node，steps 按时间顺序写 from→to 的 message，kind 取 call / return / async，每条写 explanation 讲清因果；纯静态的概念可以不画。',
  '学习主线：nodes 的顺序就是学习顺序；没有 parent 的顶层概念按先学后学排成一条从左到右的主线，每个下面用 parent 挂 3–6 个要点，要点下可以再挂细节；题多时（例如一个题组 90 题）先抓 6–12 个顶层概念，不要把所有名词平铺在顶层。overview 写一段总览和一条好记的主线，把两张图串起来。',
];
const DESIGN_FIX = '修题：只重复选项文字的解析改成「是什么 + 和谁有关、为什么对/错」；考课件页码或列表归属的题干改成考含义或关系；用 card.update 保存并写清 reason；有因果或前置关系的题用 card.link 关联；原文不支持的答案不要改。';
const DESIGN_DONE = '做完：用几句话告诉我骨架的主线，以及改了哪些题。';

/**
 * Design (or update) a skeleton for the picked topics. input: { scope (the picked { deckId, topic } pairs), lint (the quality check result or null),
 * topics (the topic names), update (the saved skeleton to update, or null) }.
 */
export function designSkeletonPrompt({ scope, lint = null, topics = [], update = null }, language = getUiLanguage()) {
  const counts = lint
    ? partsOf(language, Object.entries(lint.counts).filter(([, n]) => n).map(([code, n]) => say(language, '{0} {1} 题', [lint.labels[code], n]))) || say(language, '没有发现散装问题')
    : say(language, '还没做，skeleton.context 会带上每道题的检测结果');
  return {
    ask: update
      ? say(language, '帮我更新知识骨架 {0}：把零散的名词串成结构，顺手修掉只能死记的题。', [nameData(update.title)])
      : say(language, '帮我把这 {0} 个主题做成一份知识骨架：把零散的名词串成结构，顺手修掉只能死记的题。', [topics.length]),
    first: say(language, '用 study_workspace 的 skeleton.context {"scope": 下面 data scope 里的 JSON} 读题目、每题的检测结果和引用原文；需要更多依据时用 source.search，不要逐份翻资料'),
    notes: [
      say(language, '质量检测：{0}。', [counts]),
      ...DESIGN_NOTES.map(line => say(language, line)),
      say(language, '保存：用 skeleton.save {"skeleton": {{0}title, scope, overview, classNote, nodes, relations, sequences}}。', [update ? `"id": ${JSON.stringify(update.id)}, ` : '']),
      say(language, DESIGN_FIX),
      say(language, DESIGN_DONE),
    ],
    data: [['主题列表', topics.join('\n')], ['scope', JSON.stringify(scope)]],
  };
}

/**
 * Draw a saved skeleton with the open-source Archify skill (docs/companions.md). input: { skeleton ({ id, title }) }. The agent reads the skeleton, draws
 * one self-contained HTML file in the workspace, and registers it with skeleton.diagram.attach; without the skill it says so and gives the install command
 * instead of drawing something of its own. The skeleton's name is a name span in the learner's sentence.
 */
export function archifySkeletonPrompt({ skeleton }, language = getUiLanguage()) {
  const id = skeleton.id;
  return {
    ask: say(language, '帮我用 Archify 把知识骨架 {0} 画成一张可交互的图。', [nameData(skeleton.title)]),
    notes: [
      say(language, '先确认：有没有 archify 技能。没有就直接告诉我「没有 archify 技能」，并给我这条安装命令（命令里的 web 换成我在用的 profile，桌面版通常是 desktop），不要自己画别的图代替：`{0}`。', [installCommand()]),
      say(language, '骨架：用 study_workspace 的 skeleton.get {0} 读骨架：nodes 是概念，relations 是前置、对比、因果等关系，sequences 是时序，cards 是每个节点挂的题。骨架里没有掌握度；要标覆盖情况就用每个节点挂的题数，不要编造掌握度。', [JSON.stringify({ id })]),
      say(language, '画：让 archify 挑最合适的图类型；前置（prerequisite）画成带方向的箭头，对比（contrasts）、因果（causes）等画成带文字标注的关系；整张图写成一个自包含的 HTML 文件，存到当前工作目录的 diagrams/ 下，文件名用骨架名。'),
      say(language, '登记：用 skeleton.diagram.attach {"id": "{0}", "path": "diagrams/文件名.html", "title": "图的标题"}；StudyHub 只保存这个文件，在隔离窗口里显示，不会运行它。', [id]),
      say(language, '做完：用一两句话告诉我图画了什么、存在哪里。'),
    ],
  };
}
