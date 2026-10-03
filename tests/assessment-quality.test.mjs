import test from "node:test";
import assert from "node:assert/strict";
import { generateDeck, salvageAuthoredCards, parseJson } from "../lib/generation.js";
import { generateBatched } from "../lib/batch.js";
import { publicCard } from "../lib/domain.js";
import { authored, qualityPlan, qualityReview } from "./helpers/assessment.mjs";
import { reviewIssues, explanationIssues, answerLeakIssues, planIssues, learnerContextIssues } from "../lib/assessment-quality.js";
import { reviewedCardFingerprint } from "../lib/review-integrity.js";

const source = { id: "s", title: "Course notes", text: "Architecture includes the principles guiding a system's design and evolution." };
test('model JSON control-character repair preserves strings and rejects unrelated corruption', () => {
  const controls = Array.from({ length: 32 }, (_, n) => String.fromCharCode(n)).join('');
  const value = { answer: 'Quoted "[text]" and path C:\\notes\\n', detail: controls };
  const valid = JSON.stringify(value);
  assert.deepEqual(parseJson(valid), value);
  const malformed = valid.replace(JSON.stringify(controls), '"' + controls + '"');
  assert.deepEqual(parseJson(malformed), value);
  assert.deepEqual(parseJson('Result:\n```json\n' + malformed + '\n```\nEnd.'), value);
  assert.deepEqual(parseJson('{\n"answer":"A\r\nB\tC"\n}'), { answer: 'A\r\nB\tC' });
  for (const broken of ['{"answer":"Unclosed\n', '{"answer":"A\\qB\n"}', '{"answer":"A\\\nB"}', '{"answer":"A\nB",}'])
    assert.throws(() => parseJson(broken), SyntaxError);
});
const request = { count: 1, kind: "flashcard", sources: [source] };
const card = { id: "q", kind: "flashcard", topic: "Architecture decisions", objective: "Recognize the role of architectural constraints",
  prompt: "Why does architecture contain principles guiding design and evolution?", answer: "Principles guide subsequent design choices and changes.",
  hint: "Compare a current-state description with a constraint on permitted changes.", explanation: "The quoted definition explicitly includes principles governing design and evolution.", misconception: "Architecture only describes current components.", citations: [{ sourceId: "s", quote: source.text }] };
const candidate = () => ({ title: "Architecture", cards: [structuredClone(card)] });

test('one independent review keeps approved questions without repair or a second audit', async () => {
  const deck = candidate();
  deck.cards.push({ ...structuredClone(card), id: 'bad', prompt: 'Another question?', objective: 'Another target' });
  const req = { ...request, count: 2 }, review = qualityReview(deck);
  review.checks[1].answerLeak = 'fail';
  review.summary = 'The second card leaks its answer.';
  const replies = [qualityPlan(req), authored(deck), review], systems = [];
  const result = await generateDeck(async system => {
    systems.push(system);
    assert.ok(replies.length, 'must not launch another repair/audit');
    return JSON.stringify(replies.shift());
  }, req);
  assert.equal(result.cards.length, 1);
  assert.equal(systems.filter(system => system.startsWith('Act as a strict')).length, 1);
  assert.equal(result.editorial.reviewRounds, 1);
  assert.doesNotMatch(result.editorial.summary, /second card leaks/);
  assert.match(JSON.stringify(result.editorial.omittedIssues), /answerLeak/);
});

test('a requested-kind mismatch costs only that candidate instead of the approved batch', async () => {
  const deck = candidate();
  const quiz = { ...structuredClone(card), id: 'wrong-kind', kind: 'quiz', prompt: 'A different target?', objective: 'Different target',
    options: ['a', 'b', 'c'].map(id => ({ id, text: `Option ${id}`, correct: id === 'a', explanation: `Why ${id}` })) };
  deck.cards.push(quiz);
  const req = { ...request, count: 2 }, replies = [qualityPlan(req), authored(deck), qualityReview(deck)];
  const result = await generateDeck(async () => JSON.stringify(replies.shift()), req);
  assert.equal(result.cards.length, 1);
  assert.equal(result.cards[0].kind, 'flashcard');
  assert.equal(result.editorial.dropped, 1);
});

