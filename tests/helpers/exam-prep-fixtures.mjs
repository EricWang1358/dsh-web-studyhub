import { examBlueprintMaterial } from '../../lib/exam-blueprint-material.js';
import { examPointListSummary } from '../../lib/exam-point-list.js';

/* Fixtures of the 备考补习 page: a point list built by the real module (examBlueprintMaterial) and shaped like a snapshot source,
   a library of slides and sample papers to build one from, and the snapshot `data` around them. */

export const STAMP = '2026-10-01T08:00:00.000Z';

const slide = (deck, page, text, courses) => ({ id: `${deck}-${page}`, title: `${deck}.pptx · p.${page}`, text, createdAt: STAMP, courses,
  chars: text.length, excerpt: text.slice(0, 160), document: { id: deck, materialId: deck, page, totalPages: 6, format: 'pptx' } });

/** The slides of a transport-layer deck (page 5 was a picture and has no source), one sample paper, one second paper and a syllabus. */
export function library(courses = ['网络']) {
  const text = {
    1: '## 第 1 页 · TCP 连接\n\n三次握手建立连接，四次挥手释放连接。',
    2: '## 第 2 页 · 拥塞控制\n\n慢启动与拥塞避免通过窗口调节发送速率。',
    3: '## 第 3 页 · UDP\n\nUDP 无连接，不保证可靠交付。',
    4: '## 第 4 页 · 流量控制\n\n接收方通过窗口通告控制发送方。',
    6: '## 第 6 页 · 小结\n\n本章回顾。',
  };
  return [
    ...Object.entries(text).map(([page, body]) => slide('传输层', Number(page), body, courses)),
    { id: 'paper-1', title: '老师给的样卷', text: 'Q1 简述三次握手。(10分)\nQ2 比较慢启动与拥塞避免。(10分)\nQ3 一道讲义没讲过的题。(5分)', createdAt: STAMP, courses, chars: 60, excerpt: 'Q1' },
    { id: 'paper-2', title: '去年的卷子', text: 'Q1 说明 UDP 的特点。(10分)', createdAt: STAMP, courses, chars: 20, excerpt: 'Q1' },
    { id: 'syllabus-1', title: '考试大纲', text: '传输层：连接管理、拥塞控制。', createdAt: STAMP, courses, chars: 20, excerpt: '传输层' },
    { id: 'other-1', title: '别的课的讲义', text: '别的课', createdAt: STAMP, courses: ['数据库'], chars: 3, excerpt: '别的课' },
  ];
}

const place = (sourceId, quote, page, role = 'lecture') => ({ sourceId, quote, page, role, documentId: role === 'lecture' ? '传输层' : undefined });
const ABSENT = Symbol('absent');

/**
 * A point list as the library holds it (`source.get` reads it whole; the snapshot carries `examPointListSummary` of it). `papers` is how many sample papers it rests on.
 * Two big points (TCP, congestion control) and UDP, TCP with two small ones.
 */
