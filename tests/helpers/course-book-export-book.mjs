/* A small 复习全书 as course.book.open answers it (M6 tests): one chapter with two points, the learner's notes with a typed heading, bold definitions,
   a [[term]] marker, a noprint region, footnotes, an AI block, links to a live, a deleted and a cloze question; a Q&A file with a follow-up and an
   answer card; 未归位 with its own footnote. Pure data, no service. */
import { CASE_TYPES } from '../../lib/case-types.js';

export const GEN = [
  '**知识梳理**', '', '- **可用性**：系统能提供服务的时间比例 [^1]。', '', '**讲解**', '', '串联时 A = A1 x A2。', '',
  '**出处**', '', '[^1]: [「Availability is the proportion of time」](studyhub://source/s1) · Lecture 4', '',
  '[练 5 道：Availability](studyhub://practice?heading=h2&n=5) · [本节问答：Availability](studyhub://qa?heading=h2)',
].join('\n');
export const MINE = [
  '## 我的推导 <!-- sh:id h9 -->', '', '**MTTR** is the mean time to repair [^1].', '', '[[串联]] 的可用性相乘。', '',
  '- [练习：an old question](studyhub://card/d/gone)', '- 另见 [练习：a blank](studyhub://card/d/q3)', '',
  '<!-- sh:noprint -->', '只给自己看的草稿。', '**草稿词**：不该出现在导出里。', '<!-- /sh:noprint -->', '', '[^1]: my own footnote', '',
  '<!-- sh:ai id=ai1 at=h:h2 state=kept mode=here ask=more -->', '关于：「Availability」', '', 'An AI paragraph under the heading.', '<!-- /sh:ai -->',
].join('\n');
export const QA = [
  '- [练习：Which is right?](studyhub://card/d/q1)', '', '<!-- sh:qa card=q1 fid=f1 -->', '> **追问：** 为什么串联要相乘？', '>', '> **答：** 因为相互独立。', '<!-- /sh:qa -->',
].join('\n');
export const GEN2 = [
  '**讲解**', '', '**吞吐量**是单位时间处理的请求数 [^1]。', '', '**出处**', '', '[^1]: [「Throughput is requests per second」](studyhub://source/s2)', '',
  '[练 5 道：Performance](studyhub://practice?heading=h3&n=5) · [本节问答：Performance](studyhub://qa?heading=h3)',
].join('\n');

export const answerCard = () => ({ v: 1, language: 'zh', questionType: { id: 'availability', label: '可用性' }, signals: [], facts: [],
  concepts: [{ name: '可用性', quote: 'Availability is the proportion of time', verified: true }], assumptions: ['MTTR 为 2 小时'], steps: ['A = 1000 / (1000 + 2) = 0.998'],
  conclusion: '可用性约 99.8%。', justification: { goal: '达到目标。', cost: '多一台服务器的费用。', failure: '主备切换。', verify: '做一次故障演练。' },
  pitfalls: ['把串联的可用性相加'], marksMap: [] });

export const CARDS = {
  q1: { id: 'q1', kind: 'quiz', prompt: 'Which is right?', options: [{ id: 'a', text: 'Add them', correct: false }, { id: 'b', text: 'Multiply them', correct: true },
    { id: 'c', text: 'Average them', correct: false }], explanation: 'Independent parts in series multiply.' },
  q2: { id: 'q2', kind: 'open', prompt: '一个系统由两台串联的服务器组成，求可用性。', answer: '约 99.8%。', explanation: '', answerCard: answerCard() },
  q3: { id: 'q3', kind: 'cloze', prompt: 'Fill the blank.', cloze: { text: 'A = MTBF / (MTBF + {{c1}})', answers: [{ id: 'c1', value: 'MTTR' }] }, answer: 'MTTR' },
};
export const cardOf = (deckId, cardId) => (deckId === 'd' ? CARDS[cardId] ?? null : null);

/** The book; `patch` changes the first point. */
export function exportBook(patch = {}) {
  return {
    status: 'ok', course: 'SA', title: '复习全书 · SA', language: 'zh',
    nodes: [{ hid: 'h1', key: 'bk:c1', title: 'Introduction', number: '1', depth: 1, leaf: false, children: [
      { hid: 'h2', key: 'bk:a', title: 'Availability', number: '1.1', depth: 2, leaf: true, gen: GEN, mine: MINE, qa: QA,
        questions: [{ deckId: 'd', cardId: 'q1', prompt: 'Which is right?' }, { deckId: 'd', cardId: 'q2', prompt: CARDS.q2.prompt }], questionTotal: 2, children: [], ...patch },
      { hid: 'h3', key: 'bk:p', title: 'Performance', number: '1.2', depth: 2, leaf: true, gen: GEN2, mine: '', qa: '', questions: [], questionTotal: 0, children: [] }] }],
    unplaced: { title: '未归位', text: '### Old point（已无对应知识点）\n\nAn old note [^1].\n\n[^1]: an old footnote', file: 'unplaced.md' },
    answerCards: [{ deckId: 'd', cardId: 'q2', prompt: CARDS.q2.prompt, hid: 'h2', questionType: { id: 'availability', label: '可用性' }, concepts: [{ name: '可用性' }],
      pitfalls: ['把串联的可用性相加'], cost: '多一台服务器的费用。' }],
    caseTypes: CASE_TYPES,
  };
}
