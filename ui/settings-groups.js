/* The Settings categories, the three groups they sit under, and what is marked "待设置" (ui/Settings.jsx; docs/feature-tiers.md).

   Settings are grouped by how often they are touched:
   - 常用: what a learner adjusts in daily use or whenever something is off, one category each (for example the interface, formulas and
     calculation tools, the library folder and the AI model, the question preferences, the daily recap);
   - 一次性设置: what is set once, for a feature or a course (keys, the search extension, MinerU, audio, courses, 备考补习, import, backup);
   - 高级: what almost nobody needs: the usage frequency record (opt-in, local; docs/usage-frequency.md) and the one switch "显示实验性功能"
     (the experimental block appears under it only when it is on). Both are off by default and independent of each other.

   The page lists the categories under the group headings, one at a time on the right. A category that THIS library still needs set up carries
   the mark "待设置", and the first such category is the one that opens first. "Needs" is read from the library, never assumed: a transcription
   key is missing only when the library has recordings, MinerU only when it holds a long book that was never converted, the search extension
   only when it holds a big book. `status` is what the host reported ({ audio: { configured }, mineru: { configured }, retrieval: { status, plan } });
   a status that has not arrived marks nothing. The registry below is the one place a category is declared: its title, group, deep-link anchors, the
   host component it needs, and the pane it renders (loaded lazily). */
import { lazy } from 'react';
import { groupSourcesByDocument } from '../lib/source-groups.js';
import { bigDocuments } from '../lib/large-documents.js';
import { JOB_TYPES } from '../lib/job-status.js';

export const SETTINGS_GROUPS = Object.freeze([
  { id: 'common', title: '常用' },
  { id: 'once', title: '一次性设置' },
  { id: 'advanced', title: '高级' },
]);

/* The categories of the Settings page: a list on the left under the three group headings, and one category at a time on the right. `needs` is the component of
   the host a category depends on (a host without it shows no such category); `partNeeds` gates ONE part inside a category that stays visible without it (the
   MinerU routes need the audio component, the external Marker route does not); `anchors` are the data-tour ids inside it, which deep links and the tour use.
   `load` imports the pane (ui/settings/*Pane.jsx, a default export taking the page's services) and `Component` is that pane, lazy: Settings renders
   <category.Component {...services} /> and decides nothing else about a category. */
const category = (entry, load) => ({ ...entry, load, Component: lazy(load) });
export const SETTINGS_CATEGORIES = Object.freeze([
  category({ id: 'appearance', group: 'common', title: '界面', anchors: ['settings-appearance'] }, () => import('./settings/AppearancePane.jsx')),
  category({ id: 'science', group: 'common', title: '公式、图片与计算工具', anchors: ['settings-science'] }, () => import('./settings/SciencePane.jsx')),
  category({ id: 'model', group: 'common', title: '学习库与模型', anchors: ['settings-model'] }, () => import('./settings/ModelPane.jsx')),
  category({ id: 'generation', group: 'common', title: '出题偏好', anchors: ['settings-generation', 'settings-generation-time'], needs: 'generation' }, () => import('./settings/GenerationPane.jsx')),
  category({ id: 'daily-recap', group: 'common', title: '每日讲解合集', anchors: ['settings-daily-recap'] }, () => import('./settings/DailyRecapPane.jsx')),
  category({ id: 'practice', group: 'common', title: '练习', anchors: ['settings-practice'] }, () => import('./settings/PracticePane.jsx')),
  category({ id: 'courses', group: 'once', title: '课程', anchors: ['settings-courses'] }, () => import('./settings/CoursesPane.jsx')),
  category({ id: 'exam-prep', group: 'once', title: '备考补习', anchors: ['settings-exam-prep'], needs: 'generation' }, () => import('./settings/ExamPrepPane.jsx')),
  category({ id: 'audio', group: 'once', title: '音频转写', anchors: ['settings-audio'], needs: 'audio' }, () => import('./settings/AudioPane.jsx')),
  category({ id: 'mineru', group: 'once', title: 'PDF 转换（MinerU / Marker）', anchors: ['settings-mineru', 'settings-marker'], partNeeds: { routes: 'audio' } }, () => import('./settings/MineruPane.jsx')),
  category({ id: 'retrieval', group: 'once', title: '检索扩展', anchors: ['settings-extensions'], needs: 'generation' }, () => import('./settings/RetrievalPane.jsx')),
  category({ id: 'profile', group: 'once', title: '学习画像与导览', anchors: ['settings-profile', 'settings-sample'] }, () => import('./settings/ProfilePane.jsx')),
  category({ id: 'data', group: 'once', title: '导入、计划与备份', anchors: ['settings-data'] }, () => import('./settings/DataPane.jsx')),
  category({ id: 'update', group: 'once', title: '关于与更新', anchors: ['settings-update'] }, () => import('./settings/UpdatePane.jsx')),
  category({ id: 'usage', group: 'advanced', title: '使用频率记录', anchors: ['settings-usage'], needs: 'system' }, () => import('./settings/UsagePane.jsx')),
  category({ id: 'experimental', group: 'advanced', title: '实验性功能', anchors: ['settings-experimental', 'settings-jev'], needs: 'system' }, () => import('./settings/ExperimentalPane.jsx')),
]);

