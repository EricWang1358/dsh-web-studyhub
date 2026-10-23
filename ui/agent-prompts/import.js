import { getUiLanguage } from '../i18n.js';
import { situationMessage } from './situation.js';

/* The hand-off for a file the built-in import does not take or does not suit (the hand-off plan, 1.3): ONE entry, 'import.file', with the purpose that says
   what the file is for. It is built on situation.js (where the learner is, the facts in a fence, the fixed way of working, what to report); the registry entry
   opens its notes with the skill (study-import) and ends it with the file line (the @ that opens the chat's file picker), so the learner picks the files in the
   chat. The purposes:
     'questions'  questions the learner already has, in a file (a question book, a past paper, a spreadsheet): entered as they are, as drafts to check
     'material'   a document to keep as material (a PDF too big or scanned); goal 'generate' (the empty home): then 10 questions from it
     'audio'      recordings (several in an order, a video, a format the form does not take)
     'file'       files of a kind the page refused (an e-book, a spreadsheet, a picture, an archive): the chat decides what each one is
   `area` is the place the learner is (a catalogue key; each purpose has its own by default). */

// How questions the learner already has are entered: as they are, chapter by chapter, as drafts the learner checks (deck.import draft:true).
const ENTER_AS_IS = '录入：题干、选项、答案和解析保持原文，不出新题；推断出来的答案要标出来。';
const AS_DRAFTS = '导入：整本题册按章拆开，每章写成一个题组 JSON（格式见 library.context 的 decks），用 deck.import 的 draft:true 存成草稿，由我检查后再发布；我说直接导入时才去掉 draft。';

const PURPOSES = Object.freeze({
  questions: {
    area: '在主会话里录题',
    goal: '把文件里已有的题目原样录进题组',
    hints: [ENTER_AS_IS, AS_DRAFTS, '汇报：每章的题数、跳过的重复题和推断了答案的题。'],
  },
  material: {
    area: '添加资料',
    goal: '把这份文件导入成学习资料',
    hints: [
      '拆分：PDF 超过页数上限时，不管 pages 怎么写都会被拒绝：先按章拆成几个文件再导入，每个文件的标题写明章节和原书起始页（不然引用的页码对不上）；已经装好的 MinerU 也可以用 mineru.import 导入整本。',
      '字数：pages 只用来在页数上限之内少选几页，让提取的文字不超过字符上限。',
      '扫描件：读不出文字时，已经装好的 MinerU 可以用 mineru.import；没有就先问我，再做文字识别。',
    ],
  },
  audio: {
    area: '音频导入',
    goal: '把这些音频按我指定的顺序合成一份逐字稿',
    // recordings are not documents: StudyHub's text extraction does not apply
    extract: false,
    hints: [
      '导入：用 audio.import 的 files:[{path}] 导入，路径用绝对路径；files 的顺序就是录音的顺序。',
      '视频：先抽出音频，超过上限就按章拆开，按顺序导入同一课程。',
    ],
  },
  file: {
    area: '添加资料',
    goal: '把这些 StudyHub 不收的文件导入进来',
    hints: [
      '判断：先看每个文件是资料、已有的题目还是录音：表格把各列对应成题目，截图逐字转写，电子书和压缩包转换或解压后作为资料，视频先抽出音频。',
      ENTER_AS_IS,
      AS_DRAFTS,
      '录音：用 audio.import 导入。',
    ],
  },
});

/* The empty home's link (the old 「在对话中用工作区文件出题」): a workspace file as material, then a first set of questions from it. */
const GOALS = Object.freeze({
  generate: { goal: '用工作区里的一个文件出第一组题', hint: '出题：导入后用 generate 出 10 道题，存成草稿给我检查。' },
});

/** The purposes the registry knows. */
export const IMPORT_PURPOSES = Object.freeze(Object.keys(PURPOSES));

/**
 * input: { purpose ('questions' | 'material' | 'audio' | 'file'), goal ('generate': the empty home), area (where the learner is, a catalogue key), facts (what
 * the page knows, may be empty), error (the messages shown there), files (names), excerpt ({ text, total }: the start of a pasted or refused text) }.
 * An unknown purpose or goal throws.
 */
export function importFilePrompt({ purpose = 'material', goal = '', area = '', facts = null, error = '', files = [], excerpt = null } = {}, language = getUiLanguage()) {
  const entry = PURPOSES[purpose];
  if (!entry) throw new Error(`Unknown import purpose: ${purpose}`);
  const aim = goal ? GOALS[goal] : null;
  if (goal && !aim) throw new Error(`Unknown import goal: ${goal}`);
  return situationMessage({ area: area || entry.area, goal: aim?.goal || entry.goal, facts, error, files, excerpt, context: 'imports',
    hints: [...entry.hints, ...(aim ? [aim.hint] : [])], extract: entry.extract !== false }, language);
}