export function pointList({ title = '网络 · 传输层 考点清单', courses = ['网络'], papers = 1, createdAt = STAMP, supersedes, scope = '传输层', many = 0, orphan = false, id } = {}) {
  const inputs = [{ role: 'lecture', documentId: '传输层', sourceIds: ['传输层-1', '传输层-2', '传输层-3', '传输层-4'], title: '传输层.pptx', skippedPages: [5] },
    ...Array.from({ length: papers }, (_, index) => ({ role: 'past-paper', sourceIds: [`paper-${index + 1}`], title: index ? '去年的卷子' : '老师给的样卷' }))];
  const paper = quote => ({ sourceId: 'paper-1', quote, role: 'past-paper' });
  const points = [
    { id: 'p1', title: 'TCP 连接管理', requirement: '掌握', evidence: [place('传输层-1', '三次握手建立连接')] },
    { id: 'p2', title: '三次握手', parentId: 'p1', evidence: [place('传输层-1', '三次握手建立连接', 1), ...(papers ? [paper('简述三次握手')] : [])] },
    { id: 'p3', title: '四次挥手', parentId: 'p1', evidence: [place('传输层-1', '四次挥手释放连接', 1)] },
    { id: 'p4', title: '拥塞控制', requirement: '掌握', evidence: [place('传输层-2', '慢启动与拥塞避免通过窗口调节发送速率', 2), ...(papers ? [paper('比较慢启动与拥塞避免')] : [])] },
    { id: 'p5', title: 'UDP 的特点', evidence: [place('传输层-3', 'UDP 无连接，不保证可靠交付', 3)] },
    ...(orphan && papers ? [{ id: 'p6', title: '校验和的计算', evidence: [paper('简述三次握手')] }] : []),
    ...Array.from({ length: many }, (_, index) => ({ id: `m${index}`, title: `补充考点 ${index}`, parentId: index % 7 ? `m${index - (index % 7)}` : undefined,
      evidence: [place('传输层-4', '接收方通过窗口通告控制发送方', 4)] })),
  ];
  const material = examBlueprintMaterial({ title, courses, scope: { label: scope }, language: 'zh', inputs, points, ...(supersedes ? { supersedes } : {}),
    recommendedReading: { title: '计算机网络：自顶向下方法', author: 'Kurose', note: '老师推荐，未导入' },
    ...(papers ? { examShape: { questions: [{ label: 'Q1', type: '简答', marks: 10, pointIds: ['p2'] }, { label: 'Q2', type: '比较', marks: 10, pointIds: ['p4'] },
      { label: 'Q3', type: '简答', marks: 5, pointIds: [] }], unmatched: ['Q3'] } } : {}) });
  const source = { ...material, createdAt, ...(id ? { id } : {}) };
  return source;
}

/** A job of the snapshot for the build (the shape the runtime publishes: type, status, contract.detail.blueprint, contract.result). `course` is the build's course (`contract.detail.course`: the name, or null). */
export function buildJob({ id = 'blueprint-1', title = '网络 · 传输层 考点清单', status = 'running', done = 2, total = 5, refs = [], finishedAt, targetId = null, supersedes = null, course = '网络' } = {}) {
  return { id, type: 'exam-blueprint-build', status, startedAt: STAMP, ...(finishedAt ? { finishedAt } : {}),
    contract: { contractVersion: 1, jobId: id, kind: 'exam-blueprint-build', title, status, stage: { code: `blueprint.${status === 'complete' ? 'complete' : 'slides'}`, text: '正在读讲义' },
      progress: { done, total, unit: 'steps', percent: null, segments: [] }, result: { refs, completeness: status === 'complete' ? 'complete' : null },
      detail: { targetId, supersedes, course, blueprint: { stage: 'slides', windows: { done, total }, paper: { done: 0, total: 0 }, points: 0, dropped: { evidence: 0, points: 0 }, reused: 0, skippedPages: [], unmatchedQuestions: [] } },
      usage: { tokens: null, tokenUsage: null, calls: 0 }, calls: [], events: [], startedAt: STAMP, ...(finishedAt ? { finishedAt } : {}), actions: {} } };
}

/** The snapshot around them: the library's materials (no point list among them), the lists as summaries (`examPointLists`), the jobs. `on` switches the page on the way the host does (`features.examBlueprint`). */
export function snapshot({ on = true, lists = [pointList()], sources = library(), jobs = [], course = '网络', courses = ['网络', '数据库'], experimental = false } = {}) {
  return { root: '/tmp/library', contexts: ['materials', 'bank', 'study', 'generation', 'authoring'], ...(on === ABSENT ? {} : { features: { examBlueprint: on } }), experimental,
    sources, examPointLists: lists.map(examPointListSummary), jobs, decks: [], drafts: [], model: { ready: true }, modelReady: true,
    focus: { course, courses: courses.map(name => ({ name, count: 1, active: true })) } };
}

export { ABSENT };
