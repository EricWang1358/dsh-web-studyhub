// The snapshot's fingerprint is a JSON array of the parts it is built from (lib/contexts/library/operations.js "snapshot").
// When a poll that should be unchanged is not, this names the parts that moved, so a flaky failure in CI says why.
const PARTS = ['stamp', 'root', 'complete', 'coach', 'language', 'experimental', 'minute', 'coachActivity', 'hostState', 'storageIssues', 'jobs', 'coachLedger', 'jobArchive'];

export function fingerprintDiff(before, after) {
  if (typeof before !== 'string' || typeof after !== 'string') return `no fingerprint to compare (before ${typeof before}, after ${typeof after})`;
  let a, b;
  try { a = JSON.parse(before); b = JSON.parse(after); } catch { return 'a fingerprint is not JSON'; }
  const moved = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = JSON.stringify(a[i]), y = JSON.stringify(b[i]);
    if (x !== y) moved.push(`${PARTS[i] || `part ${i}`}: ${x?.slice(0, 200)} -> ${y?.slice(0, 200)}`);
  }
  return moved.length ? `the fingerprint moved in ${moved.join('; ')}` : 'the fingerprint is the same';
}
