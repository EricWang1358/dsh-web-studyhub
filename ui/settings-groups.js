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
  category({ id: 'appearance', group: 'common', title: '界面', anchors: ['settings-appearance', 'settings-appearance-language', 'settings-appearance-theme', 'settings-appearance-accent', 'settings-appearance-scale', 'settings-appearance-font', 'settings-appearance-motion', 'settings-appearance-contrast', 'settings-appearance-density', 'settings-appearance-radius', 'settings-appearance-reset', 'settings-appearance-transfer'],
    purpose: '语言、外观、强调色、界面大小在最上面；字体、动画、对比度、密度和圆角在「更多外观选项」里；也能把外观复制或存成文件，带到另一台电脑' }, () => import('./settings/AppearancePane.jsx')),
  category({ id: 'science', group: 'common', title: '公式、图片与计算工具', anchors: ['settings-science'], purpose: '公式的大小和对齐、图片的显示方式，以及化学配平和代数恒等式两个在本地计算的小工具' }, () => import('./settings/SciencePane.jsx')),
  category({ id: 'model', group: 'common', title: '学习库与模型', anchors: ['settings-model'], purpose: '选学习库放在哪个文件夹，也选用哪个模型出题；模型的密钥在 DSH 的「设置 › 模型」里填' }, () => import('./settings/ModelPane.jsx')),
  category({ id: 'generation', group: 'common', title: '出题偏好', anchors: ['settings-generation', 'settings-generation-time'], needs: 'generation',
    purpose: '新出题任务的默认值：题型、覆盖强度、语言、难度、公式写法，以及同时处理几批、每轮运行时限、自动再补几轮' }, () => import('./settings/GenerationPane.jsx')),
  category({ id: 'daily-recap', group: 'common', title: '每日讲解合集', anchors: ['settings-daily-recap'], purpose: '把一天里答错的题整理成一篇讲解合集：是否自动准备、默认的讲解口吻和按哪个时区算一天' }, () => import('./settings/DailyRecapPane.jsx')),
  category({ id: 'practice', group: 'common', title: '练习', anchors: ['settings-practice'], purpose: '每天的练习怎么走：每轮题数、自动跳下一步、本轮点评，以及期末一周的安排' }, () => import('./settings/PracticePane.jsx')),
  category({ id: 'courses', group: 'once', title: '课程', anchors: ['settings-courses'], purpose: '列出每门课；点开一门课可以记下考试形式、日期、总分和重点知识点，也能把两门课合并' }, () => import('./settings/CoursesPane.jsx')),
  category({ id: 'exam-prep', group: 'once', title: '备考补习', anchors: ['settings-exam-prep'], needs: 'generation', purpose: '备考补习的个人默认值：是否自动识别资料用途、清单语言，以及是否默认列出其它课程的资料' }, () => import('./settings/ExamPrepPane.jsx')),
  category({ id: 'audio', group: 'once', title: '音频转写', anchors: ['settings-audio', 'settings-live-pause'], needs: 'audio', purpose: '填转写用的密钥（Gemini 或国内能直连的硅基流动），也选课堂实录用云端还是本地转写' }, () => import('./settings/AudioPane.jsx')),
  category({ id: 'mineru', group: 'once', title: 'PDF 转换（MinerU / Marker）', anchors: ['settings-mineru', 'settings-marker'], partNeeds: { routes: 'audio' },
    purpose: '把扫描件、公式多或很大的 PDF 先在本机解析成带页码的文字：安装 MinerU，或接入 Marker' }, () => import('./settings/MineruPane.jsx')),
  category({ id: 'retrieval', group: 'once', title: '检索扩展', anchors: ['settings-extensions'], needs: 'generation', purpose: '给上百页的大教材用：装好后，整本书出题时只挑出相关页面给 AI 看' }, () => import('./settings/RetrievalPane.jsx')),
  category({ id: 'profile', group: 'once', title: '学习画像与导览', anchors: ['settings-profile', 'settings-sample'], purpose: '载入或移除示例课程、重新看功能导览，也管理陪学的学习画像' }, () => import('./settings/ProfilePane.jsx')),
  category({ id: 'guidance', group: 'once', title: '引导', anchors: ['settings-guidance'], purpose: '各处提示和引导什么时候出现，以及 AI 带学的默认设置' }, () => import('./settings/GuidancePane.jsx')),
  category({ id: 'data', group: 'once', title: '导入、计划与备份', anchors: ['settings-data', 'settings-backup', 'settings-legacy-import'], purpose: '从旧学习库导入、间隔复习（FSRS-6）的参数，以及整个学习库的备份与恢复' }, () => import('./settings/DataPane.jsx')),
  category({ id: 'update', group: 'once', title: '关于与更新', anchors: ['settings-update', 'settings-diagnostic'], purpose: '看当前版本和最新已知版本，检查更新；有新版本时在这里升级' }, () => import('./settings/UpdatePane.jsx')),
  category({ id: 'usage', group: 'advanced', title: '使用频率记录', anchors: ['settings-usage'], needs: 'system', purpose: '只在这台电脑上记你用了哪些功能、各用了几次；默认关闭，可以随时查看、导出、暂停和删除' }, () => import('./settings/UsagePane.jsx')),
  category({ id: 'experimental', group: 'advanced', title: '实验性功能', anchors: ['settings-experimental', 'settings-jev'], needs: 'system', purpose: '显示实验性功能的总开关；默认关闭，打开后才出现还在试验的功能' }, () => import('./settings/ExperimentalPane.jsx')),
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