test('questions cannot depend on remembering unseen lecture notes', () => {
  for (const prompt of [
    '这份口述笔记把建筑的电气图、管道图对应到 IT 的哪些视角？「蓝图」被界定为什么样的表达？',
    '根据课堂笔记，老师列举了哪三项？',
    'What does this lecture transcript call a blueprint?',
  ]) assert.match(learnerContextIssues({ cards: [{ ...card, prompt }] }).join(), /unavailable.*(?:notes|source)/);
  for (const prompt of ['IT 架构蓝图有什么作用？', '为什么同一个系统需要多个架构视角？', 'What is the role of an architectural blueprint?'])
    assert.deepEqual(learnerContextIssues({ cards: [{ ...card, prompt }] }), []);
});

test('an empty notes-dependent stem is rejected even when the model reviewer marks it passed', async () => {
  const bad = candidate();
  bad.cards[0].prompt = '这份口述笔记把建筑的电气图、管道图对应到 IT 的哪些视角？';
  await assert.rejects(generateDeck(async (system, prompt) => {
    if (system.startsWith('Plan a source-grounded assessment')) return JSON.stringify(qualityPlan(request));
    if (system.startsWith('Act as a strict assessment editor')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
    return JSON.stringify(authored(bad));
  }, request), /Quality gate failed.*unavailable lecture notes/);
});

test('single-round approved cards checkpoint with stable identities and rejection reasons', async () => {
 const deck=candidate(); deck.cards.push({...structuredClone(card),id:'bad',prompt:'Another question?',objective:'Another target'});
 const req={...request,count:2,title:'One requested deck'}, failed=qualityReview(deck);failed.checks[1].answerLeak='fail';
 const replies=[qualityPlan(req),authored(deck),failed],saved=[];
 const result=await generateBatched(async()=>{assert.ok(replies.length);return JSON.stringify(replies.shift());},req,()=>{},async value=>saved.push(structuredClone(value)));
 assert.equal(result.cards.length,1);assert.equal(result.cards[0].id,saved[0].cards[0].id);assert.equal(result.title,req.title);
 assert.match(result.editorial.failures.join(),/answerLeak/);
 assert.equal(result.editorial.reviewedCards[result.cards[0].id],reviewedCardFingerprint(result.cards[0]));
});

test('malformed author arrays salvage only complete objects and still require independent review', async () => {
  const good = JSON.stringify(card);
  const malformed = `{"deck":{"cards":[${good},{"kind":"flashcard","prompt":"broken" "answer":"bad"},{"kind":`;
  assert.deepEqual(salvageAuthoredCards(malformed).deck.cards, [card]);
  assert.equal(salvageAuthoredCards('{"checks":[{"cardId":"q"}]}'), null);
  const req = { ...request, count: 2 };
  const responses = [JSON.stringify(qualityPlan(req)), malformed, JSON.stringify(qualityReview(candidate()))];
  const result = await generateDeck(async () => responses.shift(), req);
  assert.equal(result.cards.length, 1);
  assert.equal(responses.length, 0);
  assert.equal(result.editorial.audit.checks.length, 1);
});

test('salvaged author objects retain literal control characters without losing sound cards', () => {
  const good = { ...card, explanation: card.explanation + '\nA second line.' };
  const text = JSON.stringify(good).replace('\\n', '\n');
  const broken = `{"deck":{"cards":[${text},{"kind":"flashcard","prompt":"unfinished`;
  assert.deepEqual(salvageAuthoredCards(broken)?.deck.cards, [good]);
});

test('local leakage checks normalise punctuation without claiming synonym detection', () => {
  const deck = { cards: [{ ...card, answer: '技术用例与业务用例', topic: '选择依据：技术用例 / 与业务用例', hint: '想想系统的边界' }] };
  assert.match(answerLeakIssues(deck).join(), /answerLeak in topic/);
  deck.cards[0].topic = '参考架构选择'; deck.cards[0].hint = '技术用例与业务用例';
  assert.match(answerLeakIssues(deck).join(), /answerLeak in hint/);
  deck.cards[0].hint = '想想系统的边界';
  assert.deepEqual(answerLeakIssues(deck), []);
});

test('planning rejects impossible list discrimination but permits scoped foundational recall', () => {
  const plan = qualityPlan(request);
  plan.targets[0].answerability = { mode: 'discrimination', requiredContextAvailable: true, answerOnlyInSourceList: true, criteriaWouldRevealAnswer: true };
  assert.match(planIssues(plan, request).join(), /infeasible/);
  plan.targets[0].answerability.mode = 'recall';
  assert.deepEqual(planIssues(plan, request), []);
  delete plan.targets[0].answerability;
  assert.match(planIssues(plan, request).join(), /infeasible/);
});

test('total-budget cancellation retains the saved single-round approved subset', async () => {
 const req={...request,count:6},controller=new AbortController(),saved=[];
 const result=generateBatched(async(system,prompt)=>{
  if(system.startsWith('Plan')) return JSON.stringify(qualityPlan(req));
  if(system.startsWith('Act as')) return JSON.stringify(qualityReview(JSON.parse(prompt).candidate));
  const n=JSON.parse(prompt.split('REQUEST DATA:\n')[1]).count;
  if(n===1) return new Promise((resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
  return JSON.stringify(authored({title:'Architecture',cards:Array.from({length:n},(_,i)=>({...structuredClone(card),id:'q'+i,prompt:'Distinct question '+i,objective:'Distinct target '+i}))}));
 },{...req,signal:controller.signal},()=>{},async value=>{saved.push(structuredClone(value));controller.abort(new Error('total budget reached'));});
 await assert.rejects(result,/total budget reached/);assert.equal(saved.at(-1).cards.length,5);
});

test('card-number findings reject only their assigned candidate in the single review', async () => {
 const deck=candidate();deck.cards.push({...structuredClone(card),id:'q2',prompt:'Another question?',objective:'Another target'});
 const req={...request,count:2},review=qualityReview(deck,['Card 2: leaks the answer']);
 const replies=[qualityPlan(req),authored(deck),review];
 const result=await generateDeck(async()=>JSON.stringify(replies.shift()),req);
 assert.equal(result.cards.length,1);assert.equal(result.cards[0].prompt,card.prompt);assert.equal(replies.length,0);
});

test('a failed card is dropped after the single audit while approved cards are kept',async()=>{
 const deck=candidate();deck.cards.push({...structuredClone(card),id:'q2',prompt:'Another question?',objective:'Another target'});
 const req={...request,count:2},review=qualityReview(deck);review.checks[1].answerLeak='fail';
 const replies=[qualityPlan(req),authored(deck),review],phases=[];
 const result=await generateDeck(async()=>JSON.stringify(replies.shift()),req,stage=>phases.push(stage));
 assert.equal(replies.length,0);assert.equal(result.cards.length,1);assert.equal(result.editorial.dropped,1);
 assert.equal(result.editorial.audit.checks[0].cardId,result.cards[0].id);assert.ok(phases.some(s=>/Dropping 1/.test(s)));
});

test('a partial author response finishes after one audit without filling missing candidates',async()=>{
 const req={...request,count:2},replies=[qualityPlan(req),authored(candidate()),qualityReview(candidate())];
 const result=await generateDeck(async()=>{assert.ok(replies.length);return JSON.stringify(replies.shift());},req);
 assert.equal(result.cards.length,1);assert.equal(result.editorial.reviewRounds,1);assert.equal(replies.length,0);
});

test('an unusable single-round review is a protocol failure without extra model calls',async()=>{
 const badId=qualityReview(candidate());badId.checks[0].cardId='unknown';
 const missing=qualityReview(candidate());delete missing.checks[0].sourceSupport;
 for(const bad of [{issues:[]},badId,missing,'{"issues":']){
  const replies=[qualityPlan(request),authored(candidate()),bad];
  await assert.rejects(generateDeck(async()=>{assert.ok(replies.length);const value=replies.shift();return typeof value==='string'?value:JSON.stringify(value);},request),/Review (?:JSON )?protocol failed/);
  assert.equal(replies.length,0);
 }
});

test("authoring and self-improvement happen in one call before an independent review", async () => {
  const original = candidate(), improved = candidate();
  improved.cards[0].prompt = "A team records a rule that every new service must use the shared access layer. What role does this rule play when later changes are proposed?";
  improved.cards[0].explanation += " The access-layer rule is a constructed example, not a quotation from the course.";
  const responses = [qualityPlan(request),
    authored(improved, [{ cardId: "q", summary: "Replaced the answer-bearing stem with a self-contained constraint scenario." }]),
    qualityReview(improved)];
  const phases = [], systems = [];
  const deck = await generateDeck(async (system) => { systems.push(system); return JSON.stringify(responses.shift()); }, request, (stage) => phases.push(stage));
  assert.equal(responses.length, 0, "three model calls: plan, author+self-check, review");
  assert.match(systems[0], /^Plan/);
  assert.match(systems[1], /^You author/);
  assert.match(systems[2], /^Act as a strict/);
  assert.notEqual(deck.cards[0].prompt, original.cards[0].prompt);
  assert.equal(deck.cards[0].prompt, improved.cards[0].prompt);
  assert.equal(deck.editorial.audit.changes.length, 1);
  assert.equal(deck.editorial.audit.checks[0].cardId, deck.cards[0].id);
  assert.equal(deck.editorial.reviewedCards[deck.cards[0].id], reviewedCardFingerprint(deck.cards[0]));
  assert.ok(phases.indexOf("Writing and self-checking questions") < phases.indexOf("Reviewing ambiguity and source support"));
});

test("unsupported planning evidence stops generation before an author writes questions", async () => {
  const plan = qualityPlan(request); plan.targets[0].citations[0].quote = "This distinction was never in the supplied notes.";
  const prompts = [];
  // The plan gets exactly one corrective round, naming the quote that failed;
  // a model that repeats it never reaches an author.
  await assert.rejects(
    generateDeck(async (_system, prompt) => { prompts.push(prompt); return JSON.stringify(plan); }, request),
    /plan is not usable: Target 1: quote "This distinction was never in the supplied notes." is not in source s/,
  );
  assert.equal(prompts.length, 2);
  assert.match(prompts[1], /Your previous plan was rejected/);
});

test("a plan whose quote only lost an emoji bullet is accepted without a retry", async () => {
  const emoji = { id: "e", title: "Outline", text: "吞吐量提升\n\t\t✋️ 服务器升级\n\t\t♻️ 缓存命中率提升，减少处理时间" };
  const req = { count: 1, kind: "flashcard", sources: [emoji] };
  const plan = qualityPlan(req);
  plan.targets[0].citations = [{ sourceId: "e", quote: "吞吐量提升\n\t\t 服务器升级\n\t\t 缓存命中率提升" }];
  const deck = { title: "性能", cards: [{ ...structuredClone(card), citations: [{ sourceId: "e", quote: "缓存命中率提升，减少处理时间" }] }] };
  const replies = [plan, authored(deck), qualityReview(deck)];
  const out = await generateDeck(async () => JSON.stringify(replies.shift()), req);
  assert.equal(out.cards.length, 1);
  assert.equal(replies.length, 0, "no corrective round was needed");
});

test("an empty issues list cannot approve missing or failed per-card checks", () => {
  assert.match(reviewIssues({ issues: [] }, candidate()).join(), /every card/);
  const review = qualityReview(candidate()); review.checks[0].answerLeak = "fail";
  assert.match(reviewIssues(review, candidate()).join(), /answerLeak/);
  const choice = candidate(); choice.cards[0].kind = "quiz";
  assert.match(reviewIssues(qualityReview(candidate()), choice).join(), /optionQuality/);
});

test('a batch with no independently approved candidates fails without repair',async()=>{
 const review=qualityReview(candidate());review.checks[0].answerLeak='fail';
 const replies=[qualityPlan(request),authored(candidate()),review];
 await assert.rejects(generateDeck(async()=>JSON.stringify(replies.shift()),request),/Quality gate failed.*answerLeak/);assert.equal(replies.length,0);
});

test("invisible slide dependency remains blocked even when all model checks claim pass", async () => {
  const deck = candidate(); deck.cards[0].prompt = "根据该幻灯片，架构的原则是什么？";
  const responses = [qualityPlan(request), authored(deck), qualityReview(deck), authored(deck), qualityReview(deck)];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /Quality gate failed:.*unavailable/);
});

test("learner projection withholds answer-bearing objectives and rubrics", () => {
  const view = publicCard({ ...card, objective: "The correct answer is principles", rubric: "Award points for naming principles" });
  assert.equal(Object.hasOwn(view, "objective"), false);
  assert.equal(Object.hasOwn(view, "rubric"), false);
  assert.equal(Object.hasOwn(view, "answer"), false);
  assert.equal(view.prompt, card.prompt);
});

test("an independent explanation-quality failure cannot be ignored", () => {
  const review = qualityReview(candidate());
  review.checks[0].explanationQuality = "fail";
  assert.match(reviewIssues(review, candidate()).join(), /explanationQuality/);
  delete review.checks[0].explanationQuality;
  assert.match(reviewIssues(review, candidate()).join(), /explanationQuality/);
});

test('approved cards retain receipts when another candidate fails its one review',async()=>{
 const deck=candidate();deck.cards.push({...structuredClone(card),id:'q2',prompt:'Another question?',objective:'Another target'});
 const req={...request,count:2},review=qualityReview(deck);review.checks[1].explanationQuality='fail';
 const replies=[qualityPlan(req),authored(deck),review];
 const result=await generateDeck(async()=>JSON.stringify(replies.shift()),req);
 assert.equal(result.cards.length,1);assert.equal(result.editorial.reviewedCards[result.cards[0].id],reviewedCardFingerprint(result.cards[0]));assert.equal(replies.length,0);
});

test('author self approval cannot replace the single independent acceptance',async()=>{
 const review=qualityReview(candidate());review.checks[0].learningValue='fail';const systems=[];
 const replies=[qualityPlan(request),authored(candidate()),review];
 await assert.rejects(generateDeck(async system=>{systems.push(system);return JSON.stringify(replies.shift());},request),/Quality gate failed/);
 assert.equal(systems.filter(s=>s.startsWith('Act as a strict')).length,1);assert.equal(replies.length,0);
});

test("answer restatements are rejected locally even if the editor approves", async () => {
  const deck = candidate();
  deck.cards[0].explanation = deck.cards[0].answer;
  assert.match(explanationIssues(deck).join(), /only repeats/);
  const responses = [qualityPlan(request), authored(deck), qualityReview(deck), authored(deck), qualityReview(deck)];
  await assert.rejects(generateDeck(async () => JSON.stringify(responses.shift()), request), /Quality gate failed.*only repeats/);
});

test("the independent editor receives the recruiting role and intended difficulty", async () => {
  const deck = candidate();
  const responses = [qualityPlan(request), authored(deck), qualityReview(deck)];
  let review;
  await generateDeck(async (system, prompt) => {
    if (system.startsWith("Act as a strict")) review = JSON.parse(prompt);
    return JSON.stringify(responses.shift());
  }, { ...request, role: "后端开发", difficulty: "hard", focus: "应用与权衡" });
  assert.equal(review.role, "后端开发");
  assert.equal(review.difficulty, "hard");
  assert.equal(review.focus, "应用与权衡");
});
