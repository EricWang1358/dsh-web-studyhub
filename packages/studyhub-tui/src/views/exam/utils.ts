import type { StudySnapshot, UiLanguage } from '../../types/contracts.js';
import { currentCourse } from '../../shell/index.js';
import { t } from '../../state/store.js';
import type {
  ExamMode,
  ExamReport,
  HistoryItem,
  OralReport,
  ReportItem,
  RunView,
  ScopeChoice,
} from './types.js';

export function formatDurationMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

export function computeRemainingMs(run: RunView | null, now: number): number | null {
  if (!run) return null;
  const limitMs =
    typeof run.paper?.limitMs === 'number' && run.paper.limitMs > 0
      ? run.paper.limitMs
      : typeof run.limitMs === 'number' && run.limitMs > 0
        ? run.limitMs
        : null;
  if (!limitMs) return null;
  const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
  if (!Number.isFinite(started)) return limitMs;
  return Math.max(0, limitMs - (now - started));
}

export function buildScopeChoices(
  snapshot: StudySnapshot | null,
  mode: ExamMode,
  lang: UiLanguage,
): ScopeChoice[] {
  const decks = (snapshot?.decks ?? []).filter((d) => !d.archived);
  const focusCourse = currentCourse(snapshot);
  const inCourse = (d: (typeof decks)[number]) =>
    !focusCourse || d.course === focusCourse || (d as { folder?: string }).folder === focusCourse;

  if (mode === 'case') {
    const caseDecks = decks.filter(
      (d) =>
        inCourse(d) &&
        ((d as { format?: string }).format === 'case-study' ||
          typeof (d as { caseMarks?: number }).caseMarks === 'number'),
    );
    return caseDecks.map((d) => {
      const marks = (d as { caseMarks?: number }).caseMarks;
      return {
        id: `deck:${d.id}`,
        label: String(d.title || d.name || d.id),
        hint: marks
          ? `${marks} ${lang === 'en' ? 'pts' : '分'}`
          : `${d.cardCount ?? 0} ${lang === 'en' ? 'Q' : '题'}`,
        args: { scope: [{ deckId: d.id }] },
      };
    });
  }

  if (mode === 'oral') {
    const scopedDecks = decks.filter((d) => inCourse(d) && (Number(d.cardCount ?? 0) > 0));
    const choices: ScopeChoice[] = [];
    if (scopedDecks.length > 0) {
      choices.push({
        id: focusCourse ? `course:${focusCourse}` : 'all',
        label: focusCourse
          ? (lang === 'en' ? `Course: ${focusCourse}` : `当前课程「${focusCourse}」`)
          : (lang === 'en' ? 'All Active Courses' : '全部激活课程'),
        hint: `${scopedDecks.length} ${lang === 'en' ? 'decks' : '个题组'}`,
        args: focusCourse ? { course: focusCourse } : {},
      });
    }
    for (const d of scopedDecks) {
      choices.push({
        id: `deck:${d.id}`,
        label: String(d.title || d.name || d.id),
        hint: `${d.cardCount ?? 0} ${lang === 'en' ? 'Q' : '题'}`,
        args: { scope: [{ deckId: d.id }] },
      });
    }
    return choices;
  }

  // Written MCQ: decks with examCount > 0 (or fallback cardCount > 0 when examCount absent)
  const writtenDecks = decks.filter((d) => {
    if (!inCourse(d)) return false;
    if ((d as { format?: string }).format === 'case-study') return false;
    const examCount = (d as { examCount?: number }).examCount;
    if (typeof examCount === 'number') return examCount > 0;
    return Number(d.cardCount ?? 0) > 0;
  });

  const choices: ScopeChoice[] = [];
  if (writtenDecks.length > 0) {
    const totalExam = writtenDecks.reduce(
      (sum, d) => sum + Number((d as { examCount?: number }).examCount ?? d.cardCount ?? 0),
      0,
    );
    choices.push({
      id: focusCourse ? `course:${focusCourse}` : 'all',
      label: focusCourse
        ? (lang === 'en' ? `Course: ${focusCourse}` : `当前课程「${focusCourse}」`)
        : (lang === 'en' ? 'All Active Courses' : '全部激活课程'),
      hint: `${totalExam} ${lang === 'en' ? 'MCQ' : '道选择'}`,
      args: { scope: writtenDecks.map((d) => ({ deckId: d.id })) },
    });
  }
  for (const d of writtenDecks) {
    const q = Number((d as { examQuizCount?: number }).examQuizCount ?? 0);
    const m = Number((d as { examMultiCount?: number }).examMultiCount ?? 0);
    const ec = Number((d as { examCount?: number }).examCount ?? d.cardCount ?? 0);
    const hint =
      q || m
        ? (lang === 'en' ? `${q}S / ${m}M` : `单${q} · 多${m}`)
        : `${ec} ${lang === 'en' ? 'Q' : '题'}`;
    choices.push({
      id: `deck:${d.id}`,
      label: String(d.title || d.name || d.id),
      hint,
      args: { scope: [{ deckId: d.id }] },
    });
  }
  return choices;
}

