import { nameData, say } from './agent-prompts/say.js';

/* The hand-off that asks the main chat to fold fine-grained topics into topic groups ('topics.group', ui/agent-prompts/index.js). Shared by the
   knowledge-skeleton page and the library's reminder. It returns the parts of one message (ui/agent-prompts/message.js); every sentence is one catalogue
   key (ui/locales/en.agent.json). Topics are read a page at a time: a whole large library in one result is spilled to a file that the chat would then
   try to parse with a shell. The course is a name span in the sentences; inside a payload it is a JSON string value, exactly as the call takes it. */

// Merge mode reads small pages (a weak model handles 60 topics reliably); replace mode reads the whole library, so its pages are larger.
const MERGE_PAGE = 60, REPLACE_PAGE = 200;
// The real shape of one skeleton.topics page (see lib/contexts/skeleton/operations.js); nextOffset is present only when more remain.
const shape = (limit) => `{"topics":[{"key":"…","topic":"…","count":3,"decks":["…"],"samples":["…"]}],"total":100,"nextOffset":${limit},"groups":{"groups":[{"id":"…","title":"…","description":"…","count":4}],"ungroupedCount":100}}`;
const GROUPS = ',"groups":[{"title":…,"description":…,"topics":[主题 key]}]}';

const ASK = {
  merge: ['帮我把学习库里还没归组的 {0} 个主题归进主题组。', '帮我把课程 {1} 里还没归组的 {0} 个主题归进主题组。'],
  replace: ['学习库的主题太碎了（{0} 个，很多只有 1–2 题），帮我按知识域归并成主题组。', '课程 {1} 的主题太碎了（{0} 个，很多只有 1–2 题），帮我按知识域归并成主题组。'],
};
const READ = {
  merge: '读：用 study_workspace 的 skeleton.topics {0}，一次 {1} 个还没归组的主题，返回的 groups.groups 是已有的主题组；每次返回都直接读，不要用命令行或脚本解析。',
  replace: '读：用 study_workspace 的 skeleton.topics {0} 分页读全部主题，按 nextOffset 读到没有为止；每条有 key、名称、题数、所在题组和一条示例题干；每次返回都直接读，不要用命令行或脚本解析。',
};
const SHAPE = '结果形状：{0}（字段名完全一致；nextOffset 只在还有剩余时出现；{1}）。';
const COUNTS = { merge: 'total 和 groups.ungroupedCount 都是还没归组的主题数', replace: 'total 是主题总数' };
const GROUP = {
  merge: '归：放得进已有组就沿用它的 title；放不进的新建组（title 是知识域名称，≤20 字；description 一句话说明范围）。',
  replace: '归：分成 12–30 个主题组；同一概念的不同叫法、中英文混写、被拆开的细主题（「XX 的定义」「XX 的计算」「XX 例题」「XX 与 YY 的区别」）放进同一组；按课程里的知识域划分，组名用我熟悉的说法（≤20 字），description 一句话说明范围；每个主题只进一个组，归不进的放「其他」组。',
};
const SAVE = {
  merge: '存：每读一批就用 topic.groups.save {0} 保存这一批；再用同样的 payload（offset 仍为 0）读下一批，直到 total 为 0。不要修改题目本身。',
  replace: '存：用 topic.groups.save {0} 保存。这只是题目之上的分组，不要修改题目本身。',
};
const DONE = { merge: '做完：告诉我各主题分别归到了哪里。', replace: '做完：列出分了哪些组、每组大概多少题。' };
const SCOPE = '范围：只动课程 {0} 的主题；其他课程的主题和主题组保持原样。';
const ALTERNATIVE = [
  '改做：如果我在最后说要把全部主题重新归并，就改做那个：用 skeleton.topics {0} 分页读全部主题（按 nextOffset 继续），重新归并成 12–30 个主题组，用 topic.groups.save {1} 保存。',
  '改做：如果我在最后说要把课程 {2} 的全部主题重新归并，就改做那个：用 skeleton.topics {0} 分页读这门课的全部主题（按 nextOffset 继续），重新归并成 12–30 个主题组，用 topic.groups.save {1} 保存；其他课程的主题和主题组保持原样。',
];

/** A topic.groups.save payload: the mode, the course when scoped, and the groups' shape in the message's language. */
const savePayload = (mode, scoped, course, language) => JSON.stringify({ mode, ...(scoped ? { course } : {}) }).replace(/\}$/, say(language, GROUPS));

/**
 * input: { mode ('merge' | 'replace'), topicCount, ungrouped, course (one course, '' for the unassigned ones; undefined, null or '*' for the whole library),
 * alternative (merge only: the page offered the quicker way, so the learner may ask for the full regroup at the end; the message then ends with 我想：) }.
 */
export function groupPrompt({ mode, topicCount, ungrouped, course, alternative = false }, language = 'zh') {
  const scoped = course !== undefined && course !== null && course !== '*';
  const merge = mode === 'merge', kind = merge ? 'merge' : 'replace';
  const only = scoped ? nameData(course || say(language, '未分类')) : '';
  const read = { compact: true, samples: 1, ...(scoped ? { course } : {}), ...(merge ? { ungrouped: true, limit: MERGE_PAGE } : { limit: REPLACE_PAGE, offset: 0 }) };
  const notes = [
    ...(scoped ? [say(language, SCOPE, [only])] : []),
    say(language, READ[kind], [JSON.stringify(read), MERGE_PAGE]),
    say(language, SHAPE, [shape(merge ? MERGE_PAGE : REPLACE_PAGE), say(language, COUNTS[kind])]),
    say(language, GROUP[kind]),
    say(language, SAVE[kind], [savePayload(kind, scoped, course, language)]),
  ];
  // Inside one course the other way is that course's own replace too: an unscoped replace starts from an empty list and would drop every other course's groups.
  const offered = alternative && merge;
  if (offered) notes.push(say(language, ALTERNATIVE[scoped ? 1 : 0], [JSON.stringify({ compact: true, samples: 1, ...(scoped ? { course } : {}), limit: REPLACE_PAGE, offset: 0 }),
    savePayload('replace', scoped, course, language), only]));
  notes.push(say(language, DONE[kind]));
  return { ask: say(language, ASK[kind][scoped ? 1 : 0], [merge ? ungrouped : topicCount, only]), notes, ...(offered ? { tail: 'ask' } : {}) };
}
