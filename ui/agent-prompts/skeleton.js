import { getUiLanguage } from '../i18n.js';
import { fenceData, say } from './say.js';
import { installCommand } from '../archify.js';

/* The knowledge-skeleton page's hand-offs to the conversation (ui-consistency #124): make a skeleton of picked topics, or extend a
   saved one. The tool names (study_workspace skeleton.context / skeleton.get / skeleton.save / skeleton.patch, card.search,
   source.search, capture, card.link, card.update) and payload shapes live here and nowhere else. Every sentence is one catalogue
   key (ui/locales/en.skeleton.json …), so the English is the text the page always sent. The topic names are read from the library:
   they are data and sit in a fence. */

const EXTEND_ASK = {
  contrast: ['把概念「{0}」和「{1}」做对比，讲清它们的关键差异和容易混淆的地方。', null],
  enrich: ['补充或修正概念「{0}」{1}', '：含义、关键特征和它与其他概念的关系是否准确、完整。'],
  cards: ['为概念「{0}」补能真正练到它的题{1}', '（理解、辨析或场景应用，不要只背名词）。'],
};

/** What the learner asked of one concept: a comparison, a correction, new questions, or their own words. */
function wanted({ intent, term, text }, language) {
  const entry = intent && EXTEND_ASK[intent];
  if (!entry) return text;
  const [template, fallback] = entry;
  if (intent === 'contrast') return say(language, template, [term, text]);
  return say(language, template, [term, text ? `: ${text}` : say(language, fallback)]);
}

/** Extend one saved skeleton incrementally (new concepts, relations, cards). input: { skeleton ({ id, title }), nodeId, term, intent, text }. */
export function extendSkeletonPrompt({ skeleton, nodeId, term, intent, text }, language = getUiLanguage()) {
  const want = wanted({ intent, term, text }, language);
  const origin = nodeId ? say(language, '，从节点 {0}「{1}」出发', [nodeId, term]) : '';
  return say(language, '请扩展知识骨架「{0}」（id: {1}）{2}：\n{3}\n\n', [skeleton.title, skeleton.id, origin, want])
    + say(language, '做法：\n')
    + say(language, '1. 用 study_workspace 的 skeleton.get（payload 为 {"id": "') + skeleton.id + say(language, '"}）读当前骨架；需要的概念已经在骨架里就复用它的节点。\n')
    + say(language, '2. 不在骨架里的概念：先用 card.search 查题库有没有相关题，用 source.search 查资料依据；再用 skeleton.patch 的 node.add 加节点（meaning 依据资料，资料里没有的明确写是补充知识），挂到合适的上位概念（parent），用 attributes 写 2–5 条关键特征，让差异在类图里一眼可见。\n')
    + say(language, '3. 用 relation.add 加关系（对比用 contrasts，note 写一句最关键的差异；因果用 causes，前置用 prerequisite）。有动态过程的差异可以用 sequence.add 补一条时序。\n')
    + say(language, '4. 题库里没有能练到这个概念或这层关系的题时补题：用 capture 加题（对比、辨析优先 kind: "quiz"，deckId 用骨架里相关题所在的题组），再用 skeleton.patch 的 node.cards 把新题挂到对应节点；有前置关系的题用 card.link 关联。\n')
    + say(language, '5. 骨架的所有修改都用 skeleton.patch 增量提交（ops 可以一次提交多步，note 写一句这次改了什么），不要整份重写；面板会实时刷新并高亮变化。最后用几句话告诉我加了什么、补了哪些题。');
}

/**
 * Design (or update) a skeleton for the picked topics. input: { scope (the picked { deckId, topic } pairs), lint (the quality check
 * result or null), topics (the topic names), update (the saved skeleton to update, or null) }.
 */
