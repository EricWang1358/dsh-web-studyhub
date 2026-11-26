/* The three first-use tips under a practice question (#948): 帮我弄懂 after a first wrong answer, 修题 after a first 「这题有问题」, 出成前置题 once an answer
   is shown under the question. The rule that decides which one (if any) shows is one pure function (ui/guidance/practice-tips.js), tested here without a
   browser; the browser test (question-tools-first-use-browser.test.mjs) draws them. Nothing here touches a real library.
   Note on static CSS guardrails below: Node has no CSS cascade or `[popover]` / `:focus-visible` pseudo-class evaluator, so the #1276 stylesheet check
   intentionally inspects ui/review/review.css statically for padding, line-height, button min-height, and tip-ring vs `:focus-visible` outlines. All
   hook/view/placement JS behavior (`usePracticeTip`, `PAGE_VIEWS.review` tourRunning propagation, `PracticeTip` toolbar clearance) is tested dynamically. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { nativeSelects } from './helpers/native-selects.mjs';

const require = createRequire(import.meta.url);
const built = await build({ stdin: { contents: `export * from './ui/guidance/practice-tips.js'; export * from './ui/guidance/registry.js'; export * from './ui/guidance/budget.js';`, resolveDir: process.cwd() },
  bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react-dom'], plugins: [nativeSelects], loader: { '.css': 'text' }, logLevel: 'silent' });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(require, module, module.exports);
const { PRACTICE_TIPS_KEY, PRACTICE_TIP_ORDER, PRACTICE_TIP, practiceTipFor, practiceTipSeen, markPracticeTipSeen, forgetPracticeTipsVisit, practiceTipState,
  GUIDANCE_ITEMS, guidanceItem, entryProblems, itemSeen, clearItem, GUIDANCE_KEY, readGuidanceState, claimProactiveTip, forgetVisitClaim } = module.exports;

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return { map, get length() { return map.size; }, key: index => [...map.keys()][index] ?? null, getItem: key => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); }, removeItem: key => { map.delete(key); } };
}
const refusing = () => ({ get length() { throw new Error('blocked'); }, key() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); }, removeItem() { throw new Error('blocked'); } });

const ALL = [...PRACTICE_TIP_ORDER];
/** What the page asks: the moments that hold now, nothing seen, every switch on. */
const ask = (moments, rest = {}) => practiceTipFor({ allowed: ALL, seen: [], ...moments, ...rest });

test('the three tips and their order are the owner\'s table: 帮我弄懂, then 修题, then 出成前置题', () => {
  assert.deepEqual(PRACTICE_TIP_ORDER, ['practice.help-first', 'practice.fix-first', 'practice.prereq-first']);
  assert.deepEqual([PRACTICE_TIP.help, PRACTICE_TIP.fix, PRACTICE_TIP.prereq], PRACTICE_TIP_ORDER);
});

test('each tip shows only at its own moment, and only after the learner acted', () => {
  assert.equal(ask({}), null, 'nothing happened: nothing shows (the learner is still thinking about the question)');
  assert.equal(ask({ feedbackWrong: false, votedDown: false, answerShown: false }), null);
  assert.equal(ask({ feedbackWrong: true }), PRACTICE_TIP.help, 'a wrong answer is showing');
  assert.equal(ask({ votedDown: true }), PRACTICE_TIP.fix, '这题有问题 was marked');
  assert.equal(ask({ answerShown: true }), PRACTICE_TIP.prereq, 'an answer of 帮我弄懂 or 追问 is shown under the question');
});

test('at most one at a time: when moments coincide the earlier row wins, and the others take their turn when it is gone', () => {
  const all = { feedbackWrong: true, votedDown: true, answerShown: true };
  assert.equal(ask(all), PRACTICE_TIP.help);
  assert.equal(ask(all, { seen: [PRACTICE_TIP.help] }), PRACTICE_TIP.fix);
  assert.equal(ask(all, { seen: [PRACTICE_TIP.help, PRACTICE_TIP.fix] }), PRACTICE_TIP.prereq);
  assert.equal(ask(all, { seen: ALL }), null);
  assert.equal(ask({ votedDown: true, answerShown: true }), PRACTICE_TIP.fix);
});

