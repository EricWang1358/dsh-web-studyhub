/** Types and formatting helpers for ExamCoachView (`coach.*` + `course.evidence.summary`). */
import type { UiLanguage } from '../../types/contracts.js';

export type CoachTab = 'calibration' | 'variants' | 'evidence' | 'mock';

export interface CoachSampleOption {
  id: string;
  text: string;
  correct?: boolean;
  misconceptionId?: string;
  misconceptionReason?: string;
}

export interface CoachSample {
  id?: string;
  format?: string;
  stem?: string;
  options?: CoachSampleOption[];
  answer?: string;
  rubric?: string;
  redacted?: boolean;
  solutionRevealedAt?: string;
}

export interface CoachTaskFamily {
  id: string;
  title: string;
  origin?: string;
  knowledgePoints?: string[];
  keyConditions?: string[];
  reasoningSteps?: string[];
  expectedArtifact?: string;
  primaryFormat: string;
  allowedFormats?: string[];
  allowFormSubstitute?: boolean;
  quota: number;
  quotaUnit?: string;
  questionsPerUnit?: number;
  priority: 'high' | 'medium' | 'deferred' | string;
  marksPerItem?: number;
  timeBudgetSec?: number;
  formatTradeoff?: string;
  calibrated?: boolean;
  defects?: Array<{ code?: string; message: string }>;
  distractorRules?: Array<{ id: string; code?: string; label?: string; reason: string }>;
  rubricPoints?: Array<{ id: string; criterion: string; marks: number; condition: string }>;
  sample?: CoachSample;
  confirmations?: {
    appearanceApproved?: boolean;
    intentApproved?: boolean;
    answerVerified?: boolean;
    staleReason?: string;
  };
}

export interface CoachSpec {
  schema?: string;
  specVersion?: number;
  course: string;
  stage?: string;
  templateName?: string;
  scopeBoundary?: {
    sampleFrequencyNote?: string;
    uncoveredMaterialSections?: string[];
  };
  crunchMode?: {
    enabled?: boolean;
    remainingMinutes?: number;
  };
  taskFamilies: CoachTaskFamily[];
  updatedAt?: string | null;
}

export interface CoachCapabilityEvidence {
  materialCoverage: {
    totalSources: number;
    totalSections: number;
    coveredSections: number;
    ratio: number;
    uncoveredSections?: string[];
    totalPublishedCards: number;
    recallOnlyCardCount: number;
    surfaceApplicationCardCount: number;
  };
  trainingCoverage: {
    specVersion?: number;
    planned: number;
    generated: number;
    verifiedUsable: number;
    practiced: number;
    outdatedVersionCardCount?: number;
    excludedScaffoldOrDowngradeCount?: number;
  };
  capabilityEvidence: {
    reviewFamiliarity: {
      reviewedCards: number;
      highStabilityCards: number;
      note?: string;
    };
    sameItemRepeatCount: number;
    assistedOrExposedCount: number;
    selfReportedCount: number;
    unknownLegacyCount?: number;
    unseenIndependentPassCount: number;
    delayedIndependent: {
      thresholdHours?: number;
      passedFamilyCount: number;
      totalActiveFamilyCount: number;
      status: string;
    };
    timedIndependent: {
      passedCount: number;
      overBudgetCount: number;
      untimedUnknownCount?: number;
      status: string;
    };
    misconceptionHypotheses?: Array<{
      misconceptionId: string;
      reason: string;
      occurrences: number;
      confirmedMisconception?: boolean;
    }>;
    readyForExam: boolean;
    verdict: string;
  };
}

export interface CoachCalibrationGetResult {
  course: string;
  courses?: string[];
  spec: CoachSpec | null;
  evidence: CoachCapabilityEvidence | null;
}

export interface CoachStatusResult {
  enabled: boolean;
  consent?: boolean;
  ready: number;
  preparing: boolean;
  preparingCards?: string[];
  readyCards?: Array<{
    originCardId: string;
    originDeckId?: string;
    prompt?: string;
    reason?: string;
  }>;
  failedCards?: Array<{
    cardId: string;
    message?: string;
  }>;
  tasks?: Array<{
    id: string;
    kind?: string;
    label?: string;
    status: string;
    message?: string;
    finishedAt?: string;
  }>;
}

export interface WrongBookEntry {
  deckId: string;
  deckTitle?: string;
  cardId: string;
  topic?: string;
  kind?: string;
  prompt?: string;
  wrongCount?: number;
  lastGrade?: number;
}

export interface CourseEvidencePoint {
  hid: string;
  nodeId?: string | null;
  key?: string | null;
  title: string;
  overall: 'unstarted' | 'shaky' | 'in_progress' | 'solid' | string;
  retention?: string;
  comprehension?: string;
  transfer?: string;
  cardsTotal?: number;
  cardsSolid?: number;
  gapHint?: string;
  cardRefs?: Array<{ deckId: string; cardId: string }>;
}

export interface CourseEvidenceSummaryResult {
  status: string;
  course: string | null;
  basis?: string;
  examDate?: string | null;
  daysLeft?: number | null;
  examNear?: boolean;
  points: CourseEvidencePoint[];
  summary: {
    total: number;
    unstarted: number;
    shaky: number;
    in_progress: number;
    solid: number;
  };
}

export interface CompiledRequestResult {
  coachSpecVersion?: number;
  totalCount: number;
  kindCounts: Record<string, number>;
  zeroQuotaFamilies?: Array<{ id: string; title: string }>;
  deferredFamilies?: Array<{ id: string; title: string }>;
  uncalibratedFamilies?: Array<{ id: string; title: string }>;
  request: Record<string, unknown> & { sourceIds?: string[] };
}

export interface MockComposeResult {
  complete: boolean;
  totalMarks: number;
  targetMarks: number;
  shortfalls?: Array<{
    sectionId: string;
    title: string;
    requested: number;
    fulfilled: number;
    reason: string;
  }>;
}

export function formatKindLabel(fmt: string | undefined, lang: UiLanguage): string {
  const map: Record<string, [string, string]> = {
    quiz: ['单选', 'MCQ'],
    multi: ['多选', 'Multi'],
    truefalse: ['判断', 'T/F'],
    cloze: ['填空', 'Cloze'],
    open: ['简答/推导', 'Open'],
    task: ['实操任务', 'Task'],
    case: ['案例大题', 'Case'],
  };
  const pair = map[String(fmt || 'quiz')];
  if (!pair) return String(fmt || 'quiz');
  return lang === 'en' ? pair[1] : pair[0];
}

export function priorityLabel(priority: string | undefined, lang: UiLanguage): string {
  if (priority === 'high') return lang === 'en' ? 'High' : '重点';
  if (priority === 'deferred') return lang === 'en' ? 'Deferred' : '延后';
  return lang === 'en' ? 'Medium' : '常规';
}

export function overallTone(overall: string): 'success' | 'warning' | 'error' | 'muted' {
  if (overall === 'solid') return 'success';
  if (overall === 'in_progress') return 'warning';
  if (overall === 'shaky') return 'error';
  return 'muted';
}

export function overallLabel(overall: string, lang: UiLanguage): string {
  const map: Record<string, [string, string]> = {
    solid: ['稳固', 'Solid'],
    in_progress: ['巩固中', 'Progress'],
    shaky: ['薄弱', 'Shaky'],
    unstarted: ['未开始', 'New'],
  };
  const pair = map[overall];
  if (!pair) return overall;
  return lang === 'en' ? pair[1] : pair[0];
}
