/* Which Settings group is open, and what is marked "not set up" (ui/Settings.jsx; docs/feature-tiers.md).

   Settings are grouped by when they are touched:
   - 常用: what is touched whenever something is off (the interface language and appearance, the AI model);
   - 一次性设置: what is set once, for a feature or a course (keys, the search extension, MinerU, audio, courses, import, backup);
   - 高级: what almost nobody needs: the usage frequency record (opt-in, local; docs/usage-frequency.md) and the one switch "显示实验性功能"
     (the experimental block appears under it only when it is on). Both are off by default and independent of each other.

   A group is closed while what THIS library needs is set up, and open, with the names of what is missing, when it is not.
   "Needs" is read from the library, never assumed: a transcription key is missing only when the library has recordings,
   MinerU only when it holds a long book that was never converted, the search extension only when it holds a big book.
   `status` is what the host reported ({ audio: { configured }, mineru: { configured }, retrieval: { status, plan } });
   a status that has not arrived marks nothing. Pure. */
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { bigDocuments } from '../lib/large-documents.js';

export const SETTINGS_GROUPS = Object.freeze([
  { id: 'common', title: '常用', lead: '界面语言、外观和 AI 模型：哪里不对劲时才需要来看看。' },
  { id: 'once', title: '一次性设置', lead: '第一次用某项功能、或开始一门新课时设一次：密钥、检索扩展、MinerU、音频转写、课程、导入与备份。' },
  { id: 'advanced', title: '高级', lead: '多数人用不到：使用频率记录和实验性功能的开关，默认都关闭。' },
]);

/** Which group each deep-linkable section lives in. */
export const SECTION_GROUP = Object.freeze({ 'settings-model': 'common' });

/* The categories of the Settings page: a list on the left under the three group headings, and one category at a time on the right. `needs` is the component of
   the host a category depends on (a host without it shows no such category); `anchors` are the data-tour ids inside it, which deep links and the tour use. */
export const SETTINGS_CATEGORIES = Object.freeze([
  { id: 'appearance', group: 'common', title: '界面', anchors: ['settings-appearance'] },
  { id: 'model', group: 'common', title: '学习库与模型', anchors: ['settings-model'] },
  { id: 'generation', group: 'common', title: '出题偏好', anchors: ['settings-generation'], needs: 'generation' },
  { id: 'courses', group: 'once', title: '课程', anchors: ['settings-courses'] },
  { id: 'audio', group: 'once', title: '音频转写', anchors: ['settings-audio'], needs: 'audio' },
  { id: 'mineru', group: 'once', title: 'PDF 转换（MinerU）', anchors: ['settings-mineru'], needs: 'audio' },
  { id: 'retrieval', group: 'once', title: '检索扩展', anchors: ['settings-extensions'], needs: 'generation' },
  { id: 'profile', group: 'once', title: '学习画像与导览', anchors: ['settings-profile', 'settings-sample'] },
  { id: 'data', group: 'once', title: '导入、计划与备份', anchors: ['settings-data'] },
  { id: 'update', group: 'once', title: '关于与更新', anchors: ['settings-update'] },
  { id: 'usage', group: 'advanced', title: '使用频率记录', anchors: ['settings-usage'], needs: 'system' },
  { id: 'experimental', group: 'advanced', title: '实验性功能', anchors: ['settings-experimental', 'settings-jev'], needs: 'system' },
]);

/** The categories this host can show, in list order. `capabilities`: { audio, generation, system } booleans. */
export const categoriesFor = (capabilities = {}) => SETTINGS_CATEGORIES.filter(category => !category.needs || capabilities[category.needs]);

/** The category a deep link or a tour anchor (a data-tour id) lives in, or null. */
export const categoryForAnchor = (anchor) => SETTINGS_CATEGORIES.find(category => category.anchors.includes(anchor))?.id ?? null;

/** What starts selected: the deep link, else the first category (in list order) that needs attention, else the one used last, else the first. */
export function initialCategory({ available, focusSection = '', missing = [], last = '' } = {}) {
  const ids = (available ?? SETTINGS_CATEGORIES).map(category => category.id);
  const linked = categoryForAnchor(focusSection);
  if (linked && ids.includes(linked)) return linked;
  const needing = ids.find(id => missing.includes(id));
  if (needing) return needing;
  return ids.includes(last) ? last : ids[0];
}

export function settingsGroupState({ data, status = {}, saved = {}, forceOpen = false } = {}) {
  const missing = { common: [], once: [], advanced: [] };
  const modelMissing = data?.model ? data.model.ready === false : data?.modelReady === false;
  if (modelMissing) missing.common.push('model');

  const items = groupSourcesByDocument(data?.sources || []);
  const books = bigDocuments(items);
  const hasRecordings = (data?.sources || []).some((source) => source.audio) || (data?.jobs || []).some((job) => job.type === 'audio-import');
  if (hasRecordings && status.audio?.configured === false) missing.once.push('audio');
  if (books.some((item) => !item.converted && !item.chapters?.length) && status.mineru?.configured === false) missing.once.push('mineru');
  const search = status.retrieval?.status;
  if (books.length && search?.extension && !search.extension.installed && search.extension.canInstall !== false && (!search.effective || search.effective === 'builtin')) missing.once.push('retrieval');

  const forced = (id) => forceOpen === true || (Array.isArray(forceOpen) && forceOpen.includes(id));
  const state = {};
  for (const { id } of SETTINGS_GROUPS) state[id] = { open: forced(id) || (typeof saved[id] === 'boolean' ? saved[id] : missing[id].length > 0), missing: missing[id] };
  return state;
}
