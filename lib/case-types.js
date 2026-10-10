/* The question types of case and analysis questions (大题) and how each is solved: DATA, not code (复习全书 M5, docs/plans/review-book.md).
   The answer card of a question (lib/answer-card.js) names its type and follows the type's steps; the model is shown this catalogue and picks one.
   A course may add its own types, or replace one of these by its id, through the course record (course.save { caseTypes }, lib/courses.js); they are
   checked by `checkedCaseTypes` and merged by `caseTypesFor`. Pure, no Node modules (the browser bundle shares it).

   A type: { id, label: { zh, en } | string, signals: [words in a stem that point to it], steps: [the solving steps, in order], formulas?: [...],
   mistakes?: [the most common mistakes, and the cost an answer must state] }. The first entries come from the SWE5001 course's own cheat sheet (a
   classmate's CP); `general` is the fallback of every other question. The 查找页 of the book (lib/course-book-lookup.js) shows a type's steps, formulas
   and mistakes as its 速查表 row. */

/** The order every answer follows, whatever its type. */
export const ANSWER_ORDER = Object.freeze([
  'stem facts (quoted)', 'explicit assumptions where the stem is silent', 'design or calculation', 'why it meets the goal', 'failure handling and cost', 'how to verify',
]);
/** ANSWER_ORDER in the learner's words (the 查找页 shows it above the 速查表). */
export const answerOrderWords = language => (language === 'en'
  ? ['Stem facts', 'Explicit assumptions', 'Design or calculation', 'Why it meets the goal', 'Failure and cost', 'How to verify']
  : ['题干事实', '明示假设', '设计/计算', '为什么满足目标', '失败与代价', '如何验证']);

