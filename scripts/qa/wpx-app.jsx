/* Wave 3 · WP-X QA page (built by scripts/qa/wpx.mjs): the written exam, the case paper, the oral exam and the audio form with a fake
   library and a fake host call. Query: ?lang=zh|en&theme=dark|light&scene=exam-setup|exam-running|exam-report|case-setup|case-running|
   case-report|oral-setup|oral-running|oral-report|audio|audio-gated */
import React from 'react';
import { createRoot } from 'react-dom/client';
import styleCss from '../../ui/style.css';
import { setUiLanguage } from '../../ui/i18n.js';
import Exam from '../../ui/Exam.jsx';
import AudioImport from '../../ui/AudioImport.jsx';

const params = new URLSearchParams(location.search);
const lang = params.get('lang') === 'en' ? 'en' : 'zh';
const theme = params.get('theme') === 'light' ? 'light' : 'dark';
const scene = params.get('scene') || 'exam-setup';
setUiLanguage(lang);
const t = (zh, en) => (lang === 'en' ? en : zh);
const now = Date.now();
const ago = (ms) => new Date(now - ms).toISOString();
const MB = 1024 * 1024;

const style = document.createElement('style');
style.textContent = `${styleCss}\n  html, body, #root { height: 100%; margin: 0; }`;
document.head.appendChild(style);

const decks = [
  { id: 'q1', title: 'CS5224 · Final paper 05', course: 'CS5224', examCount: 36, examQuizCount: 18, examMultiCount: 18, available: 36 },
  { id: 'q2', title: 'CS5224 · Final paper 06', course: 'CS5224', examCount: 20, examQuizCount: 10, examMultiCount: 10, available: 20 },
  { id: 'c1', title: 'Orchard case', format: 'case-study', course: 'CS5224', caseMarks: 10, count: 2, caseBest: { total: 7, max: 10 }, caseSourceId: 's1' },
];
const courses = [{ id: 'course-1', name: 'CS5224', exam: { format: 'open-book-case', readingMinutes: 5 } }, { id: 'course-2', name: 'Databases', exam: { format: 'closed-book' } }];
const baseData = {
  root: 'wpx', model: { ready: true, reason: 'ok' }, decks, courses, runs: [], drafts: [], jobs: [],
  sources: [{ id: 's1', title: 'Orchard case', text: t('果园公司想把订货系统搬到云上。\n\n它有三个仓库，每个仓库都有自己的库存表；高峰期在每年十月。\n\n预算有限，团队只有四名工程师。', 'Orchard Co. wants to move its ordering system to the cloud.\n\nIt has three warehouses, each with its own stock table; the peak is every October.\n\nThe budget is tight and the team has four engineers.') }],
  focus: { course: 'CS5224', courses: courses.map((course) => ({ name: course.name })) },
  exams: [
    { runId: 'e1', submittedAt: '2026-09-30T10:00:00.000Z', scorePct: 80, correct: 8, total: 10, examKinds: 'all', decks: ['CS5224 · Final paper 05'] },
    { runId: 'e2', submittedAt: '2026-09-29T10:00:00.000Z', scorePct: 70, correct: 7, total: 10, examKinds: 'case', decks: ['Orchard case'] },
  ],
  oralExams: [{ runId: 'o1', submittedAt: '2026-09-28T10:00:00.000Z', total: 5, assessed: 5, strong: 3, developing: 1, weak: 1 }],
};
const card = { id: 'k3', topic: t('架构', 'Architecture'), multiple: true, prompt: t('以下哪些做法可以降低高峰期的数据库压力？', 'Which of these reduce database load at peak time?'),
  options: [{ id: 'a', text: t('给热点查询加缓存', 'Cache the hot queries') }, { id: 'b', text: t('把读请求分流到只读副本', 'Route reads to a read replica') },
    { id: 'c', text: t('把所有表合成一张', 'Merge every table into one') }, { id: 'd', text: t('提前预热连接池', 'Warm the connection pool in advance') }] };
const writtenRun = { id: 'r1', mode: 'exam', deckId: 'q1', index: 2, total: 10, startedAt: ago(7 * 60000 + 12000), title: t('CS5224 模拟考试', 'CS5224 mock exam'), card,
  picks: [{ deckId: 'q1', cardId: 'k3', selected: ['a'] }] };