test('each shows once: a seen tip never returns', () => {
  for (const id of ALL) {
    const moment = { [PRACTICE_TIP.help]: { feedbackWrong: true }, [PRACTICE_TIP.fix]: { votedDown: true }, [PRACTICE_TIP.prereq]: { answerShown: true } }[id];
    assert.equal(ask(moment), id);
    assert.equal(ask(moment, { seen: [id] }), null, `${id} was seen`);
  }
});

test('never during an exam run, never while the tour is running', () => {
  const all = { feedbackWrong: true, votedDown: true, answerShown: true };
  assert.equal(ask(all, { exam: true }), null);
  assert.equal(ask(all, { tourRunning: true }), null);
  assert.equal(ask(all, { exam: false, tourRunning: false }), PRACTICE_TIP.help);
});

test('the master switch and a tip\'s own switch: a tip that is not allowed is skipped, the rest still go', () => {
  const all = { feedbackWrong: true, votedDown: true, answerShown: true };
  assert.equal(ask(all, { allowed: [] }), null, 'the master switch off allows none');
  assert.equal(ask(all, { allowed: [PRACTICE_TIP.fix, PRACTICE_TIP.prereq] }), PRACTICE_TIP.fix, '帮我弄懂\'s own switch is off');
  assert.equal(ask({ feedbackWrong: true }, { allowed: [PRACTICE_TIP.fix] }), null);
  assert.equal(practiceTipFor({ feedbackWrong: true }), null, 'nothing says it is allowed: it is not');
});

test('the seen / allowed lists may be arrays or sets, and unknown ids are ignored', () => {
  assert.equal(practiceTipFor({ feedbackWrong: true, seen: new Set(), allowed: new Set(ALL) }), PRACTICE_TIP.help);
  assert.equal(practiceTipFor({ feedbackWrong: true, seen: new Set(['nope']), allowed: ['nope', ...ALL] }), PRACTICE_TIP.help);
});

/* ---------- the memory: one list under one key, like the reader's hints ---------- */

test('a tip is remembered in one list; a second tip adds to it; clearing one id leaves the others', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage();
  assert.equal(practiceTipSeen(PRACTICE_TIP.help, local), false);
  assert.equal(markPracticeTipSeen(PRACTICE_TIP.help, local), true);
  assert.equal(markPracticeTipSeen(PRACTICE_TIP.help, local), true, 'twice is the same');
  assert.equal(markPracticeTipSeen(PRACTICE_TIP.prereq, local), true);
  assert.deepEqual(JSON.parse(local.getItem(PRACTICE_TIPS_KEY)), ['help-first', 'prereq-first']);
  assert.equal(practiceTipSeen(PRACTICE_TIP.help, local), true);
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), false);
  assert.deepEqual([...local.map.keys()], [PRACTICE_TIPS_KEY], 'one key holds it all');
  forgetPracticeTipsVisit();
});

test('practiceTipState: what is seen and what is allowed, read from the storage in one place', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage({ [PRACTICE_TIPS_KEY]: JSON.stringify(['fix-first']), [GUIDANCE_KEY]: JSON.stringify({ muted: ['practice.prereq-first'] }) });
  assert.deepEqual(practiceTipState(local), { seen: [PRACTICE_TIP.fix], allowed: [PRACTICE_TIP.help, PRACTICE_TIP.fix] });
  const off = memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ off: true }) });
  assert.deepEqual(practiceTipState(off), { seen: [], allowed: [] }, 'the master switch');
  assert.deepEqual(practiceTipState(memoryStorage()), { seen: [], allowed: ALL }, 'nothing stored: all on, none seen');
  forgetPracticeTipsVisit();
});

