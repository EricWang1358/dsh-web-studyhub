// Bilingual content and structured codebase metadata for StudyHub's Tech Stack & Architecture Explorer.
// Every figure, symbol, context dependency, pipeline bound, scheduler default and test metric is verified against v4.4.5.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { actionGrants, fields, reads } from '../lib/runtime/domain-contracts.js';
import { fullContextIds } from '../lib/runtime/builtins.js';
import { FAMILIAR_DAYS, MASTERED_DAYS, MASTERED_STREAK } from '../lib/mastery.js';
import { FOCUS_RETENTION_BOOST, FSRS6_WEIGHTS, LIMITS, defaults as fsrsDefaults, initialReview, nextIntervals, previewSchedule } from '../lib/sm2.js';
import { ACTIVITIES, ALTERNATIVES_MAX, CLASSROOM_METHOD, LEVELS as GATE_LEVELS, STAGES_MAX } from '../lib/course-method.js';
import { libraryContracts } from '../lib/study-contracts.js';

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url));
export const REPO_BLOB = 'https://github.com/EricWang1358/dsh-web-studyhub/blob/main';

export function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function readSuiteSummary(root = repositoryRoot) {
  const testFiles = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
  const slow = JSON.parse(readFileSync(join(root, 'tests/slow-tests.json'), 'utf8'));
  const weights = JSON.parse(readFileSync(join(root, 'tests/test-weights.json'), 'utf8'));
  const browserSet = new Set(slow.browser || []);
  const ffmpegSet = new Set(slow.ffmpeg || []);
  const cliSet = new Set(slow.cli || []);
  const slowSet = new Set([...browserSet, ...ffmpegSet, ...cliSet]);
  const knownWeights = testFiles.map(file => weights[file]).filter(Number.isFinite).sort((a, b) => a - b);
  const medianMs = knownWeights.length ? knownWeights[Math.floor(knownWeights.length / 2)] : 1000;
  // Compact items: [tenthsOfSecond, mask, shortNameIfTop] where mask bits: 1=browser, 2=ffmpeg, 4=cli (0=fast)
  const sortedByWeight = [...testFiles].sort((a, b) => {
    const wa = Number.isFinite(weights[a]) ? weights[a] : medianMs;
    const wb = Number.isFinite(weights[b]) ? weights[b] : medianMs;
    return wb - wa || (a < b ? -1 : a > b ? 1 : 0);
  });
  const topNamed = new Set([
    ...sortedByWeight.slice(0, 32),
    ...sortedByWeight.filter(file => browserSet.has(file)).slice(0, 16),
    ...sortedByWeight.filter(file => ffmpegSet.has(file)),
    ...sortedByWeight.filter(file => cliSet.has(file)).slice(0, 16),
  ]);
  const items = testFiles.map(file => {
    const ms = Number.isFinite(weights[file]) ? weights[file] : medianMs;
    const tenths = Math.max(1, Math.round(ms / 100));
    const mask = (browserSet.has(file) ? 1 : 0) | (ffmpegSet.has(file) ? 2 : 0) | (cliSet.has(file) ? 4 : 0);
    return topNamed.has(file) ? [tenths, mask, file.slice(6, -9)] : [tenths, mask];
  });
  return {
    totalFiles: testFiles.length,
    fastFiles: testFiles.length - slowSet.size,
    slowUniqueFiles: slowSet.size,
    browserFiles: browserSet.size,
    ffmpegFiles: ffmpegSet.size,
    cliFiles: cliSet.size,
    weightedFiles: knownWeights.length,
    medianWeightMs: medianMs,
    items,
  };
}

const OP_CONTEXT_META = {
  system: {
    file: 'lib/contexts/system/index.js',
    zhRole: '库级设置、当前课程焦点与每日模型用量账本。',
    enRole: 'Library settings, active course focus, and daily per-feature model usage ledger.',
    ops: 'settings.get/update, focus.get/set, usage.estimate, usage.frequency.*',
  },
  notifications: {
    file: 'lib/contexts/notifications/index.js',
    zhRole: '后台任务收件箱信件与未读状态。',
    enRole: 'Background job inbox letters and read/open transitions.',
    ops: 'inbox.list, inbox.read, inbox.open, job.dismiss',
  },
  materials: {
    file: 'lib/contexts/materials/index.js',
    zhRole: 'PDF / Office / Markdown 资料导入、页面文本、译文与引用定位。',
    enRole: 'PDF / Office / Markdown document ingestion, page text, translations, and durable quote anchors.',
    ops: 'document.import/get/list, source.add/archive/remove, selection.resolve/ask, pages.cards',
  },
  bank: {
    file: 'lib/contexts/bank/index.js',
    zhRole: '正式题组（decks）与待审草稿（drafts）的版本化读写与合并拆分。',
    enRole: 'Versioned question decks and editable drafts, card edits, prerequisite links, merge and split.',
    ops: 'list, get, cards, append, deck.import/merge/split, card.update/convert/link, draft.save',
  },
  courses: {
    file: 'lib/contexts/courses/index.js',
    zhRole: '课程档案、考试画像、重点主题、备考计划、深度定制与可编辑学法（course.method）。',
    enRole: 'Course profiles, exam metadata, focus topics, study plans, custom blueprints, and editable course methods.',
    ops: 'course.get/save, course.plan, course.custom.preview, course.focusProgress, course.rename/merge',
  },
  study: {
    file: 'lib/contexts/study/index.js',
    zhRole: 'FSRS-6 练习轮次、客观与案例判分、分步讲解、口试及 AI 带学会话。',
    enRole: 'FSRS-6 practice rounds, rule and rubric grading, step-by-step teaching, oral exams, and guided study.',
    ops: 'review.start/answer/end, exam.submit, card.grade, teach.start/answer, oral.*, study.session.*',
  },
  authoring: {
    file: 'lib/contexts/authoring/index.js',
    zhRole: '草稿快发（结构校验）与严格审阅发布，将草稿发布入正式题组。',
    enRole: 'Quick structural publication and reviewed draft publication into active decks.',
    ops: 'draft.publish.quick, draft.publish, draft.publish.plan',
  },
  generation: {
    file: 'lib/contexts/generation/index.js',
    zhRole: '五阶段可靠出题流水线、选段补题、覆盖度续跑、复习全书与考纲构建。',
    enRole: 'Five-stage grounded generation pipeline, passage supplementation, coverage top-up, outlines, and review books.',
    ops: 'generate, supplement, selection.supplement/commit/review, courseOutline.build, courseBook.build',
  },
  audio: {
    file: 'lib/contexts/audio/index.js',
    zhRole: '课堂录音转录、双语字幕校对、实时课堂保存，以及本地 MinerU / Marker 转换管理。',
    enRole: 'Lecture audio transcription, subtitle proofreading, live class capture, and local MinerU / Marker PDF jobs.',
    ops: 'audio.import/retry, audio.subtitles.import, live.save, mineru.import/install.*, marker.import',
  },
  notes: {
    file: 'lib/contexts/notes/index.js',
    zhRole: '关联题目的学习长文笔记与按课程聚合的每日复盘信件。',
    enRole: 'Card-linked study notes and opt-in daily course recap letters.',
    ops: 'note.create/save/generate, note.daily.status/generate/advance, note.material.prepare',
  },
  recording: {
    file: 'lib/contexts/recording/index.js',
    zhRole: '粘贴错题与既有题目的原样录入（ingest）与持续监听开关。',
    enRole: 'Verbatim intake of existing questions and mistakes without inventing ungrounded items.',
    ops: 'capture, ingest, ingest.start, ingest.stop, ingest.status',
  },
  coach: {
    file: 'lib/contexts/coach/index.js',
    zhRole: '陪学画像、错因追问、同考点变式预备与题目重写回退。',
    enRole: 'Learner coaching profile, post-answer debriefs, variant preparation, and reversible card rewrites.',
    ops: 'coach.profile/reply/feedback, coach.variants, coach.practice, coach.revert',
  },
  workflows: {
    file: 'lib/contexts/workflows/index.js',
    zhRole: '已退役学习流的历史会话与模板只读归档查询。',
    enRole: 'Read-only historical archive queries for retired learning flow templates and sessions.',
    ops: 'workflow.list, workflow.session.get, workflow.context, workflow.teaching.estimate',
  },
  skeleton: {
    file: 'lib/contexts/skeleton/index.js',
    zhRole: '课程知识骨架树与主题分组管理。',
    enRole: 'Course knowledge skeleton trees and syllabus topic grouping.',
    ops: 'skeleton.save/delete, topic.groups.save',
  },
  jobs: {
    file: 'lib/contexts/jobs/index.js',
    zhRole: '统一后台任务控制面（状态、等待、并发调节、中断恢复与归档）。',
    enRole: 'Unified background job control plane for status, bounded waits, concurrency tuning, recovery, and archiving.',
    ops: 'job.status, job.wait, job.control, job.cancel, job.archive/unarchive',
  },
  library: {
    file: 'lib/contexts/library/index.js',
    zhRole: `跨上下文门面与主对话按需契约读取（library.context 的 ${Object.keys(libraryContracts).length} 个专题域）。`,
    enRole: `Cross-context workspace facade and on-demand contract reader across ${Object.keys(libraryContracts).length} library.context areas.`,
    ops: 'library.context, snapshot, course.custom.apply/fill, attachments.export/import',
  },
};

const DATA_CONTEXT_META = {
  learner: {
    file: 'lib/runtime/domain-contracts.js',
    zhRole: '纯数据上下文（仅暴露 state.read）：保存学习者画像、陪学记录、反馈与预备变式，供 study / coach / workflows 按声明端口只读访问，切断循环依赖。',
    enRole: 'Data-only context (exposes state.read only): holds learner profile, coach state, feedback, and prepared variants so study, coach, and workflows read without cyclic imports.',
  },
  'workflow-data': {
    file: 'lib/runtime/domain-contracts.js',
    zhRole: '纯数据上下文（仅暴露 state.read）：保存学习流模板与会话记录，让题库发布在固定范围成员时无需反向依赖 workflows 业务层。',
    enRole: 'Data-only context (exposes state.read only): holds workflowTemplates and workflowSessions so deck publication can pin scope members without depending on workflows.',
  },
  'skeleton-data': {
    file: 'lib/runtime/domain-contracts.js',
    zhRole: '纯数据上下文（仅暴露 state.read）：保存知识骨架与主题分组，供 authoring / skeleton / workflows 共享只读视图。',
    enRole: 'Data-only context (exposes state.read only): holds skeletons and topicGroups for acyclic read access from authoring, skeleton, and workflows.',
  },
};

