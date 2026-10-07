/* What happened to the parts of one generation, in numbers and a reason each (the "partReport" of a draft and of its job). Pure; the backend writes it,
   the job card, the draft page and the agent read it. The English prose here is for the agent and the logs; the UI says the same in the learner's
   language from the counts (ui/draft-shortfall.js). */

import { reasonCode } from './generation-failure.js';

/**
 * Why a part did not fully pass, from the text the pipeline left (lib/generation-failure.js is the one classifier): 'quote' (a quote or page id that is not in the
 * pages), 'plan', 'plan-short' (the plan found fewer knowledge points for a section than it was assigned, even after asking again), 'quality', 'review-protocol' (the reviewer's reply could not be read even after being asked again), 'timeout', 'rate-limit', 'no-reply',
 * 'quota', 'credential', 'budget', 'cancelled', 'unavailable' or 'other'.
 */
export const failureReason = reasonCode;

const SAY = { 'plan-short': 'sections for which the plan found fewer knowledge points than were assigned, even after asking again', quote: 'quoted text that could not be found in the pages', plan: 'a learning-target plan that did not pass its checks',
  quality: 'questions that did not pass the quality review', 'review-protocol': 'a review reply that stayed unreadable after being asked again',
  timeout: 'a model call that timed out', 'rate-limit': 'a rate-limited model service', 'no-reply': 'a model call that returned nothing',
  quota: 'an account without balance or quota', credential: 'a refused or missing model key', budget: 'the time budget running out', cancelled: 'being stopped',
  unavailable: 'an unavailable model service', other: 'another problem' };

/** How a part ended: 'pending' (not finished), 'passed' (it kept everything it was asked for), 'partial' or 'failed'. */
export function partStatusOf(count, outcome) {
  if (!outcome || outcome.pending) return 'pending';
  const kept = outcome.deck?.cards?.length ?? 0;
  return kept >= count && !outcome.error ? 'passed' : kept > 0 ? 'partial' : 'failed';
}

/** The reason codes of a part that did not fully pass: from its own failure first, else from the reasons its dropped questions carry; 'other' when nothing says. */
export function partReasonCodes(outcome, notes = []) {
  const deck = outcome?.deck;
  const lines = [...(outcome?.error ? [outcome.error] : []), ...(deck?.editorial?.omitted || []).flatMap((item) => item.reasons || []),
    ...(deck?.editorial?.omittedIssues || []), ...(notes || [])];
  const found = [...new Set(lines.map(failureReason))].filter((code) => code !== 'other');
  return found.length ? found : ['other'];
}

/**
 * One record per part, then the totals: `{ total, passed, partial, failed, pending, reasons: { quote?, plan?, quality?, other? }, parts, citationsRepaired, summary }`.
 * `planned` are the planned parts ({ count }), `outcomes` what each produced ({ deck?, error?, pending? } or nothing yet), `notes[k]` extra reason
 * lines of part k (targets of its plan that were dropped because their quotes could not be grounded).
 */
export function summarizePartOutcomes({ planned, outcomes, notes = new Map(), attempts = [] }) {
  const parts = [], reasons = {};
  let passed = 0, partial = 0, failed = 0, pending = 0, citationsRepaired = 0;
  planned.forEach((part, k) => {
    const outcome = outcomes[k];
    if (!outcome || outcome.pending) { pending++; return; }
    const deck = outcome.deck, kept = deck?.cards?.length ?? 0;
    citationsRepaired += deck?.editorial?.citationRepair?.fixed || 0;
    const status = partStatusOf(part.count, outcome);
    const codes = status === 'passed' ? [] : partReasonCodes(outcome, notes.get(k));
    if (status === 'passed') passed++; else if (status === 'partial') partial++; else failed++;
    for (const code of codes) reasons[code] = (reasons[code] || 0) + 1;
    const tries = attempts instanceof Map ? attempts.get(k) : attempts[k];
    parts.push({ part: k + 1, asked: part.count, kept, status, ...(codes.length ? { reasons: codes } : {}), ...(tries > 1 ? { attempts: tries } : {}) });
  });
  const total = passed + partial + failed;
  const why = Object.entries(reasons).map(([code, count]) => `${count} batch(es) had ${SAY[code]}`);
  const summary = `${passed} of ${total} batches passed fully; ${partial} kept only some questions and ${failed} produced none${why.length ? ` (${why.join('; ')})` : ''}.`;
  return { total, passed, partial, failed, pending, reasons, parts, ...(citationsRepaired ? { citationsRepaired } : {}), summary };
}

