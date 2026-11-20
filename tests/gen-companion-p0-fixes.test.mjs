import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateDeck, salvageAuthoredCards } from '../lib/generation.js';
import { computeRateLimitWaitMs, generateBatched } from '../lib/batch.js';
import { focusExtractInputs, MAX_MATERIAL_CHARS } from '../lib/contexts/generation/focus-extract.js';
import { createSelectionOperations } from '../lib/contexts/generation/selection.js';
import { scopeCompanionArgs } from '../lib/companion/companions.js';
import { planCompanionBuild } from '../lib/contexts/generation/companion/plan.js';
import { compileMathInLesson } from '../lib/companion-template/mathml.js';
import { buildLessonTemplateRuntimeJs, LESSON_TEMPLATE_RUNTIME_JS } from '../lib/companion-template/template-runtime.js';
import { StudyService } from '../lib/service.js';
import { qualityPlan, qualityBlueprint, qualityReview, authored } from './helpers/assessment.mjs';
import { openLibrary, stagedModel } from './helpers/generation-baseline.mjs';
import { settleJob } from './helpers/wait.mjs';
import { requestData } from './helpers/request-data.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const { framedDocument, COMPANION_META_CSP, FRAME_CSP } = await loadUi(`
  export { framedDocument, COMPANION_META_CSP, FRAME_CSP } from './ui/diagram-frame.js';
