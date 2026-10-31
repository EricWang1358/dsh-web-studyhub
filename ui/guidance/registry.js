import { browserSession, browserStorage, readJSON, removeKey, writeJSON } from '../storage.js';
import { noteCleared } from './cleared.js';
import { WELCOME_PREFIX } from '../tour/progress.js';
import { SETUP_DONE_PREFIX, SETUP_LATER_PREFIX } from '../SetupChecklist.jsx';
import { HINTS_KEY, READER_HINTS, hintItem } from '../document-preview/reader/hints.js';
import { NOTICE_KEY } from '../document-preview/original-file.js';
import { TOPIC_GROUP_LATER_PREFIX } from '../study-map/TopicGroupReminder.jsx';
import { ARCHIFY_CARD_PREFIX } from '../archify.js';
import { BOOK_MOVES_PREFIX } from '../book/BookMoves.jsx';
import { JEV_GUIDE_KEY } from '../jev-flow.js';
import { NAV_START_KEY } from '../nav-start.js';
import { NAV_REORDER_HINT_ID, NAV_REORDER_HINT_KEY } from '../nav-reorder-hint.js';
import { NEXT_CARD_PREFIX } from '../study-map/next-dismiss.js';

/*
 * The guidance registry (3.7 guidance, step 0): every tip, card, tour and nudge that remembers "seen" or "put off" in the browser, in one list, so
 * Settings › 引导 can name each one, say when it appears, show whether it was seen, bring it back, and switch the proactive ones off.
 *
 * The surfaces keep their own keys and their own code: an entry here only POINTS at the key a surface already writes (memory; the key or prefix is
 * imported from the surface, never copied) and never renames or migrates it. Reading and clearing go through ui/storage.js, so a blocked or missing
 * storage answers "not seen" and clears nothing, never throws. clearItem also counts the clear for this tab (ui/guidance/cleared.js), so a surface
 * that holds a closing in memory for the visit gives it up.
 *
 * Adding a tip (steps 3 and 4) is one more line in GUIDANCE_ITEMS. A proactive one asks before it shows, from an effect behind a ref:
 *   if (!guidanceAllows(id)) return;                      // master switch, its own switch (ui/guidance/budget.js)
 *   if (itemSeen(guidanceItem(id))) return;               // its own one-shot memory
 *   setShow(claimProactiveTip({ id, inPractice }));       // ONE call: today's one proactive tip, never in practice; false = do not show
 * and remembers its closing under its own key (the memory this entry points at).
 *
 * An entry: { id, kind, where, title, trigger, again, memory, dismiss, proactive, needs?, until? }
 *   kind       'tip' (a line beside a control) | 'card' (a block on a page) | 'tour' (steps the learner walks through) | 'nudge' (a reminder of
 *              something left undone)
 *   where      the page it appears on, as the learner calls it; title: what it is called in Settings; trigger: when it appears, in plain words;
 *   again      when it can appear again after 再显示一次, completing "…会再出现" (all four are Chinese source text, shown through ui())
 *   memory     { store: 'local' | 'session', key, match } where match is
 *                'exact'   the key itself;
 *                'prefix'  every key that starts with `key` (per library or per course: `study-welcome:<root>`);
 *                'list'    one id (`item`) inside the JSON list stored under `key` (the reader's hints share one list)
 *   dismiss    'forever' (closed once, gone) | 'per-session' (back in a new tab) | 'until-condition' (back when what it is about changes)
 *   proactive  true when it appears without being asked for: the master switch and the item's own switch of Settings › 引导 apply to it, and the
 *              daily budget is for such items. Not proactive, and never hidden by the switch: the first-run line, the model-setup gate, the help of
 *              an error or an empty page, the course-setup checklist and its one 「全部完成」 confirmation (a status, not a tip).
 *   needs      (optional) 'experimental': listed only while 显示实验性功能 is on and the host has the system component (guidanceItemsFor).
 *   until      (optional) 'own-deck': it can never appear again once the library has a deck of its own (canComeBack).
 */
