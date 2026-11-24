/**
 * Local `file://` allowlist for "open in browser" (#1441), kept in its own module so the rule can be
 * tested without booting the TUI host. A local page is openable only when it is a real `.html`/`.htm`
 * file, resolved through symlinks, strictly inside one of the allowed roots: the study library roots
 * plus the companion folders the learner authorized (#1447 — linked companion pages live outside the library).
 */
import { realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ALLOWED_LOCAL_HTML_EXTS = new Set(['.html', '.htm']);
export const LOCAL_URL_BIDI_RE = /\p{Cf}/u;

/**
 * Validate a `file://` URL against an allowlist of local `.html`/`.htm` files strictly inside
 * one of the allowed roots. Resolves realpaths to block symlink/traversal escapes.
 * Returns canonical `file://` href when allowed, or `null` when refused.
 */
export function resolveAllowedLocalHtmlUrl(value: unknown, allowedRoots: readonly string[]): string | null {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw || raw.length > 2000 || LOCAL_URL_BIDI_RE.test(raw) || /[\x00-\x1f\x7f]/.test(raw)) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'file:') return null;
  if (parsed.hostname && parsed.hostname.toLowerCase() !== 'localhost') return null;

  let filePath: string;
  try {
    filePath = fileURLToPath(parsed);
  } catch {
    return null;
  }
  if (!ALLOWED_LOCAL_HTML_EXTS.has(extname(filePath).toLowerCase())) return null;

  let fileReal: string;
  try {
    fileReal = realpathSync(resolve(filePath));
    if (!statSync(fileReal).isFile()) return null;
  } catch {
    return null;
  }
  if (!ALLOWED_LOCAL_HTML_EXTS.has(extname(fileReal).toLowerCase())) return null;

  for (const root of allowedRoots) {
    if (!root || typeof root !== 'string') continue;
    let rootReal: string;
    try {
      rootReal = realpathSync(resolve(root));
    } catch {
      rootReal = resolve(root);
    }
    const rel = relative(rootReal, fileReal);
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
      return pathToFileURL(fileReal).href;
    }
  }
  return null;
}

/** The roots `app.open` may read from: the library roots plus the learner-authorized companion folders. */
export function allowedOpenRoots(
  libraryRoots: readonly string[],
  companionRoots: readonly string[] = [],
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const root of [...libraryRoots, ...companionRoots]) {
    if (typeof root !== 'string' || !root.trim()) continue;
    const key = resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(root);
  }
  return out;
}
