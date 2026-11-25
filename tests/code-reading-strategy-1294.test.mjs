import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_STYLE,
  CODE_READING_STRATEGY,
  isCodeOrientedMaterial,
} from '../lib/notation.js';
import {
  extractFencedCodeComments,
  codeCommentLeakIssues,
  cardLocalIssues,
  blueprintPrompts,
} from '../lib/assessment-quality.js';
import { authorPrompts } from '../lib/generation.js';
import { writePrompts } from '../lib/one-pass/prompts.js';
import { RECOMMENDED_CODE_READING_RULE } from '../lib/course-rules.js';
import { measureCodeBlockRatios } from '../scripts/qa/code-block-ratio.mjs';
import { loadUi } from './helpers/ui-module.mjs';

const CJK_RE = /[\u4e00-\u9fff]/;

const NON_CODE_SOURCES = [
  {
    id: 'src-hist',
    title: 'Modern European History',
    text: 'The Treaty of Westphalia in 1648 established principles of state sovereignty across European territories.',
  },
];

const CODE_PROSE_SOURCES = [
  {
    id: 'src-react',
    title: 'React Hooks Notes',
    text: 'When `useEffect` captures a state variable from an earlier render without listing it in the dependency array, calling `setState` inside an interval creates a stale closure.',
  },
];

test('#1294-1: code-reading strategy activates for programming/engineering material and leaves non-code prompts & CODE_STYLE unchanged', () => {
  assert.equal(isCodeOrientedMaterial(NON_CODE_SOURCES, { course: 'History' }), false);
  assert.equal(isCodeOrientedMaterial(CODE_PROSE_SOURCES, { course: 'Frontend' }), true);
  assert.equal(isCodeOrientedMaterial(NON_CODE_SOURCES, { course: 'SQL & Databases' }), true);

  const plan = { targets: [{ targetId: 't1', objective: 'o', knowledge: 'k', citations: [] }] };
  const bp = { items: [{ targetId: 't1', answer: 'a', reasoning: 'r', comparisonAxis: 'c', scenario: { kind: 'none', facts: [], decisiveConditions: [] } }] };

  const nonCodeBp = blueprintPrompts({ count: 1, kind: 'quiz', sources: NON_CODE_SOURCES, course: 'History', notation: 'text' }, plan);
  const codeBp = blueprintPrompts({ count: 1, kind: 'quiz', sources: CODE_PROSE_SOURCES, course: 'Frontend', notation: 'text' }, plan);
  assert.equal(nonCodeBp.prompt.includes(CODE_READING_STRATEGY), false);
  assert.equal(codeBp.prompt.includes(CODE_READING_STRATEGY), true);

  const nonCodeAuthor = authorPrompts({ count: 1, kind: 'quiz', sources: NON_CODE_SOURCES, course: 'History', notation: 'text' }, plan, bp);
  const codeAuthor = authorPrompts({ count: 1, kind: 'quiz', sources: CODE_PROSE_SOURCES, course: 'Frontend', notation: 'text' }, plan, bp);
  assert.equal(nonCodeAuthor.prompt.includes(CODE_READING_STRATEGY), false);
  assert.equal(codeAuthor.prompt.includes(CODE_READING_STRATEGY), true);

  const nonCodeOnePass = writePrompts({ language: '中文', difficulty: 'mixed', course: 'History' }, [{ label: 'S1', quota: 1, pieces: [{ ...NON_CODE_SOURCES[0], section: 'S1' }] }]);
  const codeOnePass = writePrompts({ language: '中文', difficulty: 'mixed', course: 'React' }, [{ label: 'S1', quota: 1, pieces: [{ ...CODE_PROSE_SOURCES[0], section: 'S1' }] }]);
  assert.equal(nonCodeOnePass.prompt.includes(CODE_READING_STRATEGY), false);
  assert.equal(codeOnePass.prompt.includes(CODE_READING_STRATEGY), true);
  assert.ok(CODE_STYLE.length < 900);
});