const local = (key, match = 'exact', item) => Object.freeze({ store: 'local', key, match, ...(item ? { item } : {}) });

export const GUIDANCE_KINDS = Object.freeze(['tip', 'card', 'tour', 'nudge']);
export const GUIDANCE_DISMISS = Object.freeze(['forever', 'per-session', 'until-condition']);

export const GUIDANCE_ITEMS = Object.freeze([
  { id: 'first-run.later', kind: 'card', where: '学习库首页', title: '首页的入门三步', trigger: '还没有自己的题组时，学习库首页是入门三步；点「以后再说」后，它缩成首页里的一张小卡。', again: '还没有自己的题组时，下次打开学习库首页时', memory: local(WELCOME_PREFIX, 'prefix'), dismiss: 'forever', proactive: false, until: 'own-deck' },
  // 步骤 3's 下一步 card (ui/study-map/NextStepCard.jsx). Not proactive: it is a status worked out from the library on every visit (the first-run line's kind), so the daily
  // budget of one tip and the master switch do not apply; 「今天先不」 hides it for the local day, and the mark is the day itself (ui/study-map/next-dismiss.js).
  { id: 'home.next', kind: 'card', where: '学习库首页', title: '首页顶部的「下一步」卡', trigger: '发布第一个自己的题组后，首页顶部有一张卡，按你现在的情况说下一步做什么；点「今天先不」当天收起。', again: '下次打开学习库首页时', memory: local(NEXT_CARD_PREFIX, 'prefix'), dismiss: 'until-condition', proactive: false },
  { id: 'setup.later', kind: 'card', where: '学习库首页 · 课程准备', title: '课程准备里点了「稍后」的步骤', trigger: '课程准备清单里点「稍后」的步骤会先收起来。', again: '下次打开学习库首页的课程准备时', memory: local(SETUP_LATER_PREFIX, 'prefix'), dismiss: 'until-condition', proactive: false },
  { id: 'setup.done', kind: 'card', where: '学习库首页 · 课程准备', title: '课程准备「全部完成」', trigger: '一门课的准备步骤都做完时，说一次就收起。', again: '这门课的准备都做完后，下次打开学习库首页时', memory: local(SETUP_DONE_PREFIX, 'prefix'), dismiss: 'forever', proactive: false },
  { id: hintItem(READER_HINTS.page), kind: 'tip', where: '阅读 · 原始 PDF', title: '提问的是哪一页', trigger: '第一次在原始 PDF 旁提问时，说明问的是哪一页、怎么换页。', again: '下次在原始 PDF 旁提问时', memory: local(HINTS_KEY, 'list', READER_HINTS.page), dismiss: 'forever', proactive: true },
  { id: hintItem(READER_HINTS.presets), kind: 'tip', where: '阅读 · 原始 PDF', title: '预设问题和发给主会话', trigger: '第一次看到预设问题时，说明点一下就提问，图表或扫描页可以发给主会话。', again: '下次在原始 PDF 旁看到预设问题时', memory: local(HINTS_KEY, 'list', READER_HINTS.presets), dismiss: 'forever', proactive: true },
  { id: 'reader.original-notice', kind: 'card', where: '阅读页', title: '「补全原文件」的说明', trigger: '打开只保存了文字的资料时，说明可以补上原文件；关掉后缩成一行。', again: '下次打开只保存了文字的资料时', memory: local(NOTICE_KEY), dismiss: 'forever', proactive: true },
  { id: 'library.topic-groups', kind: 'nudge', where: '学习库首页', title: '主题还没归入主题组', trigger: '主题多、还没归入主题组时提醒；点「稍后」后，等未归组的主题有变化再提醒。', again: '还有主题没归入主题组时，下次打开学习库首页时', memory: local(TOPIC_GROUP_LATER_PREFIX, 'prefix'), dismiss: 'until-condition', proactive: true },
  { id: 'skeleton.archify', kind: 'card', where: '知识骨架', title: '推荐用 Archify 画图', trigger: '在知识骨架页推荐开源插件 Archify；点「以后再说」后不再出现。', again: '下次打开知识骨架页时', memory: local(ARCHIFY_CARD_PREFIX, 'prefix'), dismiss: 'forever', proactive: true },
  { id: 'book.moves', kind: 'card', where: '复习全书', title: '笔记换了位置', trigger: '总纲重新整理后，说一次哪些笔记移到了新位置；下次重新整理还会再说。', again: '总纲重新整理过、有笔记换了位置时，下次打开复习全书时', memory: local(BOOK_MOVES_PREFIX, 'prefix'), dismiss: 'until-condition', proactive: true },
  // 步骤 5's 「从这里开始」 dots (ui/nav-start.js). The key holds the pages already opened, so 再显示一次 here removes it and every dot comes back.
  { id: 'nav.start', kind: 'nudge', where: '侧栏', title: '从这里开始的小圆点', trigger: '还没有打开过某一页时，侧栏这一项旁边有一个小圆点；打开过就消失。', again: '下次打开侧栏时', dismiss: 'until-condition', proactive: false, memory: local(NAV_START_KEY) },
  // The sidebar's reorder line (ui/nav-reorder-hint.js), said in the first row tooltip the learner opens and then never again. Not proactive: it is part of a
  // tooltip the learner asked for, so the switches and the daily budget do not apply; the keys stay in the shortcut sheet.
  { id: NAV_REORDER_HINT_ID, kind: 'tip', where: '侧栏', title: '侧栏怎么调整顺序', trigger: '第一次把鼠标停在侧栏的某一项上（或用键盘移到它）时，提示里多一句「长按并拖动可调整顺序（键盘：Alt+↑/↓）」；说过一次就不再说。', again: '下次把鼠标停在侧栏的某一项上时', dismiss: 'forever', proactive: false, memory: local(NAV_REORDER_HINT_KEY) },
  { id: 'jev.guide', kind: 'tour', where: '设置 · 实验性功能 · Jev', title: 'Jev 的介绍步骤', trigger: '第一次打开 Jev 设置时，一步步介绍它能替哪些地方做判断。', again: '下次打开 Jev 设置时', memory: local(JEV_GUIDE_KEY), dismiss: 'forever', proactive: false, needs: 'experimental' },
]);

