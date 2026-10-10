/* A small synthetic case library for the 分析题答案卡 tests (复习全书 M5): one case scenario (a material), one course material with the definitions, and a
   published case deck with one availability question (marks, rubric criteria with key points). `goodCard` is a model reply that passes every check of the
   program; `cardModel` is a fake model that answers the write, the review and the repair calls by their prompts. Nothing here reaches a network. */
import { renderRubric } from '../../lib/case-study.js';

export const COURSE = 'SWE5001';
export const SCENARIO = [
  'Harbour Rides runs a booking service for ferry tickets. The booking service runs on two independent servers behind a load balancer.',
  'Each server has an MTBF of 1000 hours and an MTTR of 2 hours. Last winter a single server failure stopped bookings for a whole afternoon.',
  'The business requires 99.9% availability for bookings during the season.',
].join('\n\n');
export const MATERIAL = [
  'Availability is the proportion of time a system is able to perform its required function.',
  'Redundancy means running more than one instance of a component so that the failure of one instance does not stop the service.',
].join(' ');

export const criteria = () => [
  { id: 'c1', label: 'Calculation', marks: 4, descriptor: 'Computes the availability of one server and of the pair.', keyPoints: ['availability of one server', 'availability of two servers in parallel'] },
  { id: 'c2', label: 'Judgement', marks: 2, descriptor: 'Compares the result with the target.', keyPoints: ['compare with the 99.9% target'] },
];

export function caseCard(overrides = {}) {
  return { id: 'q1', kind: 'open', topic: 'Availability', objective: 'Judge whether a redundant service meets its availability target',
    prompt: 'Does the booking service meet its availability target? Show the calculation.', answer: 'Yes. Each server is available 1000 / 1002 of the time and the pair far more.',
    hint: 'Start from MTBF and MTTR.', explanation: 'A strong answer computes both availabilities and compares them with the target.', misconception: 'Multiplying the availabilities of parallel servers.',
    marks: 6, rubricCriteria: criteria(), rubric: renderRubric(criteria(), 'en'), citations: [{ sourceId: 'scn', quote: 'Each server has an MTBF of 1000 hours and an MTTR of 2 hours.' }],
    caseQuestion: 1, review: { repetitions: 0, interval: 0, easiness: 2.5, due_at: '2026-10-01T00:00:00.000Z', last_grade: null, lapses: 0 }, ...overrides };
}

/** The sources and the published deck, as plain records for a store. */
export function caseLibrary({ card = caseCard() } = {}) {
  const sources = [
    { id: 'scn', title: 'Harbour Rides case', text: SCENARIO, createdAt: '2026-10-01T00:00:00.000Z', courses: [COURSE] },
    { id: 'mat1', title: 'Lecture 4 · Availability', text: MATERIAL, createdAt: '2026-10-01T00:00:00.000Z', courses: [COURSE] },
  ];
  const deck = { id: 'case1', title: 'Harbour Rides practice case', course: COURSE, folder: '', format: 'case-study', publishedAt: '2026-10-01T00:00:00.000Z',
    case: { sourceId: 'scn', title: 'Harbour Rides', totalMarks: 6, origin: 'generated', cues: [], language: 'English' },
    editorial: { generation: { kind: 'case', sourceIds: ['mat1'], course: COURSE, language: 'English' } }, cards: [card] };
  return { sources, deck };
}

/** The model's card: every quote word for word, every key point earned, every number from the stem or computed. */
export function goodCard() {
  return {
    questionType: 'availability',
    signals: [{ word: 'availability', quote: 'The business requires 99.9% availability for bookings during the season.' }],
    facts: [{ text: 'Two independent servers serve bookings', quote: 'The booking service runs on two independent servers behind a load balancer.' },
      { text: 'MTBF 1000 h, MTTR 2 h per server', quote: 'Each server has an MTBF of 1000 hours and an MTTR of 2 hours.' }],
    concepts: [{ name: 'Availability', ref: 'M1', definition: 'availability is the proportion of time a system is able to perform its   required function' }],
    assumptions: ['The two servers fail independently of each other.'],
    steps: ['One server: $A = 1000 / (1000 + 2) = 0.998$', 'Two servers in parallel: $A = 1 - (1 - 0.998)^2 = 0.999996$', 'Yearly downtime: $(1 - 0.999996) \\times 8760 = 0.035$ h'],
    conclusion: 'The pair of servers meets the 99.9% availability target.',
    justification: { goal: 'Bookings keep working when one server fails, which is the goal of the season.', cost: 'Two servers and a load balancer cost about twice one server.',
      failure: 'When one server fails the load balancer sends every booking to the other one.', verify: 'Measure the monthly uptime of the booking service against the target.' },
    pitfalls: ['Multiplying the two availabilities as if the servers were in series.'],
    marks: [{ point: 'c1.k1', sentence: 'One server: $A = 1000 / (1000 + 2) = 0.998$' }, { point: 'c1.k2', sentence: 'Two servers in parallel: $A = 1 - (1 - 0.998)^2 = 0.999996$' },
      { point: 'c2.k1', sentence: 'The pair of servers meets the 99.9% availability target.' }],
  };
}

const data = prompt => JSON.parse(prompt.slice(prompt.indexOf('REQUEST DATA:\n') + 'REQUEST DATA:\n'.length).split('\n\nREPAIR:')[0]);

/**
 * A fake model for the three calls. `write(n)` the card of the n-th write (1, then 2 for a repair); `review` the issues list; `fail(callNo)` throws;
 * `held` { at, gate } holds the call `at` until `gate.promise` settles. Calls are recorded as { kind: 'write' | 'review' | 'repair', system, prompt }.
 */
export function cardModel({ write = () => goodCard(), review = () => [], fail = () => false, held } = {}) {
  const calls = [];
  let writes = 0;
  const complete = async (system, prompt) => {
    const kind = system.startsWith('You independently review an answer card') ? 'review' : prompt.includes('\n\nREPAIR:') ? 'repair' : system.startsWith('You write the model answer') ? 'write' : 'other';
    calls.push({ kind, system, prompt, data: kind === 'other' ? null : data(prompt) });
    if (held && calls.length === held.at) await held.gate.promise;
    if (fail(calls.length)) throw new Error('provider down');
    if (kind === 'review') return JSON.stringify({ issues: review(calls.length), summary: 'checked' });
    if (kind === 'write' || kind === 'repair') return JSON.stringify(write(++writes));
    return '{}';
  };
  return { calls, complete };
}
