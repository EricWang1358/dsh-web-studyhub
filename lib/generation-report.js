/* What happened to the parts of one generation, in numbers and a reason each (the "partReport" of a draft and of its job). Pure; the backend writes it,
   the job card, the draft page and the agent read it. The English prose here is for the agent and the logs; the UI says the same in the learner's
   language from the counts (ui/draft-shortfall.js). */

/** Why a part did not fully pass, from the text the pipeline left: 'quote' (a quote or page id that is not in the pages), 'plan', 'quality' or 'other'. */
export function failureReason(text) {
  const value = String(text ?? '');
  if (/quote\b|not in source|unknown source|sourceId .* is not one of|citation/i.test(value)) return 'quote';
  if (/Assessment plan is not usable|Return exactly \d+ targets|infeasible self-contained/i.test(value)) return 'plan';
  if (/Quality gate failed|Editorial review still found issues|Answer blueprint|Author returned no questions|insufficient evidence|answerLeak|selfContained|optionQuality|learningValue|sourceSupport|explanationQuality|duplicate|formula outside math delimiters|the stem asks what the source says|Card \d+: [\w-]+ (?:is required|must be text)|need 3.6 options|invalid correct option count|each option requires|hint reveals the answer/i.test(value)) return 'quality';
  return 'other';
}

const SAY = { quote: 'quoted text that could not be found in the pages', plan: 'a learning-target plan that did not pass its checks',
  quality: 'questions that did not pass the quality review', other: 'another problem' };

/**
 * One record per part, then the totals: `{ total, passed, partial, failed, pending, reasons: { quote?, plan?, quality?, other? }, parts, citationsRepaired, summary }`.
 * `planned` are the planned parts ({ count }), `outcomes` what each produced ({ deck?, error?, pending? } or nothing yet), `notes[k]` extra reason
 * lines of part k (targets of its plan that were dropped because their quotes could not be grounded).
 */
export function summarizePartOutcomes({ planned, outcomes, notes = new Map() }) {
  const parts = [], reasons = {};
  let passed = 0, partial = 0, failed = 0, pending = 0, citationsRepaired = 0;
  planned.forEach((part, k) => {
    const outcome = outcomes[k];
    if (!outcome || outcome.pending) { pending++; return; }
    const deck = outcome.deck, kept = deck?.cards?.length ?? 0;
    const lines = [...(outcome.error ? [outcome.error] : []), ...(deck?.editorial?.omitted || []).flatMap((item) => item.reasons || []),
      ...(deck?.editorial?.omittedIssues || []), ...(notes.get(k) || [])];
    citationsRepaired += deck?.editorial?.citationRepair?.fixed || 0;
    const status = kept >= part.count && !outcome.error ? 'passed' : kept > 0 ? 'partial' : 'failed';
    const found = [...new Set(lines.map(failureReason))].filter((code) => code !== 'other');
    const codes = status === 'passed' ? [] : found.length ? found : ['other'];
    if (status === 'passed') passed++; else if (status === 'partial') partial++; else failed++;
    for (const code of codes) reasons[code] = (reasons[code] || 0) + 1;
    parts.push({ part: k + 1, asked: part.count, kept, status, ...(codes.length ? { reasons: codes } : {}) });
  });
  const total = passed + partial + failed;
  const why = Object.entries(reasons).map(([code, count]) => `${count} part(s) had ${SAY[code]}`);
  const summary = `${passed} of ${total} parts passed fully; ${partial} kept only some questions and ${failed} produced none${why.length ? ` (${why.join('; ')})` : ''}.`;
  return { total, passed, partial, failed, pending, reasons, parts, ...(citationsRepaired ? { citationsRepaired } : {}), summary };
}

/**
 * The part report as one plain sentence in the job's language ('en', else Chinese): how many parts passed, how many kept only some questions or
 * none, and why (for example "5 个部分的引用在资料里找不到"). The job result carries it for the agent; the UI says the same from the counts.
 */
export function describePartReport(report, language = 'zh') {
  if (!report || !report.total) return '';
  const en = language === 'en', { total, passed, partial, failed, reasons = {} } = report;
  const clause = {
    quote: (n) => en ? `${n} part(s) quoted text that could not be found in the pages` : `${n} 个部分的引用在资料里找不到`,
    plan: (n) => en ? `${n} part(s) had a learning-target plan that did not pass its checks` : `${n} 个部分的考点规划没有通过检查`,
    quality: (n) => en ? `${n} part(s) had questions that did not pass the quality review` : `${n} 个部分的题没有通过质量审阅`,
    other: (n) => en ? `${n} part(s) stopped for another reason` : `${n} 个部分因其他原因没有完成`,
  };
  const why = Object.entries(reasons).filter(([, n]) => n > 0).map(([code, n]) => (clause[code] || clause.other)(n));
  const head = en ? `${total} parts: ${passed} passed fully, ${partial} kept only some questions, ${failed} produced none.`
    : `共 ${total} 个部分：${passed} 个全部通过，${partial} 个只保留了部分题，${failed} 个没有出题。`;
  const repaired = report.citationsRepaired ? (en ? ` Citations of ${report.citationsRepaired} question(s) were repaired automatically.` : `已自动重试并修正了 ${report.citationsRepaired} 道题的引用。`) : '';
  return head + (why.length ? (en ? ` Why: ${why.join('; ')}.` : `原因：${why.join('；')}。`) : '') + repaired;
}