function shortDate(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 10);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${mi}`;
}

export function buildHistoryItems(snapshot: StudySnapshot | null, lang: UiLanguage): HistoryItem[] {
  const items: HistoryItem[] = [];
  for (const raw of snapshot?.exams ?? []) {
    const runId = String(raw.runId ?? '');
    if (!runId) continue;
    const submittedAt = String(raw.submittedAt ?? '');
    const scorePct = Math.round(Number(raw.scorePct ?? 0));
    const examKinds = String(raw.examKinds ?? 'all');
    const decks = Array.isArray(raw.decks) ? raw.decks.map(String).join(', ') : '';
    const kindLabel =
      examKinds === 'case'
        ? (lang === 'en' ? 'Case' : '案例卷')
        : (lang === 'en' ? 'Written' : '选择题卷');
    const total = Number(raw.total ?? 0);
    const correct = Number(raw.correct ?? 0);
    items.push({
      key: `written:${runId}`,
      kind: 'written',
      runId,
      submittedAt,
      title: `[${kindLabel}] ${decks || shortDate(submittedAt)}`,
      detail: `${shortDate(submittedAt)} · ${correct}/${total}`,
      score: `${scorePct}%`,
      tone: scorePct >= 80 ? 'success' : scorePct >= 60 ? 'warning' : 'error',
    });
  }
  for (const raw of snapshot?.oralExams ?? []) {
    const runId = String(raw.runId ?? '');
    if (!runId) continue;
    const submittedAt = String(raw.submittedAt ?? '');
    const role = String(raw.role ?? '').trim();
    const strong = Number(raw.strong ?? 0);
    const total = Number(raw.total ?? 0);
    const assessed = Number(raw.assessed ?? 0);
    items.push({
      key: `oral:${runId}`,
      kind: 'oral',
      runId,
      submittedAt,
      title: `[${lang === 'en' ? 'Oral' : '口试'}] ${role || shortDate(submittedAt)}`,
      detail: `${shortDate(submittedAt)} · ${assessed}/${total} ${lang === 'en' ? 'assessed' : '已评'}`,
      score: assessed ? `${strong}/${total}★` : `${total}Q`,
      tone: assessed === 0 ? 'muted' : strong >= Math.ceil(total / 2) ? 'success' : 'warning',
    });
  }
  items.sort((a, b) => Date.parse(b.submittedAt || '0') - Date.parse(a.submittedAt || '0'));
  return items;
}

export function buildWrongItemMarkdown(item: ReportItem, lang: UiLanguage): string {
  const lines: string[] = [];
  const statusTag = item.skipped
    ? (lang === 'en' ? 'Unanswered' : '未作答')
    : (lang === 'en' ? 'Incorrect' : '答错');
  lines.push(`### [${statusTag}] ${item.topic || (lang === 'en' ? 'General' : '未分类')}`);
  lines.push('');
  if (item.prompt) lines.push(item.prompt);
  lines.push('');

  if (Array.isArray(item.options) && item.options.length > 0) {
    const selectedSet = new Set(item.selected ?? []);
    lines.push(lang === 'en' ? '**Options**' : '**选项对比**');
    lines.push('');
    item.options.forEach((opt, i) => {
      const letter = String.fromCharCode(65 + i);
      const picked = selectedSet.has(opt.id);
      const mark = opt.correct
        ? (picked ? '✓ (已选/正确)' : '✓ (正确答案)')
        : (picked ? '✗ (你的选择)' : '·');
      lines.push(`- **${letter}.** ${opt.text} — \`${mark}\``);
      if (opt.explanation) lines.push(`  > ${opt.explanation}`);
    });
    lines.push('');
  } else if (item.answer) {
    lines.push(lang === 'en' ? '**Reference Answer**' : '**参考答案**');
    lines.push('');
    lines.push(item.answer);
    lines.push('');
  }

  if (item.explanation) {
    lines.push(lang === 'en' ? '**Explanation**' : '**解析**');
    lines.push('');
    lines.push(item.explanation);
    lines.push('');
  }
  if (item.misconception) {
    lines.push(lang === 'en' ? '**Common Misconception**' : '**易混点**');
    lines.push('');
    lines.push(item.misconception);
    lines.push('');
  }
  return lines.join('\n').trim();
}

export function buildOralEntryMarkdown(
  entry: OralReport['entries'][number],
  lang: UiLanguage,
): string {
  const lines: string[] = [];
  const bandLabel = entry.assessment
    ? `${entry.assessment.band.toUpperCase()} (${entry.assessment.grade}/5)`
    : (lang === 'en' ? 'Not Assessed' : '未AI评估');
  lines.push(`### ${entry.topic || (lang === 'en' ? 'Question' : '题目')} · \`${bandLabel}\``);
  lines.push('');
  if (entry.prompt) {
    lines.push(entry.prompt);
    lines.push('');
  }
  lines.push(lang === 'en' ? '**Your Answer**' : '**你的回答**');
  lines.push('');
  lines.push(entry.answer?.trim() || (lang === 'en' ? '*(No answer)*' : '*(未作答)*'));
  lines.push('');
  if (entry.followup) {
    lines.push(lang === 'en' ? '**Interviewer Follow-up**' : '**考官追问**');
    lines.push('');
    lines.push(`> ${entry.followup}`);
    lines.push('');
    lines.push(entry.followupAnswer?.trim() || (lang === 'en' ? '*(No follow-up answer)*' : '*(未补充追问)*'));
    lines.push('');
  }
  if (entry.assessment?.reason) {
    lines.push(lang === 'en' ? '**Assessment**' : '**点评**');
    lines.push('');
    lines.push(entry.assessment.reason);
    lines.push('');
  }
  if (entry.expected) {
    lines.push(lang === 'en' ? '**Reference Points**' : '**参考要点**');
    lines.push('');
    lines.push(entry.expected);
  }
  return lines.join('\n').trim();
}

export function reportTopicBars(report: ExamReport, lang: UiLanguage) {
  return (report.byTopic ?? []).slice(0, 8).map((row) => ({
    label: row.topic || (lang === 'en' ? 'General' : '未分类'),
    value: row.total > 0 ? Math.round((row.correct / row.total) * 100) : 0,
  }));
}

export function copyText(lang: UiLanguage, zh: string, en: string): string {
  return t(lang, zh, en);
}