export function buildExplorerNodes() {
  const plugins = [
    {
      id: 'plugin-workbench',
      group: 'plugins',
      badge: 'Workbench · 1',
      label: 'daily-flashcard',
      zhTitle: 'daily-flashcard（工作台主插件）',
      enTitle: 'daily-flashcard (Workbench Plugin)',
      zhSummary: '挂载 StudyHub 桌面/网页工作台视图、右侧栏桥接、全局看板，并向主对话注册过渡入口工具 study_workspace。',
      enSummary: 'Mounts the StudyHub workspace UI, right-panel bridge, global todo board, and registers the study_workspace transition tool.',
      owned: ['UI shell + 15 deferredView() chunks', 'panel-bridge', 'global todo board'],
      deps: ['studyRuntime', 'all 19 contexts in full workbench mode'],
      ops: 'Registers study_workspace + workspace HTTP/RPC routes',
      links: [
        ['lib/index.js', 'lib/index.js'],
        ['lib/plugins/workbench.js', 'lib/plugins/workbench.js'],
        ['docs/architecture.md', 'docs/architecture.md'],
      ],
    },
    {
      id: 'plugin-runtime',
      group: 'plugins',
      badge: 'Capability · 1/6',
      label: 'studyhub-runtime',
      zhTitle: 'studyhub-runtime（共享微内核底座）',
      enTitle: 'studyhub-runtime (Shared Runtime Kernel)',
      zhSummary: '创建以 Symbol.for("studyhub.runtime.scope.v1") 键控的共享运行时作用域，提供 studyRuntime 服务与零参数能力索引工具 study_capabilities，自身安装 0 个业务域。',
      enSummary: 'Creates the shared scope keyed by Symbol.for("studyhub.runtime.scope.v1"), provides the studyRuntime service and compact study_capabilities discovery tool, and installs 0 domain contexts itself.',
      owned: ['studyRuntime service', 'shared Cordis runtime scope'],
      deps: ['lib/runtime.js', 'lib/store.js'],
      ops: 'Provides study_capabilities (compact index vs {context, operation} schema lookup)',
      links: [
        ['lib/plugins/runtime.js', 'lib/plugins/runtime.js'],
        ['lib/runtime.js', 'lib/runtime.js'],
        ['lib/runtime/tools.js', 'lib/runtime/tools.js'],
      ],
    },
    {
      id: 'plugin-materials',
      group: 'plugins',
      badge: 'Capability · 2/6',
      label: 'studyhub-materials',
      zhTitle: 'studyhub-materials（资料能力插件）',
      enTitle: 'studyhub-materials (Materials Capability)',
      zhSummary: '独立安装 materials 与基础 system 上下文，向主对话暴露类型化工具 study_materials（17 个文档导入、页码定位与选段问答操作）。',
      enSummary: 'Installs the materials context and exposes the typed study_materials agent tool (17 operations for document import, page anchors, and grounded passage Q&A).',
      owned: ['sources', 'documents'],
      deps: ['studyhub-runtime', 'system'],
      ops: 'Provides study_materials (17 typed operations)',
      links: [
        ['lib/plugins/materials.js', 'lib/plugins/materials.js'],
        ['lib/contexts/materials/index.js', 'lib/contexts/materials/index.js'],
      ],
    },
    {
      id: 'plugin-bank',
      group: 'plugins',
      badge: 'Capability · 3/6',
      label: 'studyhub-bank',
      zhTitle: 'studyhub-bank（题库能力插件）',
      enTitle: 'studyhub-bank (Question Bank Capability)',
      zhSummary: '安装 bank 上下文，暴露 study_bank（list / get / cards / append 4 个操作），支持乐观并发版本号 expectedVersion 与逐字引用校验。',
      enSummary: 'Installs the bank context and exposes study_bank (4 operations: list, get, cards, append) with expectedVersion optimistic concurrency and verbatim quote checks.',
      owned: ['decks', 'drafts'],
      deps: ['studyhub-runtime', 'materials', 'system', 'notifications'],
      ops: 'Provides study_bank (list, get, cards, append)',
      links: [
        ['lib/plugins/bank.js', 'lib/plugins/bank.js'],
        ['lib/contexts/bank/index.js', 'lib/contexts/bank/index.js'],
      ],
    },
    {
      id: 'plugin-study',
      group: 'plugins',
      badge: 'Capability · 4/6',
      label: 'studyhub-study',
      zhTitle: 'studyhub-study（练习与排期插件）',
      enTitle: 'studyhub-study (Practice & FSRS-6 Capability)',
      zhSummary: '默认安装 bank + study（设 independent: true 时仅装 study），暴露 study_practice（10 个操作），强制揭晓前隐藏答案且禁止 AI 代答。',
      enSummary: 'Installs bank + study (or study alone when independent: true) and exposes study_practice (10 operations), keeping answers hidden before reveal and refusing proxy answers.',
      owned: ['runs', 'attempts (1,000/shard)', 'oralRuns', 'teaching', 'studySessions'],
      deps: ['studyhub-runtime', 'bank', 'courses', 'learner'],
      ops: 'Provides study_practice (review.*, exam.report, teach.*)',
      links: [
        ['lib/plugins/study.js', 'lib/plugins/study.js'],
        ['lib/sm2.js', 'lib/sm2.js'],
        ['lib/mastery.js', 'lib/mastery.js'],
      ],
    },
    {
      id: 'plugin-generation',
      group: 'plugins',
      badge: 'Capability · 5/6',
      label: 'studyhub-generation',
      zhTitle: 'studyhub-generation（可靠出题插件）',
      enTitle: 'studyhub-generation (Grounded Generation Capability)',
      zhSummary: '默认安装 materials + bank + authoring + generation（independent: true 时仅 authoring + generation），暴露 study_generate_selection（4 个操作）。',
      enSummary: 'Installs materials + bank + authoring + generation (or authoring + generation when independent: true) and exposes study_generate_selection (4 operations).',
      owned: ['selectionJobs'],
      deps: ['studyhub-runtime', 'materials', 'bank', 'authoring'],
      ops: 'Provides study_generate_selection (selection.supplement/get/commit/review)',
      links: [
        ['lib/plugins/generation.js', 'lib/plugins/generation.js'],
        ['lib/generation.js', 'lib/generation.js'],
        ['docs/generation-reliability.md', 'docs/generation-reliability.md'],
      ],
    },
    {
      id: 'plugin-audio',
      group: 'plugins',
      badge: 'Capability · 6/6',
      label: 'studyhub-audio',
      zhTitle: 'studyhub-audio（课堂音频与 PDF 转换插件）',
      enTitle: 'studyhub-audio (Audio & Local PDF Capability)',
      zhSummary: '安装独立 audio 上下文，暴露 study_audio（13 个转录、字幕校对与实时课堂保存操作），并通过显式授权端口把成稿写入资料库。',
      enSummary: 'Installs the audio context, exposes study_audio (13 transcription, subtitle review, and live recording operations), and publishes transcripts through declared material grants.',
      owned: ['audioResults'],
      deps: ['studyhub-runtime', 'materials', 'bank', 'notifications'],
      ops: 'Provides study_audio (13 operations)',
      links: [
        ['lib/plugins/audio.js', 'lib/plugins/audio.js'],
        ['lib/contexts/audio/index.js', 'lib/contexts/audio/index.js'],
      ],
    },
    {
      id: 'pkg-retrieval',
      group: 'plugins',
      badge: 'Companion Package',
      label: 'packages/studyhub-retrieval',
      zhTitle: 'packages/studyhub-retrieval（大教材本地检索扩展包）',
      enTitle: 'packages/studyhub-retrieval (Companion Retrieval Package)',
      zhSummary: '可选同仓扩展包：当选中资料超过 150,000 字符（RETRIEVE_ABOVE_CHARS）时，通过 mcp:<tool>、service 或 builtin 三种本地索引提供器先缩小证据窗口再规划考点。',
      enSummary: 'Optional companion package: when selected sources exceed 150,000 characters (RETRIEVE_ABOVE_CHARS), narrows the passage window via mcp:<tool>, service, or builtin local index providers.',
      owned: ['Local retrieval index outside exported study shards'],
      deps: ['lib/retrieval.js', 'generation retrieval runtime-port'],
      ops: 'Providers: mcp:<tool> | service | builtin (> 150,000 chars)',
      links: [
        ['packages/studyhub-retrieval/package.json', 'packages/studyhub-retrieval/package.json'],
        ['lib/retrieval.js', 'lib/retrieval.js'],
        ['docs/architecture.md', 'docs/architecture.md'],
      ],
    },
  ];

  const tools = [
    {
      id: 'tool-capabilities',
      group: 'tools',
      badge: 'Tool · 1/7',
      label: 'study_capabilities',
      zhTitle: 'study_capabilities（按需契约发现工具）',
      enTitle: 'study_capabilities (Compact API Discovery Tool)',
      zhSummary: '无参调用仅返回紧凑的上下文与操作名索引（避免一次性塞入约 106,000 字符的全量 Schema）；传入 {context} 或 {operation} 时返回省去默认值的精确输入 Schema。',
      enSummary: 'Zero-arg call returns a compact index of context IDs and grouped operation names (saving ~106,000 chars of raw tool schemas); {context} or {operation} fetches exact slimmed input schemas.',
      owned: ['Stateless discovery over StudyRuntime.capabilities()'],
      deps: ['studyhub-runtime', 'lib/runtime/tools.js'],
      ops: '{ context?: string, operation?: string }',
      links: [['lib/runtime/tools.js', 'lib/runtime/tools.js']],
    },
    {
      id: 'tool-materials',
      group: 'tools',
      badge: 'Tool · 2/7',
      label: 'study_materials',
      zhTitle: 'study_materials（17 个资料与引用操作）',
      enTitle: 'study_materials (17 Document & Citation Operations)',
      zhSummary: '面向主对话的类型化资料工具：支持 PDF/Office/MD 导入、可见选段解析、基于证据提问、章节切分以及页码关联题目查询。',
      enSummary: 'Typed material tool for importing PDF/Office/MD files, resolving selected passages, asking grounded questions, segmenting outlines, and querying page-linked cards.',
      owned: ['Delegates to materials.v1'],
      deps: ['studyhub-materials', 'materials context'],
      ops: '17 ops: document.import/get/list/attach, original.*, selection.resolve/ask, outline.*, links.list, pages.cards, enrich',
      links: [['lib/runtime/tools.js', 'lib/runtime/tools.js'], ['lib/contexts/materials/contracts.js', 'lib/contexts/materials/contracts.js']],
    },
    {
      id: 'tool-bank',
      group: 'tools',
      badge: 'Tool · 3/7',
      label: 'study_bank',
      zhTitle: 'study_bank（4 个题组读取与追加操作）',
      enTitle: 'study_bank (4 Deck Read & Append Operations)',
      zhSummary: '读取 JSON 题组（list / get / cards）或向现有普通题组幂等追加通过校验的题目（append 强制要求 expectedVersion、operationId 与 ≥12 字逐字引用）。',
      enSummary: 'Reads JSON decks (list, get, cards) and appends verified cards once into an active deck (requiring expectedVersion, operationId, and >= 12-char verbatim citations).',
      owned: ['Delegates to bank.v1'],
      deps: ['studyhub-bank', 'bank context'],
      ops: '4 ops: list, get, cards, append',
      links: [['lib/runtime/tools.js', 'lib/runtime/tools.js'], ['lib/contexts/bank/index.js', 'lib/contexts/bank/index.js']],
    },
    {
      id: 'tool-practice',
      group: 'tools',
      badge: 'Tool · 4/7',
      label: 'study_practice',
      zhTitle: 'study_practice（10 个练习与分步讲解操作）',
      enTitle: 'study_practice (10 Practice & Stepwise Teaching Operations)',
      zhSummary: '通过独立策略接口启动与推进练习：揭晓前隐藏答案，客观题规则判分，teach.start 显式区分理解模式与计算模式，严禁替学习者作答。',
      enSummary: 'Drives practice rounds and stepwise teaching (understanding vs calculation modes) while keeping answers hidden before reveal and forbidding assistant auto-answering.',
      owned: ['Delegates to study.v1'],
      deps: ['studyhub-study', 'study context'],
      ops: '10 ops: review.start/get/reveal/answer/move/end, exam.report, teach.start/get/answer',
      links: [['lib/runtime/tools.js', 'lib/runtime/tools.js'], ['lib/contexts/study/index.js', 'lib/contexts/study/index.js']],
    },
    {
      id: 'tool-generate-selection',
      group: 'tools',
      badge: 'Tool · 5/7',
      label: 'study_generate_selection',
      zhTitle: 'study_generate_selection（4 个选段出题操作）',
      enTitle: 'study_generate_selection (4 Passage Generation Operations)',
      zhSummary: '针对已校验的原文选段生成经独立审阅的候选题目并追加至目标题组，持久化保存候选以便查询、复审或重试。',
      enSummary: 'Generates independently reviewed questions from a validated material selection into an existing deck with persisted candidate state for inspection or retry.',
      owned: ['Delegates to generation.v1'],
      deps: ['studyhub-generation', 'generation context'],
      ops: '4 ops: selection.supplement, selection.get, selection.commit, selection.review',
      links: [['lib/runtime/tools.js', 'lib/runtime/tools.js'], ['lib/contexts/generation/contracts.js', 'lib/contexts/generation/contracts.js']],
    },
    {
      id: 'tool-audio',
      group: 'tools',
      badge: 'Tool · 6/7',
      label: 'study_audio',
      zhTitle: 'study_audio（13 个录音转录与实时课堂操作）',
      enTitle: 'study_audio (13 Audio & Live Class Operations)',
      zhSummary: '管理后台音频转录、带时间戳字幕导入、校对复核与实时课堂保存；不接受对话内明文密钥，密钥状态脱敏返回。',
      enSummary: 'Manages background audio transcription, timestamped subtitle imports, correction review, and live recordings while masking provider keys.',
      owned: ['Delegates to audio.v1'],
      deps: ['studyhub-audio', 'audio context'],
      ops: '13 ops: results, result.get, jobs, job.wait/cancel, audio.settings.get, audio.import/retry, audio.subtitles.import, audio.corrections.review, live.list/get/save',
      links: [['lib/runtime/tools.js', 'lib/runtime/tools.js'], ['lib/contexts/audio/index.js', 'lib/contexts/audio/index.js']],
    },
    {
      id: 'tool-workspace',
      group: 'tools',
      badge: 'Tool · 7/7',
      label: 'study_workspace',
      zhTitle: 'study_workspace（工作台全能力桥接工具）',
      enTitle: 'study_workspace (Workbench Transition Entry Tool)',
      zhSummary: '主工作台动作入口（action + payload_json）：覆盖课程学法、复习全书、AI 带学、看板与深度定制，并显式拦截仅限面板点击的操作（如 usage.frequency.*、mineru.install.*）。',
      enSummary: 'Workbench action bridge (action + payload_json) covering course methods, review books, guided study, todo board, and custom plans while refusing UI-only actions like usage.frequency.*.',
      owned: ['Dispatches across StudyRuntime + library.context'],
      deps: ['daily-flashcard', 'lib/study-contracts.js'],
      ops: `library.context (${Object.keys(libraryContracts).length} areas) + full workspace operations`,
      links: [['lib/index.js', 'lib/index.js'], ['lib/study-contracts.js', 'lib/study-contracts.js']],
    },
  ];

  const contexts = fullContextIds.map(id => {
    const isDataOnly = Object.hasOwn(DATA_CONTEXT_META, id);
    const meta = isDataOnly ? DATA_CONTEXT_META[id] : OP_CONTEXT_META[id];
    const ownedFields = fields[id] || [];
    const readPorts = reads[id] || [];
    const grants = actionGrants[id] ? Object.entries(actionGrants[id]).map(([target, list]) => `${target}: ${list.join(', ')}`) : [];
    return {
      id: `ctx-${id}`,
      group: 'contexts',
      badge: isDataOnly ? 'Data-Only Context' : 'Operation Context',
      label: id,
      zhTitle: `${id}（${isDataOnly ? '纯数据只读上下文' : '业务操作上下文'}）`,
      enTitle: `${id} (${isDataOnly ? 'Data-Only Context' : 'Operation Context'})`,
      zhSummary: meta.zhRole,
      enSummary: meta.enRole,
      owned: ownedFields.length ? ownedFields : ['(stateless / delegates writes via declared grants)'],
      deps: [
        `reads: ${readPorts.join(', ') || 'none'}`,
        ...(grants.length ? [`grants: ${grants.join(' | ')}`] : []),
      ],
      ops: isDataOnly ? 'state.read only (no folder under lib/contexts/)' : meta.ops,
      links: [
        [meta.file, meta.file],
        ['lib/runtime/domain-contracts.js', 'lib/runtime/domain-contracts.js'],
      ],
    };
  });

  const storageAndUi = [
    {
      id: 'infra-store-v5',
      group: 'storage',
      badge: 'Store v5 · Sharded',
      label: 'study-sharded (v5)',
      zhTitle: '分片内容寻址存储 v5（lib/store.js）',
      enTitle: 'Sharded Content-Addressed Store v5 (lib/store.js)',
      zhSummary: 'manifest v5（format: "study-sharded"）：答题记录按每片 1,000 条（ATTEMPT_CHUNK）切分，题组/资料逐条独立成片，文件名采用 20 位 SHA-1 内容哈希，解析结果深冻结（deep-freeze）后跨快照共享内存；后台任务归档上限 200 条 / 90 天。',
      enSummary: 'Manifest v5 (format: "study-sharded"): chunks attempts at 1,000 records/shard (ATTEMPT_CHUNK), stores sources and decks per item under 20-hex SHA-1 content-addressed filenames, deep-freezes parsed shards in memory, and caps job-archive.json at 200 records / 90 days.',
      owned: ['manifest.json (v5)', '1,000 attempts/shard', '20-hex SHA-1 shard files', 'job-archive.json (<= 200 / 90d)'],
      deps: ['Atomic temp-file + rename writes', 'eslint no-restricted-imports fence'],
      ops: 'item | chunk (1000) | whole modes via createStatePort()',
      links: [
        ['lib/store.js', 'lib/store.js'],
        ['lib/job-archive.js', 'lib/job-archive.js'],
        ['lib/runtime/builtins.js', 'lib/runtime/builtins.js'],
      ],
    },
    {
      id: 'infra-lazy-ui',
      group: 'storage',
      badge: 'UI · 8 + 7 Lazy Chunks',
      label: 'deferredView() Boundaries',
      zhTitle: '按需分块加载视图边界（ui/workspace-views.jsx）',
      enTitle: 'Lazy UI View Boundaries (ui/workspace-views.jsx)',
      zhSummary: '首屏仅保留高频日常闭环（资料、生成、草稿、练习、错题本）；8 个可选重型功能视图（BlogNotes、Skeleton、Workflows、Graph、TaskConsole、AudioDashboard、DocumentViewer、LiveClass）与 7 个低频页面（GuidedStudy、Dashboard、Exam、ExamPrep、CourseOutline、BookPage、Board）共 15 个 deferredView() 边界及 PagePeek 在首次打开时独立加载。',
      enSummary: 'Keeps the daily study loop in the initial bundle while isolating 8 optional feature views (BlogNotes, Skeleton, Workflows, Graph, TaskConsole, AudioDashboard, DocumentViewer, LiveClass) plus 7 occasional pages (GuidedStudy, Dashboard, Exam, ExamPrep, CourseOutline, BookPage, Board) into 15 deferredView() chunks (plus lazy PagePeek).',
      owned: ['8 optional feature views + 7 occasional pages = 15 deferredView() chunks'],
      deps: ['ui/deferred-view.jsx', 'LiveClass stays mounted across route switches while recording'],
      ops: 'Independent error + loading boundary per surface',
      links: [
        ['ui/workspace-views.jsx', 'ui/workspace-views.jsx'],
        ['ui/tokens.css', 'ui/tokens.css'],
        ['docs/architecture.md', 'docs/architecture.md'],
      ],
    },
  ];

  return [...plugins, ...tools, ...contexts, ...storageAndUi];
}

