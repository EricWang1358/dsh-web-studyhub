/**
 * Local types for WrongBookView mirroring `lib/insights.js` (`wrongBook`),
 * `lib/wrong-detail.js` (`wrongDetail`), `lib/recommend.js` (`recommendSimilar`),
 * and `lib/evidence/mistake-triage.js` (`triageMistake`).
 */

export type ErrorReasonId =
  | 'concept'
  | 'condition'
  | 'derivation'
  | 'slip'
  | 'prerequisite'
  | 'bad_question';

export type TriageRoute =
  | 'fsrs_only'
  | 'confusable_contrast'
  | 'book_retell'
  | 'rescue_companion'
  | 'prereq_branch'
  | 'fix_question';

export type WrongBookTab = 'all' | 'weak' | 'confusable' | 'reason';

export interface ConfusableRow {
  aspect?: string;
  cells?: string[];
}

export interface ConfusablePair {
  id?: string;
  items?: string[];
  names?: string[];
  hids?: string[];
  rows?: ConfusableRow[];
  matchBy?: string;
}

export interface PrereqRef {
  deckId: string;
  cardId: string;
  topic?: string;
  prompt?: string;
}

export interface WrongBookTriage {
  route: TriageRoute;
  reason?: ErrorReasonId | null;
  source?: string;
  tokens?: 'zero' | 'light' | string;
  course?: string;
  hid?: string;
  rescueFocus?: string;
  fallback?: boolean;
  confusable?: ConfusablePair;
  prereq?: PrereqRef;
  prereqRefs?: PrereqRef[];
}

export interface CardCitation {
  sourceId?: string;
  title?: string;
  page?: number;
  quote?: string;
}

export interface WrongBookItem {
  deckId: string;
  deckTitle: string;
  cardId: string;
  topic?: string;
  kind?: string;
  assessment?: 'graded' | 'self' | 'oral' | 'rubric' | string;
  prompt?: string;
  lastGrade?: number;
  lastAt?: string;
  wrongCount?: number;
  firstWrongAt?: string;
  lastWrongAt?: string;
  recoveredAt?: string;
  suspended?: boolean;
  leech?: boolean;
  hid?: string;
  errorReason?: ErrorReasonId | null;
  triage?: WrongBookTriage | null;
  similarWin?: boolean;
  citations?: CardCitation[];
  /** Client-annotated source list: 'weak' (待巩固) or 'history' (已订正). */
  _view: 'weak' | 'history';
}

export interface WrongBookResponse {
  view?: 'weak' | 'history';
  total?: number;
  counts?: {
    weak?: number;
    history?: number;
  };
  items?: Omit<WrongBookItem, '_view'>[];
}

export interface DistractorExplanation {
  id?: string;
  text: string;
  explanation: string;
}

export interface WrongBookDetail {
  deckId: string;
  cardId: string;
  kind?: string;
  prompt?: string;
  yourAnswer?: string | null;
  selfGrade?: number | null;
  lastGrade?: number | null;
  missedGrade?: number | null;
  missedAt?: string | null;
  correctAnswer?: string;
  explanation?: string;
  misconception?: string;
  distractorExplanations?: DistractorExplanation[];
  cloze?: {
    text?: string;
    answers?: Array<{ id: string; value: string }>;
  };
  clozeAnswers?: Record<string, string>;
  clozeDetails?: Array<{ id: string; correct: boolean; expected?: string }>;
  rubric?: {
    total?: number;
    max?: number;
    items?: Array<{ label?: string; score?: number; max?: number; note?: string }>;
  };
  correction?: string;
  oralFeedback?: {
    band?: string | null;
    reason?: string;
    correction?: string;
  };
  oralFollowup?: {
    question?: string;
    answer?: string;
  };
}

export interface RecommendReason {
  type: 'topic' | 'page' | 'near' | 'terms' | 'source' | string;
  topic?: string;
  sourceTitle?: string;
  page?: number;
  terms?: string[];
}

export interface WrongBookRecommendItem {
  deckId: string;
  deckTitle: string;
  cardId: string;
  topic?: string;
  kind?: string;
  prompt?: string;
  score?: number;
  reasons?: RecommendReason[];
  forCardIds?: string[];
  matches?: Array<{
    cardId: string;
    reasons?: RecommendReason[];
    score?: number;
  }>;
}

export interface WrongBookRecommendResponse {
  items?: WrongBookRecommendItem[];
  considered?: number;
}