test('a blocked or missing storage: nothing throws; a tip seen in this visit is not shown again in it', () => {
  for (const storage of [null, refusing()]) {
    forgetPracticeTipsVisit();
    assert.doesNotThrow(() => practiceTipSeen(PRACTICE_TIP.help, storage));
    assert.equal(practiceTipSeen(PRACTICE_TIP.help, storage), false);
    assert.equal(markPracticeTipSeen(PRACTICE_TIP.help, storage), false, 'it cannot be stored');
    assert.equal(practiceTipSeen(PRACTICE_TIP.help, storage), true, 'but this visit remembers it');
    assert.equal(practiceTipSeen(PRACTICE_TIP.fix, storage), false);
    assert.deepEqual(practiceTipState(storage).seen, [PRACTICE_TIP.help]);
  }
  forgetPracticeTipsVisit();
});

test('a tip seen in this visit stays seen when another tab clears the storage; 再显示一次 in this tab brings it back', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage();
  markPracticeTipSeen(PRACTICE_TIP.fix, local);
  local.removeItem(PRACTICE_TIPS_KEY); // another tab's reset, or cleared site data
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), true, 'held for the visit');
  markPracticeTipSeen(PRACTICE_TIP.fix, local);
  assert.equal(clearItem(guidanceItem(PRACTICE_TIP.fix), { local, session: memoryStorage() }), true);
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), false, 'this tab cleared it: back without a reload');
  forgetPracticeTipsVisit();
});

/* ---------- 设置 › 引导 lists them ---------- */

test('the registry lists the three: a tip of 练习, proactive, closed for good, pointing at the one list', () => {
  const entries = PRACTICE_TIP_ORDER.map(id => guidanceItem(id));
  for (const entry of entries) {
    assert.ok(entry, 'registered');
    assert.deepEqual(entryProblems(entry), [], entry.id);
    assert.equal(entry.kind, 'tip');
    assert.equal(entry.where, '练习');
    assert.equal(entry.proactive, true, 'the master switch and their own switch apply');
    assert.equal(entry.dismiss, 'forever');
    assert.equal(entry.memory.store, 'local');
    assert.equal(entry.memory.key, PRACTICE_TIPS_KEY);
    assert.equal(entry.memory.match, 'list');
    assert.ok(entry.trigger.length > 12 && entry.again.length > 4, 'a true trigger and a true again');
  }
  assert.deepEqual(entries.map(entry => entry.memory.item), ['help-first', 'fix-first', 'prereq-first']);
  assert.deepEqual(entries.map(entry => entry.title), ['答错后提示「帮我弄懂」', '标记「这题有问题」后提示「修题」', '看到讲解后提示「出成前置题」']);
  assert.equal(new Set(GUIDANCE_ITEMS.map(item => item.id)).size, GUIDANCE_ITEMS.length, 'ids stay unique');
});

test('the registry sees what the page writes, and 再显示一次 clears exactly that id', () => {
  forgetPracticeTipsVisit();
  const local = memoryStorage();
  const storages = { local, session: memoryStorage() };
  markPracticeTipSeen(PRACTICE_TIP.help, local);
  markPracticeTipSeen(PRACTICE_TIP.fix, local);
  assert.equal(itemSeen(guidanceItem(PRACTICE_TIP.help), storages), true);
  assert.equal(itemSeen(guidanceItem(PRACTICE_TIP.prereq), storages), false);
  assert.equal(clearItem(guidanceItem(PRACTICE_TIP.help), storages), true);
  assert.equal(practiceTipSeen(PRACTICE_TIP.help, local), false);
  assert.equal(practiceTipSeen(PRACTICE_TIP.fix, local), true, 'the other id of the list stays');
  forgetPracticeTipsVisit();
});

/* ---------- not the daily budget ---------- */

test('the three tips do not go through the daily budget: showing them never spends today\'s one tip, and a spent day does not stop them', () => {
  forgetPracticeTipsVisit(); forgetVisitClaim();
  const day = new Date(2026, 9, 26, 12).getTime();
  const spent = memoryStorage({ [GUIDANCE_KEY]: JSON.stringify({ day: '2026-10-26', shownToday: 1 }) });
  assert.equal(claimProactiveTip({ id: 'a.one', now: day, storage: spent }), false, 'the day is spent');
  assert.deepEqual(practiceTipState(spent).allowed, ALL, 'but the practice tips still ask only the switches');
  const local = memoryStorage();
  markPracticeTipSeen(PRACTICE_TIP.help, local);
  assert.equal(readGuidanceState(local).shownToday, 0, 'marking a practice tip seen counts nothing against the day');
  assert.equal(claimProactiveTip({ id: 'a.one', now: day, storage: local }), true, 'the day\'s tip is still there for the other surfaces');
  forgetPracticeTipsVisit(); forgetVisitClaim();
});