export const OPEN_PRIMITIVES = [
  {
    code: '01 · SKILLS',
    zhTitle: '6 个模块化场景技能（Skills）',
    enTitle: '6 Modular Agent Skills',
    zhBody: '将带学（study-tutor）、导览（study-guide）、多源导入（study-import）、复习全书（study-book）、深度定制（study-custom）与目标自学建课（study-self）拆成按需挂载的 SKILL.md，而非把死板步骤硬编码进单一系统提示词。',
    enBody: 'Splits tutoring (study-tutor), onboarding (study-guide), multi-format intake (study-import), review-book co-authoring (study-book), custom planning (study-custom), and goal-driven self-study setup (study-self) into on-demand SKILL.md playbooks instead of one rigid prompt.',
    file: 'skills/study-tutor/SKILL.md',
  },
  {
    code: '02 · CONTRACTS',
    zhTitle: `${Object.keys(libraryContracts).length} 个按需契约域与真源常量`,
    enTitle: `${Object.keys(libraryContracts).length} On-Demand Contract Areas`,
    zhBody: '主对话通过 library.context 按需读取单域契约（如 guided / plan / custom / book），所有字数、页数、题型上限直接从执行校验的 JS 常量拼装，绝不手抄第二份过时文档。',
    enBody: 'The main chat loads only the relevant library.context contract area (guided, plan, custom, book, etc.), with every byte, page, and card limit interpolated directly from live enforcement constants.',
    file: 'lib/study-contracts.js',
  },
  {
    code: '03 · DATA FENCES',
    zhTitle: '动态反引号数据围栏与缓存友好人设',
    enTitle: 'Dynamic Backtick Data Fences',
    zhBody: '静态人设（presets/study.patch.yml）仅含模型变量以稳定命中前缀缓存；不可信课件与题面装入反引号长度动态取 max+1 的 :data 围栏，学习者意图独立装入 :request 围栏，阻断提示词注入。',
    enBody: 'Keeps presets/study.patch.yml static for prompt-cache stability while wrapping untrusted course text in dynamically sized (max backtick run + 1) :data fences separate from :request user intent.',
    file: 'ui/agent-prompts/message.js',
  },
  {
    code: '04 · COURSE METHODS',
    zhTitle: `可与主对话共创的每课「学法」（1–${STAGES_MAX} 阶段）`,
    enTitle: `Co-Designed Per-Course Methods (1-${STAGES_MAX} Stages)`,
    zhBody: `每门课可独立保存由 ${ACTIVITIES.length} 类活动（${ACTIVITIES.join(' / ')}）、最多 ${ALTERNATIVES_MAX} 个备选动作与 ${GATE_LEVELS.length} 档过关线（loose / medium 2/3 通过·0.8 进阶 / strict）组成的学法；默认 ${CLASSROOM_METHOD.stages.length} 阶段「${CLASSROOM_METHOD.name}」只是普通数据，随时可与主对话协商改写。`,
    enBody: `Each course stores an editable 1-${STAGES_MAX} stage method built from ${ACTIVITIES.length} composable activities (${ACTIVITIES.join(', ')}), up to ${ALTERNATIVES_MAX} alternatives per stage, and ${GATE_LEVELS.length} gate levels (loose, medium 2/3 pass & 0.8 advance, strict 1.0); the ${CLASSROOM_METHOD.stages.length}-stage default method is plain data saved via course.save { method }.`,
    file: 'lib/course-method.js',
  },
];