/** The entries this learner can meet: one that `needs: 'experimental'` only while 显示实验性功能 is on AND the host has the system component (the
    gate of the 实验性功能 category, ui/settings-groups.js), so a hidden experiment leaves no trace in Settings and 重新显示全部提示 leaves its memory alone. */
export const guidanceItemsFor = ({ experimental = false, system = false } = {}, items = GUIDANCE_ITEMS) =>
  items.filter(item => item.needs !== 'experimental' || (experimental === true && system === true));

/** Can the entry appear again in this library? Not 首页的入门三步 once the library has a deck of its own (ui/first-run/line.js shows it only before). */
export const canComeBack = (item, { ownDeck = false } = {}) => !(item.until === 'own-deck' && ownDeck);

/** The entry with this id, or undefined. */
export const guidanceItem = (id, items = GUIDANCE_ITEMS) => items.find(item => item.id === id);

/** The storage an entry lives in: the browser's lasting one, or the tab's own. `storages` lets tests hand in both. */
const storageOf = (memory, storages) => (memory.store === 'session' ? storages.session : storages.local);
const defaultStorages = () => ({ local: browserStorage(), session: browserSession() });

/** Every key of `storage`, or [] when it cannot be listed. */
function storageKeys(storage) {
  const keys = [];
  try {
    const count = storage?.length ?? 0;
    for (let index = 0; index < count; index++) { const key = storage.key(index); if (typeof key === 'string') keys.push(key); }
  } catch { return []; }
  return keys;
}