const writtenReport = { runId: 'r2', scorePct: 70, correct: 7, total: 10, answered: 9, durationMs: 18 * 60000 + 22000, comparison: { scorePct: 60, deltaPct: 10 },
  byTopic: [{ deckId: 'q1', deckTitle: 'Final 05', topic: t('架构', 'Architecture'), correct: 3, total: 5 }, { deckId: 'q1', deckTitle: 'Final 05', topic: t('数据库', 'Databases'), correct: 4, total: 5 }],
  byDeck: [{ deckId: 'q1', title: 'CS5224 · Final paper 05', correct: 7, total: 10 }], byKind: [{ kind: 'quiz', correct: 4, total: 5 }, { kind: 'multi', correct: 3, total: 5 }],
  wrong: [{ deckId: 'q1', cardId: 'k1', topic: t('架构', 'Architecture'), prompt: t('以下哪项不属于微服务拆分原则？', 'Which is not a microservice split principle?'), kind: 'quiz' }],
  skipped: [{ deckId: 'q1', cardId: 'k9', topic: t('数据库', 'Databases'), prompt: t('说明 ACID 中的 I。', 'Explain the I in ACID.'), kind: 'multi' }],
  weakScope: [{ deckId: 'q1', cardId: 'k1' }, { deckId: 'q1', cardId: 'k9' }] };

const paper = { deckId: 'c1', minutesPerMark: 2, readingMinutes: 5, writingMinutes: 20, handwriting: false };
const caseRun = { id: 'cp1', mode: 'exam', paper, startedAt: ago(8 * 60000), highlights: [], responses: [{ cardId: 'q1', response: t('我建议先上读写分离。', 'I would start with read/write splitting.') }],
  paperCards: [{ id: 'q1', marks: 6, prompt: t('建议果园公司如何应对十月高峰？', 'How should Orchard handle the October peak?') }, { id: 'q2', marks: 4, prompt: t('指出一项主要风险并给出对策。', 'Name one main risk and a mitigation.') }] };
const rubric = { total: 4, max: 6, band: 'good', summary: t('建议清楚，案例依据偏少。', 'Clear advice, thin on case evidence.'),
  criteria: [{ id: 'c1', label: t('建议', 'Recommendation'), score: 3, max: 3, ratio: 1, evidence: [t('先上读写分离', 'start with read/write splitting')] },
    { id: 'c2', label: t('案例依据', 'Case linkage'), score: 1, max: 3, ratio: 0.33, missing: [{ id: 'm1', text: t('提到三个仓库', 'mention the three warehouses') }], suggestion: t('引用“三个仓库”。', 'Quote "three warehouses".') }] };
const caseReport = { runId: 'cp2', case: { deckId: 'c1', title: 'Orchard case', total: 7, max: 10, pending: 0, handwriting: false,
  pacing: { readingMs: 5 * 60000, writingMs: 19 * 60000, transcribeMs: 0, rows: [{ cardId: 'q1', status: 'over', spentMs: 14 * 60000, budgetMs: 12 * 60000 }], unanswered: [], overBudget: ['q1'], writingMinutes: 20 },
  questions: [{ cardId: 'q1', n: 1, prompt: t('建议果园公司如何应对十月高峰？', 'How should Orchard handle the October peak?'), status: 'graded', total: 4, marks: 6, rubric },
    { cardId: 'q2', n: 2, prompt: t('指出一项主要风险并给出对策。', 'Name one main risk and a mitigation.'), status: 'graded', total: 3, marks: 4, rubric: null }],
  weakest: [{ cardId: 'q1', criterionId: 'c2', label: t('案例依据', 'Case linkage'), n: 1, score: 1, max: 3 }] } };

const oralRun = { id: 'ora1', index: 1, total: 5, answered: 1, entry: { cardId: 'k5', topic: t('索引设计', 'Index design'), prompt: t('面试官：请解释覆盖索引，以及什么时候不该用。', 'Interviewer: explain a covering index and when not to use one.'),
  options: [], answer: '', followup: '' } };
const oralReport = { runId: 'ora2', total: 5, answered: 5, assessed: 5, strong: 3, developing: 1, weak: 1, feedbackStatus: 'assessed',
  weakTopics: [{ topic: t('索引设计', 'Index design') }], weakScope: [{ deckId: 'q1', cardId: 'k5' }],
  entries: [{ deckId: 'q1', cardId: 'k5', topic: t('索引设计', 'Index design'), prompt: t('解释覆盖索引。', 'Explain a covering index.'), answer: t('索引包含查询需要的全部列。', 'The index holds every column the query needs.'),
    assessment: { band: 'strong', reason: t('定义准确。', 'Accurate definition.') }, expected: t('覆盖索引无需回表。', 'No table lookup is needed.'), followup: '' }] };