async function loadStatefulPracticeUi(entryCode) {
  const contexts = new Map();
  let currentInst = null;
  let cursor = 0;
  let idSeq = 0;
  const depsSame = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  const miniReact = {
    Fragment: Symbol.for('react.fragment'),
    Suspense: Symbol.for('react.suspense'),
    Component: class Component { constructor(props) { this.props = props; this.state = {}; } },
    useInsertionEffect() {},
    lazy(load) { return { $$lazy: true, load }; },
    createContext(defaultValue) {
      const ctx = { _default: defaultValue };
      ctx.Provider = ({ value, children }) => ({ $$provider: ctx, value, children });
      return ctx;
    },
    createElement(type, props, ...children) {
      const p = props ? { ...props } : {};
      if (children.length === 1) p.children = children[0];
      else if (children.length > 1) p.children = children;
      return { type, props: p };
    },
    memo(fn) { return { $$memo: true, type: fn }; },
    forwardRef(fn) { return { $$forwardRef: true, render: fn }; },
    useContext(ctx) {
      const stack = contexts.get(ctx);
      return stack && stack.length ? stack[stack.length - 1] : ctx._default;
    },
    useId() {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) inst.slots[idx] = `:r${++idSeq}:`;
      return inst.slots[idx];
    },
    useState(init) {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) inst.slots[idx] = typeof init === 'function' ? init() : init;
      const setState = (next) => {
        const prev = inst.slots[idx];
        const value = typeof next === 'function' ? next(prev) : next;
        if (!Object.is(prev, value)) {
          inst.slots[idx] = value;
          inst.render(inst.lastProps);
        }
      };
      return [inst.slots[idx], setState];
    },
    useRef(init) {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) inst.slots[idx] = { current: init };
      return inst.slots[idx];
    },
    useCallback(fn, deps) {
      const inst = currentInst;
      const idx = cursor++;
      const prev = inst.slots[idx];
      if (!prev || !depsSame(prev.deps, deps)) inst.slots[idx] = { fn, deps };
      return inst.slots[idx].fn;
    },
    useMemo(fn, deps) {
      const inst = currentInst;
      const idx = cursor++;
      const prev = inst.slots[idx];
      if (!prev || !depsSame(prev.deps, deps)) inst.slots[idx] = { value: fn(), deps };
      return inst.slots[idx].value;
    },
    useEffect(fn, deps) {
      const inst = currentInst;
      const idx = cursor++;
      const prev = inst.effects[idx];
      if (!prev || !deps || !depsSame(prev.deps, deps)) {
        inst.pendingEffects.push({ idx, fn, deps });
      }
    },
    useLayoutEffect(fn, deps) { miniReact.useEffect(fn, deps); },
    useSyncExternalStore(subscribe, getSnapshot) {
      const inst = currentInst;
      const idx = cursor++;
      if (!(idx in inst.slots)) {
        const entry = {
          value: getSnapshot(),
          unsub: subscribe(() => {
            const next = getSnapshot();
            if (!Object.is(entry.value, next)) {
              entry.value = next;
              inst.render(inst.lastProps);
            }
          }),
        };
        inst.slots[idx] = entry;
      } else {
        inst.slots[idx].value = getSnapshot();
      }
      return inst.slots[idx].value;
    },
  };
  miniReact.default = miniReact;

  const compiled = await build({
    stdin: { contents: entryCode, resolveDir: process.cwd() },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'cjs',
    external: ['react', 'react-dom', '@codemirror/*', '@lezer/*', '@base-ui/*', 'markdown-it', 'markdown-it-texmath', 'dompurify', 'katex', 'katex/*'],
    plugins: [nativeSelects],
    loader: { '.css': 'text' },
    logLevel: 'silent',
  });
  const modObj = { exports: {} };
  const customRequire = (id) => (id === 'react' ? miniReact : require(id));
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(customRequire, modObj, modObj.exports);

  function mount(Component, initialProps = {}, { contextValues = [], onBeforeEffects } = {}) {
    const fn = Component?.$$memo ? Component.type : Component;
    const inst = {
      slots: [],
      effects: [],
      pendingEffects: [],
      lastProps: initialProps,
      tree: null,
      render(nextProps = inst.lastProps) {
        inst.lastProps = nextProps;
        for (const [ctx, val] of contextValues) {
          if (!contexts.has(ctx)) contexts.set(ctx, []);
          contexts.get(ctx).push(val);
        }
        const prevInst = currentInst;
        const prevCursor = cursor;
        currentInst = inst;
        cursor = 0;
        try {
          inst.tree = fn(nextProps);
        } finally {
          currentInst = prevInst;
          cursor = prevCursor;
          for (const [ctx] of contextValues) contexts.get(ctx).pop();
        }
        onBeforeEffects?.(inst.tree);
        const queue = inst.pendingEffects.splice(0);
        for (const item of queue) {
          inst.effects[item.idx]?.cleanup?.();
          const cleanup = item.fn();
          inst.effects[item.idx] = { deps: item.deps, cleanup: typeof cleanup === 'function' ? cleanup : null };
        }
        return inst.tree;
      },
      unmount() {
        for (const eff of inst.effects) eff?.cleanup?.();
        for (const slot of inst.slots) slot?.unsub?.();
      },
    };
    inst.render(initialProps);
    return inst;
  }

  return { exports: modObj.exports, mount };
}

