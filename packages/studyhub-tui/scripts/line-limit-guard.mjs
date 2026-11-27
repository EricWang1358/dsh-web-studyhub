#!/usr/bin/env node
/**
 * P4 (#1354 D12): Source file line-limit guardrail and ratchet baseline scanner for StudyHub TUI.
 *
 * Rules:
 * - Hard ceiling for every `packages/studyhub-tui/src/**\/*.{ts,tsx}` file: `MAX_SOURCE_FILE_LINES` (1000).
 * - Legacy oversized files are frozen in `tests/fixtures/file-line-limit-baseline.json` on a downward-only ratchet:
 *   1. No new file may exceed 1000 lines (and split files removed from the baseline can never rebound above 1000).
 *   2. No baselined oversized file may grow more than `LEGACY_GROWTH_TOLERANCE` lines past its recorded ceiling.
 *   3. Once a baselined file shrinks to <= 1000 lines (or is deleted), it must be removed from the baseline.
 *
 * CLI:
 *   node packages/studyhub-tui/scripts/line-limit-guard.mjs           # check against baseline
 *   node packages/studyhub-tui/scripts/line-limit-guard.mjs --update  # ratchet baseline down only
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The only copy of the limit: the baseline JSON lists legacy files, not the limit itself.
export const MAX_SOURCE_FILE_LINES = 1000;

// Legacy oversized files may sit up to this many lines above their recorded ceiling, so small fixes
// in open PRs that branched before the baseline was recorded do not fail. The ceiling itself never rises
// (`--update` only lowers it), so total creep per file stays bounded by this number.
export const LEGACY_GROWTH_TOLERANCE = 25;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const TUI_PKG_ROOT = path.resolve(__dirname, '..');
export const TUI_SRC_ROOT = path.join(TUI_PKG_ROOT, 'src');
export const LINE_LIMIT_BASELINE_PATH = path.join(
  TUI_PKG_ROOT,
  'tests',
  'fixtures',
  'file-line-limit-baseline.json',
);

/** Count physical lines consistently across LF, CRLF, and legacy CR line endings. */
export function countSourceLines(content) {
  if (!content) return 0;
  const normalized = content.replace(/\r\n|\r/g, '\n');
  const parts = normalized.split('\n');
  return normalized.endsWith('\n') ? parts.length - 1 : parts.length;
}

function walkSourceFiles(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Scan all `.ts` and `.tsx` source files under `srcRoot`, returning `{ [posixRelPath]: lineCount }`. */
export function scanSourceLineCounts(srcRoot = TUI_SRC_ROOT) {
  const files = walkSourceFiles(srcRoot).sort();
  const counts = {};
  for (const full of files) {
    const rel = path.relative(srcRoot, full).replace(/\\/g, '/');
    counts[rel] = countSourceLines(fs.readFileSync(full, 'utf8'));
  }
  return counts;
}

export function loadLineLimitBaseline(baselinePath = LINE_LIMIT_BASELINE_PATH) {
  const raw = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
  const files = raw?.files && typeof raw.files === 'object' && !Array.isArray(raw.files) ? raw.files : {};
  const notes = raw?.notes && typeof raw.notes === 'object' && !Array.isArray(raw.notes) ? raw.notes : {};
  return { files, notes };
}

/**
 * Pure ratchet evaluator:
 * - `newOverLimit`: file > maxLines and not present in `baseline.files`
 * - `grewAboveBaseline`: file in `baseline.files` with `lines > limit + LEGACY_GROWTH_TOLERANCE`
 * - `staleBaselineEntries`: entry in `baseline.files` that is deleted or now <= maxLines
 * - `invalidBaselineEntries`: entry in `baseline.files` whose limit is not an integer > maxLines
 */
export function evaluateLineLimitRatchet({ lineCounts, baseline, maxLines = MAX_SOURCE_FILE_LINES }) {
  const baselineFiles = baseline?.files ?? {};
  const newOverLimit = [];
  const grewAboveBaseline = [];
  const staleBaselineEntries = [];
  const invalidBaselineEntries = [];
  let overLimitCount = 0;

  for (const [relPath, limit] of Object.entries(baselineFiles).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Number.isInteger(limit) || limit <= maxLines) {
      invalidBaselineEntries.push({ file: relPath, limit });
      continue;
    }
    if (!Object.hasOwn(lineCounts, relPath)) {
      staleBaselineEntries.push({ file: relPath, limit, current: null, reason: 'missing' });
    } else if (lineCounts[relPath] <= maxLines) {
      staleBaselineEntries.push({
        file: relPath,
        limit,
        current: lineCounts[relPath],
        reason: 'under-limit',
      });
    }
  }

  for (const [relPath, lines] of Object.entries(lineCounts).sort(([a], [b]) => a.localeCompare(b))) {
    if (lines > maxLines) {
      overLimitCount += 1;
      if (!Object.hasOwn(baselineFiles, relPath)) {
        newOverLimit.push({ file: relPath, lines, maxLines });
      } else if (
        Number.isInteger(baselineFiles[relPath]) &&
        lines > baselineFiles[relPath] + LEGACY_GROWTH_TOLERANCE
      ) {
        grewAboveBaseline.push({ file: relPath, lines, limit: baselineFiles[relPath] });
      }
    }
  }

  const ok =
    newOverLimit.length === 0 &&
    grewAboveBaseline.length === 0 &&
    staleBaselineEntries.length === 0 &&
    invalidBaselineEntries.length === 0;

  return {
    ok,
    maxLines,
    totalFiles: Object.keys(lineCounts).length,
    overLimitCount,
    newOverLimit,
    grewAboveBaseline,
    staleBaselineEntries,
    invalidBaselineEntries,
  };
}