const listOf = (memory, storage) => { const value = readJSON(memory.key, [], storage); return Array.isArray(value) ? value.filter(id => typeof id === 'string') : []; };
const present = (key, storage) => { try { const value = storage?.getItem(key); return value !== null && value !== undefined; } catch { return false; } };

/** The keys an entry holds right now (a list entry: its key, while the list has its id). */
export function itemKeys(item, storages = defaultStorages()) {
  const { memory } = item, storage = storageOf(memory, storages);
  if (!storage) return [];
  if (memory.match === 'prefix') return storageKeys(storage).filter(key => key.startsWith(memory.key));
  if (memory.match === 'list') return listOf(memory, storage).includes(memory.item) ? [memory.key] : [];
  return present(memory.key, storage) ? [memory.key] : [];
}

/** Has the learner seen (closed, put off, finished) this entry in this browser? False when the storage cannot be read. */
export const itemSeen = (item, storages = defaultStorages()) => itemKeys(item, storages).length > 0;

function clearStored(item, storages) {
  const { memory } = item, storage = storageOf(memory, storages);
  if (!storage) return false;
  if (memory.match === 'list') {
    const list = listOf(memory, storage);
    if (!list.includes(memory.item)) return true;
    const rest = list.filter(id => id !== memory.item);
    return rest.length ? writeJSON(memory.key, rest, storage) : removeKey(memory.key, storage);
  }
  return itemKeys(item, storages).map(key => removeKey(key, storage)).every(Boolean);
}

/** Forget that the entry was seen, so it can appear again; true when nothing of it is left stored. Other keys, and other ids of a shared list, stay.
    The clear is counted for this tab either way (a closing held in memory for the visit is given up). */
export function clearItem(item, storages = defaultStorages()) {
  noteCleared(item.id);
  return clearStored(item, storages);
}

/** 重新显示全部提示: clear every entry of `items` that was seen. Answers the ids that were seen (and are cleared now), in list order. Nothing appears by itself. */
export function resetAllGuidance(storages = defaultStorages(), items = GUIDANCE_ITEMS) {
  const cleared = [];
  for (const item of items) if (itemSeen(item, storages) && clearItem(item, storages)) cleared.push(item.id);
  return cleared;
}

/** What is wrong with an entry, as a list of sentences (empty when it is well formed). The registry test runs it on every entry. */
export function entryProblems(item) {
  const problems = [];
  if (!item || typeof item !== 'object') return ['not an object'];
  if (typeof item.id !== 'string' || !/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/.test(item.id)) problems.push(`id "${item.id}" is not area.name`);
  if (!GUIDANCE_KINDS.includes(item.kind)) problems.push(`kind "${item.kind}"`);
  if (!GUIDANCE_DISMISS.includes(item.dismiss)) problems.push(`dismiss "${item.dismiss}"`);
  if (typeof item.proactive !== 'boolean') problems.push('proactive is not a boolean');
  if (item.needs !== undefined && item.needs !== 'experimental') problems.push(`needs "${item.needs}"`);
  if (item.until !== undefined && item.until !== 'own-deck') problems.push(`until "${item.until}"`);
  for (const field of ['where', 'title', 'trigger', 'again']) if (typeof item[field] !== 'string' || !item[field].trim()) problems.push(`no ${field}`);
  const memory = item.memory;
  if (!memory || !['local', 'session'].includes(memory.store) || typeof memory.key !== 'string' || !memory.key) problems.push('memory needs a store and a key');
  else if (!['exact', 'prefix', 'list'].includes(memory.match)) problems.push(`memory.match "${memory.match}"`);
  else if (memory.match === 'list' && (typeof memory.item !== 'string' || !memory.item)) problems.push('a list memory names its item');
  return problems;
}
