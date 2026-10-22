import { getUiLanguage } from '../i18n.js';
import { say } from './say.js';
import { composeMessage } from './message.js';

/* The skeleton every NEW 「发给主会话」 entry is built on (the hand-off plan, section 1.3), in the one layout of ui/agent-prompts/message.js: the learner's
   sentence (where they are and what they wanted), then the notes: read the context area, one fixed way of working, what never to do, what to report, and
   the facts in data fences. A built-in flow that did not fit (an error line, a refused file, a failed job) hands over with this. The tools are not listed
   here: the skill (the registry entry's) and the library.context area name them (the chat reads them itself), so this text never drifts from them.
   Every sentence is one catalogue key (ui/locales/en.agent.json). */

const ASK = '我在 StudyHub 的「{0}」想{1}，内置的做法没走通或不合我意，你帮我办一下。';
const FIRST = '用 study_workspace 读 library.context {"area":"{0}"}';
const HOW = '做法：有对应的 StudyHub 工具就直接用；格式不支持时，先用 StudyHub 自带的抽取（study_materials 的 document.import，再用 source.export 写成文件），还不行再用命令行转换；转换结果写到工作区的 studyhub-work/ 下，再导入。';
// An entry whose files are not documents (audio): StudyHub's text extraction and source.export do not apply.
const HOW_NO_EXTRACT = '做法：有对应的 StudyHub 工具就直接用，还不行再用命令行转换；转换结果写到工作区的 studyhub-work/ 下，再导入。';
const NEVER = '不要：没问过我就装软件；删除或覆盖我的原文件；安装或配置 MinerU、Marker，或改 StudyHub 设置（需要时让我去设置页）。';
const REPORT = '做完：告诉我做了什么、结果在哪（题组、草稿、资料或文件路径）、哪些没做成以及原因、哪些是推断的需要我核对。';

/** The facts as lines: an array of lines, or an object of name → value (a value that is not text is written as JSON). */
function factLines(facts) {
  if (!facts) return '';
  if (Array.isArray(facts)) return facts.filter(line => String(line ?? '').trim()).join('\n');
  return Object.entries(facts).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
}

/**
 * situationMessage({ area (the StudyHub place, in the learner's words), goal (what they wanted, a verb phrase), facts, error (the message as it was shown),
 * files (file names), context (the library.context area), hints (the entry's own notes, each one catalogue key "标签：…。"), extract (false: the files are
 * not documents, so no word about StudyHub's text extraction) }, language) -> the parts of the message (the registry entry adds the skill).
 * area and goal go in 「」 as written by the caller (StudyHub's own words, catalogue keys); facts, error and files are data and sit in fences.
 */
export function situationMessage({ area = '', goal = '', facts = null, error = '', files = [], context = 'imports', hints = [], extract = true } = {}, language = getUiLanguage()) {
  return {
    ask: say(language, ASK, [say(language, area), say(language, goal)]),
    first: say(language, FIRST, [context]),
    notes: [say(language, extract ? HOW : HOW_NO_EXTRACT), ...(hints || []).map(line => say(language, line)), say(language, NEVER), say(language, REPORT)],
    data: [['情况', factLines(facts)], ['错误原文', error], ['文件', (files || []).filter(Boolean).join('\n')]],
  };
}

/** The whole message of a situation outside the registry (the tests read it this way): situationMessage laid out with `skill` (default study-import). */
export const situationPrompt = (input = {}, language = getUiLanguage()) =>
  composeMessage(situationMessage(input, language), { skill: input.skill || 'study-import', language });
