import { selectBoardQueueMetrics } from './selectors/board-metrics.js';
import { singleLine, todayLocalYmd } from './selectors/primitives.js';
import {
  buildDoctorReport,
  buildStatsSummary,
  formatDoctorReport,
  formatStatsSummary,
  shouldAutoAscii,
  toPureAscii,
  type ParsedCliArgs,
} from './cli-args.js';
import {
  countsInScope,
  getProgressMap,
  selectCourseScope,
  selectDeckMetrics,
  type StudySnapshotLike,
} from './selectors/study-metrics.js';

export interface ExportReceipt {
  ok: true;
  path: string;
  bytes: number;
  decks: number;
  cards: number;
  libraryRoot: string;
  generatedAt: string;
}

export interface SearchCardHit {
  deckId: string;
  cardId: string;
  prompt: string;
  topic: string;
  deckTitle: string;
  course: string;
}

export interface SearchPassageHit {
  sourceId: string;
  title: string;
  course: string;
  page: number | null;
  snippet: string;
}

export interface SearchCliReport {
  version: string;
  libraryRoot: string;
  query: string;
  limit: number;
  generatedAt: string;
  totals: {
    cards: number;
    passages: number;
  };
  cards: SearchCardHit[];
  passages: SearchPassageHit[];
}

interface BackendCardSearchHit {
  deckId?: string;
  deckTitle?: string;
  course?: string;
  cardId?: string;
  topic?: string;
  prompt?: string;
}

interface BackendCardSearchResponse {
  results?: BackendCardSearchHit[];
}

interface BackendContentSearchHit {
  kind?: string;
  sourceId?: string;
  title?: string;
  course?: string;
  page?: number | null;
  snippet?: string;
}

interface BackendContentSearchResponse {
  results?: BackendContentSearchHit[];
  groups?: {
    sources?: BackendContentSearchHit[];
  };
}

/**
 * Run `--doctor` diagnostics without loading React, Ink, or StudyRuntime.
 */
