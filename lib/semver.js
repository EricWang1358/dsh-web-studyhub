/* Semantic version precedence (semver 2.0) for the update check: release tags
   may carry a leading "v"; build metadata is ignored; a pre-release sorts below
   its release and its identifiers compare numerically or as ASCII text. */
const NUMBER = '(0|[1-9]\\d*)';
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)';
const VERSION = new RegExp(`^v?${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-(${IDENTIFIER}(?:\\.${IDENTIFIER})*))?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`);

/** { major, minor, patch, prerelease, text } or null when `value` is not a version. */
export function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION.exec(value.trim());
  if (!match) return null;
  const [major, minor, patch] = match.slice(1, 4).map(Number);
  const prerelease = match[4] ? match[4].split('.').map(part => /^\d+$/.test(part) ? Number(part) : part) : [];
  return { major, minor, patch, prerelease, text: `${major}.${minor}.${patch}${match[4] ? `-${match[4]}` : ''}` };
}

function comparePrerelease(a, b) {
  if (!a.length || !b.length) return a.length === b.length ? 0 : a.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i], y = b[i];
    if (x === y) continue;
    if (typeof x === 'number' && typeof y === 'number') return x > y ? 1 : -1;
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

/** -1, 0 or 1; throws when either side is not a version. */
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error(`Not a semantic version: ${!a ? left : right}`);
  for (const part of ['major', 'minor', 'patch']) if (a[part] !== b[part]) return a[part] > b[part] ? 1 : -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

/** True only when both are versions and `candidate` is strictly newer. */
export function isNewerVersion(candidate, current) {
  return !!parseVersion(candidate) && !!parseVersion(current) && compareVersions(candidate, current) > 0;
}
