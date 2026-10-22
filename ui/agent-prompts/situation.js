import { getUiLanguage } from '../i18n.js';
import { fenceData, say } from './say.js';

/* The skeleton every NEW 「发给主会话」 entry is built on (the hand-off plan, section 1.3): where the learner is and what they wanted, the facts in a data
   fence, one fixed way of working, and what to report. A built-in flow that did not fit (an error line, a refused file, a failed job) hands over with this.
   The tools are not listed here: the skill and the library.context area name them (the chat reads them itself), so this text never drifts from them.
   Every sentence is one catalogue key (ui/locales/en.agent.json). */

const HEAD = '我在 StudyHub 的「{0}」想{1}，内置做法走不通或不合我意，请你来办。';
const METHOD = [
  '做法：',
  '- 先读 skill {0}，再用 study_workspace 读 library.context {"area":"{1}"}。',
  '- 有对应的 StudyHub 工具就直接用。',
  '- 格式不支持时，先用 StudyHub 自带的抽取：study_materials 的 document.import，再用 source.export 写成文件；还不行，再用命令行转换。',
  '- 转换结果写到工作区的 studyhub-work/ 下，再导入。',
  '- 装软件前先问我；不删除、不覆盖我的原文件。',
  '- 不装、不配置 MinerU 或 Marker，不改 StudyHub 设置；需要时让我去设置页。',
];
const REPORT = '做完告诉我：做了什么，结果在哪（题组、草稿、资料或文件路径），哪些没做成以及原因，哪些是推断的需要我核对。';

/** The facts as lines: an array of lines, or an object of name → value (a value that is not text is written as JSON). */
function factLines(facts) {
  if (!facts) return '';
  if (Array.isArray(facts)) return facts.filter(line => String(line ?? '').trim()).join('\n');
  return Object.entries(facts).filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n');
}

/**
 * situationPrompt({ area (the StudyHub place, in the learner's words), goal (what they wanted, a verb phrase), facts, error (the message as it was shown),
 * files (file names), skill ('study-import' | 'study-book'), context (the library.context area), hints (the entry's own extra lines of the way of working,
 * each one catalogue key starting with "- ") }, language) -> the four parts, one per paragraph.
 * area, goal, facts, error and files are data: area and goal go in 「」 as written by the caller (StudyHub's own words), the rest in fences.
 */
export function situationPrompt({ area = '', goal = '', facts = null, error = '', files = [], skill = 'study-import', context = 'imports', hints = [] } = {}, language = getUiLanguage()) {
  const parts = [say(language, HEAD, [say(language, area), say(language, goal)])];
  const data = [fenceData('情况', factLines(facts), language), fenceData('错误原文', error, language),
    fenceData('文件', (files || []).filter(Boolean).join('\n'), language)].filter(Boolean);
  if (data.length) parts.push(data.join('\n'));
  parts.push([...METHOD.map((line, index) => (index === 1 ? say(language, line, [skill, context]) : say(language, line))), ...(hints || []).map(line => say(language, line))].join('\n'));
  parts.push(say(language, REPORT));
  return parts.join('\n\n');
}
