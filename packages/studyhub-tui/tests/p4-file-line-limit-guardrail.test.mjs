// P4 (#1354 D12): Source file line-limit guardrail & downward-only ratchet verification.
// Run: node --test tests/p4-file-line-limit-guardrail.test.mjs
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  MAX_SOURCE_FILE_LINES,
  countSourceLines,
  evaluateLineLimitRatchet,
  formatLineLimitReport,
  loadLineLimitBaseline,
  ratchetDownBaseline,
  scanSourceLineCounts,
} from '../scripts/line-limit-guard.mjs';

describe('P4 (#1354 D12): TUI Source File Line-Limit Guardrail & Ratchet', () => {
  test('countSourceLines handles empty text, LF, CRLF, CR, and missing trailing newline consistently', () => {
    assert.equal(countSourceLines(''), 0);
    assert.equal(countSourceLines('one line'), 1);
    assert.equal(countSourceLines('one line\n'), 1);
    assert.equal(countSourceLines('a\nb\nc\n'), 3);
    assert.equal(countSourceLines('a\r\nb\r\nc\r\n'), 3);
    assert.equal(countSourceLines('a\r\nb\r\nc'), 3);
    assert.equal(countSourceLines('a\rb\rc\r'), 3);
  });

  test('evaluateLineLimitRatchet rejects baseline maxLines tampering and ignores Object.prototype keys', () => {
    const tampered = evaluateLineLimitRatchet({
      lineCounts: { 'views/ok/CleanView.tsx': 500 },
      baseline: { maxLines: 5000, files: {} },
      maxLines: 1000,
    });
    assert.equal(tampered.ok, false);
    assert.deepEqual(tampered.invalidBaselineMaxLines, { expected: 1000, actual: 5000 });
    assert.ok(formatLineLimitReport(tampered).includes('5000'));

    const protoCheck = evaluateLineLimitRatchet({
      lineCounts: { toString: 1001 },
      baseline: { maxLines: 1000, files: {} },
      maxLines: 1000,
    });
    assert.equal(protoCheck.ok, false);
    assert.deepEqual(protoCheck.newOverLimit, [{ file: 'toString', lines: 1001, maxLines: 1000 }]);
  });

  test('evaluateLineLimitRatchet rejects new >1000-line files, baseline growth, stale entries, and invalid limits', () => {
    const baseline = {
      maxLines: 1000,
      files: {
        'views/legacy/HugeView.tsx': 1400,
        'views/legacy/AlreadySplit.tsx': 1200,
        'views/legacy/DeletedView.tsx': 1100,
        'views/legacy/InvalidEntry.tsx': 900,
      },
    };
    const lineCounts = {
      'views/review/ReviewView.tsx': 1001, // rebound / new over-limit file
      'views/legacy/HugeView.tsx': 1401, // grew above baseline
      'views/legacy/AlreadySplit.tsx': 850, // shrunk <= 1000, must be removed from baseline
      'views/legacy/InvalidEntry.tsx': 850,
      'views/ok/CleanView.tsx': 1000, // boundary: exactly 1000 is allowed
    };

    const res = evaluateLineLimitRatchet({ lineCounts, baseline, maxLines: 1000 });
    assert.equal(res.ok, false);
    assert.deepEqual(res.newOverLimit, [{ file: 'views/review/ReviewView.tsx', lines: 1001, maxLines: 1000 }]);
    assert.deepEqual(res.grewAboveBaseline, [{ file: 'views/legacy/HugeView.tsx', lines: 1401, limit: 1400 }]);
    assert.deepEqual(res.staleBaselineEntries, [
      { file: 'views/legacy/AlreadySplit.tsx', limit: 1200, current: 850, reason: 'under-limit' },
      { file: 'views/legacy/DeletedView.tsx', limit: 1100, current: null, reason: 'missing' },
    ]);
    assert.deepEqual(res.invalidBaselineEntries, [{ file: 'views/legacy/InvalidEntry.tsx', limit: 900 }]);

    const report = formatLineLimitReport(res);
    assert.ok(report.includes('views/review/ReviewView.tsx'));
    assert.ok(report.includes('views/legacy/HugeView.tsx'));
    assert.ok(report.includes('views/legacy/AlreadySplit.tsx'));
    assert.ok(report.includes('views/legacy/DeletedView.tsx'));
  });

  test('ratchetDownBaseline lowers caps and drops split/removed files without ever raising limits or adding new files', () => {
    const baseline = {
      maxLines: 1000,
      files: {
        'views/a/Shrunk.tsx': 1500,
        'views/a/SplitNow.tsx': 1300,
        'views/a/GrewAttempt.tsx': 1200,
        'views/a/Deleted.tsx': 1100,
        'views/a/CorruptString.tsx': '1300',
        'views/a/UnderLimitInvalid.tsx': 900,
      },
      notes: {
        'views/a/GrewAttempt.tsx': 'keep note when limit unchanged',
        'views/a/Shrunk.tsx': 'drop note once limit shrinks',
      },
    };
    const lineCounts = {
      'views/a/Shrunk.tsx': 1250,
      'views/a/SplitNow.tsx': 920,
      'views/a/GrewAttempt.tsx': 1220,
      'views/a/BrandNewHuge.tsx': 1400,
      'views/a/CorruptString.tsx': 1300,
      'views/a/UnderLimitInvalid.tsx': 1200,
    };

    const next = ratchetDownBaseline({ lineCounts, baseline, maxLines: 1000 });
    assert.deepEqual(next.files, {
      'views/a/GrewAttempt.tsx': 1200,
      'views/a/Shrunk.tsx': 1250,
    });
    assert.deepEqual(next.notes, {
      'views/a/GrewAttempt.tsx': 'keep note when limit unchanged',
    });
  });

  test('live TUI src/ tree satisfies the 1000-line ceiling and downward ratchet (ReviewView.tsx excluded from baseline)', () => {
    const baseline = loadLineLimitBaseline();
    const lineCounts = scanSourceLineCounts();

    assert.equal(baseline.maxLines, MAX_SOURCE_FILE_LINES);
    assert.equal(
      'views/review/ReviewView.tsx' in baseline.files,
      false,
      'ReviewView.tsx must stay out of the oversized baseline so it can never rebound above 1000 lines',
    );
    assert.ok(
      typeof lineCounts['views/review/ReviewView.tsx'] === 'number' &&
        lineCounts['views/review/ReviewView.tsx'] <= MAX_SOURCE_FILE_LINES,
      `ReviewView.tsx must be <= ${MAX_SOURCE_FILE_LINES} lines (found ${lineCounts['views/review/ReviewView.tsx']})`,
    );

    const result = evaluateLineLimitRatchet({
      lineCounts,
      baseline,
      maxLines: MAX_SOURCE_FILE_LINES,
    });
    assert.equal(result.ok, true, formatLineLimitReport(result));
  });
});