`);

/* ---------- 1. authorJson retry instead of premature 1-card short-circuit ---------- */

test('authorJson retries malformed first reply when salvaged coverage is too low, and recovers full batch on retry', async () => {
  const text = 'Architecture sets principles guiding system design and evolution. '.repeat(4);
  const sources = [{ id: 's1', title: 'Arch', text }];
  const req = { count: 4, kind: 'flashcard', sources };
  const plan = qualityPlan(req);
  const fullCards = plan.targets.map((target, idx) => ({
    id: `q${idx + 1}`,
    targetId: target.targetId,
    kind: 'flashcard',
    topic: `Architecture topic ${idx + 1}`,
    objective: target.objective,
    prompt: `What distinguishes architecture principle ${idx + 1}?`,
    answer: `Architecture principle ${idx + 1} guides evolution.`,
    hint: `Consider dimension ${idx + 1}.`,
    explanation: `Principle ${idx + 1} establishes design constraints for evolution.`,
    misconception: `Confusing principle ${idx + 1} with implementation detail.`,
    citations: target.citations,
  }));
  const fullDeck = { title: 'Architecture', cards: fullCards };
  const blueprint = qualityBlueprint(req, plan, fullDeck);
  // Attempt 0 returns broken JSON where only 1 of 4 cards (25% < 80%) is salvageable.
  const partialMalformed = `{"deck":{"cards":[${JSON.stringify(fullCards[0])},{"id":"q2","prompt":"cut off`;

  let authorCalls = 0;
  const complete = async (system, prompt) => {
    if (system.startsWith('Plan a source-grounded')) return JSON.stringify(plan);
    if (system.startsWith('Prepare supported answers')) return JSON.stringify(blueprint);
    if (system.startsWith('You author')) {
      authorCalls++;
      if (authorCalls === 1) return partialMalformed;
      assert.match(prompt, /Return valid JSON only/);
      return JSON.stringify(authored(fullDeck, [], plan));
    }
    if (system.startsWith('Act as a strict assessment editor')) {
      return JSON.stringify(qualityReview(requestData(prompt).candidate));
    }
    throw new Error(`unexpected stage: ${system.slice(0, 40)}`);
  };

  const result = await generateDeck(complete, req);
  assert.equal(authorCalls, 2, 'authorJson must retry when attempt 0 salvages only 1/4 cards');
  assert.equal(result.cards.length, 4, 'retry recovers all 4 cards');
});

test('salvageAuthoredCards recovers cards containing single-backslash \\ce chemical formulas', () => {
  const broken = String.raw`{"deck":{"cards":[{"targetId":"target-1","kind":"flashcard","prompt":"写出 $\ce{H2SO4}$ 的电离方程","explanation":"强酸"},{"targetId":"target-2","prompt":"cut`;
  const salvaged = salvageAuthoredCards(broken);
  assert.equal(salvaged?.deck.cards.length, 1);
  assert.equal(salvaged.deck.cards[0].prompt, '写出 $\\ce{H2SO4}$ 的电离方程');
});

/* ---------- 2. draft-repair passes { sources } to reviewIssues & wraps bare math / omits nulls ---------- */

test('draft.repair passes { sources } to reviewIssues (demoting quote-format nitpicks) and tidies bare math & null fields', async (t) => {
  const source = { id: 's1', title: 'Notes', text: 'Architecture sets principles that guide how a system is designed and changed.' };
  const baseCard = {
    id: 'a',
    kind: 'flashcard',
    topic: 'Architecture',
    objective: 'Explain architecture principles',
    prompt: 'What guides system design and change?',
    answer: 'Architecture sets principles.',
    hint: 'Think about long-term evolution.',
    explanation: 'Principles guide system design.',
    misconception: 'Architecture is only diagrams.',
    citations: [{ sourceId: 's1', quote: source.text }],
  };
  let repairCalls = 0;
  let reviewCalls = 0;
  const staged = stagedModel();
  const complete = async (system, prompt, context = {}) => {
    if (system.startsWith('Repair one draft card')) {
      repairCalls++;
      // Model returns bare TeX + inapplicable null options/rubric; tidyRepairedCard should fix both at zero cost.
      return JSON.stringify({
        patch: {
          explanation: 'Principles guide design with complexity a^{l-1} over time.',
          options: null,
          rubric: null,
        },
      });
    }
    if (system.startsWith('Act as a strict')) {
      reviewCalls++;
      const review = qualityReview(requestData(prompt).candidate);
      // Reviewer raises a quote-punctuation nitpick even though citation is verbatim in sources.
      review.issues = ['a: quote differs from the source in trailing punctuation'];
      review.checks[0].sourceSupport = 'fail';
      review.checks[0].explanation = 'Quote trailing period punctuation nitpick.';
      return JSON.stringify(review);
    }
    return staged.complete(system, prompt, context);
  };

  const { service } = await openLibrary(t, { prefix: 'study-repair-sources-', model: complete });
  await service.call('source.add', source);
  const saved = await service.call('draft.save', {
    deck: {
      id: 'd1',
      title: 'Architecture',
      cards: [baseCard],
      editorial: { generation: { sourceIds: ['s1'], kind: 'flashcard' }, rejectedIssues: { a: ['explanationQuality failed'] } },
    },
  });

  const started = await service.call('draft.repair', { id: 'd1', draftVersion: saved.draftVersion });
  const done = await settleJob(service, started.jobId);
  assert.equal(done.status, 'complete', done.stage);
  assert.equal(repairCalls, 1, 'card should pass on round 1 without burning a retry');
  assert.equal(reviewCalls, 1);
  const draft = (await service.call('export')).drafts.find(d => d.id === 'd1');
  assert.deepEqual(draft.editorial.rejectedIssues, {});
  assert.match(draft.cards[0].explanation, /\$a\^\{l-1\}\$/);
  assert.equal('options' in draft.cards[0], false);
  assert.equal('rubric' in draft.cards[0], false);
});

/* ---------- 3. selection.review passes { sources } & enforces clozeIssues + optionCueIssues ---------- */

test('generation.selection.review enforces clozeIssues and passes { sources } to reviewIssues', async () => {
  const sourceText = 'In Newton mechanics, force equals mass times acceleration F = ma under constant mass.';
  const state = {
    settings: {},
    sources: [{ id: 's1', title: 'Physics', text: sourceText }],
    decks: [{ id: 'deck-1', title: 'Physics', course: 'Physics', contentVersion: 1, cards: [] }],
    selectionJobs: [],
  };
  const appended = [];
  const handlers = createSelectionOperations({
    root: '/tmp/selection-test',
    read: async () => structuredClone(state),
    update: async (fn) => fn(state),
    materials: async (action) => {
      if (action === 'materials.selection.resolve') {
        return { status: 'resolved', selection: { documentId: 'doc-1', sourceId: 's1', quote: sourceText } };
      }
      if (action === 'materials.document.get') {
        return { title: 'Physics', sources: state.sources };
      }
      throw new Error(`unexpected materials action: ${action}`);
    },
    bank: {
      get: async () => ({ deck: state.decks[0], version: 1 }),
      append: async (payload) => { appended.push(payload); return { cardIds: payload.cards.map(c => c.id) }; },
    },
    complete: async (_sys, prompt) => {
      const review = qualityReview(requestData(prompt).candidate);
      review.issues = ['c-ok: quote differs from the source in trailing punctuation'];
      review.checks[0].sourceSupport = 'fail';
      review.checks[0].explanation = 'Quote trailing punctuation nitpick.';
      return JSON.stringify(review);
    },
  });

  // Case A: Clozen blank inside formula MUST be caught by clozeIssues in selection.review.
  state.selectionJobs.push({
    operationId: 'op-cloze-bad',
    deckId: 'deck-1',
    expectedVersion: 1,
    selection: { documentId: 'doc-1', sourceId: 's1', quote: sourceText },
    request: { count: 1, kind: 'cloze', focus: '' },
    status: 'review-failed',
    candidates: [{
      id: 'c-bad',
      kind: 'cloze',
      topic: 'Newton second law',
      objective: 'State Newton second law',
      prompt: 'Force equals ${{b1}}$ under constant mass.',
      answer: 'ma',
      hint: 'Recall the formula.',
      explanation: 'Force equals mass times acceleration.',
      misconception: 'Confusing velocity with acceleration.',
      cloze: { text: 'Force equals ${{b1}}$ under constant mass.', answers: [{ id: 'b1', value: 'ma' }] },
      citations: [{ sourceId: 's1', quote: sourceText }],
    }],
  });
  const clozeRes = await handlers['generation.selection.review']({ operationId: 'op-cloze-bad' });
  assert.equal(clozeRes.status, 'review-failed');
  assert.match(clozeRes.error, /inside a formula/i);
  assert.equal(appended.length, 0);

  // Case B: Valid card with quote-format reviewer nitpick passes because { sources } is passed to reviewIssues.
  state.selectionJobs.push({
    operationId: 'op-quote-format',
    deckId: 'deck-1',
    expectedVersion: 1,
    selection: { documentId: 'doc-1', sourceId: 's1', quote: sourceText },
    request: { count: 1, kind: 'flashcard', focus: '' },
    status: 'review-failed',
    candidates: [{
      id: 'c-ok',
      kind: 'flashcard',
      topic: 'Newton second law',
      objective: 'State Newton second law',
      prompt: 'Under constant mass, how is net force related to mass and acceleration?',
      answer: 'Net force equals mass times acceleration.',
      hint: 'Recall the proportionality between force and acceleration.',
      explanation: 'Under constant mass, net force equals mass times acceleration according to Newton mechanics.',
      misconception: 'Thinking force is proportional to velocity.',
      citations: [{ sourceId: 's1', quote: sourceText }],
    }],
  });
  const okRes = await handlers['generation.selection.review']({ operationId: 'op-quote-format' });
  assert.equal(okRes.status, 'complete', okRes.error);
  assert.equal(appended.length, 1);
});

/* ---------- 4. focus-extract strictly caps total material chars at 24k ---------- */

test('focusExtractInputs enforces MAX_MATERIAL_CHARS even for 100 and 300 PDF page sources', () => {
  for (const count of [40, 100, 300]) {
    const sources = Array.from({ length: count }, (_, i) => ({
      id: `p-${i + 1}`,
      title: `Chapter ${Math.floor(i / 10) + 1} · Page ${i + 1}`,
      text: `Detailed lecture content for page ${i + 1}. `.repeat(80),
    }));
    const { materials } = focusExtractInputs({ sources }, {
      course: 'Algorithms',
      sourceIds: sources.map(s => s.id),
    });
    const totalChars = materials.reduce((sum, item) => sum + item.title.length + item.excerpt.length, 0);
    assert.ok(materials.length > 0, `count=${count}: must keep materials`);
    assert.ok(totalChars <= MAX_MATERIAL_CHARS, `count=${count}: totalChars ${totalChars} exceeded ${MAX_MATERIAL_CHARS}`);
    // Even sampling should cover both the beginning and the end of a 300-page PDF.
    assert.equal(materials[0].id, 'p-1');
    assert.equal(materials.at(-1).id, `p-${count}`);
  }
});

/* ---------- 5. batch.js 429 retry respects retryAfterMs + Full Jitter ---------- */

test('computeRateLimitWaitMs honors error.retryAfterMs (capped at 60s) and applies Full Jitter otherwise', () => {
  // Respects retryAfterMs with bounded positive jitter
  assert.equal(computeRateLimitWaitMs({ retryAfterMs: 5000 }, 0, 2000, () => 0), 5000);
  assert.equal(computeRateLimitWaitMs({ retryAfterMs: 5000 }, 0, 2000, () => 1), 6000);
  assert.equal(computeRateLimitWaitMs({ retryAfterMs: 120_000 }, 0, 2000, () => 0.5), 60_000);

  // Without retryAfterMs: Full Jitter in [0, min(60s, base * 2^attempt)]
  assert.equal(computeRateLimitWaitMs({}, 0, 2000, () => 0.5), 1000);
  assert.equal(computeRateLimitWaitMs({}, 2, 2000, () => 0.25), 2000);
  assert.equal(computeRateLimitWaitMs({}, 2, 2000, () => 1), 8000);
  assert.equal(computeRateLimitWaitMs({}, 10, 2000, () => 1), 60_000);
});

test('generateBatched passes error.retryAfterMs into onWait backoff duration', async () => {
  const source = { id: 's1', title: 'Page 1', text: 'Architecture sets principles guiding design and evolution over time. '.repeat(3) };
  const waits = [];
  let hit429 = false;
  const complete = async (system, prompt) => {
    if (!hit429) {
      hit429 = true;
      throw Object.assign(new Error('429 Too Many Requests'), { status: 429, retryAfterMs: 42 });
    }
    const data = requestData(prompt);
    if (system.startsWith('Plan a source-grounded')) return JSON.stringify(qualityPlan({ ...data, kind: 'flashcard', sources: [source] }));
    if (system.startsWith('Prepare supported answers')) {
      const plan = data.assessmentPlan;
      return JSON.stringify(qualityBlueprint({ kind: 'flashcard' }, plan, {
        cards: plan.targets.map((t, i) => ({
          id: `q${i + 1}`, targetId: t.targetId, kind: 'flashcard', topic: 'Arch', objective: t.objective,
          prompt: 'What does architecture set?', answer: 'Principles guiding design.', hint: 'Think about principles.',
          explanation: 'Architecture sets principles guiding design and evolution.', misconception: 'Only diagrams.',
          citations: t.citations,
        })),
      }));
    }
    if (system.startsWith('You author')) {
      const plan = data.assessmentPlan;
      const cards = plan.targets.map((t, i) => ({
        id: `q${i + 1}`, targetId: t.targetId, kind: 'flashcard', topic: 'Arch', objective: t.objective,
        prompt: 'What does architecture set?', answer: 'Principles guiding design.', hint: 'Think about principles.',
        explanation: 'Architecture sets principles guiding design and evolution.', misconception: 'Only diagrams.',
        citations: t.citations,
      }));
      return JSON.stringify(authored({ title: 'D', cards }, [], plan));
    }
    if (system.startsWith('Act as a strict')) return JSON.stringify(qualityReview(data.candidate));
    throw new Error(`unexpected: ${system.slice(0, 30)}`);
  };

  const result = await generateBatched(complete, {
    count: 1,
    kind: 'flashcard',
    sources: [source],
    performance: { concurrency: 1, batchSize: 5, fillRounds: 0 },
    rateLimitBackoffMs: 1,
    random: () => 0,
    onWait: (ev) => { if (ev.phase === 'start') waits.push(ev.ms); },
  });
  assert.equal(result.cards.length, 1);
  assert.deepEqual(waits, [42]);
});

/* ---------- 6. DiagramFrame safeBootJson & real <meta CSP> ---------- */

test('framedDocument escapes <!-- and </script> as valid RFC 8259 JSON and injects <meta http-equiv="Content-Security-Policy">', () => {
  const html = '<!doctype html><html><head><title>Lab</title></head><body><main>hi</main></body></html>';
  const draftWithComment = '<!-- HTML comment --> </script><script>alert(1)</script> & \u2028\u2029';
  const framed = framedDocument(html, {
    channelToken: 'tok-safe-json',
    theme: 'dark',
    memory: { 'try:note': draftWithComment },
    askLabel: '<!-- Ask -->',
  });

  // Must inject strict <meta http-equiv="Content-Security-Policy"> before scripts.
  assert.ok(framed.includes(`<meta http-equiv="Content-Security-Policy" content="${COMPANION_META_CSP}">`));
  assert.ok(!framed.includes('<\\!--'), 'illegal JSON escape <\\!-- must never appear');
  assert.ok(!framed.includes('</script><script>alert(1)'), 'raw </script> must be escaped');

  // Extracted boot JSON must parse cleanly and round-trip identically!
  const match = /<script id="sh-companion-boot" type="application\/json">([\s\S]*?)<\/script>/.exec(framed);
  assert.ok(match, 'boot script tag must be present');
  const parsed = JSON.parse(match[1]);
  assert.equal(parsed.channelToken, 'tok-safe-json');
  assert.equal(parsed.memory['try:note'], draftWithComment);
  assert.equal(parsed.askLabel, '<!-- Ask -->');

  // Non-companion framing also injects real <meta CSP> matching FRAME_CSP.
  const plain = framedDocument(html);
  assert.ok(plain.includes(`<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}">`));
});

/* ---------- 7. template-runtime.js: @@SHM_ rendering, hasOwnProperty & live hover readouts ---------- */

test('template-runtime renders @@SHM_ tokens in keyLine/name/inside/schedule, blocks prototype calls in evalAst, and updates sandbox readouts on hover', () => {
  assert.doesNotThrow(() => new vm.Script(LESSON_TEMPLATE_RUNTIME_JS));
  assert.doesNotThrow(() => new vm.Script(buildLessonTemplateRuntimeJs('en')));

  // Build a minimal DOM + DOMParser harness to execute the real runtime JS!
  class FakeNode {
    constructor(tag) {
      this.tagName = tag;
      this.localName = tag;
      this.children = [];
      this.attrs = {};
      this.style = {};
      this.dataset = {};
      this.listeners = new Map();
      this._text = '';
      this.hidden = false;
      this.disabled = false;
      this.className = '';
      this.value = '';
      this.parentNode = null;
      this.classList = {
        add: (...cls) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.add(c);
          this.className = [...set].join(' ');
        },
        remove: (...cls) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          for (const c of cls) set.delete(c);
          this.className = [...set].join(' ');
        },
        toggle: (c, force) => {
          const set = new Set(this.className.split(/\s+/).filter(Boolean));
          const has = set.has(c);
          const next = force === undefined ? !has : Boolean(force);
          if (next) set.add(c); else set.delete(c);
          this.className = [...set].join(' ');
        },
      };
    }
    get isConnected() { return true; }
    get textContent() {
      if (!this.children.length) return this._text;
      return this.children.map(c => (typeof c === 'string' ? c : c.textContent)).join('');
    }
    set textContent(v) {
      this.children = [];
      this._text = String(v ?? '');
    }
    append(...items) {
      for (const item of items.flat(Infinity)) {
        if (item == null || item === false) continue;
        if (item.isFragment) {
          this.append(...item.children);
        } else if (typeof item === 'object') {
          item.parentNode = this;
          this.children.push(item);
        } else {
          this.children.push(String(item));
        }
      }
    }
    prepend(...items) {
      const flat = [];
      for (const item of items.flat(Infinity)) {
        if (item == null || item === false) continue;
        if (item.isFragment) flat.push(...item.children);
        else { if (typeof item === 'object') item.parentNode = this; flat.push(item); }
      }
      this.children.unshift(...flat);
    }
    insertBefore(node, ref) {
      if (node && typeof node === 'object') node.parentNode = this;
      const idx = this.children.indexOf(ref);
      if (idx < 0) this.children.push(node);
      else this.children.splice(idx, 0, node);
      return node;
    }
    remove() {
      if (this.parentNode) {
        this.parentNode.children = this.parentNode.children.filter(c => c !== this);
        this.parentNode = null;
      }
    }
    replaceChildren(...items) {
      this.children = [];
      this._text = '';
      this.append(...items);
    }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'id') byId.set(String(v), this); if (k === 'class') this.className = String(v); if (k === 'hidden') this.hidden = true; }
    getAttribute(k) { return this.attrs[k] ?? null; }
    removeAttribute(k) { delete this.attrs[k]; if (k === 'hidden') this.hidden = false; }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    removeEventListener(type, fn) {
      const list = this.listeners.get(type);
      if (list) this.listeners.set(type, list.filter(x => x !== fn));
    }
    dispatch(type, event = {}) {
      for (const fn of this.listeners.get(type) || []) fn({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...event });
    }
    getBoundingClientRect() { return { left: 0, top: 0, width: 540, height: 264 }; }
    cloneNode() {
      const copy = new FakeNode(this.tagName);
      copy._text = this._text;
      copy.attrs = { ...this.attrs };
      copy.children = this.children.map(c => (typeof c === 'string' ? c : c.cloneNode(true)));
      return copy;
    }
    querySelectorAll(selector) {
      const cls = selector.startsWith('.') ? selector.slice(1) : null;
      const out = [];
      const walk = (n) => {
        for (const c of n.children) {
          if (typeof c !== 'object') continue;
          if ((cls && c.className.split(/\s+/).includes(cls)) || (!cls && c.tagName === selector)) out.push(c);
          walk(c);
        }
      };
      walk(this);
      return out;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    contains() { return false; }
    closest() { return null; }
  }

  const rawLesson = compileMathInLesson({
    format: 'studyhub-lesson/1',
    language: 'en',
    id: 'runtime-fix-test',
    title: 'Runtime Checks',
    slides: [
      {
        beat: 'open',
        title: 'Sandbox & Takeaways',
        blocks: [
          {
            t: 'sandbox',
            say: 'Hover the curve.',
            key: '$\\zeta = 1$ is critical.',
            knobs: [{ id: 'a', label: '$a$', min: 1, max: 5, step: 1, default: 2 }],
            domain: { variable: 'x', min: 0, max: 10, steps: 20, label: 'x' },
            series: [{ id: 'y', label: '$y(x)$', expr: 'a * x' }],
            readouts: [
              { id: 'r1', label: '$f(x)$', expr: 'a * x', unit: '' },
              // Prototype-chain attack in forged _compiled AST: must evaluate to NaN ("—"), never invoke Object.prototype.constructor/toString.
              { id: 'proto', label: 'Proto', expr: 'a', _badProto: true },
            ],
          },
          {
            t: 'name',
            term: 'Critical $\\zeta = 1$',
            alias: 'Alias $\\omega_n$',
            oneLine: 'Boundary at $\\zeta = 1$.',
            asked: ['Why $\\zeta = 1$?'],
            say: 'Formal name.',
          },
          {
            t: 'inside',
            caption: 'Check $\\zeta$',
            source: 'line 1\nline 2',
            walk: [{ focusLines: [1], label: '$\\zeta = 1$', say: 'Step 1' }],
            say: 'Inside.',
          },
          {
            t: 'schedule',
            lanes: ['A', 'B'],
            shared: { name: 'x', start: 0 },
            goals: [{ value: 1, label: 'Reach $\\zeta = 1$' }],
            say: 'Schedule.',
          },
        ],
      },
    ],
  });

  // Inject compiled ASTs including a forged prototype-chain call node `{ t: 'call', fn: 'constructor', args: [] }`.
  const sb = rawLesson.slides[0].blocks[0];
  sb._compiled = {
    domain: { variable: 'x', min: 0, max: 10, steps: 20, label: 'x', unit: '' },
    series: [{ id: 'y', label: sb.series[0].label, ast: { t: 'bin', op: '*', l: { t: 'var', name: 'a' }, r: { t: 'var', name: 'x' } } }],
    readouts: [
      { id: 'r1', label: sb.readouts[0].label, unit: '', ast: { t: 'bin', op: '*', l: { t: 'var', name: 'a' }, r: { t: 'var', name: 'x' } } },
      { id: 'proto', label: 'Proto', unit: '', ast: { t: 'call', fn: 'constructor', args: [] } },
    ],
  };

  const byId = new Map();
  const makeById = (id, tag = 'div') => { const n = new FakeNode(tag); n.setAttribute('id', id); return n; };
  const body = new FakeNode('body');
  const rootEl = new FakeNode('html');
  const topTools = new FakeNode('div'); topTools.className = 'top__tools';
  const lessonDataEl = makeById('lesson-data', 'script');
  lessonDataEl.textContent = JSON.stringify(rawLesson);
  for (const id of ['title', 'beats', 'stage', 'line', 'key', 'prev', 'next', 'count', 'notes', 'notes-list', 'theme']) {
    body.append(makeById(id));
  }
  body.append(topTools);

  let domParserCalls = 0;
  class FakeDOMParser {
    parseFromString(xml) {
      domParserCalls++;
      const mathEl = new FakeNode('math');
      mathEl._text = xml.includes('zeta') ? 'ζ' : 'math';
      return {
        documentElement: mathEl,
        getElementsByTagName: () => [],
      };
    }
  }

  const fakeDoc = {
    documentElement: rootEl,
    body,
    getElementById: (id) => byId.get(id) || null,
    querySelector: (sel) => (sel === '.top__tools' ? topTools : body.querySelector(sel)),
    createElement: (tag) => new FakeNode(tag),
    createElementNS: (_ns, tag) => new FakeNode(tag),
    createDocumentFragment: () => Object.assign(new FakeNode('#fragment'), { isFragment: true }),
    createTextNode: (t) => Object.assign(new FakeNode('#text'), { _text: String(t) }),
    importNode: (node) => node.cloneNode(true),
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  const fakeWindow = {
    document: fakeDoc,
    innerWidth: 1024,
    innerHeight: 768,
    location: { hash: '' },
    matchMedia: () => ({ matches: false }),
    addEventListener: () => {},
    removeEventListener: () => {},
    postMessage: () => {},
  };
  fakeWindow.parent = fakeWindow;

  vm.runInNewContext(buildLessonTemplateRuntimeJs('en'), {
    window: fakeWindow,
    document: fakeDoc,
    location: fakeWindow.location,
    DOMParser: FakeDOMParser,
    localStorage: { getItem: () => null, setItem: () => {} },
    requestAnimationFrame: (fn) => fn(),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    console,
    Math,
    Number,
    Object,
    Array,
    String,
    Boolean,
    Set,
    Map,
    WeakMap,
    JSON,
    RegExp,
    Error,
  });

  // 1. keyLine must NOT leak raw @@SHM_ token
  const keyText = byId.get('key').textContent;
  assert.doesNotMatch(keyText, /@@SHM_\d+@@/, `keyLine leaked token: ${keyText}`);
  assert.match(keyText, /Key takeaway:/);

  // 2. name, inside (code__tag) & schedule must NOT leak raw @@SHM_ tokens
  const stageText = byId.get('stage').textContent;
  assert.doesNotMatch(stageText, /@@SHM_\d+@@/, `stage leaked token: ${stageText}`);

  // 3. Prototype-chain AST call `constructor` evaluates to NaN -> rendered as "—", never "[object Object]"
  const metricEls = byId.get('stage').querySelectorAll('.sbox__metric');
  assert.equal(metricEls.length, 2);
  assert.equal(metricEls[0].querySelector('b').textContent, '10', 'initial readout at midU=5 with a=2 is 10');
  assert.equal(metricEls[1].querySelector('b').textContent, '—', 'forged constructor AST call must return NaN (—)');

  // 4. Hovering across hitRect live-updates metricsBox readout AND reuses DOMParser cache!
  const hitRect = byId.get('stage').querySelector('.sbox__hit');
  assert.ok(hitRect, 'sandbox hitRect must exist');
  const parserCallsBeforeHover = domParserCalls;
  // Lp=50, pw=540-50-18=472. Move pointer to x=2 => clientX = 50 + (2/10)*472 = 144.4
  hitRect.dispatch('pointermove', { clientX: 50 + 0.2 * 472, clientY: 100 });
  assert.equal(metricEls[0].querySelector('b').textContent, '4', 'hover at x=2 must live-update readout to 2*2=4');
  // Second pointermove at x=8 => clientX = 50 + 0.8*472 -> readout=16; DOMParser must NOT re-parse cached tokens!
  hitRect.dispatch('pointermove', { clientX: 50 + 0.8 * 472, clientY: 100 });
  assert.equal(metricEls[0].querySelector('b').textContent, '16', 'hover at x=8 must live-update readout to 2*8=16');
  assert.equal(domParserCalls, parserCallsBeforeHover, 'DOMParser cache must avoid re-parsing MathML on pointermove');
  // Pointer leave restores midU readout (10)
  hitRect.dispatch('pointerleave');
  assert.equal(metricEls[0].querySelector('b').textContent, '10', 'pointerleave must restore midU readout');
});