export const CASE_TYPES = Object.freeze([
  { id: 'risk', label: { zh: '风险场景', en: 'Risk scenario' },
    signals: ['风险', '威胁', '攻击', '安全', '漏洞', '泄露', 'STRIDE', 'risk', 'threat', 'attack', 'security', 'vulnerab', 'breach'],
    steps: ['Classify the threats with STRIDE (spoofing, tampering, repudiation, information disclosure, denial of service, elevation of privilege)',
      'Write each risk as a four-part chain: the threat exploits a vulnerability, harms an asset, which leads to a consequence',
      'Rank the risks (likelihood x impact) and say which comes first and why',
      'Give a control for each top risk (prevent, detect, respond)',
      'Say how to verify each control works and what residual risk remains'],
    mistakes: ['Listing threats without the four-part chain (threat, vulnerability, asset, consequence)', 'A control with no way to verify it',
      'Forgetting the residual risk and the cost of the control'] },
  { id: 'availability', label: { zh: '可用性', en: 'Availability' },
    signals: ['可用性', '可用率', '宕机', '停机', '故障', 'MTBF', 'MTTR', 'availability', 'uptime', 'downtime', 'failover', 'nines'],
    formulas: ['A = MTBF / (MTBF + MTTR)', 'independent components in series: A = A1 x A2 x ... x An', 'independent components in parallel: A = 1 - (1 - A1)(1 - A2)...(1 - An)',
      'yearly downtime = (1 - A) x 8760 h'],
    steps: ['List the components on the path and the availability of each (quoted from the stem, or an explicit assumption)',
      'Compute each component with A = MTBF / (MTBF + MTTR) when the stem gives MTBF and MTTR',
      'Combine: series multiplies, independent parallel replicas give 1 - product of (1 - Ai)', 'Turn the result into yearly downtime with (1 - A) x 8760 h',
      'Compare with the target and change the weakest part (redundancy, faster repair) if it is not met'],
    mistakes: ['Adding availabilities instead of multiplying them in series', 'Treating replicas as independent when they share a failure (power, region, software)',
      'No downtime in hours, so the target cannot be compared', 'Redundancy without its cost (more hardware, failover complexity)'] },
  { id: 'performance', label: { zh: '性能', en: 'Performance' },
    signals: ['响应时间', '延迟', '吞吐', '并发', 'TPS', 'QPS', '性能', 'latency', 'response time', 'throughput', 'performance', 'concurrent'],
    formulas: ['response time = queueing + processing + network', 'a serial path: the times add up', 'throughput (TPS) is bounded by the slowest layer'],
    steps: ['Draw the request path layer by layer and the time each layer takes', 'Response time = queueing + processing + network; along a serial path the times add up',
      'Throughput is bounded by the slowest layer: find it', 'Remove the bottleneck (caching, more instances, asynchronous work) and recompute',
      'Check the result against the target (for example a percentile response time)'],
    mistakes: ['Averages instead of the percentile the target names', 'Scaling a layer that is not the bottleneck', 'A cache without its cost (staleness, invalidation, memory)'] },
  { id: 'capacity', label: { zh: '容量与 RAID', en: 'Capacity and RAID' },
    signals: ['容量', '存储', '磁盘', 'RAID', '备份', '多少空间', 'capacity', 'storage', 'disk', 'backup', 'terabyte', 'TB', 'GB'],
    formulas: ['raw data = users x events per user x record size x years', 'then add index overhead, redundancy (RAID level or replicas) and backups'],
    steps: ['Raw data = users x events per user per period x record size x years kept', 'Add the index overhead', 'Apply the redundancy (RAID level or the number of replicas)',
      'Add the backup copies and their retention', 'State the total with its unit and the assumptions it rests on'],
    mistakes: ['Mixing units (GB and GiB, per day and per year)', 'Forgetting the RAID or replica overhead, or the backups', 'A total with no stated assumptions'] },
  { id: 'domain', label: { zh: '领域划分', en: 'Domain decomposition' },
    signals: ['领域', '限界上下文', '微服务划分', '拆分', '服务边界', 'bounded context', 'domain', 'decompos', 'service boundar', 'microservice'],
    steps: ['Group by business language: the same word means the same thing inside one domain', 'Keep the rules that must be synchronously correct inside one domain',
      'Keep what changes together together', 'Weigh the cost of every cross-domain call (latency, failure, consistency)',
      'Name the domains, their responsibilities and how they talk to each other'],
    mistakes: ['Splitting by technical layer instead of business language', 'A rule that must be synchronously correct split across two domains',
      'Cross-domain calls without their cost (latency, failure, consistency)'] },
  { id: 'cloud', label: { zh: '云迁移与选型', en: 'Cloud migration and choice' },
    signals: ['云', '迁移', '上云', '选型', 'IaaS', 'PaaS', 'SaaS', 'serverless', 'cloud', 'migrat', 'vendor', 'choose between'],
    steps: ['Quote the stem facts that decide the choice', 'State the missing assumption the choice depends on', 'Make the choice',
      'Say why it satisfies the need', 'Say what it costs and how failures are handled', 'Say how to validate it'],
    mistakes: ['A choice without the stem fact that decides it', 'No cost (lock-in, migration effort, running cost)', 'No way to validate the choice'] },
  { id: 'general', label: { zh: '一般分析题', en: 'General analysis' }, signals: [],
    steps: ['Quote the stem facts the question turns on', 'State the assumptions where the stem is silent', 'Design or calculate',
      'Say why it meets the goal', 'Say what it costs and how failures are handled', 'Say how to verify it'],
    mistakes: ['Claims the stem does not support', 'An assumption used but never stated', 'No cost and no way to verify'] },
]);

