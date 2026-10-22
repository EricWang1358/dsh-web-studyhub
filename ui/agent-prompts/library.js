import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';
import { composeMessage, listText } from './message.js';

/* The short hand-offs the library home and the results page send to the conversation (ui-consistency #124): ask about a deck or a topic, hand over a
   workspace file, go through the weak topics of a round. Each returns the parts of one message (ui/agent-prompts/message.js): the learner's sentence with
   the deck, topic and round names in name spans (nameData: library data, not instructions), and a short note of how. The tool names live here and nowhere
   else. The English of each sentence is in ui/locales/en.agent.json. */

const GROUNDED = '做法：讲解以学习库资料为准，需要依据时用 source.search。';

/** "Which topics of this deck are weakest, and in what order should I study?" input: { deckTitle }. */
export function deckAnalysisPrompt({ deckTitle }, language = getUiLanguage()) {
  return {
    ask: say(language, '帮我看看题组 {0}：哪些主题最薄弱，接下来按什么顺序学？', [nameData(deckTitle)]),
    notes: [say(language, '做法：用 study_workspace 的 map 看这个题组的掌握情况；先说结论，再给学习顺序。')],
  };
}

/** "Explain this topic, then check me with a question or two." input: { topic, deckTitle, mastery (percent), weak (count of weak questions) }. */
export function topicExplainPrompt({ topic, deckTitle, mastery, weak = 0 }, language = getUiLanguage()) {
  return {
    ask: say(language, '给我讲讲题组 {1} 里的 {0}：先讲核心概念，再出一两道小题考考我。', [nameData(topic), nameData(deckTitle)]),
    notes: [say(language, '进度：掌握度 {0}%{1}。', [mastery, weak ? say(language, ' · {0} 道题当前薄弱', [weak]) : '']), say(language, GROUNDED)],
  };
}

/** "Add a file of my workspace as a material and make 10 questions from it": not a registry entry (the empty home's link sends it); it ends with the @. */
export function workspaceFilePrompt(language = getUiLanguage()) {
  return composeMessage({
    ask: say(language, '帮我把工作区里的一个文件加为学习资料，再出 10 道题。'),
    notes: [say(language, '做法：用 study_workspace 把这个文件添加为学习资料，再生成 10 道题。')],
    tail: 'file',
  }, { language });
}

/** "These topics are still shaky after the round: explain each and check me." input: { title (the round's name), topics }. Up to four names stay in the sentence. */
export function weakTopicsPrompt({ title, topics = [] }, language = getUiLanguage()) {
  const inline = topics.length <= 4;
  return {
    ask: inline
      ? say(language, '我刚做完 {0}，{1} 还没掌握稳。帮我逐个讲清楚，每个出一道小题考考我。', [nameData(title), listText(language, topics.map(nameData))])
      : say(language, '我刚做完 {0}，下面这 {1} 个主题还没掌握稳。帮我逐个讲清楚，每个出一道小题考考我。', [nameData(title), topics.length]),
    notes: [say(language, GROUNDED)],
    data: inline ? [] : [['主题列表', topics.join('\n')]],
  };
}