/**
 * The part report as one plain sentence in the job's language ('en', else Chinese): how many parts passed, how many kept only some questions or
 * none, and why (for example "5 个批次的引用在资料里找不到"). The job result carries it for the agent; the UI says the same from the counts.
 */
export function describePartReport(report, language = 'zh') {
  if (!report || !report.total) return '';
  const en = language === 'en', { total, passed, partial, failed, reasons = {} } = report;
  const clause = {
    'plan-short': (n) => en ? `${n} batch(es) in which the model gave fewer knowledge points than were assigned, even after asking again` : `${n} 个批次里模型给出的考点比计划的少，补问一次后仍然不足`,
    quote: (n) => en ? `${n} batch(es) quoted text that could not be found in the pages` : `${n} 个批次的引用在资料里找不到`,
    plan: (n) => en ? `${n} batch(es) had a learning-target plan that did not pass its checks` : `${n} 个批次的考点规划没有通过检查`,
    quality: (n) => en ? `${n} batch(es) had questions that did not pass the quality review` : `${n} 个批次的题没有通过质量审阅`,
    'review-protocol': (n) => en ? `${n} batch(es) had a review reply that stayed unreadable after being asked again` : `${n} 个批次的审阅回复格式不对，重新审阅后仍然不行`,
    timeout: (n) => en ? `${n} batch(es) stopped because the model did not answer in time` : `${n} 个批次因模型长时间没有回应而没有完成`,
    'rate-limit': (n) => en ? `${n} batch(es) were rate-limited by the model service` : `${n} 个批次被模型服务限流，重试后仍未完成`,
    'no-reply': (n) => en ? `${n} batch(es) stopped because the model returned nothing` : `${n} 个批次因模型没有返回内容而没有完成`,
    quota: (n) => en ? `${n} batch(es) stopped because the model account has no balance or quota` : `${n} 个批次因模型账户余额或额度不足而没有完成`,
    credential: (n) => en ? `${n} batch(es) stopped because the model key was refused or missing` : `${n} 个批次因模型密钥缺失或被拒绝而没有完成`,
    budget: (n) => en ? `${n} batch(es) stopped when the time budget ran out` : `${n} 个批次因生成用时到限而没有完成`,
    cancelled: (n) => en ? `${n} batch(es) were stopped` : `${n} 个批次被停止`,
    unavailable: (n) => en ? `${n} batch(es) stopped because the model service was unavailable` : `${n} 个批次因模型服务暂时不可用而没有完成`,
    other: (n) => en ? `${n} batch(es) stopped for another reason` : `${n} 个批次因其他原因没有完成`,
  };
  const why = Object.entries(reasons).filter(([, n]) => n > 0).map(([code, n]) => (clause[code] || clause.other)(n));
  const head = en ? `${total} batches: ${passed} passed fully, ${partial} kept only some questions, ${failed} produced none.`
    : `共 ${total} 个批次：${passed} 个全部通过，${partial} 个只保留了部分题，${failed} 个没有出题。`;
  const repaired = report.citationsRepaired ? (en ? ` Citations of ${report.citationsRepaired} question(s) were repaired automatically.` : `已自动重试并修正了 ${report.citationsRepaired} 道题的引用。`) : '';
  return head + (why.length ? (en ? ` Why: ${why.join('; ')}.` : `原因：${why.join('；')}。`) : '') + repaired;
}