export const PIPELINE_STAGES = [
  {
    step: 1,
    id: 'plan',
    fn: 'planAssessment() + groundedPlan()',
    file: 'lib/assessment-quality.js',
    budgetZh: '每组 ≤ 60,000 字符 · 每次规划 ≤ 10 个考点 · 最多 1 次纠错重问 + 逐条挽救',
    budgetEn: '<= 60,000 chars/group · <= 10 targets/call · at most 1 corrective retry + target-level salvage',
    zhTitle: '1. 考点规划与逐字引文核验（Plan）',
    enTitle: '1. Evidence Planning & Verbatim Quote Check (Plan)',
    zhSummary: '模型先从资料分片中提取不重叠的考查目标（≤ 10 个），每个目标必须附带原文逐字引文（≥ 12 个字符）。本地代码用 NFKC 字母数字归一化逐页核对；若模型标错页码但引文在同批其他页逐字存在，自动重归属真实 sourceId。',
    enSummary: 'Extracts up to 10 distinct assessment targets per chunk, each carrying a verbatim >= 12-character quote. Code verifies quotes with NFKC alphanumeric normalization and automatically reattributes cross-page sourceId mismatches when the quote appears verbatim in another selected source.',
    inputShape: 'sources[{ id, title, text <= 60000 chars }], count <= 10, kind, focusTopics?, assignments?, existing[]',
    outputShape: 'targets[{ targetId: "target-1", objective, knowledge, section?, focus?, citations[{ sourceId, quote >= 12 chars }] }], dropped?[]',
    gateZh: '零模型成本校验：引文长度 ≥ 12、原文精确定位（lib/quote-match.js）、与既有题组目标去重；失败时仅对问题引文做 1 次指名重问，随后保留已核实的合法考点。',
    gateEn: 'Zero-model gate: quote >= 12 chars, exact passage match (lib/quote-match.js), and duplicate-objective filtering; 1 targeted retry naming missing quotes/allowed sourceIds, then target-level salvage.',
  },
  {
    step: 2,
    id: 'blueprint',
    fn: 'blueprintAssessment() + checkCalculation()',
    file: 'lib/assessment-quality.js',
    budgetZh: '每批 ≤ 5 题 · 最多 1 次蓝图纠错重问 + 单题级挽救 · 确定性算式与单位核对（0 次额外调用）',
    budgetEn: '<= 5 items/part · at most 1 corrective retry + item-level salvage · deterministic arithmetic & unit check (0 extra calls)',
    zhTitle: '2. 答案与计算蓝图锁定（Blueprint）',
    enTitle: '2. Answer, Distractor & Calculation Lock (Blueprint)',
    zhSummary: '在动笔写题干前先锁定每道题的唯一支撑答案、推理链、比较维度（comparisonAxis）、情境类型（none | constructed | source）、干扰项错因或评分细则；计算题额外经过确定性算术与单位换算检查器。',
    enSummary: 'Locks each item’s supported answer, reasoning chain, comparisonAxis, scenario mode (none | constructed | source), distractors/rubric/cloze blanks, and runs deterministic arithmetic and unit conversion checks before stem authoring begins.',
    inputShape: 'verifiedTargets[<= 5], sourcePassages, notation: "auto" | "text" | "latex"',
    outputShape: 'blueprintItems[{ targetId, answer, reasoning, comparisonAxis, scenario, options[] | rubric | cloze, calculation? }]',
    gateZh: 'checkCalculation（lib/calculation-check.js）核验 10^-12..10^12 数量级与 mm/cm/m/km、g/kg、s/min/h、% 换算；wrapItemMath 统一公式定界符；不合格项最多重问 1 次后仅丢弃坏项。',
    gateEn: 'checkCalculation (lib/calculation-check.js) verifies 10^-12..10^12 magnitudes and mm/cm/m/km, g/kg, s/min/h, % conversions; wrapItemMath normalizes TeX delimiters; 1 retry then item-level salvage.',
  },
  {
    step: 3,
    id: 'author',
    fn: 'authorPrompts() + bindSupportedAnswers() + autofixDeck()',
    file: 'lib/generation.js',
    budgetZh: '每批 1 次写题调用（并行度 concurrency = 4）· 仅当 0 题可恢复时重问 1 次 JSON · 绑定与自动修复 0 次模型调用',
    budgetEn: '1 author call/part (concurrency = 4) · 1 JSON retry only if 0 cards recovered · 0 model calls for answer binding & autofix',
    zhTitle: '3. 题干撰写、支撑答案硬绑定与本地修复（Author + Bind）',
    enTitle: '3. Stem Authoring, Answer Binding & Deterministic Autofix',
    zhSummary: '模型撰写自包含题干、提示与解析；若输出在尾部被截断，括号平衡扫描器（salvageAuthoredCards）直接提取已闭合的完整题目。随后代码按 targetId 用第 2 步锁定的答案、选项、评分点与引文强制覆盖作者输出，杜绝写题阶段篡改事实。',
    enSummary: 'Authors self-contained stems, hints, and explanations. If output JSON truncates mid-stream, a balanced-brace scanner (salvageAuthoredCards) extracts completed card objects. Code then overwrites objective, citations, answer, options, rubric, and cloze by targetId from Stage 2.',
    inputShape: 'lockedBlueprint[<= 5], styleReferences? (untrusted form-only examples)',
    outputShape: 'boundCards[{ id, targetId, kind, topic, prompt, answer, options?, rubric?, cloze?, hint, explanation, citations }]',
    gateZh: 'bindSupportedAnswers 强制回写已锁定的答案与引文；autofixDeck（lib/card-autofix.js）本地补齐缺失主题/提示并修复裸露数学符号，不消耗任何模型 Token。',
    gateEn: 'bindSupportedAnswers enforces Stage 2 answers and Stage 1 citations; autofixDeck (lib/card-autofix.js) repairs missing topics/hints and bare math delimiters locally with 0 model tokens.',
  },
  {
    step: 4,
    id: 'review',
    fn: 'cardLocalIssues() + singleRoundReview()',
    file: 'lib/generation.js',
    budgetZh: '本地确定性门禁 0 次调用 + 1 次独立审阅调用 · 协议缺失最多追加补问 REVIEW_REASKS = 2 次（保前缀缓存）',
    budgetEn: '0-call local deterministic gates + 1 independent editor call · up to REVIEW_REASKS = 2 protocol re-asks appended for cache reuse',
    zhTitle: '4. 本地确定性门禁 + 六维独立审阅（Local + Independent Review）',
    enTitle: '4. Local Deterministic Gates + 6-Dimension Independent Review',
    zhSummary: '先过本地规则门禁（拦截“根据课件/讲义”上下文依赖、提示泄底、空解析、填空占位符失配、正确项鹤立鸡群）；再交由不看写题推理过程的独立审阅提示词，从 6 个维度逐题打分，严格区分阻断缺陷（fail）与非阻断建议（suggest）。',
    enSummary: 'Runs deterministic local checks (catching "according to the slides" leaks, answer-in-hint leaks, broken cloze markers, and option length/cue giveaways) followed by 1 independent editor call across 6 dimensions separating blocking fail verdicts from non-blocking suggest notes.',
    inputShape: 'boundCards[], citedSourceSnippets[] (independent editor prompt without author scratchpad)',
    outputShape: '{ issues: string[], suggestions: string[], summary: string, checks: [{ cardId, selfContained, answerLeak, optionQuality, learningValue, sourceSupport, explanationQuality, explanation }] }',
    gateZh: '6 个审阅维度：selfContained、answerLeak、optionQuality、learningValue、sourceSupport、explanationQuality；suggest 建议保留卡片供学习者参考，绝不误杀合格题。',
    gateEn: '6 dimensions: selfContained, answerLeak, optionQuality, learningValue, sourceSupport, explanationQuality; suggest notes never drop a grounded card.',
  },
  {
    step: 5,
    id: 'patch',
    fn: 'patchPrompts() + reserve / fillRounds',
    file: 'lib/generation-yield.js',
    budgetZh: '仅措辞缺陷题做 1 次批量改写 + 1 次子集复审 · 缺口补齐上限 fillRounds = 2（可设 0..4，预留槽位 ≤ 3）',
    budgetEn: '1 batched patchPrompts rewrite + 1 subset re-review for wording-only fails · shortfall capped at fillRounds = 2 (configurable 0..4, reserve <= 3)',
    zhTitle: '5. 有界措辞修补与诚实缺口补齐（Bounded Patch + Fill）',
    enTitle: '5. Bounded Wording Patch & Honest Shortfall Fill',
    zhSummary: '若题目证据扎实但仅因题干/提示/干扰项措辞被标 fail，执行 1 次冻结答案与引文的批量措辞改写（PATCH_FIELDS）并只复审改过的子集；若仍有数量缺口，最多携带前轮拒因摘要（priorRoundBrief）补跑 2 轮，证据不足时诚实报告实得题数，绝不死循环凑数。',
    enSummary: 'Cards failing only on wording fields (PATCH_FIELDS) get 1 batched rewrite with bound answers and citations frozen, plus 1 subset re-audit. Remaining shortfall runs at most fillRounds = 2 carrying priorRoundBrief rejection summaries, then reports exact actual counts if evidence is exhausted.',
    inputShape: 'wordingFailedCards[] (answers & citations frozen) + shortfallCount + priorRoundBrief[]',
    outputShape: 'acceptedDeck + omissionReport{ requested, accepted, droppedByReason, recoverableDraft }',
    gateZh: '绝不重改已验证的答案与逐字引用；改写仍不合格则果断丢弃并写入草稿缺口原因，杜绝无界 Token 消耗。',
    gateEn: 'Never mutates verified answers or verbatim citations; cards still failing after 1 patch are dropped with transparent omission reasons instead of unbounded retries.',
  },
];

