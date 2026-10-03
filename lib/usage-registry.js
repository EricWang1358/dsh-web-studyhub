/* The controls StudyHub knows by a stable key (Settings › Advanced › Usage frequency record; docs/usage-frequency.md).

   One list, in one place: the key a control is recorded under, its plain name in both languages, when it is used (tier: once | daily
   | periodic, as in docs/feature-tiers.md), the group it belongs to and, for the sidebar pages, the sidebar group it sits in today.
   The page's controls carry the key in a `data-usage` attribute; everything else is keyed from its own stable hook or its
   language-independent name (ui/usage/keys.js). The same list is what "available but never used" is measured against, what names the
   rows of the personal report, and what the export carries as the key → name table.

   It lives in lib/ because the report and the export are built by the backend; ui/usage/registry.js re-exports it for the page. */

/** When a control is used (docs/feature-tiers.md): once = a course's or a feature's set-up, daily = every session, periodic = now and then. */
export const USAGE_TIERS = Object.freeze(['daily', 'periodic', 'once']);
export const USAGE_TIER_NAMES = Object.freeze({
  daily: { zh: '每天', en: 'Every day' },
  periodic: { zh: '阶段性', en: 'Now and then' },
  once: { zh: '一次性', en: 'Once per course' },
  other: { zh: '其他', en: 'Other' },
});

/** The pages (areas) a use is filed under. `other` takes whatever the page cannot name. */
export const USAGE_AREAS = Object.freeze([
  { id: 'library', zh: '学习库', en: 'Study library' },
  { id: 'review', zh: '做题', en: 'Practice' },
  { id: 'wrongbook', zh: '错题与待巩固', en: 'Mistakes & weak points' },
  { id: 'workflows', zh: '学习流', en: 'Learning flow' },
  { id: 'notes', zh: '学习笔记', en: 'Study notes' },
  { id: 'board', zh: '待办', en: 'Tasks' },
  { id: 'exam', zh: '模拟考试', en: 'Mock exam' },
  { id: 'dashboard', zh: '统计', en: 'Statistics' },
  { id: 'sources', zh: '资料', en: 'Sources' },
  { id: 'reader', zh: '阅读', en: 'Reading' },
  { id: 'generate', zh: '创建题组', en: 'Create deck' },
  { id: 'draft', zh: '草稿', en: 'Draft' },
  { id: 'manage', zh: '题组管理', en: 'Deck management' },
  { id: 'graph', zh: '知识图谱', en: 'Knowledge graph' },
  { id: 'skeleton', zh: '知识骨架', en: 'Knowledge outline' },
  { id: 'audio', zh: '音频转录', en: 'Audio transcription' },
  { id: 'live', zh: '课堂实录', en: 'Live class' },
  { id: 'settings', zh: '设置', en: 'Settings' },
  { id: 'other', zh: '其他', en: 'Other' },
]);
export const USAGE_AREA_IDS = Object.freeze(USAGE_AREAS.map(area => area.id));

/** The sidebar groups (ui/nav-order.js): the registry records which one a page sits in today, for the report's suggestions. */
export const USAGE_NAV_GROUPS = Object.freeze({
  daily: { zh: '每天', en: 'Every day' },
  periodic: { zh: '阶段性', en: 'Now and then' },
  setup: { zh: '课程准备与管理', en: 'Setup & manage' },
});

export const USAGE_GROUPS = Object.freeze({
  nav: { zh: '侧栏', en: 'Sidebar' },
  home: { zh: '学习库首页', en: 'Home' },
  review: { zh: '做题', en: 'Practice' },
  reader: { zh: '阅读', en: 'Reading' },
  generate: { zh: '出题', en: 'Creating questions' },
  import: { zh: '加资料', en: 'Adding sources' },
  settings: { zh: '设置', en: 'Settings' },
  shortcut: { zh: '快捷键', en: 'Keyboard shortcuts' },
  general: { zh: '通用', en: 'General' },
});

/** The key a click into a text box, text area or editor is recorded under: never anything about what is in it. */
export const TEXT_FIELD_KEY = 'control.text-field';

const nav = (id, zh, en, tier, navGroup, extra = {}) => ({ key: `nav.${id}`, zh, en, tier, group: 'nav', navGroup, ...extra });
const entry = (key, zh, en, tier, group, extra = {}) => ({ key, zh, en, tier, group, ...extra });
// A documented keyboard shortcut: `keys` is what the learner presses, and what the report says when it points at one.
const shortcut = (id, keys, zh, en, tier) => entry(`shortcut.${id}`, `快捷键 ${keys}：${zh}`, `${/[–/]/.test(keys) ? 'Keys' : 'Key'} ${keys}: ${en}`, tier, 'shortcut', { keys });