test('#1294-2: codeCommentLeakIssues flags answer-leaking comments inside fenced blocks, ignores neutral comments, short answers, URLs, C directives, and decrement operators', () => {
  const leakingDeck = {
    title: 'React Traps',
    cards: [
      {
        id: 'q1',
        kind: 'quiz',
        topic: 'Hooks',
        prompt: 'What happens when this component runs?\n```jsx\nfunction Counter() {\n  const [n, setN] = useState(0);\n  useEffect(() => {\n    // BUG: captures stale closure of n = 0 forever\n    setInterval(() => setN(n + 1), 1000);\n  }, []);\n}\n```',
        hint: 'Check the dependency array.',
        options: [
          { id: 'a', text: 'Captures stale closure of n = 0 forever', correct: true, explanation: 'Empty deps.' },
          { id: 'b', text: 'Increments smoothly every second', correct: false, explanation: 'No functional updater.' },
          { id: 'c', text: 'Throws a React runtime error', correct: false, explanation: 'Valid syntax.' },
        ],
        answer: 'Captures stale closure of n = 0 forever',
        explanation: 'Empty dependency array captures initial n.',
        misconception: 'Assuming state reads live value.',
      },
    ],
  };

  const leakIssues = codeCommentLeakIssues(leakingDeck);
  assert.equal(leakIssues.length, 1);
  assert.match(leakIssues[0], /answerLeak in code comment/);

  // Also surfaced through cardLocalIssues
  const localIssues = cardLocalIssues(leakingDeck);
  assert.ok(localIssues.some(issue => /answerLeak in code comment/.test(issue)));

  // Neutral comment + short numeric answer + URL + C preprocessor + i-- -> zero false positives
  const cleanDeck = {
    title: 'Clean Code Cards',
    cards: [
      {
        id: 'q2',
        kind: 'quiz',
        topic: 'Python Copy',
        prompt: 'What does this print?\n```python\n# initialize nested list\na = [[1, 2]]\nb = a.copy()\nb[0].append(3)\nprint(a)\n```',
        hint: 'Consider shallow vs deep copy.',
        options: [
          { id: 'a', text: '[[1, 2, 3]] because shallow copy shares inner list', correct: true, explanation: 'Shared ref.' },
          { id: 'b', text: '[[1, 2]] because copy clones nested objects', correct: false, explanation: 'That is deepcopy.' },
          { id: 'c', text: 'Raises TypeError at runtime', correct: false, explanation: 'List is mutable.' },
        ],
        answer: '[[1, 2, 3]] because shallow copy shares inner list',
        explanation: 'list.copy() is shallow.',
        misconception: 'Confusing shallow and deep copy.',
      },
      {
        id: 'q3',
        kind: 'flashcard',
        topic: 'Arithmetic',
        prompt: 'What value is returned?\n```js\n// returns 3\nconst url = "https://example.com";\nlet i = 4;\ni--;\nreturn i;\n```',
        answer: '3',
        explanation: 'i-- decrements 4 to 3.',
      },
      {
        id: 'q4',
        kind: 'flashcard',
        topic: 'C Headers',
        prompt: 'Which header declares printf?\n```c\n#include <stdio.h>\nint main() { return 0; }\n```',
        answer: 'Standard input/output header stdio.h',
        explanation: 'stdio.h provides printf.',
      },
    ],
  };

  assert.deepEqual(codeCommentLeakIssues(cleanDeck), []);
  // Verify extractor ignores C preprocessor, URLs, and i--
  assert.deepEqual(extractFencedCodeComments('```c\n#include <stdio.h>\nint x = 1;\nx--;\n```'), []);
  assert.deepEqual(extractFencedCodeComments('```sql\n-- Serializable prevents write skew\nSELECT * FROM t;\n```'), ['Serializable prevents write skew']);
});

test('#1294-3: read-only measurement helper summarizes per-course fenced code ratios and 3–16 line stats', () => {
  const report = measureCodeBlockRatios([
    {
      id: 'd1',
      title: 'SQL Locks',
      course: 'SQL',
      cards: [
        { id: 'c1', prompt: '```sql\nBEGIN;\nSELECT * FROM t FOR UPDATE;\nUPDATE t SET v = 1;\nCOMMIT;\n```' },
        { id: 'c2', prompt: 'Explain MVCC in words.' },
      ],
    },
  ]);
  assert.equal(report.courses.length, 1);
  assert.equal(report.courses[0].course, 'SQL');
  assert.equal(report.courses[0].withCode, 1);
  assert.equal(report.courses[0].cards, 2);
  assert.equal(report.courses[0].ratio, 0.5);
  assert.equal(report.courses[0].inTargetLines, 1);
  assert.equal(report.courses[0].targetLineRatio, 1);
});

test('#1294-4: CourseRulesEditor exposes recommended code-reading rule preset with Tooltip and EN i18n', async () => {
  assert.ok(RECOMMENDED_CODE_READING_RULE.length > 20 && RECOMMENDED_CODE_READING_RULE.length <= 200);
  const ui = await loadUi(`
    export { setUiLanguage, ui } from './ui/i18n.js';
    export { default as CourseRulesEditor } from './ui/course-rules/CourseRulesEditor.jsx';
  `);
  ui.setUiLanguage('en');
  try {
    for (const key of [
      '加入代码阅读题推荐守则',
      '已加入代码阅读题推荐守则',
      '适用于编程与工程类课程：优先把大段口述代码执行改成 3–16 行最小可读代码块，并禁止在代码注释里泄题。',
    ]) {
      const en = ui.ui(key);
      assert.ok(en && !CJK_RE.test(en), `Missing/leaked EN translation for "${key}": ${en}`);
    }
  } finally {
    ui.setUiLanguage('zh');
  }
});