/** The built-in types' steps, formulas and mistakes in Chinese (the English above is what the model is shown); a course's own types stay as written. */
const ZH_TEXT = Object.freeze({
  risk: { steps: ['用 STRIDE 给威胁分类（仿冒、篡改、抵赖、信息泄露、拒绝服务、权限提升）', '每个风险写成四段链：威胁利用漏洞，损害资产，导致后果',
    '给风险排序（可能性 × 影响），说清先处理哪个、为什么', '为排在前面的风险各给一个控制措施（预防、检测、响应）', '说明怎样验证每个控制有效，还剩哪些残余风险'],
  mistakes: ['只列威胁，没有四段链（威胁、漏洞、资产、后果）', '控制措施没有验证方法', '忘了残余风险和控制措施的代价'] },
  availability: { steps: ['列出路径上的部件和每个的可用性（引题干原话，或明示假设）', '题干给了 MTBF 和 MTTR 时，用 A = MTBF / (MTBF + MTTR) 算每个部件',
    '组合：串联相乘；独立的并联副本是 1 − ∏(1 − Ai)', '用 (1 − A) × 8760 小时换算成每年停机时间', '和目标比较；达不到就改最弱的一环（冗余、更快修复）'],
  formulas: ['A = MTBF / (MTBF + MTTR)', '独立部件串联：A = A1 × A2 × … × An', '独立部件并联：A = 1 − (1 − A1)(1 − A2)…(1 − An)', '每年停机 = (1 − A) × 8760 小时'],
  mistakes: ['串联时把可用性相加，而不是相乘', '副本有共同故障（电源、机房、软件）却当成相互独立', '没有换算成停机小时，无法和目标比较', '只说冗余，不说代价（更多硬件、切换的复杂度）'] },
  performance: { steps: ['逐层画出请求路径和每层用时', '响应时间 = 排队 + 处理 + 网络；串行路径上各段相加', '吞吐量受最慢一层限制：找出它',
    '消除瓶颈（缓存、加实例、异步处理）后重新计算', '用目标检查结果（例如某个百分位的响应时间）'],
  formulas: ['响应时间 = 排队 + 处理 + 网络', '串行路径：各段时间相加', '吞吐量（TPS）受最慢一层限制'],
  mistakes: ['目标要百分位，却用平均值', '扩容的不是瓶颈那一层', '加缓存不说代价（数据过期、失效处理、内存）'] },
  capacity: { steps: ['原始数据 = 用户数 × 每人每期事件数 × 每条记录大小 × 保存年数', '加上索引开销', '算上冗余（RAID 级别或副本数）', '加上备份份数和保留期',
    '写出带单位的总量和它依据的假设'],
  formulas: ['原始数据 = 用户数 × 每人事件数 × 记录大小 × 年数', '再加索引开销、冗余（RAID 级别或副本）和备份'],
  mistakes: ['单位混用（GB 与 GiB、每天与每年）', '漏了 RAID 或副本的开销，或漏了备份', '总量没有写明假设'] },
  domain: { steps: ['按业务语言分组：同一个词在一个领域里意思相同', '必须同步保证正确的规则放在一个领域内', '一起变化的放在一起', '权衡每次跨领域调用的代价（延迟、失败、一致性）',
    '写出各领域的名字、职责和相互通信方式'],
  mistakes: ['按技术分层拆，而不是按业务语言', '必须同步正确的规则被拆到两个领域', '跨领域调用不说代价（延迟、失败、一致性）'] },
  cloud: { steps: ['引出决定选择的题干事实', '说出选择所依赖、题干没给的假设', '做出选择', '说明为什么满足需求', '说明代价和故障怎么处理', '说明怎样验证'],
    mistakes: ['做了选择却没有决定它的题干事实', '不说代价（锁定、迁移工作量、运行费用）', '没有验证选择的办法'] },
  general: { steps: ['引出题目所依据的题干事实', '题干没说的地方明示假设', '设计或计算', '说明为什么满足目标', '说明代价和故障怎么处理', '说明怎样验证'],
    mistakes: ['写了题干不支持的结论', '用了假设却没写出来', '没有代价，也没有验证方法'] },
});
const CJK = /[㐀-鿿]/u;
/**
 * A type's words in a language: { steps, formulas, mistakes, signals }. A built-in type (not replaced by a course, not `own`) is in Chinese for 'zh'
 * and in English for 'en', its signals those of that language (an acronym such as MTBF in both); a course's own type is as written.
 */