test('usePracticeTip suppresses tips during exam runs and active tours, and ReviewView forwards tourRunning to Review', async () => {
  const origDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const origSetTimeout = globalThis.setTimeout;
  const origClearTimeout = globalThis.clearTimeout;
  const timers = new Map();
  let nextTimerId = 1;

  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { addEventListener: () => {}, removeEventListener: () => {} },
  });
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: memoryStorage(),
  });
  globalThis.setTimeout = (fn) => {
    const id = nextTimerId++;
    timers.set(id, fn);
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  const flushTimers = () => {
    for (const [id, fn] of [...timers.entries()]) {
      timers.delete(id);
      fn();
    }
  };

  try {
    const ui = await loadStatefulPracticeUi(`
      export { usePracticeTip } from './ui/review/use-practice-tip.js';
      export { PRACTICE_TIP, practiceTipSeen, forgetPracticeTipsVisit } from './ui/guidance/practice-tips.js';
      export { PAGE_VIEWS } from './ui/app/page-views.jsx';
      export { AppContext } from './ui/app/app-context.js';
      export { default as Review } from './ui/Review.jsx';
    `);
    ui.exports.forgetPracticeTipsVisit();

    let latest = null;
    function HookProbe(props) {
      latest = ui.exports.usePracticeTip(props);
      return null;
    }

    // 1. Practice run with wrong feedback shows help-first after settle delay; turning on tourRunning hides it without marking seen.
    const wrongCard = { id: 'c1', kind: 'quiz', options: [{ id: 'a', text: 'A', correct: true }, { id: 'b', text: 'B', correct: false }] };
    const wrongRun = { id: 'r1', index: 0, mode: 'quiz', card: wrongCard, feedback: { correct: false } };
    const probe = ui.mount(HookProbe, { run: wrongRun, tourRunning: false });
    assert.equal(latest.tip, null, 'waits for settle timer before showing');
    flushTimers();
    assert.equal(latest.tip, ui.exports.PRACTICE_TIP.help, 'shows help-first after wrong answer in practice mode');

    probe.render({ run: wrongRun, tourRunning: true });
    assert.equal(latest.tip, null, 'starting the tour immediately clears the active tip');
    assert.equal(ui.exports.practiceTipSeen(ui.exports.PRACTICE_TIP.help), false, 'tour suppression does not spend the tip');

    // 2. While tourRunning stays true, firing timers does not re-open a tip.
    flushTimers();
    assert.equal(latest.tip, null, 'no tip opens while tourRunning is true');
    probe.unmount();

    // 3. Exam runs never open practice tips even on wrong feedback.
    const examRun = { id: 'r2', index: 0, mode: 'exam', card: { ...wrongCard, id: 'c2' }, feedback: { correct: false } };
    const examProbe = ui.mount(HookProbe, { run: examRun, tourRunning: false });
    flushTimers();
    assert.equal(latest.tip, null, 'exam run suppresses practice tips');
    examProbe.unmount();

    // 4. ReviewView (PAGE_VIEWS.review) forwards !!tour.tourStep into Review context.tourRunning.
    const makeApp = (tourStep) => ({
      data: { root: '/tmp/lib', decks: [] },
      core: { act: async () => {} },
      nav: { navigate: () => {}, show: { note: () => {}, page: () => {} } },
      lib: { detour: null },
      set: { setBoardView: () => {}, setWorkflowReturn: () => {} },
      session: { run: wrongRun, coach: {}, continueTo: () => null },
      learn: { trailLabel: '', trailPage: '', trailPlace: null, returnFromContext: () => {}, returnFromDetour: () => {}, returnToReading: () => {}, captureContext: () => ({}), rememberContext: () => {}, openLearningTarget: () => {}, openBoardWithContext: () => {} },
      dailyPlan: { refresh: () => {} },
      settingsEntry: { openModelSettings: () => {}, setSettingsFocus: () => {} },
      tour: { tourStep },
    });
    const findReview = (node) => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) return node.map(findReview).find(Boolean) || null;
      if (node.type === ui.exports.Review) return node;
      return node.props?.children ? findReview(node.props.children) : null;
    };

    const viewWithTour = ui.mount(ui.exports.PAGE_VIEWS.review, { feedback: null }, { contextValues: [[ui.exports.AppContext, makeApp({ id: 'tour-1' })]] });
    assert.equal(findReview(viewWithTour.tree)?.props?.context?.tourRunning, true, 'ReviewView passes tourRunning=true when tour.tourStep is active');
    viewWithTour.unmount();

    const viewNoTour = ui.mount(ui.exports.PAGE_VIEWS.review, { feedback: null }, { contextValues: [[ui.exports.AppContext, makeApp(null)]] });
    assert.equal(findReview(viewNoTour.tree)?.props?.context?.tourRunning, false, 'ReviewView passes tourRunning=false when no tour step is active');
    viewNoTour.unmount();
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    if (origDoc) Object.defineProperty(globalThis, 'document', origDoc);
    else delete globalThis.document;
    if (origStorage) Object.defineProperty(globalThis, 'localStorage', origStorage);
    else delete globalThis.localStorage;
  }
});