export const FAILURE_MODES = [
  {
    id: 'hallucinated-quote',
    targetStage: 1,
    zhLabel: '幻觉引文或跨页标错来源',
    enLabel: 'Hallucinated quote or wrong page ID',
    zhWhat: '模型编造了原文没有的句子，或引文低于 12 字，或把第 8 页的原话标到了第 5 页。',
    enWhat: 'The model paraphrases instead of quoting verbatim, emits fewer than 12 characters, or cites page 5 for a sentence on page 8.',
    zhDefense: '第 1 阶段 groundedPlan() 先在已选页面中做 NFKC 归一化跨页检索：若原话在第 8 页逐字出现则自动修正 sourceId（0 次重问）；若确属编造，发起最多 1 次点名纠错，仍无实据则仅剔除该考点并保留其余合法考点。',
    enDefense: 'Caught in Stage 1 (groundedPlan): NFKC cross-page scan silently reattributes the true sourceId when the quote exists in another selected page (0 retries); truly invented quotes get at most 1 named corrective retry before target-level salvage drops only that target.',
  },
  {
    id: 'calc-mismatch',
    targetStage: 2,
    zhLabel: '计算题算式或单位换算错位',
    enLabel: 'Calculation step or unit mismatch',
    zhWhat: '蓝图给出的推导算式结果与最终数值答案不符，或毫米/米、分钟/秒等单位换算漏乘系数。',
    enWhat: 'A numerical blueprint’s intermediate formula evaluates to a different value or unit magnitude than its stated answer.',
    zhDefense: '第 2 阶段 checkCalculation()（lib/calculation-check.js）在写题干前用确定性解析器核验 10^-12..10^12 幂次与常用物理/百分比单位，不一致立即触发最多 1 次蓝图纠错，避免带着错答案去写题干和解析。',
    enDefense: 'Caught in Stage 2 (checkCalculation in lib/calculation-check.js): deterministic expression and unit verifier checks 10^-12..10^12 magnitudes and unit pairs before stem authoring, triggering at most 1 blueprint retry.',
  },
  {
    id: 'truncated-or-drifted',
    targetStage: 3,
    zhLabel: '写题输出截断或擅自改动答案',
    enLabel: 'Truncated JSON or author answer drift',
    zhWhat: '长批次 JSON 在第 4 题末尾因输出上限中断，或者写题模型为了凑题面悄悄改掉了第 2 步锁定的正确选项。',
    enWhat: 'Batch output cuts off mid-JSON on card 4, or the authoring model subtly alters the locked Stage 2 answer while phrasing options.',
    zhDefense: '第 3 阶段 salvageAuthoredCards() 通过引号感知的括号平衡扫描直接救回前 3 道完整题目（仅在救回 0 题时重问 1 次）；紧接着 bindSupportedAnswers() 按 targetId 强制覆盖答案、选项正误与引用，作者无法篡改事实。',
    enDefense: 'Caught in Stage 3: string-aware balanced-brace scanning (salvageAuthoredCards) salvages cards 1-3 without retrying (retrying once only if 0 cards parse), then bindSupportedAnswers() overwrites answers, options, rubrics, and citations from Stage 2.',
  },
  {
    id: 'context-or-leak',
    targetStage: 4,
    zhLabel: '“根据课件第3页”或题干/提示泄底',
    enLabel: '"According to slide 3" or answer leak',
    zhWhat: '题干脱离原课件就无法作答（出现“如讲义所示”），或提示/主题直接包含了标准答案关键词。',
    enWhat: 'The stem depends on unseen slide layout ("according to the lecture notes") or leaks the answer text inside the topic or hint.',
    zhDefense: '第 4 阶段本地规则（learnerContextIssues / answerLeakIssues）0 Token 先行拦截明显泄底与上下文依赖；随后独立审阅模型在 6 个维度复核，把致命问题标为 fail，而把“表述可更精炼”留作不删题的 suggest。',
    enDefense: 'Caught in Stage 4: deterministic learnerContextIssues and answerLeakIssues flag non-self-contained stems and leaks at 0 token cost; the 6-dimension independent editor marks true defects as fail while keeping minor polish notes as non-blocking suggest.',
  },
  {
    id: 'wording-only-defect',
    targetStage: 5,
    zhLabel: '证据扎实但题面措辞有小瑕疵',
    enLabel: 'Grounded card with wording-only defect',
    zhWhat: '考点与引用完全成立，但某个干扰项区分度偏弱或题干句式拗口，直接整题丢弃会浪费前四步算力。',
    enWhat: 'Citations and locked answer are solid, but a distractor cue or stem phrasing failed review — dropping the whole card would waste Stages 1-4.',
    zhDefense: '第 5 阶段识别仅涉及 PATCH_FIELDS（topic / prompt / hint / explanation / 干扰项文本）的失败卡，冻结答案与引用做 1 次批量改写 + 1 次子集复审；剩余缺口最多跑 fillRounds = 2 轮后诚实收敛。',
    enDefense: 'Rescued in Stage 5 (lib/generation-yield.js): freezes bound answers and citations, runs 1 batched patchPrompts rewrite over PATCH_FIELDS plus 1 subset re-review, and bounds any remaining shortfall to fillRounds = 2.',
  },
];