/** The categories this host can show, in list order. `capabilities`: { audio, generation, system } booleans. */
export const categoriesFor = (capabilities = {}) => SETTINGS_CATEGORIES.filter(category => !category.needs || capabilities[category.needs]);

/** Is one gated part of a category available on this host? A part the registry does not gate is always available. */
export const partAvailable = (id, part, capabilities = {}) => {
  const needs = SETTINGS_CATEGORIES.find(entry => entry.id === id)?.partNeeds?.[part];
  return !needs || !!capabilities[needs];
};

/** The category a deep link or a tour anchor (a data-tour id) lives in, or null. */
export const categoryForAnchor = (anchor) => SETTINGS_CATEGORIES.find(category => category.anchors.includes(anchor))?.id ?? null;

/** The section a settings link names, else `fallback`: a click handler is also handed the click event (or nothing), and only an id of the registry is a target. */
export const settingsSectionOr = (section, fallback) => (typeof section === 'string' && categoryForAnchor(section) ? section : fallback);

/** What starts selected: the deep link, else the first category (in list order) that needs attention, else the one used last, else the first. */
export function initialCategory({ available, focusSection = '', missing = [], last = '' } = {}) {
  const ids = (available ?? SETTINGS_CATEGORIES).map(category => category.id);
  const linked = categoryForAnchor(focusSection);
  if (linked && ids.includes(linked)) return linked;
  const needing = ids.find(id => missing.includes(id));
  if (needing) return needing;
  return ids.includes(last) ? last : ids[0];
}

/** { common: { missing: [category id…] }, once: { … }, advanced: { … } }: the categories this library still needs set up, by group. */
export function settingsGroupState({ data, status = {} } = {}) {
  const missing = { common: [], once: [], advanced: [] };
  const modelMissing = data?.model ? data.model.ready === false : data?.modelReady === false;
  if (modelMissing) missing.common.push('model');

  const items = groupSourcesByDocument(data?.sources || []);
  const books = bigDocuments(items);
  const hasRecordings = (data?.sources || []).some((source) => source.audio) || (data?.jobs || []).some((job) => job.type === JOB_TYPES.AUDIO_IMPORT);
  if (hasRecordings && status.audio?.configured === false) missing.once.push('audio');
  if (books.some((item) => !item.converted && !item.chapters?.length) && status.mineru?.configured === false) missing.once.push('mineru');
  const search = status.retrieval?.status;
  if (books.length && search?.extension && !search.extension.installed && search.extension.canInstall !== false && (!search.effective || search.effective === 'builtin')) missing.once.push('retrieval');

  const state = {};
  for (const { id } of SETTINGS_GROUPS) state[id] = { missing: missing[id] };
  return state;
}