test('#1276: practice tip card uses roomy padding, normal sm button height, toolbar clearance >= 8*scale, and a tip ring distinct from focus-visible', async () => {
  const { readFile } = await import('node:fs/promises');
  const css = await readFile(new URL('../ui/review/review.css', import.meta.url), 'utf8');

  // Roomier vertical padding & snug line-height on .practice-tip[popover], normal sm button (no squashed min-height: 0 / padding: 0).
  assert.match(css, /\.practice-tip\[popover\][^{]*\{[^}]*padding:\s*var\(--space-2\)\s+var\(--space-3-5\);/s);
  assert.match(css, /\.practice-tip\[popover\][^{]*\{[^}]*line-height:\s*var\(--lh-snug\);/s);
  assert.doesNotMatch(css, /\.practice-tip__ok[^{]*\{[^}]*min-height:\s*0/s, '知道了 keeps normal small-button height');

  // Tip ring uses dashed --info-ink + --info-bg (not solid --accent-soft identical to :focus-visible), while :focus-visible still wins on keyboard focus.
  assert.match(css, /\[data-practice-tip-ring\]\s*\{[^}]*outline:\s*2px\s+dashed\s+var\(--info-ink\);[^}]*background:\s*var\(--info-bg\);/s);
  assert.doesNotMatch(css, /\[data-practice-tip-ring\]\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent-soft\)/s);
  assert.match(css, /\[data-practice-tip-ring\]:focus-visible\s*\{[^}]*outline:\s*2px\s+solid\s+var\(--accent-soft\);/s);

  // Behavioral clearance check: mount PracticeTip at 1.25x zoom scale and verify placed top sits >= 8 * scale below the toolbar block.
  const origWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const origDoc = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const origNodeFilter = Object.getOwnPropertyDescriptor(globalThis, 'NodeFilter');
  const origRaf = globalThis.requestAnimationFrame;
  const origCancelRaf = globalThis.cancelAnimationFrame;

  const scale = 1.25;
  const toolbarRect = { left: 100, top: 200, right: 380, bottom: 232, width: 280, height: 32 };
  const btnRect = { left: 100, top: 200, right: 180, bottom: 232, width: 80, height: 32 };
  const attrs = new Map();
  let popoverOpen = false;
  const fakeBtn = {
    getClientRects: () => [btnRect],
    getBoundingClientRect: () => btnRect,
    checkVisibility: () => true,
    setAttribute: (k, v) => attrs.set(k, v),
    removeAttribute: (k) => attrs.delete(k),
    closest: (sel) => {
      if (sel.includes('.question-toolbar')) return fakeToolbar;
      if (sel.includes('.question-tools')) return fakeToolbar;
      if (sel.includes('.question-area')) return fakeArea;
      return null;
    },
  };
  const fakeToolbar = {
    getBoundingClientRect: () => toolbarRect,
    querySelector: () => fakeToolbar,
    querySelectorAll: (sel) => (sel === 'button' ? [fakeBtn] : []),
    closest: (sel) => (sel === '.question-area' ? fakeArea : null),
    contains: (el) => el === fakeBtn,
  };
  const fakeArea = {
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const fakeScope = {
    querySelectorAll: (sel) => (sel === '[data-usage="review.help"]' ? [fakeBtn] : []),
    querySelector: (sel) => (sel === '.question-area' ? fakeArea : sel === '.question-toolbar' ? fakeToolbar : null),
  };
  const fakeCard = {
    style: {},
    offsetWidth: 200,
    getBoundingClientRect: () => ({ width: 200 * scale, height: 48 * scale }),
    matches: (sel) => sel === ':popover-open' && popoverOpen,
    showPopover: () => { popoverOpen = true; },
    hidePopover: () => { popoverOpen = false; },
    closest: (sel) => (sel === '.review-body' ? fakeScope : null),
    contains: () => false,
  };

  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { innerWidth: 1280, innerHeight: 800, addEventListener: () => {}, removeEventListener: () => {} },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      body: fakeArea,
      querySelector: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
      createRange: () => ({ selectNodeContents: () => {}, getClientRects: () => [] }),
      createTreeWalker: () => ({ nextNode: () => null }),
    },
  });
  Object.defineProperty(globalThis, 'NodeFilter', { configurable: true, value: { SHOW_TEXT: 4 } });
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};

  try {
    const ui = await loadStatefulPracticeUi(`export { default as PracticeTip } from './ui/review/PracticeTip.jsx';`);
    const inst = ui.mount(
      ui.exports.PracticeTip,
      { id: PRACTICE_TIP.help, onClose: () => {}, onShown: () => {} },
      {
        onBeforeEffects: (tree) => {
          if (tree?.props?.ref) tree.props.ref.current = fakeCard;
        },
      },
    );
    try {
      assert.equal(popoverOpen, true, 'PracticeTip opens its manual popover');
      assert.ok(attrs.has('data-practice-tip-ring'), 'PracticeTip rings the target control while visible');
      const placedTopViewport = parseFloat(fakeCard.style.top) * scale;
      const clearance = placedTopViewport - toolbarRect.bottom;
      assert.ok(clearance >= 8 * scale - 0.01, `expected toolbar clearance >= ${8 * scale}px (8 * scale), got ${clearance}px`);
    } finally {
      inst.unmount();
    }
  } finally {
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCancelRaf;
    if (origWindow) Object.defineProperty(globalThis, 'window', origWindow);
    else delete globalThis.window;
    if (origDoc) Object.defineProperty(globalThis, 'document', origDoc);
    else delete globalThis.document;
    if (origNodeFilter) Object.defineProperty(globalThis, 'NodeFilter', origNodeFilter);
    else delete globalThis.NodeFilter;
  }
});
