import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendSimilar, normalizeTopic, promptTokens, deckShortTitles } from '../lib/recommend.js';

// WP26: "为你推荐" — similar EXISTING questions for the current mistakes, with no model call.
const NOW = Date.parse('2026-10-02T10:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const card = (id, topic, prompt, extra = {}) => ({ id, kind: 'quiz', topic, prompt, answer: 'a', citations: [], ...extra });
const pdfPage = (docId, filename, page) => ({ id: `${docId}-p${page}`, title: `${filename} · p.${page}`, text: 'x',
  document: { id: docId, filename, page, totalPages: 80 } });
const attempt = (deckId, quiz_id, grade, timestamp, extra = {}) => ({ id: `${deckId}-${quiz_id}-${timestamp}`, deckId, quiz_id, grade, timestamp, ...extra });

function state(overrides = {}) {
  return {
    sources: [pdfPage('doc', '05 Platform Management', 21), pdfPage('doc', '05 Platform Management', 22),
      pdfPage('doc', '05 Platform Management', 60), { id: 'note', title: 'My notes', text: 'x' },
      { id: 'json', title: 'JSON 导入：期末卷', text: 'x', provenance: 'json-card-self-reference' }],
    decks: [
      { id: 'd4', title: 'Platform Engineering｜期末综合卷04｜90题', course: 'PE', cards: [
        card('m1', '保护状态', '熔断器处于哪种保护状态时会拒绝全部请求？', { citations: [{ sourceId: 'doc-p21', quote: 'q' }] }),
        card('m2', '组织与架构', '平台团队应该如何划分职责边界？') ] },
      { id: 'd2', title: 'Platform Engineering｜期末综合卷02｜90题', course: 'PE', cards: [
        card('same-topic', ' 保护 状态 ', '以下关于半开状态的描述哪项正确？'),
        card('same-page', '恢复探测', '为什么这一页强调要探测依赖恢复？', { citations: [{ sourceId: 'doc-p21', quote: 'q' }] }),
        card('near-page', '其它', '相邻一页讲了什么？', { citations: [{ sourceId: 'doc-p22', quote: 'q' }] }),
        card('far-page', '其它', '很远的一页讲了什么？', { citations: [{ sourceId: 'doc-p60', quote: 'q' }] }),
        card('self-cited', '其它', '自引用的 JSON 题不算独立证据？', { citations: [{ sourceId: 'json', quote: 'q' }] }),
        card('overlap', '杂项', '熔断器拒绝请求之后如何保护下游依赖？'),
        card('stop-only', '杂项', '下列哪个说法是正确的？什么是最佳实践？'),
        card('unrelated', '杂项', '光合作用发生在叶绿体的哪个部分？') ] },
      { id: 'other', title: 'Biology', course: 'BIO', cards: [card('bio', '保护状态', '另一门课里同主题的题')] },
    ],
    attempts: [], runs: [],
    ...overrides,
  };
}
const mistakes = [{ deckId: 'd4', cardId: 'm1' }];
const ids = (result) => result.items.map((item) => item.cardId);
const reasonsOf = (result, id) => result.items.find((item) => item.cardId === id)?.reasons.map((r) => r.type);

test('topic names are normalised before comparing and 未分类 never matches', () => {
  assert.equal(normalizeTopic(' 保护 状态 '), normalizeTopic('保护状态'));
  assert.equal(normalizeTopic('Circuit-Breaker  State'), normalizeTopic('circuit breaker state'));
  assert.equal(normalizeTopic('未分类'), '');
  assert.equal(normalizeTopic(undefined), '');
});

test('prompt tokens are CJK bigrams plus latin words, without question boilerplate', () => {
  const tokens = promptTokens('Kubernetes 的熔断器如何保护下游？What is a circuit breaker?');
  for (const expected of ['熔断', '断器', 'kubernetes', 'circuit', 'breaker']) assert.ok(tokens.has(expected), expected);
  assert.ok(!tokens.has('what'));
  assert.ok(!promptTokens('下列哪个说法是正确的？').has('下列'));
});

test('a question with the same normalised topic in another deck is recommended with the topic as the reason', () => {
  const result = recommendSimilar(state(), { mistakes, course: 'PE', now: NOW });
  assert.ok(ids(result).includes('same-topic'));
  const item = result.items.find((x) => x.cardId === 'same-topic');
  assert.deepEqual(item.reasons[0], { type: 'topic', topic: '保护状态' });
  assert.equal(item.deckId, 'd2');
  assert.deepEqual(item.forCardIds, ['m1']);
  assert.equal(result.items[0].cardId, 'same-topic', 'the strongest evidence (same topic) ranks first');
});

test('citing the same page or a neighbouring page of the same document is a reason; a distant page is not', () => {
  const result = recommendSimilar(state(), { mistakes, course: 'PE', now: NOW });
  assert.deepEqual(result.items.find((x) => x.cardId === 'same-page').reasons.find((r) => r.type === 'page'),
    { type: 'page', sourceTitle: '05 Platform Management', page: 21 });
  assert.deepEqual(result.items.find((x) => x.cardId === 'near-page').reasons.find((r) => r.type === 'near'),
    { type: 'near', sourceTitle: '05 Platform Management', page: 22 });
  assert.ok(!ids(result).includes('far-page'));
  const samePageRank = ids(result).indexOf('same-page'), nearRank = ids(result).indexOf('near-page');
  assert.ok(samePageRank < nearRank, 'same page outranks a neighbouring page');
});

test('a JSON self-reference is not independent evidence and never links two cards', () => {
  const s = state();
  s.decks[0].cards[0].citations = [{ sourceId: 'json', quote: 'q' }];
  const result = recommendSimilar(s, { mistakes, course: 'PE', now: NOW });
  assert.ok(!ids(result).includes('self-cited'));
});

test('sharing key terms in the prompt recommends a question; boilerplate alone does not', () => {
  const result = recommendSimilar(state(), { mistakes, course: 'PE', now: NOW });
  assert.ok(ids(result).includes('overlap'));
  const terms = result.items.find((x) => x.cardId === 'overlap').reasons.find((r) => r.type === 'terms');
  assert.ok(terms.terms.length >= 1 && terms.terms.length <= 3);
  assert.ok(!ids(result).includes('stop-only'));
  assert.ok(!ids(result).includes('unrelated'));
});

test('mistakes themselves, other wrong-book cards, recently answered and suspended cards are excluded', () => {
  const s = state({ attempts: [
    attempt('d4', 'm1', 1, daysAgo(1)),
    attempt('d2', 'same-page', 2, daysAgo(2)),
    attempt('d2', 'same-topic', 5, daysAgo(2)),
    attempt('d2', 'overlap', 4, daysAgo(30)),
    attempt('d2', 'near-page', 4, daysAgo(1), { implicit: true }),
  ] });
  s.decks[1].cards.find((c) => c.id === 'self-cited').suspended = true;
  const result = recommendSimilar(s, { mistakes, course: 'PE', days: 7, now: NOW });
  assert.ok(!ids(result).includes('m1'), 'the mistake itself');
  assert.ok(!ids(result).includes('same-page'), 'still wrong: already in the wrong book');
  assert.ok(!ids(result).includes('same-topic'), 'answered correctly two days ago');
  assert.ok(ids(result).includes('overlap'), 'answered correctly 30 days ago is fair game again');
  assert.ok(ids(result).includes('near-page'), 'an implicit prerequisite credit is not an answer');
  assert.ok(!ids(result).includes('self-cited'));
});

test('the course scope limits the pool; archived and system decks never contribute', () => {
  const s = state();
  s.decks.push({ id: 'sys', title: '为你定制', systemKind: 'coach', course: 'PE', cards: [card('variant', '保护状态', '定制变式？')] },
    { id: 'old', title: 'Old', course: 'PE', archived: true, cards: [card('gone', '保护状态', '归档题？')] });
  const scoped = recommendSimilar(s, { mistakes, course: 'PE', now: NOW });
  assert.ok(!ids(scoped).includes('bio'));
  assert.ok(!ids(scoped).includes('variant'));
  assert.ok(!ids(scoped).includes('gone'));
  const all = recommendSimilar(s, { mistakes, course: '*', now: NOW });
  assert.ok(ids(all).includes('bio'), 'all courses include other courses');
});

test('results are ranked by evidence, capped, deterministic and never mutate the library', () => {
  const s = state();
  for (let i = 0; i < 15; i++) s.decks[1].cards.push(card(`topic-${String(i).padStart(2, '0')}`, '保护状态', `变体题 ${i}：另一个角度？`));
  const before = JSON.stringify(s);
  const first = recommendSimilar(s, { mistakes, course: 'PE', now: NOW });
  const second = recommendSimilar(s, { mistakes, course: 'PE', now: NOW });
  assert.equal(JSON.stringify(s), before);
  assert.deepEqual(first, second);
  assert.equal(first.items.length, 10);
  const scores = first.items.map((x) => x.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  const small = recommendSimilar(s, { mistakes, course: 'PE', now: NOW, limit: 3 });
  assert.equal(small.items.length, 3);
});

test('several mistakes: a candidate lists every mistake it relates to and no mistakes means no recommendations', () => {
  const result = recommendSimilar(state(), { mistakes: [...mistakes, { deckId: 'd4', cardId: 'm2' }], course: 'PE', now: NOW });
  assert.ok(result.items.find((x) => x.cardId === 'same-topic').forCardIds.includes('m1'));
  assert.deepEqual(recommendSimilar(state(), { mistakes: [], course: 'PE', now: NOW }).items, []);
  assert.deepEqual(recommendSimilar(state(), { mistakes: [{ deckId: 'nope', cardId: 'x' }], course: 'PE', now: NOW }).items, []);
});

test('deck titles lose the repeated course prefix and the question-count suffix', () => {
  const titles = ['Platform Engineering｜期末综合卷04｜90题', 'Platform Engineering｜期末综合卷02｜90题', 'Platform Engineering｜期末综合卷01｜90题'];
  assert.deepEqual(titles.map((t) => deckShortTitles(titles).get(t)), ['期末综合卷04', '期末综合卷02', '期末综合卷01']);
  assert.equal(deckShortTitles(['Memento notes']).get('Memento notes'), 'Memento notes', 'a single title is never emptied');
  assert.equal(deckShortTitles(['A｜B', 'A｜B']).get('A｜B'), 'A｜B', 'identical titles keep their text');
  assert.equal(deckShortTitles(['Networking 101', 'Networking 202'], 'Networking').get('Networking 101'), '101');
});