/** Produce a ratcheted-down baseline map (never adds files, raises existing limits, or keeps corrupt limits). */
export function ratchetDownBaseline({ lineCounts, baseline, maxLines = MAX_SOURCE_FILE_LINES }) {
  const nextFiles = {};
  const nextNotes = {};
  const prevFiles = baseline?.files ?? {};
  const prevNotes = baseline?.notes ?? {};

  for (const [relPath, prevLimit] of Object.entries(prevFiles).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Number.isInteger(prevLimit) || prevLimit <= maxLines) continue;
    const current = Object.hasOwn(lineCounts, relPath) ? lineCounts[relPath] : undefined;
    if (typeof current !== 'number' || current <= maxLines) continue;
    nextFiles[relPath] = Math.min(prevLimit, current);
    if (Object.hasOwn(prevNotes, relPath) && prevNotes[relPath] && nextFiles[relPath] === prevLimit) {
      nextNotes[relPath] = prevNotes[relPath];
    }
  }

  return {
    files: nextFiles,
    ...(Object.keys(nextNotes).length > 0 ? { notes: nextNotes } : {}),
  };
}

export function formatLineLimitReport(result) {
  const lines = [];
  if (result.newOverLimit.length > 0) {
    lines.push(`New or rebound files exceeding ${result.maxLines} lines (must be split to <= ${result.maxLines}):`);
    for (const item of result.newOverLimit) {
      lines.push(`  - ${item.file}: ${item.lines} lines (max ${item.maxLines})`);
    }
  }
  if (result.grewAboveBaseline.length > 0) {
    lines.push(`Oversized baseline files that grew more than ${LEGACY_GROWTH_TOLERANCE} lines above their ratchet ceiling:`);
    for (const item of result.grewAboveBaseline) {
      lines.push(`  - ${item.file}: ${item.lines} lines > baseline ${item.limit} + ${LEGACY_GROWTH_TOLERANCE}`);
    }
  }
  if (result.staleBaselineEntries.length > 0) {
    lines.push('Stale baseline entries (file split <= maxLines or removed — delete from baseline to lock in):');
    for (const item of result.staleBaselineEntries) {
      lines.push(
        `  - ${item.file}: baseline ${item.limit}, current ${item.current === null ? 'missing' : `${item.current} lines`}`,
      );
    }
  }
  if (result.invalidBaselineEntries.length > 0) {
    lines.push(`Invalid baseline entries (must be integer > ${result.maxLines}):`);
    for (const item of result.invalidBaselineEntries) {
      lines.push(`  - ${item.file}: ${String(item.limit)}`);
    }
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const update = process.argv.includes('--update');
  const baseline = loadLineLimitBaseline();
  const lineCounts = scanSourceLineCounts();

  if (update) {
    const next = ratchetDownBaseline({ lineCounts, baseline, maxLines: MAX_SOURCE_FILE_LINES });
    fs.writeFileSync(LINE_LIMIT_BASELINE_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    console.log(
      `Ratcheted ${path.relative(TUI_PKG_ROOT, LINE_LIMIT_BASELINE_PATH)} (${Object.keys(next.files).length} oversized files remaining).`,
    );
    const postCheck = evaluateLineLimitRatchet({ lineCounts, baseline: next, maxLines: MAX_SOURCE_FILE_LINES });
    if (!postCheck.ok) {
      console.error(formatLineLimitReport(postCheck));
      process.exit(1);
    }
    process.exit(0);
  }

  const result = evaluateLineLimitRatchet({ lineCounts, baseline, maxLines: MAX_SOURCE_FILE_LINES });
  if (!result.ok) {
    console.error(formatLineLimitReport(result));
    process.exit(1);
  }
  console.log(
    `Line-limit guardrail OK: ${result.totalFiles} files scanned, ${result.overLimitCount} legacy oversized files within ratchet baseline (max ${result.maxLines} lines).`,
  );
}