export async function runDoctorFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const [{ accessSync, constants, existsSync, statSync }, { homedir }, { delimiter, dirname, isAbsolute, join, resolve: resolvePath }, { fileURLToPath }] =
    await Promise.all([import('node:fs'), import('node:os'), import('node:path'), import('node:url')]);

  const home = homedir();
  const dshOverride = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : '';
  const dshHome = dshOverride
    ? isAbsolute(dshOverride)
      ? resolvePath(dshOverride)
      : resolvePath(home, dshOverride)
    : join(home, '.dsh');
  const tuiPrefsPath = join(dshHome, 'study', 'tui.json');
  const tuiPrefsExists = existsSync(tuiPrefsPath);

  const marker = join('application', 'desktop-host.js');
  let desktopRoot: string | null = null;
  const desktopOverride =
    typeof process.env.STUDYHUB_DESKTOP_ROOT === 'string' ? process.env.STUDYHUB_DESKTOP_ROOT.trim() : '';
  if (desktopOverride && existsSync(join(desktopOverride, marker))) {
    desktopRoot = resolvePath(desktopOverride);
  } else {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
      for (const candidate of [join(dir, 'studyhub-desktop'), join(dir, 'packages', 'studyhub-desktop')]) {
        if (existsSync(join(candidate, marker))) {
          desktopRoot = candidate;
          break;
        }
      }
      if (desktopRoot) break;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  let agyPath: string | null = null;
  const rawPath = process.env.PATH ?? process.env.Path ?? '';
  if (rawPath) {
    const names = process.platform === 'win32' ? ['agy.cmd', 'agy.exe', 'agy.bat', 'agy'] : ['agy'];
    for (const entry of rawPath.split(delimiter)) {
      const dir = entry.trim().replace(/^"|"$/g, '');
      if (!dir) continue;
      for (const name of names) {
        const full = join(dir, name);
        try {
          if (!statSync(full).isFile()) continue;
          if (process.platform !== 'win32') accessSync(full, constants.X_OK);
          agyPath = full;
          break;
        } catch {
          // Not found or not executable
        }
      }
      if (agyPath) break;
    }
  }

  const report = buildDoctorReport({
    env: process.env,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
    isTty: Boolean(process.stdout?.isTTY),
    stdoutCols: typeof process.stdout?.columns === 'number' ? process.stdout.columns : null,
    stdoutRows: typeof process.stdout?.rows === 'number' ? process.stdout.rows : null,
    version,
    args: parsed,
    dshHome,
    tuiPrefsPath,
    tuiPrefsExists,
    desktopRoot,
    agyPath,
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDoctorReport(report, report.terminal.asciiMode)}\n`);
  }
}

/**
 * Run `--stats` offline library summary without loading React or Ink.
 */
export async function runStatsFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const { createTuiHost } = await import('./host/tui-host.js');
  const host = await createTuiHost({
    libraryRoot: parsed.libraryRoot,
    skipAutoProbe: true,
    language: parsed.language,
  });
  try {
    const refresh = await host.refreshSnapshot();
    const libraryRoot =
      refresh.binding?.root || refresh.snapshot?.root || host.getLibraryRoot() || parsed.libraryRoot || '';
    const summary = buildStatsSummary({
      libraryRoot,
      snapshot: refresh.snapshot,
      version,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    } else {
      const ascii = parsed.asciiMode ?? shouldAutoAscii(process.env);
      process.stdout.write(`${formatStatsSummary(summary, ascii)}\n`);
    }
  } finally {
    await host.dispose().catch(() => {});
  }
}

/**
 * Run `--export` 1-shot atomic JSON library backup without loading React, Ink, or any LLM provider.
 */
export async function runExportFastPath(args: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const { atomicWriteExportJson, resolveSafeBackupExportPath } = await import('./host/atomic-write.js');

  // Fail fast on unsafe user-supplied export paths before booting the full desktop host.
  if (args.libraryRoot && args.exportPath) {
    resolveSafeBackupExportPath(args.libraryRoot, args.exportPath, 'studyhub-backup', '.json');
  }

  const { createTuiHost } = await import('./host/tui-host.js');

  const host = await createTuiHost({
    libraryRoot: args.libraryRoot,
    skipAutoProbe: true,
    language: args.language,
  });

  try {
    const libraryRoot = host.getLibraryRoot() || args.libraryRoot || '';
    const safeTargetPath = resolveSafeBackupExportPath(
      libraryRoot || process.cwd(),
      args.exportPath,
      'studyhub-backup',
      '.json',
    );

    const res = await host.call<Record<string, unknown>>('export', {});
    if (!res.ok || !res.value) {
      throw new Error(res.error?.message || 'Failed to export library backup');
    }

    const written = await atomicWriteExportJson(safeTargetPath, res.value);

    const decksList = Array.isArray(res.value.decks) ? (res.value.decks as Array<{ cards?: unknown[] }>) : [];
    const decks = decksList.length;
    const cards = decksList.reduce(
      (sum, deck) => sum + (Array.isArray(deck?.cards) ? deck.cards.length : 0),
      0,
    );
    const generatedAt = new Date().toISOString();

    const receipt: ExportReceipt = {
      ok: true,
      path: written.path,
      bytes: written.bytes,
      decks,
      cards,
      libraryRoot,
      generatedAt,
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    } else {
      const ascii = args.asciiMode ?? shouldAutoAscii(process.env);
      const rule = ascii ? '----------------------------------------' : '────────────────────────────────────────';
      const bullet = ascii ? '-' : '•';
      const okMark = ascii ? '[ok]' : '✓';
      const lines = [
        `StudyHub TUI Export (v${version})`,
        rule,
        `Status: ${okMark} Exported library backup`,
        `  ${bullet} Path: ${receipt.path}`,
        `  ${bullet} Library: ${receipt.libraryRoot || '(unset)'}`,
        `  ${bullet} Size: ${receipt.bytes} bytes`,
        `  ${bullet} Contents: ${receipt.decks} decks, ${receipt.cards} cards`,
        `  ${bullet} Generated: ${receipt.generatedAt}`,
      ];
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  } finally {
    await host.dispose().catch(() => {});
  }
}

function strVal(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function clipText(value: unknown, max: number, ascii: boolean): string {
  const base = singleLine(value);
  const text = ascii ? toPureAscii(base) : base;
  if (!text) return '';
  if (text.length <= max) return text;
  const ell = ascii ? '...' : '…';
  return `${text.slice(0, Math.max(1, max - ell.length)).trimEnd()}${ell}`;
}

/**
 * Format a `SearchCliReport` for terminal output. Guaranteed 100% pure ASCII when `ascii` is true.
 */
export function formatSearchReport(report: SearchCliReport, ascii = false): string {
  const rule = ascii ? '----------------------------------------' : '────────────────────────────────────────';
  const bullet = ascii ? '-' : '•';
  const sep = ascii ? ' | ' : ' · ';
  const clean = (s: string) => (ascii ? toPureAscii(singleLine(s)) : singleLine(s));

  const lines = [
    `StudyHub TUI Search (v${clean(report.version)})`,
    rule,
    `Query: "${clean(report.query)}" (limit ${report.limit})`,
    `Library: ${clean(report.libraryRoot || '(unset)')}`,
    `Matches: ${report.totals.cards} cards, ${report.totals.passages} passages`,
    `Cards (${report.cards.length})`,
  ];

  if (report.cards.length === 0) {
    lines.push(`  ${bullet} (none)`);
  } else {
    for (const card of report.cards) {
      const promptText = clipText(card.prompt, 120, ascii) || clipText(card.topic, 120, ascii) || clean(card.cardId);
      const meta = [
        clipText(card.topic, 40, ascii),
        clipText(card.deckTitle, 40, ascii),
        clipText(card.course, 32, ascii),
      ]
        .filter(Boolean)
        .join(sep);
      lines.push(`  ${bullet} ${promptText}${meta ? ` [${meta}]` : ''}`);
    }
  }

  lines.push(`Passages (${report.passages.length})`);
  if (report.passages.length === 0) {
    lines.push(`  ${bullet} (none)`);
  } else {
    for (const passage of report.passages) {
      const titleText = clipText(passage.title, 80, ascii) || clean(passage.sourceId);
      const pageTag =
        typeof passage.page === 'number' && Number.isFinite(passage.page) && passage.page >= 1
          ? ` (p.${Math.trunc(passage.page)})`
          : '';
      const courseTag = clipText(passage.course, 32, ascii);
      const snippetText = clipText(passage.snippet, 120, ascii);
      const header = `${titleText}${pageTag}${courseTag ? ` [${courseTag}]` : ''}`;
      lines.push(`  ${bullet} ${header}${snippetText ? `: ${snippetText}` : ''}`);
    }
  }

  return lines.join('\n');
}

/**
 * Run `--search <query>` offline full-text search across cards & source passages without loading React, Ink, or any LLM provider.
 */
export async function runSearchFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const query = (parsed.searchQuery ?? '').trim();
  const rawLimit = parsed.searchLimit ?? 10;
  const limit = Math.max(1, Math.min(100, Math.trunc(rawLimit)));

  const { createTuiHost } = await import('./host/tui-host.js');
  const host = await createTuiHost({
    libraryRoot: parsed.libraryRoot,
    skipAutoProbe: true,
    language: parsed.language,
  });

  try {
    const contentLimit = Math.min(100, Math.max(limit * 4, 24));
    const [cardRes, contentRes] = await Promise.all([
      host.call<BackendCardSearchResponse>('card.search', { query, limit }).catch(() => null),
      host
        .call<BackendContentSearchResponse>('search.content', { query, limit: contentLimit, includeSample: true })
        .catch(() => null),
    ]);

    const cardHits = cardRes?.ok && Array.isArray(cardRes.value?.results) ? cardRes.value.results : [];
    const rawContentHits =
      contentRes?.ok && Array.isArray(contentRes.value?.groups?.sources)
        ? contentRes.value.groups.sources
        : contentRes?.ok && Array.isArray(contentRes.value?.results)
          ? contentRes.value.results.filter((item) => item?.kind === 'source')
          : [];

    const cards: SearchCardHit[] = [];
    for (const hit of cardHits) {
      if (cards.length >= limit) break;
      const deckId = strVal(hit?.deckId);
      const cardId = strVal(hit?.cardId);
      if (!deckId || !cardId) continue;
      cards.push({
        deckId,
        cardId,
        prompt: singleLine(hit?.prompt),
        topic: singleLine(hit?.topic),
        deckTitle: singleLine(hit?.deckTitle),
        course: singleLine(hit?.course),
      });
    }

    const passages: SearchPassageHit[] = [];
    for (const hit of rawContentHits) {
      if (passages.length >= limit) break;
      const sourceId = strVal(hit?.sourceId);
      if (!sourceId) continue;
      const page =
        typeof hit?.page === 'number' && Number.isFinite(hit.page) && hit.page >= 1
          ? Math.trunc(hit.page)
          : null;
      passages.push({
        sourceId,
        title: singleLine(hit?.title) || sourceId,
        course: singleLine(hit?.course),
        page,
        snippet: singleLine(hit?.snippet),
      });
    }

    const report: SearchCliReport = {
      version,
      libraryRoot: host.getLibraryRoot() || parsed.libraryRoot || '',
      query,
      limit,
      generatedAt: new Date().toISOString(),
      totals: {
        cards: cards.length,
        passages: passages.length,
      },
      cards,
      passages,
    };

    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const ascii = parsed.asciiMode ?? shouldAutoAscii(process.env);
      process.stdout.write(`${formatSearchReport(report, ascii)}\n`);
    }
  } finally {
    await host.dispose().catch(() => {});
  }
}

export interface DueDeckEntry {
  id: string;
  title: string;
  course: string;
  due: number;
  weak: number;
  newCount: number;
  total: number;
  mastery: number;
}

export interface DueCliReport {
  version: string;
  libraryRoot: string;
  courseFilter: string | null;
  limit: number;
  generatedAt: string;
  totals: {
    decks: number;
    decksWithDue: number;
    due: number;
    weak: number;
    newCards: number;
    totalCards: number;
  };
  decks: DueDeckEntry[];
}

interface SnapshotDeckLike {
  id?: string;
  title?: string;
  name?: string;
  course?: string;
  archived?: boolean;
  systemKind?: string;
  count?: number;
  cardCount?: number;
  due?: number;
  dueCount?: number;
  wrong?: number;
  wrongCount?: number;
  newCount?: number;
  mastery?: number;
}

/**
 * Build a deterministic offline due-queue report from a StudySnapshot.
 */
export function buildDueReport(opts: {
  libraryRoot: string;
  snapshot: { decks?: SnapshotDeckLike[]; progress?: Record<string, unknown>; courses?: StudySnapshotLike['courses'] } | null | undefined;
  courseFilter?: string;
  limit?: number;
  version?: string;
  generatedAt?: string;
}): DueCliReport {
  const snap = opts.snapshot ?? {};
  const rawDecks = Array.isArray(snap.decks) ? snap.decks : [];
  const progress = getProgressMap(snap);
  const courseFilterRaw = (opts.courseFilter ?? '').trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit ?? 20)));
  const scope = selectCourseScope(snap, courseFilterRaw || null, { fuzzy: true });

  const matched: DueDeckEntry[] = [];
  let totalDue = 0;
  let totalWeak = 0;
  let totalNew = 0;
  let totalCards = 0;
  let decksWithDue = 0;

  for (const deck of rawDecks) {
    if (!countsInScope(deck, scope)) continue;
    const id = strVal(deck.id);
    if (!id) continue;
    const course = singleLine(deck.course);

    const m = selectDeckMetrics(deck, progress);
    const total = m.total;
    const due = m.due;
    const weak = m.weak;
    const newCount = m.newCount;
    const mastery = m.mastery;

    totalDue += due;
    totalWeak += weak;
    totalNew += newCount;
    totalCards += total;
    if (due > 0) decksWithDue += 1;

    matched.push({
      id,
      title: singleLine(deck.title ?? deck.name) || id,
      course,
      due,
      weak,
      newCount,
      total,
      mastery,
    });
  }

  matched.sort((a, b) => b.due - a.due || b.weak - a.weak || b.total - a.total || a.title.localeCompare(b.title));

  return {
    version: opts.version ?? '1.0.0',
    libraryRoot: opts.libraryRoot,
    courseFilter: courseFilterRaw || null,
    limit,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    totals: {
      decks: matched.length,
      decksWithDue,
      due: totalDue,
      weak: totalWeak,
      newCards: totalNew,
      totalCards,
    },
    decks: matched.slice(0, limit),
  };
}

/**
 * Format a `DueCliReport` for terminal output. Guaranteed 100% pure ASCII when `ascii` is true.
 */
export function formatDueReport(report: DueCliReport, ascii = false): string {
  const rule = ascii ? '----------------------------------------' : '────────────────────────────────────────';
  const bullet = ascii ? '-' : '•';
  const sep = ascii ? ' | ' : ' · ';
  const clean = (s: string) => (ascii ? toPureAscii(singleLine(s)) : singleLine(s));
  const t = report.totals;

  const lines = [
    `StudyHub TUI Due Queue (v${clean(report.version)})`,
    rule,
    `Library: ${clean(report.libraryRoot || '(unset)')}`,
    ...(report.courseFilter ? [`Course: ${clean(report.courseFilter)}`] : []),
    `Queue: ${t.due} due | ${t.weak} weak | ${t.newCards} new (${t.decksWithDue}/${t.decks} decks with due, ${t.totalCards} cards)`,
    `Decks (${report.decks.length}/${t.decks})`,
  ];

  if (report.decks.length === 0) {
    lines.push(`  ${bullet} (none)`);
  } else {
    for (const d of report.decks) {
      const titleText = clipText(d.title, 60, ascii);
      const courseTag = d.course ? ` [${clipText(d.course, 32, ascii)}]` : '';
      const metrics = `${d.due} due${sep}${d.weak} weak${sep}${d.total} cards${sep}${d.mastery}% mastery`;
      lines.push(`  ${bullet} ${titleText}${courseTag}: ${metrics}`);
    }
  }

  return lines.join('\n');
}

/**
 * Run `--due` offline review queue summary without loading React, Ink, or any LLM provider.
 */
export async function runDueFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const { createTuiHost } = await import('./host/tui-host.js');
  const host = await createTuiHost({
    libraryRoot: parsed.libraryRoot,
    skipAutoProbe: true,
    language: parsed.language,
  });

  try {
    const snap = await host.refreshSnapshot();
    const report = buildDueReport({
      libraryRoot: host.getLibraryRoot() || parsed.libraryRoot || '',
      snapshot: snap.snapshot,
      courseFilter: parsed.course,
      limit: parsed.searchLimit ?? 20,
      version,
    });
    if (parsed.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      const ascii = parsed.asciiMode ?? shouldAutoAscii(process.env);
      process.stdout.write(`${formatDueReport(report, ascii)}\n`);
    }
  } finally {
    await host.dispose().catch(() => {});
  }
}

export interface BoardCliCard {
  id: string;
  title: string;
  column: 'todo' | 'doing' | 'done';
  course: string;
  dueDate: string;
  status: 'none' | 'done' | 'overdue' | 'today' | 'upcoming';
}

export interface BoardCliReport {
  version: string;
  libraryRoot: string;
  boardPath: string;
  existed: boolean;
  courseFilter: string | null;
  generatedAt: string;
  counts: {
    total: number;
    todo: number;
    doing: number;
    done: number;
    overdue: number;
    dueToday: number;
  };
  focusStats: {
    date: string;
    completedPomodoros: number;
    focusedMinutes: number;
  } | null;
  cards: BoardCliCard[];
}

/**
 * Build a deterministic offline Kanban board summary from a parsed `BoardDocument`.
 */
export function buildBoardCliReport(opts: {
  libraryRoot: string;
  boardPath: string;
  existed: boolean;
  doc: {
    cards?: ReadonlyArray<{ id: string; title: string; column: 'todo' | 'doing' | 'done'; course?: string; dueDate?: string }>;
    focusStats?: { date: string; completedPomodoros: number; focusedMinutes: number };
  };
  todayYmd?: string;
  courseFilter?: string;
  version?: string;
  generatedAt?: string;
}): BoardCliReport {
  const today = opts.todayYmd ?? todayLocalYmd();
  const courseFilterRaw = (opts.courseFilter ?? '').trim();
  const queue = selectBoardQueueMetrics(opts.doc.cards ?? [], {
    todayYmd: today,
    courseFilter: courseFilterRaw || undefined,
  });

  const cards: BoardCliCard[] = queue.classified.map(({ card, status }) => ({
    id: card.id,
    title: singleLine(card.title) || card.id,
    column: card.column,
    course: singleLine(card.course),
    dueDate: singleLine(card.dueDate),
    status,
  }));

  return {
    version: opts.version ?? '1.0.0',
    libraryRoot: opts.libraryRoot,
    boardPath: opts.boardPath,
    existed: opts.existed,
    courseFilter: courseFilterRaw || null,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    counts: {
      total: queue.total,
      todo: queue.todo,
      doing: queue.doing,
      done: queue.done,
      overdue: queue.overdue,
      dueToday: queue.dueToday,
    },
    focusStats: opts.doc.focusStats ? { ...opts.doc.focusStats } : null,
    cards,
  };
}

/**
 * Format a `BoardCliReport` for terminal output. Guaranteed 100% pure ASCII when `ascii` is true.
 */
export function formatBoardCliReport(report: BoardCliReport, ascii = false): string {
  const rule = ascii ? '----------------------------------------' : '────────────────────────────────────────';
  const bullet = ascii ? '-' : '•';
  const clean = (s: string) => (ascii ? toPureAscii(singleLine(s)) : singleLine(s));
  const c = report.counts;

  const lines = [
    `StudyHub TUI Board (v${clean(report.version)})`,
    rule,
    `Library: ${clean(report.libraryRoot || '(unset)')}`,
    ...(report.courseFilter ? [`Course: ${clean(report.courseFilter)}`] : []),
    `Summary: ${c.total} tasks (${c.doing} doing | ${c.todo} todo | ${c.done} done | ${c.overdue} overdue | ${c.dueToday} due today)`,
  ];

  if (report.focusStats) {
    lines.push(
      `Focus (${clean(report.focusStats.date)}): ${report.focusStats.completedPomodoros} pomodoros (${report.focusStats.focusedMinutes} min)`,
    );
  }

  const sections: ReadonlyArray<{ col: 'doing' | 'todo' | 'done'; heading: string; mark: string }> = [
    { col: 'doing', heading: 'Doing', mark: '[~]' },
    { col: 'todo', heading: 'Todo', mark: '[ ]' },
    { col: 'done', heading: 'Done', mark: '[x]' },
  ];

  for (const sec of sections) {
    const colCards = report.cards.filter((card) => card.column === sec.col);
    lines.push(`${sec.heading} (${colCards.length})`);
    if (colCards.length === 0) {
      lines.push(`  ${bullet} (none)`);
    } else {
      for (const card of colCards) {
        const courseTag = card.course ? ` [${clipText(card.course, 28, ascii)}]` : '';
        const dueTag =
          card.status === 'overdue'
            ? ` (OVERDUE ${clean(card.dueDate)})`
            : card.status === 'today'
              ? ` (TODAY ${clean(card.dueDate)})`
              : card.dueDate
                ? ` (${clean(card.dueDate)})`
                : '';
        lines.push(`  ${bullet} ${sec.mark} ${clipText(card.title, 72, ascii)}${courseTag}${dueTag}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Run `--board` offline Kanban summary directly from `<libraryRoot>/tui-board.json` without mounting React/Ink/StudyRuntime.
 */
export async function runBoardFastPath(parsed: ParsedCliArgs, version = '1.0.0'): Promise<void> {
  const [{ resolve: resolvePath }, { boardFilePath, loadBoardSafe }] = await Promise.all([
    import('node:path'),
    import('./views/board/board-store.js'),
  ]);

  let libraryRoot = parsed.libraryRoot ? resolvePath(parsed.libraryRoot) : '';
  if (!libraryRoot) {
    const { createTuiHost } = await import('./host/tui-host.js');
    const host = await createTuiHost({ skipAutoProbe: true, language: parsed.language });
    try {
      libraryRoot = host.getLibraryRoot();
    } finally {
      await host.dispose().catch(() => {});
    }
  }

  const loaded = await loadBoardSafe(libraryRoot);
  if (!loaded.ok) {
    process.stderr.write(`Error: Failed to read board file ${loaded.path}: ${loaded.error}\n`);
    process.exit(1);
  }

  const report = buildBoardCliReport({
    libraryRoot,
    boardPath: boardFilePath(libraryRoot),
    existed: loaded.existed,
    doc: loaded.doc,
    todayYmd: todayLocalYmd(),
    courseFilter: parsed.course,
    version,
  });

  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const ascii = parsed.asciiMode ?? shouldAutoAscii(process.env);
    process.stdout.write(`${formatBoardCliReport(report, ascii)}\n`);
  }
}