/* ---------- 8. SCOPED_COMPANION_ACTIONS includes companion.catchup.save ---------- */

test('scopeCompanionArgs strips caller workspace and injects host workspace for companion.catchup.save', () => {
  const scoped = scopeCompanionArgs(
    'companion.catchup.save',
    { course: 'Math', workspace: '/evil/path', startFolder: '/evil/start', allowRememberTrusted: true, syncFeedback: true },
    '/real/workspace',
    '/real/start',
    { fromPanel: false },
  );
  assert.equal(scoped.workspace, '/real/workspace');
  assert.equal(scoped.startFolder, '/real/start');
  assert.equal(scoped.allowRememberTrusted, undefined);
  assert.equal(scoped.syncFeedback, true);
});

test('companion.catchup.save syncs feedback to a workspace linkedRoot when scoped by host', async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), 'sh-catchup-scope-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const storeDir = join(tmp, 'library');
  const workspaceDir = join(tmp, 'workspace');
  const linkedPack = join(workspaceDir, 'my-lab');
  const htmlFile = join(linkedPack, 'pages', 'damping.html');
  await mkdir(join(linkedPack, 'pages'), { recursive: true });
  await mkdir(join(linkedPack, 'feedback'), { recursive: true });
  await writeFile(htmlFile, '<!doctype html><html><head><title>Damping Lab</title></head><body><main>Lab</main></body></html>', 'utf8');

  const service = new StudyService(storeDir, {});
  t.after(() => service.dispose());
  await service.call('course.save', { name: 'Physics' });
  const attached = await service.call('companion.attach', scopeCompanionArgs('companion.attach', {
    course: 'Physics',
    path: linkedPack,
    mode: 'linked',
  }, workspaceDir, workspaceDir, { fromPanel: true }));
  assert.equal(attached.kind, 'directory');
  assert.equal(attached.attached, 1);
  const list = await service.call('companion.list', { course: 'Physics' });
  const companionId = list.companions?.[0]?.id;
  assert.ok(companionId, 'linked companion must attach cleanly');

  // Unscoped call without workspace fails authorization for a workspace linkedRoot
  await assert.rejects(
    service.call('companion.catchup.save', {
      course: 'Physics',
      companionId,
      syncFeedback: true,
      note: 'Unauthorized without workspace',
      prompt: 'Prompt without workspace',
      answer: 'Answer without workspace',
    }),
    /未授权/,
  );

  // Host-scoped call via scopeCompanionArgs injects workspace and succeeds
  const scoped = scopeCompanionArgs('companion.catchup.save', {
    course: 'Physics',
    companionId,
    syncFeedback: true,
    note: 'Why does critical damping avoid overshoot?',
    prompt: 'What characterizes critical damping?',
    answer: 'Repeated characteristic root with fastest non-overshooting return.',
  }, workspaceDir, workspaceDir, { fromPanel: true });

  const saved = await service.call('companion.catchup.save', scoped);
  assert.equal(saved.feedbackSynced, true, 'workspace linkedRoot feedback sync must succeed when workspace is injected');
  const ledger = JSON.parse(await readFile(join(linkedPack, 'feedback', 'questions.json'), 'utf8'));
  assert.equal(ledger.items.length, 1);
  assert.match(ledger.items[0].note, /critical damping/);
});