export function renderExplorerContent(lang = 'zh', { version = '4.4.5' } = {}) {
  const c = (zh, en) => (lang === 'en' ? en : zh);
  const doc = (path, label) => `<a class="src-link" href="${escHtml(`${REPO_BLOB}/${path}`)}" target="_blank" rel="noopener">${escHtml(label || path)}</a>`;
  const nodes = buildExplorerNodes();
  const suite = readSuiteSummary();
  const defaultPreview = previewSchedule(fsrsDefaults, { grade: 4, reviews: 6 }) || [];
  const initialHints = nextIntervals(initialReview(), '2026-01-01T00:00:00.000Z', fsrsDefaults);
  const dayUnit = c('天', 'd');
  const firstNode = nodes[0];
  const firstStage = PIPELINE_STAGES[0];
  const firstFailure = FAILURE_MODES[0];

  const localizedNodes = nodes.map(node => ({
    id: node.id,
    group: node.group,
    badge: node.badge,
    label: node.label,
    title: lang === 'en' ? node.enTitle : node.zhTitle,
    summary: lang === 'en' ? node.enSummary : node.zhSummary,
    owned: node.owned,
    deps: node.deps,
    ops: node.ops,
    links: node.links,
  }));

  const localizedStages = PIPELINE_STAGES.map(stage => ({
    step: stage.step,
    id: stage.id,
    fn: stage.fn,
    file: stage.file,
    budget: lang === 'en' ? stage.budgetEn : stage.budgetZh,
    title: lang === 'en' ? stage.enTitle : stage.zhTitle,
    summary: lang === 'en' ? stage.enSummary : stage.zhSummary,
    inputShape: stage.inputShape,
    outputShape: stage.outputShape,
    gate: lang === 'en' ? stage.gateEn : stage.gateZh,
  }));

  const localizedFailures = FAILURE_MODES.map(item => ({
    id: item.id,
    targetStage: item.targetStage,
    label: lang === 'en' ? item.enLabel : item.zhLabel,
    what: lang === 'en' ? item.enWhat : item.zhWhat,
    defense: lang === 'en' ? item.enDefense : item.zhDefense,
  }));

  const clientPayload = {
    lang,
    version,
    repoBlob: REPO_BLOB,
    nodes: localizedNodes,
    stages: localizedStages,
    failures: localizedFailures,
    suite,
    i18n: lang === 'en'
      ? {
          themeToDark: 'Dark ink desk',
          themeToLight: 'Light paper desk',
          ownedLabel: 'Owned state / boundary',
          depsLabel: 'Declared reads & action grants',
          opsLabel: 'Surface / operations',
          sourceLabel: 'Source files (v' + version + ')',
          stageBadge: 'Stage',
          budgetLabel: 'Bounded call & retry budget',
          inputLabel: 'Input contract',
          outputLabel: 'Output contract',
          gateLabel: 'Deterministic & independent gate',
          caughtAt: 'Handled at Stage',
          levelNames: { new: 'New', weak: 'Weak', learning: 'Learning', familiar: 'Familiar', mastered: 'Mastered' },
          gradeNames: { 1: 'Again (1)', 3: 'Hard (3)', 4: 'Good (4)', 5: 'Easy (5)' },
          noReviewsYet: 'Unstudied card — showing 6-review Good (4) projection at current target recall. Click any grade button to simulate real answers.',
          historyPrefix: 'Simulated review history',
          dayUnit: 'd',
          reviewLabel: 'R',
          reviewSuffix: '',
          nextDuePrefix: 'Next review in',
          daysWord: 'days',
          focusActive: 'Focus boost +0.04 active',
          focusOff: 'Standard recall target',
          ruleNew: 'Unanswered: 0 repetitions -> New.',
          ruleWeak: 'Latest grade < 3 -> Weak (passing streak reset to 0, lapses incremented if previously learned).',
          ruleEasy5: 'Self-grade 5 (Easy) -> Immediate Mastered badge while scheduled review still continues on its FSRS-6 interval.',
          ruleMastered: 'Interval >= 21d AND passing streak >= 2 -> Mastered.',
          ruleFamiliar: 'Interval >= 6d (and below 21d/2-streak threshold) -> Familiar.',
          ruleLearning: 'Grade >= 3 with interval < 6d -> Learning.',
          shardTitlePrefix: 'Shard',
          ofWord: 'of',
          filesWord: 'files',
          estWeightWord: 'weighted load',
          balanceWord: 'Max/min balance',
          heaviestWord: 'Heaviest files in selected shard',
          noMatchingFiles: 'No files in this shard for the selected tier.',
          subTierCmdComment: '# CLI --shard=I/N partitions the full (or --fast) suite; run slow sub-tier files explicitly:',
          tierNames: {
            all: 'Full suite',
            fast: 'Fast tier (--fast)',
            slow: 'All slow-listed',
            browser: 'Browser (Playwright)',
            ffmpeg: 'FFmpeg media',
            cli: 'Child CLI / process',
          },
        }
      : {
          themeToDark: '深色砚台',
          themeToLight: '浅色纸面',
          ownedLabel: '拥有状态与存储边界',
          depsLabel: '声明式只读端口与跨上下文授权',
          opsLabel: '暴露能力与操作集',
          sourceLabel: '源码定位（v' + version + '）',
          stageBadge: '阶段',
          budgetLabel: '有界调用与重试上限',
          inputLabel: '输入契约',
          outputLabel: '输出契约',
          gateLabel: '确定性门禁与独立审阅机制',
          caughtAt: '拦截 / 挽救于第',
          levelNames: { new: '未学', weak: '薄弱', learning: '学习中', familiar: '熟悉', mastered: '已掌握' },
          gradeNames: { 1: '重来 (1)', 3: '勉强 (3)', 4: '熟练 (4)', 5: '轻松 (5)' },
          noReviewsYet: '尚未作答 —— 当前展示该目标保持率下连续 6 次「熟练 (4)」的默认预测曲线；点击上方任一评分按钮开始实时推演。',
          historyPrefix: '实时作答轨迹',
          dayUnit: '天',
          reviewLabel: '第 ',
          reviewSuffix: ' 次',
          nextDuePrefix: '下次复习间隔',
          daysWord: '天',
          focusActive: '已开启重点提频（+0.04）',
          focusOff: '常规目标保持率',
          ruleNew: '尚未作答（repetitions = 0）→ 未学（new）。',
          ruleWeak: '最近一次有效作答 < 3 分 → 薄弱（weak，连对归零，已学卡计一次遗忘 lapse）。',
          ruleEasy5: '自评 5 分（轻松掌握）→ 立即标为已掌握（mastered），同时继续按 FSRS-6 间隔排期复习。',
          ruleMastered: '间隔 ≥ 21 天且连续答对 ≥ 2 次 → 已掌握（mastered）。',
          ruleFamiliar: '间隔 ≥ 6 天（未满 21 天 + 连对 2 次）→ 熟悉（familiar）。',
          ruleLearning: '最近作答 ≥ 3 分且间隔 < 6 天 → 学习中（learning）。',
          shardTitlePrefix: '分片',
          ofWord: '/',
          filesWord: '个测试文件',
          estWeightWord: '权重耗时',
          balanceWord: '最大/最小负载均衡比',
          heaviestWord: '当前选中分片内最重的测试文件',
          noMatchingFiles: '当前筛选层级下该分片无测试文件。',
          subTierCmdComment: '# CLI --shard=I/N 作用于全量（或 --fast）套件；单独运行该慢速子集请显式传入文件：',
          tierNames: {
            all: '全量测试集',
            fast: '快速层（--fast）',
            slow: '全部慢速层文件',
            browser: '浏览器层（Playwright）',
            ffmpeg: '音视频层（FFmpeg）',
            cli: '子进程 / CLI 层',
          },
        },
  };

  const renderGroupButtons = (groupKey, headingZh, headingEn) => {
    const groupNodes = localizedNodes.filter(item => item.group === groupKey);
    return `<div class="node-cluster" data-cluster="${escHtml(groupKey)}">
      <div class="cluster-head">
        <h3>${escHtml(c(headingZh, headingEn))}</h3>
        <span class="cluster-count">${groupNodes.length}</span>
      </div>
      <div class="node-grid">
        ${groupNodes.map((node, index) => {
          const isSelected = node.id === firstNode.id && index === 0 && groupKey === 'plugins';
          return `<button type="button" class="arch-node${isSelected ? ' is-selected' : ''}" data-node-id="${escHtml(node.id)}" data-node-group="${escHtml(node.group)}" aria-pressed="${isSelected ? 'true' : 'false'}">
            <span class="arch-node-badge">${escHtml(node.badge)}</span>
            <strong class="arch-node-name">${escHtml(node.label)}</strong>
          </button>`;
        }).join('')}
      </div>
    </div>`;
  };

  const safeJson = JSON.stringify(clientPayload).replace(/</g, '\\u003c');

  return `<main id="main">
  <header class="hero-sheet" id="top">
    <div class="hero-kicker">
      <span class="stamp">INK DESK · ARCHITECTURE</span>
      <span>StudyHub v${version} · Node.js &ge;22.19 · Cordis Runtime</span>
    </div>
    <h1>${c('把每道题锚回原页的<br>开放式学习架构', 'An open, grounded architecture<br>built to link every question home.')}</h1>
    <p class="hero-intro">${c(
      'StudyHub 不是写死步骤的黑盒刷题模板，而是一套运行在 DSH 宿主内的模块化学习工作台：底层用声明式上下文边界、分片内容寻址存储与五阶段证据校验守住数据可靠；上层用可组合的技能、按需契约、动态数据围栏与可编辑课程「学法」，让学习者能和主对话一起自由定制每门课的学法。',
      'StudyHub is not a rigid, hardcoded study template. Underneath, declarative runtime boundaries, content-addressed shards, and a five-stage verification pipeline keep every citation and schedule auditable; on top, composable skills, on-demand contracts, dynamic data fences, and editable per-course methods let learners co-design how they study with the main DSH chat.'
    )}</p>

    <div class="metric-strip" role="list" aria-label="${c('核心架构指标', 'Key architecture figures')}">
      <div class="metric-cell" role="listitem">
        <span class="metric-val">1 + 6 + 1</span>
        <span class="metric-lbl">${c('工作台主包 + 6 个能力插件 + 1 个检索扩展包', 'Workbench + 6 capability plugins + 1 retrieval package')}</span>
      </div>
      <div class="metric-cell" role="listitem">
        <span class="metric-val">7 · 19</span>
        <span class="metric-lbl">${c('7 个 DSH 工具 · 19 个 StudyRuntime 上下文（16 业务 + 3 纯数据）', '7 DSH agent tools · 19 StudyRuntime contexts (16 op + 3 data)')}</span>
      </div>
      <div class="metric-cell" role="listitem">
        <span class="metric-val">5 ${c('阶段', 'stages')}</span>
        <span class="metric-lbl">${c('规划 → 蓝图 → 写题硬绑定 → 六维独审 → 有界修补', 'Plan -> Blueprint -> Bind -> 6D Review -> Bounded Patch')}</span>
      </div>
      <div class="metric-cell" role="listitem">
        <span class="metric-val">${suite.totalFiles}</span>
        <span class="metric-lbl">${c(`离线确定性测试文件（${suite.fastFiles} 快速 + ${suite.slowUniqueFiles} 慢速 · 0 外网请求）`, `Offline deterministic test files (${suite.fastFiles} fast + ${suite.slowUniqueFiles} slow · 0 network calls)`)}</span>
      </div>
    </div>

    <div class="paper-manifesto" aria-label="${c('开放与可组合的主对话协作设计', 'Open and composable main-chat collaboration')}">
      <div class="manifesto-head">
        <div>
          <span class="manifesto-tag">${c('设计哲学 · 开放可组合而非死板模板', 'DESIGN PRINCIPLE · COMPOSABLE BY DEFAULT')}</span>
          <h2>${c('为什么学习者能和主对话一起「改学法」？', 'Why learners and the main chat can co-design workflows')}</h2>
        </div>
        <p>${c(
          '固定按钮管高频确定动作，开放探索交给主对话：技能、契约、围栏与课程学法全部作为一等数据暴露，既防提示词注入，又不把学习锁死在单一路径里。',
          'Dedicated views handle fast deterministic loops while open-ended planning lives in conversation: skills, contracts, data fences, and course methods are composable primitives rather than rigid step graphs.'
        )}</p>
      </div>
      <div class="manifesto-grid">
        ${OPEN_PRIMITIVES.map(item => `<article class="manifesto-card">
          <div class="manifesto-code">${escHtml(item.code)}</div>
          <h3>${escHtml(c(item.zhTitle, item.enTitle))}</h3>
          <p>${escHtml(c(item.zhBody, item.enBody))}</p>
          <div class="manifesto-foot">${doc(item.file, `${item.file} ↗`)}</div>
        </article>`).join('')}
      </div>
    </div>
  </header>

  <section class="sec" id="overview" data-stage="OVERVIEW">
    <div class="sec-head">
      <div class="eyebrow"><b>01</b><span>COMPONENT &amp; CONTEXT MAP</span></div>
      <h2>${c('插件、Agent 工具与 19 个运行时上下文', 'Plugins, Agent Tools & 19 Runtime Contexts')}</h2>
      <p class="sec-lede">${c(
        '所有插件共享同一个以 Symbol.for("studyhub.runtime.scope.v1") 键控的 StudyRuntime 微内核。每个业务域只能读取 domain-contracts.js 声明的快照端口，跨上下文写操作必须经过显式 actionGrants 授权；ESLint（eslint.config.js）封锁裸存储与全局兼容层直连，架构边界测试（tests/architecture-boundaries.test.mjs）通过 esbuild 依赖图与 runtime.describe() 深度优先搜索锁死跨上下文私有隔离与单向无环图。',
        'Every capability plugin attaches to one shared StudyRuntime scope keyed by Symbol.for("studyhub.runtime.scope.v1"). Domains read only declared snapshot ports in domain-contracts.js, cross-domain mutations require explicit actionGrants, ESLint (eslint.config.js) blocks raw store/global bypasses, and architecture boundary tests (tests/architecture-boundaries.test.mjs) enforce cross-context private-import isolation (esbuild metafile) and an acyclic runtime.describe() dependency graph.'
      )}</p>
    </div>

    <div class="filter-bar" role="toolbar" aria-label="${c('架构层级筛选', 'Filter architecture layers')}">
      <button type="button" class="chip-btn is-active" data-map-filter="all" aria-pressed="true">${c(`全部节点 (${localizedNodes.length})`, `All nodes (${localizedNodes.length})`)}</button>
      <button type="button" class="chip-btn" data-map-filter="plugins" aria-pressed="false">${c('插件与检索包 (8)', 'Plugins & Retrieval (8)')}</button>
      <button type="button" class="chip-btn" data-map-filter="tools" aria-pressed="false">${c('DSH 工具 (7)', 'DSH Agent Tools (7)')}</button>
      <button type="button" class="chip-btn" data-map-filter="contexts" aria-pressed="false">${c('运行时上下文 (19)', 'Runtime Contexts (19)')}</button>
      <button type="button" class="chip-btn" data-map-filter="storage" aria-pressed="false">${c('分片存储与懒加载视图 (2)', 'Store v5 & Lazy UI (2)')}</button>
    </div>

    <div class="explorer-split">
      <div class="explorer-canvas" id="overviewCanvas">
        ${renderGroupButtons('plugins', '1 个工作台主插件 + 6 个能力插件 + 1 个检索扩展包', '1 Workbench + 6 Capability Plugins + 1 Retrieval Package')}
        ${renderGroupButtons('tools', '7 个 DSH 主对话工具（按需发现 + 类型化域工具）', '7 DSH Agent Tools (Compact Discovery + Typed Domain Tools)')}
        ${renderGroupButtons('contexts', '19 个 StudyRuntime 上下文（16 个业务操作域 + 3 个纯数据只读域）', '19 StudyRuntime Contexts (16 Operation + 3 Data-Only)')}
        ${renderGroupButtons('storage', 'v5 分片内容寻址存储与按需视图拆包', 'Sharded Store v5 & Deferred UI View Chunks')}
      </div>

      <aside class="inspector-card" id="nodeInspector" aria-live="polite">
        <div class="inspector-top">
          <span class="inspector-badge" id="inspBadge">${escHtml(firstNode.badge)}</span>
          <code class="inspector-id" id="inspCode">${escHtml(firstNode.label)}</code>
        </div>
        <h3 id="inspTitle">${escHtml(c(firstNode.zhTitle, firstNode.enTitle))}</h3>
        <p class="inspector-summary" id="inspSummary">${escHtml(c(firstNode.zhSummary, firstNode.enSummary))}</p>
        <dl class="inspector-dl">
          <div>
            <dt id="inspOwnedLabel">${escHtml(clientPayload.i18n.ownedLabel)}</dt>
            <dd id="inspOwned">${firstNode.owned.map(item => `<code>${escHtml(item)}</code>`).join(' ')}</dd>
          </div>
          <div>
            <dt id="inspDepsLabel">${escHtml(clientPayload.i18n.depsLabel)}</dt>
            <dd id="inspDeps">${firstNode.deps.map(item => `<code>${escHtml(item)}</code>`).join(' ')}</dd>
          </div>
          <div>
            <dt id="inspOpsLabel">${escHtml(clientPayload.i18n.opsLabel)}</dt>
            <dd id="inspOps"><code>${escHtml(firstNode.ops)}</code></dd>
          </div>
          <div>
            <dt id="inspSrcLabel">${escHtml(clientPayload.i18n.sourceLabel)}</dt>
            <dd id="inspLinks" class="inspector-links">${firstNode.links.map(([p, l]) => doc(p, `${l} ↗`)).join(' ')}</dd>
          </div>
        </dl>
      </aside>
    </div>

    <div class="ref-ledger" aria-label="${c('架构静态速查表', 'Static architecture reference ledger')}">
      <div class="ledger-card">
        <h4>${c('插件拓扑（1 + 6 + 1）', 'Plugin Topology (1 + 6 + 1)')}</h4>
        <p>${c(
          '完整安装包内置主工作台 daily-flashcard 与 6 个可独立启停的能力组件（runtime / materials / bank / study / generation / audio），大教材检索由同仓包 studyhub-retrieval 在 &gt;150,000 字符时接管。',
          'Full release bundles daily-flashcard plus 6 independently toggleable capabilities (runtime, materials, bank, study, generation, audio); studyhub-retrieval narrows selections above 150,000 chars.'
        )}</p>
        <p class="ledger-links">${doc('docs/architecture.md', 'docs/architecture.md ↗')} ${doc('lib/runtime/builtins.js', 'lib/runtime/builtins.js ↗')}</p>
      </div>
      <div class="ledger-card">
        <h4>${c('19 个上下文无环契约', '19 Acyclic Runtime Contexts')}</h4>
        <p>${c(
          '16 个业务目录位于 <code>lib/contexts/&lt;id&gt;/</code>；<code>learner</code>、<code>workflow-data</code>、<code>skeleton-data</code> 3 个纯数据上下文仅暴露 <code>state.read</code>，使跨域共享状态无需反向 import。',
          '16 operation contexts live under <code>lib/contexts/&lt;id&gt;/</code>; 3 data-only contexts (<code>learner</code>, <code>workflow-data</code>, <code>skeleton-data</code>) expose only <code>state.read</code> to keep shared state strictly acyclic.'
        )}</p>
        <p class="ledger-links">${doc('lib/runtime/domain-contracts.js', 'lib/runtime/domain-contracts.js ↗')} ${doc('eslint.config.js', 'eslint.config.js ↗')} ${doc('tests/architecture-boundaries.test.mjs', 'tests/architecture-boundaries.test.mjs ↗')}</p>
      </div>
      <div class="ledger-card">
        <h4>${c('分片存储 v5 与 15 个懒加载块', 'Store v5 & 15 Lazy UI Chunks')}</h4>
        <p>${c(
          '答题流水每 1,000 条切分一片并以 20 位 SHA-1 寻址；UI 将 8 个重型功能台与 7 个低频页面拆为 15 个 deferredView() 按需分块（外加懒加载 PagePeek）。',
          'Attempts shard at 1,000 records per 20-hex SHA-1 file; UI splits 8 optional feature surfaces and 7 occasional pages into 15 deferredView() chunks (plus lazy PagePeek).'
        )}</p>
        <p class="ledger-links">${doc('lib/store.js', 'lib/store.js ↗')} ${doc('ui/workspace-views.jsx', 'ui/workspace-views.jsx ↗')}</p>
      </div>
    </div>
  </section>

  <section class="sec" id="pipeline" data-stage="PIPELINE">
    <div class="sec-head">
      <div class="eyebrow"><b>02</b><span>RELIABLE GENERATION PIPELINE</span></div>
      <h2>${c('五阶段有界出题流水线与故障拦截演练', 'Five-Stage Grounded Generation & Failure Recovery')}</h2>
      <p class="sec-lede">${c(
        '长资料先按 ≤ 60,000 字符分组、每批最多并行 4 组（每组 ≤ 5 题）。流水线把「找依据」「锁答案」「写题面」「独立审题」与「微调补缺」拆成五个职责隔离的阶段：能用确定性代码核对的绝不交给模型猜，重试次数严格封顶，仅统计调用次数与 Token 规则。',
        'Large selections split into &lt;= 60,000-character groups and parts of &lt;= 5 cards (concurrency = 4). By separating evidence planning, answer locking, stem phrasing, independent 6D review, and bounded wording patches, deterministic code enforces facts while model retries stay strictly capped.'
      )}</p>
    </div>

    <div class="stepper-rail" role="tablist" aria-label="${c('出题流水线五阶段', 'Five generation pipeline stages')}">
      ${localizedStages.map((stage, idx) => `<button type="button" class="stage-step${idx === 0 ? ' is-active' : ''}" role="tab" aria-selected="${idx === 0 ? 'true' : 'false'}" data-stage-step="${stage.step}">
        <span class="stage-num">0${stage.step}</span>
        <span class="stage-name">${escHtml(stage.id.toUpperCase())}</span>
        <small class="stage-fn">${escHtml(stage.fn.split('+')[0].trim())}</small>
      </button>`).join('')}
    </div>

    <div class="pipeline-detail" id="pipelineDetail" aria-live="polite">
      <div class="pipeline-detail-head">
        <div>
          <span class="inspector-badge" id="pipeBadge">${escHtml(clientPayload.i18n.stageBadge)} 01 / 05</span>
          <h3 id="pipeTitle">${escHtml(c(firstStage.zhTitle, firstStage.enTitle))}</h3>
        </div>
        <span class="pipe-src" id="pipeSrc">${doc(firstStage.file, `${firstStage.file} ↗`)}</span>
      </div>
      <p class="pipeline-summary" id="pipeSummary">${escHtml(c(firstStage.zhSummary, firstStage.enSummary))}</p>
      <div class="pipe-budget">
        <strong id="pipeBudgetLabel">${escHtml(clientPayload.i18n.budgetLabel)}:</strong>
        <span id="pipeBudget">${escHtml(c(firstStage.budgetZh, firstStage.budgetEn))}</span>
      </div>
      <div class="io-grid">
        <div class="io-box">
          <div class="io-label" id="pipeInLabel">${escHtml(clientPayload.i18n.inputLabel)}</div>
          <pre id="pipeInput"><code>${escHtml(firstStage.inputShape)}</code></pre>
        </div>
        <div class="io-box">
          <div class="io-label" id="pipeOutLabel">${escHtml(clientPayload.i18n.outputLabel)}</div>
          <pre id="pipeOutput"><code>${escHtml(firstStage.outputShape)}</code></pre>
        </div>
      </div>
      <div class="gate-callout">
        <strong id="pipeGateLabel">${escHtml(clientPayload.i18n.gateLabel)}</strong>
        <p id="pipeGate">${escHtml(c(firstStage.gateZh, firstStage.gateEn))}</p>
      </div>
    </div>

    <div class="failure-lab">
      <div class="failure-head">
        <h3>${c('常见模型失误切换器：看哪一关拦截或挽救它', 'Failure-Mode Simulator: Inspect How Each Defect Is Caught or Salvaged')}</h3>
        <p>${c('点击任一真实故障场景，自动高亮对应防线阶段并展示代码级处置策略：', 'Select a failure mode to highlight the stage that catches or salvages it without unbounded token burn:')}</p>
      </div>
      <div class="failure-toggles" role="toolbar" aria-label="${c('常见生成故障模式', 'Generation failure modes')}">
        ${localizedFailures.map((item, idx) => `<button type="button" class="chip-btn${idx === 0 ? ' is-active' : ''}" data-failure-mode="${escHtml(item.id)}" aria-pressed="${idx === 0 ? 'true' : 'false'}">
          <span class="fail-stage-pill">S${item.targetStage}</span>
          <span>${escHtml(item.label)}</span>
        </button>`).join('')}
      </div>
      <div class="failure-readout" id="failureReadout" aria-live="polite">
        <div class="failure-tag" id="failStageTag">${escHtml(c(`拦截 / 挽救于第 ${firstFailure.targetStage} 阶段`, `Handled at Stage ${firstFailure.targetStage}`))}</div>
        <p class="failure-what" id="failWhat">${escHtml(c(firstFailure.zhWhat, firstFailure.enWhat))}</p>
        <p class="failure-def" id="failDefense">${escHtml(c(firstFailure.zhDefense, firstFailure.enDefense))}</p>
      </div>
    </div>

    <div class="stage-matrix" aria-label="${c('五阶段契约完整一览', 'All five stages at a glance')}">
      ${localizedStages.map(stage => `<article class="stage-mini">
        <div class="stage-mini-top"><b>0${stage.step} · ${escHtml(stage.id.toUpperCase())}</b> ${doc(stage.file, 'source ↗')}</div>
        <p>${escHtml(stage.summary)}</p>
        <p class="stage-mini-budget"><code>${escHtml(stage.budget)}</code></p>
      </article>`).join('')}
    </div>
    <p class="sec-links">${doc('docs/generation-reliability.md', 'docs/generation-reliability.md ↗')} ${doc('docs/assessment-quality.md', 'docs/assessment-quality.md ↗')} ${doc('docs/token-usage.md', 'docs/token-usage.md ↗')} ${doc('lib/batch.js', 'lib/batch.js ↗')}</p>
  </section>

  <section class="sec" id="fsrs" data-stage="FSRS-6">
    <div class="sec-head">
      <div class="eyebrow"><b>03</b><span>LIVE FSRS-6 &amp; MASTERY SIMULATOR</span></div>
      <h2>${c('实时 FSRS-6 记忆状态与掌握度推演器', 'Live FSRS-6 Memory State & Mastery Simulator')}</h2>
      <p class="sec-lede">${c(
        `直接运行打包进本页的真实产品排期代码（lib/sm2.js 21 维默认权重 w0..w20，衰减率 w20 = ${FSRS6_WEIGHTS[20]}，长周期无随机抖动模式，按学习者本地日历天计数）与掌握度规则（lib/mastery.js：熟悉 ≥ ${FAMILIAR_DAYS} 天；已掌握 ≥ ${MASTERED_DAYS} 天且连对 ≥ ${MASTERED_STREAK} 次，或自评 5 分立即达标；&lt; 3 分转入薄弱）。`,
        `Runs the actual bundled product modules (lib/sm2.js with all ${FSRS6_WEIGHTS.length} default FSRS-6 weights w0..w20, decay w20 = ${FSRS6_WEIGHTS[20]}, long-term deterministic mode on local calendar days) and lib/mastery.js (Familiar &gt;= ${FAMILIAR_DAYS}d; Mastered &gt;= ${MASTERED_DAYS}d with streak &gt;= ${MASTERED_STREAK}, or immediate self-grade 5; Weak on grade &lt; 3).`
      )}</p>
    </div>

    <div class="fsrs-workbench">
      <div class="fsrs-controls">
        <div class="control-group">
          <div class="control-label-row">
            <label for="fsrsRetention">${c('目标回忆保持率（request_retention）', 'Target recall retention (request_retention)')}</label>
            <output id="fsrsRetentionOut" for="fsrsRetention">0.90</output>
          </div>
          <input type="range" id="fsrsRetention" min="${LIMITS.request_retention.min}" max="${LIMITS.request_retention.max}" step="0.01" value="${fsrsDefaults.request_retention}">
          <div class="range-ticks"><span>0.70 (${c('更长间隔', 'wider gaps')})</span><span>0.90 (${c('默认', 'default')})</span><span>0.97 (${c('考前高频', 'high recall')})</span></div>
        </div>

        <div class="control-row">
          <button type="button" class="chip-btn" id="fsrsFocusToggle" aria-pressed="false">
            ${c(`重点卡片提频（+${FOCUS_RETENTION_BOOST}）`, `Focus card boost (+${FOCUS_RETENTION_BOOST})`)}
          </button>
          <span class="effective-ret" id="fsrsEffectiveNote">${c('常规目标保持率：0.90', 'Effective recall target: 0.90')}</span>
        </div>

        <div class="grade-pad" role="group" aria-label="${c('模拟作答评分按钮', 'Simulate answer grades')}">
          <button type="button" class="grade-btn grade-btn--again" data-fsrs-grade="1">
            <strong>${c('0–2 · 重来 Again', '0-2 · Again')}</strong>
            <small data-grade-hint="1">+${initialHints[1]}${dayUnit}</small>
          </button>
          <button type="button" class="grade-btn grade-btn--hard" data-fsrs-grade="3">
            <strong>${c('3 · 勉强 Hard', '3 · Hard')}</strong>
            <small data-grade-hint="3">+${initialHints[3]}${dayUnit}</small>
          </button>
          <button type="button" class="grade-btn grade-btn--good" data-fsrs-grade="4">
            <strong>${c('4 · 熟练 Good', '4 · Good')}</strong>
            <small data-grade-hint="4">+${initialHints[4]}${dayUnit}</small>
          </button>
          <button type="button" class="grade-btn grade-btn--easy" data-fsrs-grade="5">
            <strong>${c('5 · 轻松 Easy', '5 · Easy')}</strong>
            <small data-grade-hint="5">+${initialHints[5]}${dayUnit}</small>
          </button>
        </div>

        <div class="fsrs-actions">
          <button type="button" class="reset-btn" id="fsrsReset">${c('重置为新卡（Reset）', 'Reset to new card')}</button>
          <span class="fsrs-links">${doc('lib/sm2.js', 'lib/sm2.js ↗')} ${doc('lib/mastery.js', 'lib/mastery.js ↗')}</span>
        </div>
      </div>

      <div class="fsrs-display" aria-live="polite">
        <div class="fsrs-readout-grid">
          <div class="stat-tile">
            <span class="stat-k">${c('稳定性 Stability S', 'Stability S')}</span>
            <strong class="stat-v" id="fsrsStability">0.00${dayUnit}</strong>
          </div>
          <div class="stat-tile">
            <span class="stat-k">${c('难度 Difficulty D', 'Difficulty D')}</span>
            <strong class="stat-v" id="fsrsDifficulty">—</strong>
          </div>
          <div class="stat-tile">
            <span class="stat-k">${c('下次复习间隔', 'Next interval')}</span>
            <strong class="stat-v" id="fsrsInterval">0${dayUnit}</strong>
          </div>
          <div class="stat-tile">
            <span class="stat-k">${c('连对 / 遗忘次数', 'Streak / Lapses')}</span>
            <strong class="stat-v" id="fsrsStreak">0 / 0</strong>
          </div>
        </div>

        <div class="mastery-banner">
          <div>
            <span class="mastery-k">${c('当前推导掌握度（cardLevel）', 'Derived mastery state (cardLevel)')}</span>
            <p class="mastery-rule" id="fsrsRuleText">${c('尚未作答（repetitions = 0）→ 未学（new）。', 'Unanswered: 0 repetitions -&gt; New.')}</p>
          </div>
          <span class="mastery-pill" id="fsrsMasteryBadge" data-level="new">${c('未学', 'New')}</span>
        </div>

        <div class="timeline-card">
          <div class="timeline-head">
            <strong id="fsrsTimelineTitle">${c('尚未作答 —— 当前展示默认 0.90 保持率下连续 6 次「熟练 (4)」间隔预测', 'Unstudied card — showing 6-review Good (4) interval projection at 0.90 recall')}</strong>
          </div>
          <div class="timeline-bars" id="fsrsTimelineBars">
            ${defaultPreview.map(pt => `<div class="t-bar-row">
              <span class="t-bar-step">${c(`第 ${pt.review} 次`, `R${pt.review}`)}</span>
              <span class="t-bar-track"><span class="t-bar-fill" data-tone="${pt.interval >= 21 && pt.review >= 2 ? 'mastered' : pt.interval >= 6 ? 'familiar' : 'learning'}" style="width:${Math.min(100, Math.max(8, Math.round((Math.log(pt.interval + 1) / Math.log(160)) * 100)))}%"></span></span>
              <strong class="t-bar-val">+${pt.interval}${dayUnit} (${c(`Σ ${pt.day}天`, `day ${pt.day}`)})</strong>
            </div>`).join('')}
          </div>
        </div>
      </div>
    </div>
  </section>

  <section class="sec" id="testing" data-stage="TESTING">
    <div class="sec-head">
      <div class="eyebrow"><b>04</b><span>DETERMINISTIC OFFLINE TEST &amp; SHARDING</span></div>
      <h2>${c('零外网确定性测试套件与 LPT 均衡分片器', 'Zero-Network Deterministic Tests & LPT Sharding')}</h2>
      <p class="sec-lede">${c(
        `全仓 ${suite.totalFiles} 个测试文件在完全断绝外部网络的沙箱中运行：scripts/test.mjs 注入临时 DSH_HOME、清除本机密钥、设置 STUDY_NO_CALIBRATION=1 消除分片顺序漂移；test-network.mjs 拦截一切非回环请求；fake-model.mjs 用 42 类确定性提示词处理器毫秒级模拟带逐字引用的大模型响应。`,
        `All ${suite.totalFiles} test files run inside a hermetic loopback-only harness: scripts/test.mjs creates a temporary DSH_HOME, scrubs host secrets, and sets STUDY_NO_CALIBRATION=1; test-network.mjs blocks every non-loopback socket; fake-model.mjs serves 42 deterministic prompt-family handlers with grounded verbatim quotes.`
      )}</p>
    </div>

    <div class="harness-pillars">
      <article class="pillar-card">
        <div class="pillar-k">test-network.mjs</div>
        <h3>${c('外网硬阻断（仅放行回环）', 'Loopback-Only Network Guard')}</h3>
        <p>${c(
          '通过 Node --import 预加载，接管 fetch、http、https、net、tls 与 Socket.prototype.connect，仅允许 127.0.0.1 / ::1 / localhost / 命名管道，任何外部请求立即抛出 TEST_NETWORK_BLOCKED。',
          'Preloaded via --import to patch fetch, http, https, net, tls, and Socket.prototype.connect; anything outside localhost / 127.* / ::1 / named pipes throws TEST_NETWORK_BLOCKED.'
        )}</p>
        <p>${doc('scripts/qa/test-network.mjs', 'scripts/qa/test-network.mjs ↗')}</p>
      </article>
      <article class="pillar-card">
        <div class="pillar-k">fake-model.mjs · 42 handlers</div>
        <h3>${c('离线确定性大模型替身', '42-Handler Offline Fake LLM')}</h3>
        <p>${c(
          '路由 preview/fake-model 识别规划、蓝图、写题、六维审阅、措辞修补、复习全书等 42 类提示词家族，直接从传入资料切片提取 ≥12 字真实引文并模拟前缀缓存 Token 账本。',
          'Routes preview/fake-model across 42 prompt-family handlers (planning, blueprints, authoring, 6D review, patching, review books), extracting real >= 12-char quotes and simulating cache token accounting.'
        )}</p>
        <p>${doc('scripts/fake-model.mjs', 'scripts/fake-model.mjs ↗')}</p>
      </article>
      <article class="pillar-card">
        <div class="pillar-k">STUDY_NO_CALIBRATION=1</div>
        <h3>${c('环境隔离与跨机器一致性', 'Hermetic State & Shard Invariance')}</h3>
        <p>${c(
          '每次运行创建独立临时 DSH_HOME、剥离 API 密钥、禁用动态 Token 校准，并发上限 max(2, min(cores - 1, 12))，单测试超时 300 秒、单文件超时 480 秒。',
          'Allocates an isolated temp DSH_HOME, scrubs credentials, sets STUDY_NO_CALIBRATION=1 so shard order never shifts token estimates, and caps concurrency at max(2, min(cores - 1, 12)).'
        )}</p>
        <p>${doc('scripts/test.mjs', 'scripts/test.mjs ↗')} ${doc('scripts/qa/run-tests.mjs', 'scripts/qa/run-tests.mjs ↗')}</p>
      </article>
    </div>

    <div class="shard-explorer">
      <div class="shard-controls">
        <div class="tier-bar" role="toolbar" aria-label="${c('测试分层筛选', 'Filter test tiers')}">
          <button type="button" class="chip-btn is-active" data-test-tier="all" aria-pressed="true">${c(`全量 (${suite.totalFiles})`, `All (${suite.totalFiles})`)}</button>
          <button type="button" class="chip-btn" data-test-tier="fast" aria-pressed="false">${c(`快速层 --fast (${suite.fastFiles})`, `Fast --fast (${suite.fastFiles})`)}</button>
          <button type="button" class="chip-btn" data-test-tier="slow" aria-pressed="false">${c(`慢速合集 (${suite.slowUniqueFiles})`, `Slow unique (${suite.slowUniqueFiles})`)}</button>
          <button type="button" class="chip-btn" data-test-tier="browser" aria-pressed="false">browser (${suite.browserFiles})</button>
          <button type="button" class="chip-btn" data-test-tier="cli" aria-pressed="false">cli (${suite.cliFiles})</button>
          <button type="button" class="chip-btn" data-test-tier="ffmpeg" aria-pressed="false">ffmpeg (${suite.ffmpegFiles})</button>
        </div>

        <div class="shard-slider-wrap">
          <div class="control-label-row">
            <label for="shardCountSlider">${c('LPT 贪心负载均衡分片数（--shard=I/N，CLI 支持 1..64）', 'LPT weight-balanced shard count (--shard=I/N, CLI supports 1..64)')}</label>
            <output id="shardCountOut" for="shardCountSlider">8</output>
          </div>
          <input type="range" id="shardCountSlider" min="1" max="16" step="1" value="8">
        </div>
      </div>

      <div class="shard-body" aria-live="polite">
        <div class="shard-bars" id="shardBars">
          <div class="shard-row is-selected">
            <span class="shard-lbl">#1/8</span>
            <span class="shard-track"><span class="shard-fill" style="width:98%"></span></span>
            <span class="shard-meta">${Math.ceil(suite.totalFiles / 8)} ${c('个文件', 'files')}</span>
          </div>
        </div>

        <div class="shard-inspector" id="shardInspector">
          <div class="shard-insp-head">
            <strong id="shardInspTitle">${c('分片 1 / 8 · 全量测试集', 'Shard 1 of 8 · Full suite')}</strong>
            <span class="shard-balance" id="shardBalanceChip">${c('基于 tests/test-weights.json 确定性切分', 'Deterministic split from tests/test-weights.json')}</span>
          </div>
          <pre class="shard-cmd"><code id="shardCmd">node scripts/test.mjs --shard=1/8</code></pre>
          <p class="shard-note">${c(
            'shardKeys()（scripts/qa/test-schedule.mjs）只读取入库的 tests/test-weights.json（绝不读取本机缓存耗时），按权重降序依次把每个文件分给当前累计最轻的分片，保证多机并行无需协调即可精确覆盖全部文件一次。',
            'shardKeys() in scripts/qa/test-schedule.mjs reads only committed tests/test-weights.json (never machine-local timings), assigning heaviest files first to the least-loaded shard so distributed runners partition identically without coordination.'
          )}</p>
          <div class="shard-heavy">
            <span class="shard-heavy-k" id="shardHeavyLabel">${escHtml(clientPayload.i18n.heaviestWord)}:</span>
            <div class="shard-heavy-list" id="shardHeavyList"><code>site-qa / ui / generation / store</code></div>
          </div>
          <p class="sec-links">${doc('scripts/qa/test-schedule.mjs', 'scripts/qa/test-schedule.mjs ↗')} ${doc('tests/slow-tests.json', 'tests/slow-tests.json ↗')} ${doc('tests/test-weights.json', 'tests/test-weights.json ↗')}</p>
        </div>
      </div>
    </div>
  </section>
  <script id="explorer-data" type="application/json">${safeJson}</script>
</main>`;
}
