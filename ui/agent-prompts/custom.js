import { getUiLanguage } from '../i18n.js';
import { nameData, say } from './say.js';

/* 'custom.start': the message behind 「深度定制这本书」 (the import list and the 解析历史, for a document of CUSTOM_BOOK_PAGES pages or more) and 「深度定制…」 in the
   review book's 更多 menu (ui/custom-entry.js). The main chat runs the interview of skills/study-custom/SKILL.md: a few option questions, one at a time, and only
   what the learner ticks is made. The message carries the course (a name span in the learner's sentence, a JSON string in the note that names the tool argument),
   the document key and its page count when the entry knows them, and whether the course already has a 定制方案 (then only what changed is asked). It carries no
   book text and no plan: the chat reads course.get and the 定制预览 itself. The English of each sentence is in ui/locales/en.custom.json. */

const ASK = {
  book: '帮我给课程 {0} 里的这本书（共 {1} 页）做深度定制：先问我几个选项，我选了要做什么，再动手生成。',
  bookOnly: '帮我给这本书（共 {0} 页）做深度定制：先问我几个选项，我选了要做什么，再动手生成。',
  course: '帮我给课程 {0} 做深度定制：先问我几个选项，我选了要做什么，再动手生成。',
  revise: '帮我改一改课程 {0} 的深度定制：只问我想改的地方。',
  none: '帮我做深度定制：先问我几个选项，我选了要做什么，再动手生成。',
};
const WHERE = '位置：课程 {0}（调用 course.* 时 name 用它）。';
const WHERE_NONE = '位置：这条消息没有指定课程；先读 library.context 里的焦点课程，不确定就问我是哪一门。';
const DOCUMENT = '资料：文档 key {0}，共 {1} 页；在 skill 里说的定制预览（skeleton）里按这个 key 找它。';
const DOCUMENT_ONLY = '资料：文档 key {0}；在 skill 里说的定制预览（skeleton）里按这个 key 找它。';
const HOW = '做法：按 skill 里的顺序一次问我一个问题，用 ask_user_question 给选项；先读一次 course.get 和定制预览，我每答一题就重读预览，用一句话说调用次数和 token 的变化，不说价格。';
const CONSENT = '保存：确认之前不生成任何东西，也不存任何东西；我确认之后才用 course.save 的 custom 存定制方案，再开始第一步。';
const HAS_CUSTOM = '已有定制：这门课已有定制方案，先用一句话说给我听，只问我想改的地方，不要把整套问题再问一遍。';
const RULE = '说明：选项里现有功能做不到的，只记进定制方案，如实告诉我没有做；变式题和生成的讲解是模型写的，可能有错，答案旁的页码可以回去核对。';

/**
 * The parts of the message that starts the 定制 interview (the registry composes it).
 * input: { course (the course name; '' or absent: not known), document (the document key, when the entry is a document's row), pages (its page count),
 * hasCustom (the course already has a 定制方案) }.
 */
export function customStartPrompt({ course = '', document = '', pages = 0, hasCustom = false } = {}, language = getUiLanguage()) {
  const name = String(course ?? '').trim(), key = String(document ?? '').trim(), count = Number.isFinite(pages) && pages > 0 ? Math.round(pages) : 0;
  const ask = hasCustom && name ? say(language, ASK.revise, [nameData(name)])
    : key && name && count ? say(language, ASK.book, [nameData(name), count])
      : key && count ? say(language, ASK.bookOnly, [count])
        : name ? say(language, ASK.course, [nameData(name)]) : say(language, ASK.none);
  const notes = [name ? say(language, WHERE, [JSON.stringify(name)]) : say(language, WHERE_NONE)];
  if (key) notes.push(count ? say(language, DOCUMENT, [JSON.stringify(key), count]) : say(language, DOCUMENT_ONLY, [JSON.stringify(key)]));
  notes.push(say(language, HOW), say(language, CONSENT));
  if (hasCustom) notes.push(say(language, HAS_CUSTOM));
  notes.push(say(language, RULE));
  return { ask, notes };
}
