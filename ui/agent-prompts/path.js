import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';
import { listText } from './message.js';
import { MATTER_WORDS, rangesText } from '../generation-path-flow.js';
import { CALL_PAGES, CALL_QUESTIONS } from '../../lib/generation-path.js';

/* 'path.brief': the message that opens a conversation about a step plan (ui/GenerationPath.jsx; lib/generation-path.js makes the plan). It returns the parts
   of one message (ui/agent-prompts/message.js): the learner's sentence names the book and the course (name spans), their goal sits in a request fence, and
   the plan (chapter titles come from the PDF: the least trusted text) and the page ids sit in data fences. The notes say how to map a page range to ids,
   what the index can do, how big one generate call may be, how to see a job (job.status) and to take the next step only after the one before ended, and
   what the assistant should do: shape the steps with the learner, and only after they confirm, generate each step. Every sentence is one catalogue key
   (ui/locales/en.agent.json). */

/** While they fit, the page ids of the steps go with the message (each step's ids in one line); beyond it the chat lists them with source.list. */
const ID_BUDGET = 6000;

const STEP = '{0}. {1}{2} · {3} 页 · {4} 字符 · 建议 {5} 题{6}';
const STEP_SKIPPED = '{0}. {1}{2} · {3} 页 · {4}';
const NOTES = {
  plan: '初步路径：应用按章节做的，只是起点（见下面的 data 围栏）{0}。',
  pageNumbers: '；页码是 PDF 页码，也就是页面标题里“p.”后面的数字',
  pages: '页码→页面：不要猜 id，调用 source.list {"query": "书名", "groupBy": "document", "memberOffset": 第一页页码-1, "memberLimit": 最多 200}；每个成员都带 page 和 id，按页码排好，取我说的范围里的那些 id。',
  omitted: '省略：为了不太长，部分步骤的 sourceIds 没有带上；需要时用 source.list 取这本书的页面。',
  indexed: '检索：检索索引已经建好，按我的需求用 source.search 找页面，不要整章整章地读。',
  unindexed: '检索：检索索引还没建好，只读需要的页面。',
  ask: '先问我：重点学什么、跳过什么、讲多深、每步多少题；再给出调整后的路径（可以合并、拆分、调整顺序或改章节名，每一步写明页面、重点和题数）。',
  generate: '生成：我确认之前不要生成任何东西；确认后按顺序对每一步调用 generate，带上这一步的 sourceIds、focus 和 count（标了跳过的步骤除非我要）。',
  size: '大小：每次调用 generate 至多 {0} 页、{1} 题；一步超过这个大小就拆成几次 generate：把页面按页码切成每段至多 {0} 页，题数分给各段，一次接一次地做。',
  jobs: '任务：generate 只是开始一个后台任务并返回 jobId，这时题目还没有写好；用 job.status {jobId} 看它（马上返回；需要时才用 job.wait 等一小会儿，最多 60 秒）；上一步完成（job.status 显示已结束且 complete）之后再开始下一步，还在进行就告诉我现在到哪了（阶段、已存/要求的题数）。你无法在两条消息之间自己盯着任务，所以不要承诺“好了再告诉你”：说明我下次发消息时你会先用 job.status 查看，然后真的汇报。',
};

/** input: { steps (lib/generation-path.js), course, goal (the learner's words), indexed (the search index is built) }. */
export function pathBrief({ steps = [], course = '', goal = '', indexed = false }, language = getUiLanguage()) {
  const english = language === 'en';
  const documents = [...new Set(steps.flatMap(step => (step.ranges || []).map(run => run.document)).filter(Boolean))];
  const skipped = step => step.included === false;
  let used = 0;
  const lines = [], ids = [];
  for (const step of steps) {
    const range = rangesText(step.ranges, english, documents.length);
    // a title made of its own page range ("第 55–76 页") is not followed by the range again
    const shown = range && !String(step.title).includes(range.replace(/^"[^"]*" |^《[^》]*》/, '')) ? ` · ${range}` : '';
    if (skipped(step)) {
      // in an English sentence the matter word is lowercased ("suggest skipping it (front matter and contents)")
      const word = step.optional && MATTER_WORDS[step.matter] ? (english ? MATTER_WORDS[step.matter].en.toLowerCase() : MATTER_WORDS[step.matter].zh) : '';
      const why = step.optional ? say(language, '建议跳过{0}；我需要时再说', [word ? say(language, '（{0}）', [word]) : '']) : say(language, '我没勾选这一步，先跳过');
      lines.push(say(language, STEP_SKIPPED, [step.order, step.title, shown, step.pages, why]));
      continue;
    }
    lines.push(say(language, STEP, [step.order, step.title, shown, step.pages, step.chars, step.count, step.focus ? say(language, ' · 重点：{0}', [step.focus]) : '']));
    const joined = step.sourceIds.join(',');
    if (used + joined.length <= ID_BUDGET) { used += joined.length; ids.push(`${step.order}: ${joined}`); }
  }
  const omitted = ids.length < steps.filter(step => !skipped(step)).length;
  const hasRanges = steps.some(step => step.ranges?.length);
  const book = documents.length ? listText(language, documents.map(nameData)) : say(language, '这本书');
  return {
    ask: say(language, '我想按步骤学完 {0}{1}，先和你一起定每一步学哪些章节。', [book, course ? say(language, '（课程 {0}）', [nameData(course)]) : '']),
    request: goal, requestLabel: '我的目标',
    notes: [
      say(language, NOTES.plan, [hasRanges ? say(language, NOTES.pageNumbers) : '']),
      hasRanges ? say(language, NOTES.pages) : '',
      omitted ? say(language, NOTES.omitted) : '',
      say(language, indexed ? NOTES.indexed : NOTES.unindexed),
      say(language, NOTES.ask),
      say(language, NOTES.generate),
      say(language, NOTES.size, [CALL_PAGES, CALL_QUESTIONS]),
      say(language, NOTES.jobs),
    ],
    // the ids first: the input box shows the end of a message, so the plan (what the learner reads) is the last thing above the language sentence
    data: [...(ids.length ? [['sourceIds（按步骤）', ids.join('\n')]] : []), ['初步路径', lines.join('\n')]],
  };
}