export function typeText(type, language) {
  const builtIn = CASE_TYPES.find(item => item.id === type?.id), zh = ZH_TEXT[type?.id];
  const same = !!builtIn && !type.own && (type.steps || [])[0] === builtIn.steps[0];
  const own = { steps: type?.steps || [], formulas: type?.formulas || [], mistakes: type?.mistakes || [], signals: type?.signals || [] };
  if (!same) return own;
  const signals = own.signals.filter(signal => (language === 'en' ? !CJK.test(signal) : CJK.test(signal) || /^[A-Z0-9]+$/.test(signal)));
  return language === 'en' ? { ...own, signals } : { steps: zh.steps, formulas: zh.formulas || own.formulas, mistakes: zh.mistakes || own.mistakes, signals };
}

const LIMITS = Object.freeze({ types: 12, id: 32, label: 40, signals: 16, signal: 40, steps: 10, step: 300, formulas: 6, mistakes: 6 });
const clean = (value, max) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const strings = (value, count, max) => (Array.isArray(value) ? value.map(item => clean(item, max)).filter(Boolean).slice(0, count) : []);

/** A course's own types, checked: [{ id, label, signals, steps, formulas? }] (an invalid entry is an error, so course.save says what is wrong). */
export function checkedCaseTypes(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > LIMITS.types) throw new Error(`caseTypes: a list of at most ${LIMITS.types} question types`);
  const seen = new Set();
  return value.map((item, at) => {
    const id = clean(item?.id, LIMITS.id).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || seen.has(id)) throw new Error(`caseTypes[${at}]: a unique id of letters, digits and dashes`);
    seen.add(id);
    const label = clean(typeof item.label === 'string' ? item.label : item.label?.zh || item.label?.en, LIMITS.label);
    const steps = strings(item.steps, LIMITS.steps, LIMITS.step);
    if (!label || !steps.length) throw new Error(`caseTypes[${at}]: a label and at least one step`);
    const formulas = strings(item.formulas, LIMITS.formulas, LIMITS.step), mistakes = strings(item.mistakes, LIMITS.mistakes, LIMITS.step);
    return { id, label, signals: strings(item.signals, LIMITS.signals, LIMITS.signal), steps, ...(formulas.length ? { formulas } : {}), ...(mistakes.length ? { mistakes } : {}) };
  });
}

/** The catalogue a course uses: the built-in types, a course's own type replacing the one of the same id, the others added before `general`. */
export function caseTypesFor(extra = []) {
  let own = [];
  try { own = checkedCaseTypes(Array.isArray(extra) ? extra : []) || []; } catch { own = []; }
  const byId = new Map(own.map(item => [item.id, item]));
  const builtIn = CASE_TYPES.filter(item => item.id !== 'general').map(item => byId.get(item.id) || item);
  const added = own.filter(item => !CASE_TYPES.some(builtin => builtin.id === item.id));
  return [...builtIn, ...added, byId.get('general') || CASE_TYPES.find(item => item.id === 'general')];
}

/** The label of a type in a language. */
export const typeLabel = (type, language) => (typeof type?.label === 'string' ? type.label : (language === 'en' ? type?.label?.en : type?.label?.zh) || type?.id || '');

/** The type whose signals a text names most often (case-insensitive), else `general`. A guess the model may overrule; used when it names no known type. */
export function guessCaseType(text, types = CASE_TYPES) {
  const value = String(text ?? '').toLowerCase();
  let best = null, hits = 0;
  for (const type of types) {
    const count = (type.signals || []).filter(signal => signal && value.includes(signal.toLowerCase())).length;
    if (count > hits) { best = type; hits = count; }
  }
  return best || types.find(type => type.id === 'general') || types.at(-1);
}
