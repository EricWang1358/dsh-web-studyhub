import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'course.focus': 「发给主会话」 for recording course exam highlights (重点), especially when the learner only has screenshots or photos
   (WeChat/QQ scope screenshots, slide/whiteboard photos) or raw scope notes. Staged image paths live under studyhub-work/focus-intake/ so
   both vision models and text-only models (such as DeepSeek with local OCR or MinerU) can read them without blocking composer submission. */

const ASK_COURSE = '帮我从这些重点图片或说明里整理课程 {0} 的考试重点，存进这门课。';
const ASK_COURSE_GEN = '帮我从这些重点图片或说明里整理课程 {0} 的考试重点存进这门课，再按重点出一组题存成草稿。';
const ASK_GENERIC = '帮我从这些重点图片或说明里整理考试重点，存到对应的课程里。';
const ASK_GENERIC_GEN = '帮我从这些重点图片或说明里整理考试重点存进课程，再按重点出一组题存成草稿。';

const FIRST = '用 study_workspace 读 library.context {"area":"{0}"}';
const READ_ATTACHED = '识图：重点图片已存到工作区（路径见下方 data 围栏），若这条消息附了图可直接结合图片看；看不清或当前模型看不了图时，用已装好的 MinerU（mineru.import）或本机文字识别读取这些路径，不要猜测没读出的字。';
const READ_STAGED = '识图：重点图片已存到工作区（路径见下方 data 围栏）；能直接看工作区图片就直接逐字转写，看不了图片时用已装好的 MinerU（mineru.import）或本机已有的文字识别工具读取，要装新工具先问我，不要猜测没读出的字。';
const SAVE_FOCUS = '入库：把整理出的重点原文用 source.add 存成这门课的一份重点资料，再用 course.get 读出现有课程信息，把提炼出的简短重点条目合入 focusTopics、把这份资料的 id 合入 guidanceSourceIds，通过 course.save 存回（保留课程原有的 exam 和 plan）。';
const GENERATE_AFTER = '出题：存好重点后，结合这门课已有的学习资料调用 generate 出一组草稿题给我检查（课程已设 focusTopics 时会自动提高重点占比并加深到应用或分析难度）。';
const NEVER = '不要：没问过我就装软件；删除或覆盖我的原文件；安装或配置 MinerU、Marker，或改 StudyHub 设置（需要时让我去设置页）。';
const ASK_FIRST = '先问：永久删除或归档任何东西之前，先用一句话问我：什么会没有，什么会留下；我说好再动手。';
const REPORT = '做完：列出识别并存入 focusTopics 的重点条目、新建资料的标题，以及看不清需要我核对的地方。';

/**
 * input: { course?: string, files?: string[], notes?: string, existingTopics?: string[], generateAfter?: boolean, attached?: boolean }.
 */
export function courseFocusPrompt({ course = '', files = [], notes = '', existingTopics = [], generateAfter = false, attached = false } = {}, language = getUiLanguage()) {
  const courseText = String(course ?? '').trim();
  const fileLines = (Array.isArray(files) ? files : []).map(item => String(item ?? '').trim()).filter(Boolean).join('\n');
  const existingLines = (Array.isArray(existingTopics) ? existingTopics : []).map(item => String(item ?? '').trim()).filter(Boolean).join('\n');
  const ask = courseText
    ? say(language, generateAfter ? ASK_COURSE_GEN : ASK_COURSE, [nameData(courseText)])
    : say(language, generateAfter ? ASK_GENERIC_GEN : ASK_GENERIC);
  const bulletNotes = [
    fileLines ? say(language, attached ? READ_ATTACHED : READ_STAGED) : '',
    say(language, SAVE_FOCUS),
    generateAfter ? say(language, GENERATE_AFTER) : '',
    say(language, NEVER),
    say(language, ASK_FIRST),
    say(language, REPORT),
  ].filter(Boolean);
  return {
    ask,
    request: String(notes ?? '').trim(),
    requestLabel: '我的补充说明',
    first: say(language, FIRST, ['imports']),
    notes: bulletNotes,
    data: [
      ['目标课程', courseText],
      ['重点图片路径', fileLines],
      ['课程已有重点', existingLines],
    ],
  };
}