const hostCalls = {
  'review.get': ({ runId }) => ({ r1: writtenRun, r2: { id: 'r2', mode: 'exam', closed: true }, cp1: caseRun, cp2: { id: 'cp2', mode: 'exam', paper, closed: true } })[runId],
  'exam.report': ({ runId }) => (runId === 'cp2' ? caseReport : writtenReport),
  'oral.active': () => oralRun,
  'oral.get': ({ runId }) => (runId === 'ora2' ? { id: 'ora2', submitted: true } : oralRun),
  'oral.report': () => oralReport,
  'review.answer': () => ({}), 'review.highlights': () => ({}), 'review.move': () => writtenRun, 'audio.preflight': () => ({ transcription: true, text: true, files: [] }),
  'audio.files': () => ({ files: [{ path: '/w/lecture-week6.mp3', name: 'lecture-week6.mp3', rel: 'recordings/lecture-week6.mp3', size: 38 * MB, modified: ago(86400000) }] }),
};
const call = async (action, args) => {
  if (!hostCalls[action]) throw new Error(`Capability unavailable: ${action}`);
  return hostCalls[action](args || {});
};
const never = () => new Promise(() => {});
const inert = { ...baseData };

const job = (extra = {}) => ({ type: 'audio-import', id: 'j', status: 'running', filename: 'lecture-week4.mp3', phase: 'proofread', done: 1, total: 5, minutes: 47.8,
  startedAt: ago(3 * 60000), steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 1, total: 5 } }, pace: { proofread: { at: now - 10000, each: 40000 } }, warnings: [], tasks: [], ...extra });
const audioData = { ...baseData, jobs: [job(),
  job({ id: 'f', status: 'failed', filename: 'lecture-week5.mp3', phase: 'translate', stage: t('翻译第 1/8 部分失败：服务暂时不可用', 'Translation of part 1/8 failed: the service is temporarily unavailable'), retryable: true, finishedAt: ago(60000),
    steps: { transcribe: { done: 1, total: 1 }, proofread: { done: 5, total: 5 }, translate: { done: 0, total: 8 } } }),
  job({ id: 'c', status: 'complete', filename: 'lecture-week3.mp3', phase: 'done', sourceIds: ['s1'], corrected: 4, finishedAt: ago(30000) })] };
const files = [{ kind: 'upload', uploadId: 'u1', name: 'lecture-week6.mp3', size: 45 * MB }, { kind: 'path', path: '/w/lecture-week7.mp3', name: 'lecture-week7.mp3', size: 38 * MB }];

const exam = (props = {}) => <Exam call={call} data={inert} onExit={() => {}} onCreate={() => {}} onStartRun={() => {}} onSetupModel={() => {}} {...props} />;
const scenes = {
  'exam-setup': () => exam({ initialKind: 'exam', data: { ...inert, focus: { ...inert.focus, course: 'Databases' } }, call: never }),
  'exam-running': () => exam({ initialRunId: 'r1' }),
  'exam-report': () => exam({ initialRunId: 'r2' }),
  'case-setup': () => exam({ initialKind: 'case', call: never }),
  'case-setup-nomodel': () => exam({ initialKind: 'case', call: never, data: { ...inert, model: { ready: false, reason: 'no-route' } } }),
  'case-running': () => exam({ initialKind: 'case', initialRunId: 'cp1' }),
  'case-report': () => exam({ initialKind: 'case', initialRunId: 'cp2' }),
  'oral-setup': () => exam({ initialKind: 'oral', call: async (action) => (action === 'oral.active' ? null : call(action)) }),
  'oral-running': () => exam({ initialKind: 'oral' }),
  'oral-report': () => exam({ initialKind: 'oral', initialRunId: 'ora2' }),
  audio: () => <div className="page"><AudioImport data={audioData} busy={false} act={() => {}} call={call} initialFiles={files} initialReadiness={{ transcription: true, text: true }}
    initialChecks={{ 'initial-0': { seconds: 1800, requests: 1 }, 'initial-1': { seconds: 4 * 3600, requests: 4, issue: { code: 'long-split', minutes: 240, parts: 4, requests: 4, partMinutes: 59.5 } } }} onOpenSources={() => {}} onOpenSettings={() => {}} /></div>,
  'audio-empty': () => <div className="page"><AudioImport data={audioData} busy={false} act={() => {}} call={call} initialReadiness={{ transcription: true, text: true }} onOpenSources={() => {}} /></div>,
};
createRoot(document.getElementById('root')).render(
  <div className="study-app" data-theme={theme} lang={lang === 'en' ? 'en' : 'zh-CN'} style={{ height: '100%', overflow: 'auto' }}><main style={{ flex: 1, minWidth: 0 }}>{(scenes[scene] || scenes['exam-setup'])()}</main></div>,
);
