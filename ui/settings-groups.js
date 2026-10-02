/* Which Settings group is open, and what is marked "not set up" (ui/Settings.jsx; docs/feature-tiers.md).

   Settings are grouped by when they are touched:
   - 常用: what is touched whenever something is off (the interface language and appearance, the AI model);
   - 一次性设置: what is set once, for a feature or a course (keys, the search extension, MinerU, audio, courses, import, backup).

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
]);

/** Which group each deep-linkable section lives in. */
export const SECTION_GROUP = Object.freeze({ 'settings-model': 'common' });

export function settingsGroupState({ data, status = {}, saved = {}, forceOpen = false } = {}) {
  const missing = { common: [], once: [] };
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
