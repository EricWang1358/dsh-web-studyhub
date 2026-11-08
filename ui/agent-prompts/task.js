import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'task.check': 「在主会话里检查」 on ui/TaskCardRun.jsx (#778). Hands a hands-on task card (any discipline: code, SQL, derivation,
   experimental design, outline, modelling) to the main chat for static criterion-by-criterion evaluation against its acceptance criteria,
   with strict scope (read only user-named files, never scan the repo, never run tests), issue cap (at most 3 concrete issues),
   agency guard (never edit files or output rewritten complete work), and card.grade write-back to StudyHub. */

const ASK_DECK_TOPIC = '帮我按验收标准静态检查这道动手任务（题组 {0} · 主题 {1}）。';
const ASK_TOPIC = '帮我按验收标准静态检查这道关于 {0} 的动手任务。';
const ASK_GENERIC = '帮我按验收标准静态检查这道动手任务。';

const REQ_BOTH = '指定文件：{0}\n补充说明：{1}';
const REQ_FILE = '指定文件：{0}';

const FIRST = '用 study_workspace 读 library.context {"area":"cards"}，必要时用 card.get 读取这道题的完整验收标准';
const WHERE = '定位：题库与练习轮定位 {0}（调用 card.grade 写回时原样带上 deckId、cardId 和 runId）。';
const SCOPE_RULE = '范围：只读我在消息或主会话里明确指定的文件（还没指定就先问我文件在哪）；绝不扫描整个仓库，绝不评判我没给出的文件，也不运行测试。';
const CHECK_RULE = '验收：按下方验收标准逐条静态判定「满足 / 缺失 / 有问题（第几行）」（对应 status 为 satisfied、missing 或 issue，定位到具体行时填正整数 line），最多指出 3 处具体问题。';
const NO_EDIT_RULE = '禁令：严禁替我修改文件，严禁直接给出改好的完整代码、完整推导或完整成品，只指出具体问题所在与改进方向。';
const WRITEBACK_RULE = '做完：调用 study_workspace 的 card.grade（传入定位里的 deckId、cardId、runId，files 填实际读取的文件列表，checks 填逐条结果数组 [{id,status,line?,feedback,evidence?}]，summary 写简短总评）把逐条验收结果写回 StudyHub，再在主会话里简明告诉我结果。';

function formatTaskCriteria(rubric, rubricCriteria) {
  const structured = Array.isArray(rubricCriteria)
    ? rubricCriteria
      .filter((item) => item && typeof item === 'object' && String(item.id || item.label || '').trim())
      .map((item, idx) => {
        const cid = String(item.id || `c${idx + 1}`).trim();
        const label = String(item.label || cid).trim();
        const desc = String(item.descriptor || '').trim();
        const marks = Number.isInteger(item.marks) && item.marks > 0 ? ` (${item.marks})` : '';
        return `[${cid}] ${label}${marks}${desc ? ` - ${desc}` : ''}`;
      })
    : [];
  const raw = String(rubric ?? '').trim();
  if (structured.length && raw) return `${structured.join('\n')}\n\n${raw}`;
  if (structured.length) return structured.join('\n');
  return raw;
}

/**
 * input: { deckId?, cardId?, runId?, deckTitle?, topic?, prompt?, rubric?, rubricCriteria?, filePath?, note? }.
 */
export function taskCheckPrompt({
  deckId = '',
  cardId = '',
  runId = '',
  deckTitle = '',
  topic = '',
  prompt = '',
  rubric = '',
  rubricCriteria = [],
  filePath = '',
  note = '',
} = {}, language = getUiLanguage()) {
  const deckText = String(deckTitle ?? '').trim();
  const topicText = String(topic ?? '').trim();
  const promptText = String(prompt ?? '').trim();
  const fileText = Array.isArray(filePath)
    ? filePath.map((item) => String(item ?? '').trim()).filter(Boolean).join(', ')
    : String(filePath ?? '').trim();
  const noteText = String(note ?? '').trim();
  const criteriaText = formatTaskCriteria(rubric, rubricCriteria);
  const ask = deckText && topicText
    ? say(language, ASK_DECK_TOPIC, [nameData(deckText), nameData(topicText)])
    : topicText ? say(language, ASK_TOPIC, [nameData(topicText)]) : say(language, ASK_GENERIC);
  const request = fileText && noteText
    ? say(language, REQ_BOTH, [fileText, noteText])
    : fileText ? say(language, REQ_FILE, [fileText]) : noteText;
  const ref = {
    ...(deckId ? { deckId: String(deckId) } : {}),
    ...(cardId ? { cardId: String(cardId) } : {}),
    ...(runId ? { runId: String(runId) } : {}),
  };
  return {
    ask,
    request,
    requestLabel: '我的文件与说明',
    first: say(language, FIRST),
    notes: [
      say(language, WHERE, [JSON.stringify(ref)]),
      say(language, SCOPE_RULE),
      say(language, CHECK_RULE),
      say(language, NO_EDIT_RULE),
      say(language, WRITEBACK_RULE),
    ],
    data: [
      ['任务说明', promptText],
      ['验收标准', criteriaText],
    ],
    tail: fileText ? null : 'file',
  };
}