/* ---------- 9. Rescue plan scopeHash incorporates errorReason & thinkingNote ---------- */

test('planCompanionBuild rescue scopeHash varies with errorReason and thinkingNote and stays stable for identical inputs', () => {
  const state = {
    courses: [{ id: 'c1', name: 'ODE' }],
    sources: [{ id: 's1', title: 'Damping Notes', course: 'ODE', text: 'Critical damping occurs at zeta = 1 with repeated root r = -1.' }],
    decks: [{
      id: 'd1',
      course: 'ODE',
      title: 'ODE Deck',
      cards: [{
        id: 'card-1',
        kind: 'flashcard',
        topic: 'Critical Damping',
        prompt: 'What happens at zeta = 1?',
        answer: 'Repeated root requires t*e^{-t}.',
        citations: [{ sourceId: 's1', quote: 'Critical damping occurs at zeta = 1' }],
      }],
    }],
    attempts: [],
  };

  const base = { mode: 'rescue', course: 'ODE', deckId: 'd1', cardIds: ['card-1'], hid: 'H01' };
  const pNone = planCompanionBuild(state, base);
  const pConcept = planCompanionBuild(state, { ...base, errorReason: 'concept' });
  const pConceptCase = planCompanionBuild(state, { ...base, errorReason: ' Concept ' });
  const pDeriv = planCompanionBuild(state, { ...base, errorReason: 'derivation' });
  const pNoteA = planCompanionBuild(state, { ...base, errorReason: 'concept', thinkingNote: 'Thought roots were complex' });
  const pNoteB = planCompanionBuild(state, { ...base, errorReason: 'concept', thinkingNote: 'Forgot secular factor t' });

  assert.equal(pConcept.scopeHash, pConceptCase.scopeHash, 'case/whitespace normalization keeps scopeHash stable');
  assert.notEqual(pNone.scopeHash, pConcept.scopeHash, 'adding errorReason must change scopeHash');
  assert.notEqual(pConcept.scopeHash, pDeriv.scopeHash, 'switching errorReason must change scopeHash');
  assert.notEqual(pConcept.scopeHash, pNoteA.scopeHash, 'adding thinkingNote must change scopeHash');
  assert.notEqual(pNoteA.scopeHash, pNoteB.scopeHash, 'changing thinkingNote must change scopeHash');
});