export function designSkeletonPrompt({ scope, lint = null, topics = [], update = null }, language = getUiLanguage()) {
  const counts = lint
    ? Object.entries(lint.counts).filter(([, n]) => n).map(([code, n]) => say(language, '{0} {1} 题', [lint.labels[code], n])).join('；') || say(language, '没有发现散装问题')
    : say(language, '（还没做质量检测，skeleton.context 会带上每道题的检测结果）');
  const names = `\n${fenceData('主题', topics.join('、'), language)}`;
  return (update ? say(language, '请更新知识骨架「{0}」（id: {1}），', [update.title, update.id]) : say(language, '请为下面这组题做一份「知识骨架」，'))
    + say(language, '把散装的名词串成结构，并修掉只能死记的题：\n')
    + say(language, '主题：{0}\n', [names])
    + say(language, '范围 scope：{0}\n', [JSON.stringify(scope)])
    + say(language, '质量检测：{0}\n\n', [counts])
    + say(language, '步骤：\n')
    + say(language, '1. 用 study_workspace 的 skeleton.context（payload 为 {"scope": 上面的 scope}）读题目、每题的检测结果和引用原文片段；需要更多依据时用 source.search，不要逐份翻资料。\n')
    + say(language, '2. 设计一份骨架，会画成可交互的 UML 类图 + 时序图，并配文字阐述：\n')
    + say(language, '   · 类图（nodes + relations）：每个名词是一个类，写一句含义 meaning 和 2–5 条关键特征 attributes；「是一种」用 parent（泛化），「是…的组成部分」用 part-of，「导致」用 causes，「学它之前要懂」用 prerequisite，「是…的例子」用 example-of，容易混的用 contrasts。不同题组里的同一个名词合并成一个节点，节点挂上对应题目的 {deckId, cardId}。classNote 用文字讲清这张结构图怎么读。\n')
    + say(language, '   · 时序图（sequences，最多 4 条）：把动态过程画出来，比如故障如何一步步传导、请求如何流转、机制如何生效。participants 是参与者（能对应节点就填 node），steps 按时间顺序写 from→to 的 message，kind 取 call / return / async；每条写 explanation 讲清因果。纯静态的概念可以不画时序图。\n')
    + say(language, '   · 学习脉络：nodes 的顺序就是学习顺序。没有 parent 的顶层概念按先学后学排列，会画成一条从左到右的主线；每个顶层概念下用 parent 挂 3–6 个要点，要点下可以再挂细节。题多时（例如一个题组 90 题）先抓 6–12 个顶层概念，不要把所有名词平铺在顶层。\n')
    + say(language, '   · overview 写一段总览和一条好记的主线，把两张图串起来。\n')
    + say(language, '3. 用 skeleton.save 保存（payload 为 {"skeleton": {{0}title, scope, overview, classNote, nodes, relations, sequences}}）。\n', [update ? `"id": "${update.id}", ` : ''])
    + say(language, '4. 按检测结果修题：只重复选项文字的解析改成「是什么 + 和谁有关、为什么对/错」；考课件页码或列表归属的题干改成考含义或关系；用 card.update 保存并写清 reason。有因果或前置关系的题用 card.link 关联。不要改动原文不支持的答案。\n')
    + say(language, '5. 最后用几句话告诉我骨架的主线，以及改了哪些题。');
}

/**
 * Draw a saved skeleton with the open-source Archify skill (docs/companions.md). input: { skeleton ({ id, title }) }. The agent reads the
 * skeleton, draws one self-contained HTML file in the workspace, and registers it with skeleton.diagram.attach; without the skill it says
 * so and gives the install command instead of drawing something of its own. The skeleton's name is library data and sits in a fence.
 */
export function archifySkeletonPrompt({ skeleton }, language = getUiLanguage()) {
  const id = skeleton.id;
  return say(language, '请用 archify 技能，把知识骨架（id: {0}）画成一张可交互的 HTML 图。', [id]) + '\n'
    + `${fenceData('骨架名称', skeleton.title, language)}\n`
    + say(language, '做法：\n')
    + say(language, '1. 用 study_workspace 的 skeleton.get（payload 为 {"id": "{0}"}）读骨架：概念是 nodes，前置、对比、因果等关系是 relations，时序是 sequences，每个节点挂着的题在 cards 里。骨架数据里没有掌握度；要标覆盖情况就用每个节点挂的题数，不要编造掌握度。', [id]) + '\n'
    + say(language, '2. 用 archify 技能画图，让它挑最合适的图类型：概念画成节点，前置（prerequisite）画成带方向的箭头，对比（contrasts）和因果（causes）等画成带文字标注的关系。整张图写成一个自包含的 HTML 文件，保存到当前工作目录的 diagrams/ 下，文件名用骨架名。') + '\n'
    + say(language, '3. 如果当前没有 archify 技能：直接告诉我「没有 archify 技能」，并把下面这条安装命令给我（命令里的 web 要换成我正在用的 profile，桌面版通常是 desktop）。不要自己画别的图来代替。\n{0}', [installCommand()]) + '\n'
    + say(language, '4. 画好后用 skeleton.diagram.attach 登记（payload 为 {"id": "{0}", "path": "diagrams/文件名.html", "title": "图的标题"}）。StudyHub 只保存这个文件，并在隔离窗口里显示，不会运行它。最后用一两句话告诉我图画了什么、存在哪里。', [id]);
}