/** key → { key, zh, en, tier, group, navGroup?, shortcut? }. Keys are unique; every control a page marks with data-usage is listed here. */
export const USAGE_REGISTRY = Object.freeze([
  nav('library', '学习库', 'Study library', 'daily', 'daily'),
  nav('wrongbook', '错题与待巩固', 'Mistakes & weak points', 'daily', 'daily'),
  nav('workflows', '学习流', 'Learning flow', 'daily', 'daily'),
  nav('notes', '学习笔记', 'Study notes', 'daily', 'daily'),
  nav('board', '待办', 'Tasks', 'daily', 'daily'),
  nav('exam', '模拟考试', 'Mock exam', 'periodic', 'periodic'),
  nav('dashboard', '统计', 'Statistics', 'periodic', 'periodic'),
  nav('sources', '资料', 'Sources', 'daily', 'daily'),
  nav('generate', '创建题组', 'Create deck', 'daily', 'daily'),
  nav('skeleton', '知识骨架', 'Knowledge outline', 'once', 'setup'),
  nav('audio', '音频转录', 'Audio transcription', 'once', 'setup'),
  nav('live', '课堂实录', 'Live class', 'once', 'setup'),
  nav('settings', '设置', 'Settings', 'periodic', null),
  nav('resume', '回到题目', 'Return to question', 'daily', 'daily', { shortcut: 'shortcut.resume' }),
  nav('coach', '为你定制', 'Personalised', 'daily', 'daily'),
  nav('tour', '功能导览', 'Feature tour', 'once', null),
  nav('theme', '外观切换', 'Appearance toggle', 'periodic', null),
  nav('language', '界面语言', 'Interface language', 'periodic', null),
  nav('collapse', '收起/展开侧栏', 'Collapse or expand the sidebar', 'periodic', null),
  nav('group', '折叠侧栏分组', 'Fold a sidebar group', 'periodic', null),
  nav('reset', '恢复默认顺序', 'Reset the sidebar order', 'periodic', null, { hook: 'nav-reset' }),

  entry('home.start', '首页主按钮：开始或接着学习', 'Home main button: start or continue studying', 'daily', 'home', { shortcut: 'shortcut.resume' }),

  entry('review.option', '选择答案选项', 'Choose an answer option', 'daily', 'review', { shortcut: 'shortcut.digit' }),
  entry('review.submit', '提交答案', 'Submit answer', 'daily', 'review', { shortcut: 'shortcut.next' }),
  entry('review.grade', '自评打分（0–5）', 'Grade yourself (0–5)', 'daily', 'review', { shortcut: 'shortcut.digit' }),
  entry('review.derive', '出前置题…（更多菜单）', 'Make a prerequisite question… (More menu)', 'periodic', 'review'),
  entry('review.derive-prereq', '把问答出成前置题', 'Turn a Q&A into a prerequisite question', 'periodic', 'review'),
  entry('review.derive-standalone', '把问答出成独立题', 'Turn a Q&A into a separate question', 'periodic', 'review'),
  entry('review.flip', '翻面看答案', 'Flip the card', 'daily', 'review', { shortcut: 'shortcut.flip' }),
  entry('review.next', '下一题', 'Next question', 'daily', 'review', { shortcut: 'shortcut.next' }),
  entry('review.prev', '上一题', 'Previous question', 'daily', 'review', { shortcut: 'shortcut.prev' }),
  entry('review.return', '返回学习库', 'Back to the library', 'daily', 'review', { hook: 'review-return' }),
  entry('review.help', '帮我弄懂', 'Help me understand', 'daily', 'review', { shortcut: 'shortcut.explain' }),

  entry('reader.translate', '翻译（译）', 'Translate', 'daily', 'reader'),
  entry('reader.practice', '做这几页的题', 'Practise these pages', 'daily', 'reader', { shortcut: 'shortcut.practice' }),
  entry('reader.peek', '看原页', 'Original page', 'periodic', 'reader', { hook: 'reader-peek' }),
  entry('reader.display', '阅读显示设置（Aa）', 'Reading display (Aa)', 'periodic', 'reader'),

  entry('import.add', '添加资料', 'Add source', 'once', 'import'),
  entry('generate.submit', '生成并检查题组', 'Generate and check a deck', 'once', 'generate'),

  entry('settings.experimental', '显示实验性功能', 'Show experimental features', 'once', 'settings'),
  entry('settings.jev', 'Jev 总开关', 'Jev master switch', 'once', 'settings'),
  entry('settings.export', '导出学习库', 'Export library', 'periodic', 'settings'),

  shortcut('resume', 'S', '回到题目或开始今日学习', 'return to question or start today’s study', 'daily'),
  shortcut('autopilot', 'A', '自动驾驶', 'autopilot', 'periodic'),
  shortcut('help', '?', '快捷键速查', 'shortcut sheet', 'periodic'),
  shortcut('practice', 'P', '做这几页的题', 'practise these pages', 'daily'),
  shortcut('digit', '0–6', '按数字作答：自评 0–5 分，或选第 1–6 个选项', 'answer with a number: grade 0–5, or choose option 1–6', 'daily'),
  shortcut('next', 'Enter / →', '下一题或提交', 'next question or submit', 'daily'),
  shortcut('prev', '←', '上一题', 'previous question', 'daily'),
  shortcut('flip', 'Space', '翻卡', 'flip the card', 'daily'),
  shortcut('hint', 'H', '提示或讲解', 'hint or explanation', 'daily'),
  shortcut('explain', 'T', '通俗详解', 'plain explanation', 'daily'),

  entry(TEXT_FIELD_KEY, '文本输入框（只记点击，不记内容）', 'Text field (clicks only, never the content)', 'daily', 'general'),
].map(item => Object.freeze(item)));

export const USAGE_REGISTRY_BY_KEY = Object.freeze(Object.fromEntries(USAGE_REGISTRY.map(item => [item.key, item])));
export const usageEntry = key => USAGE_REGISTRY_BY_KEY[key] || null;
export const usageArea = id => USAGE_AREAS.find(area => area.id === id) || USAGE_AREAS.at(-1);

/** Existing class names that are unique to one control: class → key (ui/usage/keys.js tries these after data-usage). */
export const USAGE_CLASS_HOOKS = Object.freeze(Object.fromEntries(USAGE_REGISTRY.filter(item => item.hook).map(item => [item.hook, item.key])));

/** The shortcut keys, for the capture listener: a pressed key on a page → the registry key of the documented shortcut. */
export const USAGE_SHORTCUT_KEYS = Object.freeze(USAGE_REGISTRY.filter(item => item.group === 'shortcut').map(item => item.key));
