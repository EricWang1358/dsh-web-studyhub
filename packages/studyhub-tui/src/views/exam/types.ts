/**
 * Local, loosely-typed mirrors of the StudyRuntime exam payloads used by the Exam view.
 * Source of truth: `lib/study-state.js` (projection / examReport), `lib/oral-exam.js`
 * (oralView / oralReport) and `lib/case-study.js` (casePaperReport).
 */

export type ExamMode = 'written' | 'case' | 'oral';
export type WrittenKinds = 'all' | 'balanced' | 'quiz' | 'multi';

export interface ScopeRef {
  deckId: string;
  cardId?: string;
  topic?: string;
}

export interface ExamOption {
  id: string;
  text: string;
}

export interface ExamCard {
  id: string;
  kind?: string;
  topic?: string;
  prompt?: string;
  hint?: string;
  multiple?: boolean;
  marks?: number;
  options?: ExamOption[];
  rubricCriteria?: Array<{ id?: string; label?: string; marks?: number }>;
  deckId?: string;
}

export interface ExamPick {
  deckId: string;
  cardId: string;
  selected: string[] | null;
}

/** `review.start` / `review.get` / `review.move` / `review.answer` projection of an exam run. */
export interface RunView {
  id: string;
  startedAt?: string;
  mode?: string;
  examKinds?: string;
  limitMs?: number | null;
  index: number;
  total?: number;
  questions?: number;
  title?: string;
  complete?: boolean;
  closed?: boolean;
  card?: ExamCard | null;
  picks?: ExamPick[];
  responses?: Array<{ deckId: string; cardId: string; response: string }>;
  paperCards?: ExamCard[];
  paper?: {
    deckId?: string;
    limitMs?: number | null;
    totalMarks?: number;
    readingMinutes?: number;
    writingMinutes?: number;
    handwriting?: boolean;
  };
  [k: string]: unknown;
}

export interface ReportItemOption {
  id: string;
  text: string;
  correct: boolean;
  explanation?: string;
}

export interface ReportItem {
  deckId: string;
  cardId: string;
  topic?: string;
  prompt?: string;
  kind?: string;
  multiple?: boolean;
  selected?: string[];
  options?: ReportItemOption[];
  answer?: string;
  explanation?: string;
  misconception?: string;
  /** Local marker: item comes from `skipped` (unanswered). */
  skipped?: boolean;
}

export interface CaseQuestionReport {
  cardId: string;
  deckId?: string;
  n: number;
  prompt?: string;
  marks: number;
  response?: string;
  answered?: boolean;
  status: 'graded' | 'pending' | 'unanswered' | string;
  total: number | null;
  band?: string | null;
}

/** `exam.submit` / `exam.report` value. */
export interface ExamReport {
  runId: string;
  startedAt?: string;
  submittedAt?: string;
  examKinds?: string;
  examRole?: string;
  total: number;
  answered: number;
  unanswered: number;
  correct: number;
  scorePct: number;
  comparison?: { runId: string; scorePct: number | null; deltaPct: number } | null;
  durationMs?: number;
  case?: {
    title?: string;
    total: number;
    max: number;
    pending: number;
    questions: CaseQuestionReport[];
    weakest?: Array<{ label?: string; ratio?: number; [k: string]: unknown }>;
  };
  byTopic?: Array<{ deckId?: string; deckTitle?: string; topic: string; correct: number; total: number }>;
  byDeck?: Array<{ deckId?: string; title?: string; correct: number; total: number }>;
  byKind?: Array<{ kind: string; correct: number; total: number }>;
  wrong?: ReportItem[];
  skipped?: ReportItem[];
  weakScope?: ScopeRef[];
}

/** `oral.start` / `oral.answer` / `oral.next` / `oral.followup` value. */
export interface OralView {
  id: string;
  role?: string;
  startedAt?: string;
  index: number;
  total: number;
  submitted: boolean;
  answered: number;
  entry: {
    deckId: string;
    cardId: string;
    topic?: string;
    prompt?: string;
    kind?: string;
    options?: ExamOption[];
    answer: string;
    followup: string;
    followupAnswer: string;
  } | null;
}

export interface OralAssessment {
  band: 'strong' | 'developing' | 'weak' | string;
  grade: number;
  reason?: string;
}

/** `oral.submit` / `oral.report` value. */
export interface OralReport {
  runId: string;
  role?: string;
  startedAt?: string;
  submittedAt?: string;
  total: number;
  answered: number;
  assessed: number;
  strong: number;
  developing: number;
  weak: number;
  feedbackStatus?: string;
  weakTopics?: Array<{ topic: string; weak: number; developing: number; unanswered: number }>;
  entries: Array<{
    deckId: string;
    cardId: string;
    topic?: string;
    prompt?: string;
    answer?: string;
    followup?: string;
    followupAnswer?: string;
    expected?: string;
    assessment: OralAssessment | null;
  }>;
  weakScope?: ScopeRef[];
}

export type ReportState =
  | { kind: 'written'; report: ExamReport }
  | { kind: 'oral'; report: OralReport };

export interface ScopeChoice {
  id: string;
  label: string;
  hint?: string;
  /** Extra args merged into the start payload. */
  args: Record<string, unknown>;
}

export interface ExamSetupValue {
  mode: ExamMode;
  scopeId: string;
  count: number;
  minutes: number;
  kinds: WrittenKinds;
}

export interface HistoryItem {
  key: string;
  kind: 'written' | 'oral';
  runId: string;
  submittedAt: string;
  title: string;
  detail: string;
  score: string;
  tone: 'success' | 'warning' | 'error' | 'muted';
}
