/* Release-note clamping and language selection (shared by host update-check and browser UpdateDialog, zero Node imports).
   StudyHub's release workflow concatenates the English section ("## <version> — <date>") and the Chinese section
   ("## <version> — <date>"). Clamping keeps both halves within NOTES_LIMIT even on large releases; selection picks the
   section matching the active UI language ('zh' | 'en') and drops a redundant version-only heading line. */

export const NOTES_LIMIT = 12_000;
const MAX_RAW_NOTES_SCAN = 64_000;
const HAN_CHAR = /[\u3400-\u9fff]/g;
const VERSION_HEADING = /^##\s+v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\s+[—–-]\s+\S+)?\s*(?:\n+|$)/;

function splitNoteSections(text) {
  const clean = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!clean) return [];
  const parts = clean.split(/\n(?=##\s+)/);
  if (parts.length > 1 && !parts[0].startsWith('## ')) {
    parts[1] = `${parts[0]}\n${parts[1]}`;
    parts.shift();
  }
  return parts.map(part => part.trim()).filter(Boolean);
}

function isChineseSection(section) {
  const body = section.replace(/^##[^\n]*\n?/, '').replace(/\s+/g, '');
  if (!body) return /[\u3400-\u9fff]/.test(section);
  return ((body.match(HAN_CHAR) || []).length / body.length) >= 0.15;
}

/** Bound stored release notes to `limit` without letting a long English section drop the Chinese half. */
export function clampReleaseNotes(body, limit = NOTES_LIMIT) {
  if (typeof body !== 'string' || !body) return '';
  const scanned = body.slice(0, MAX_RAW_NOTES_SCAN);
  if (scanned.length <= limit) return scanned;
  const sections = splitNoteSections(scanned);
  const zh = sections.filter(isChineseSection), en = sections.filter(item => !isChineseSection(item));
  if (!zh.length || !en.length || limit < 4) return scanned.slice(0, limit);
  const enFull = en.join('\n\n'), zhFull = zh.join('\n\n');
  const half = Math.floor((limit - 2) / 2);
  const enPart = enFull.slice(0, Math.min(enFull.length, Math.max(half, limit - 2 - zhFull.length)));
  const zhPart = zhFull.slice(0, Math.max(0, limit - 2 - enPart.length));
  return `${enPart}\n\n${zhPart}`.slice(0, limit);
}

/** Pick the release-notes section matching the interface language ('zh' | 'en') and drop a redundant version-only heading. */
export function selectReleaseNotes(notes, language = 'zh') {
  const sections = splitNoteSections(notes);
  if (!sections.length) return '';
  const zh = sections.filter(isChineseSection), en = sections.filter(item => !isChineseSection(item));
  const chosen = zh.length && en.length ? (language === 'en' ? en : zh) : sections;
  return chosen.map(item => item.replace(VERSION_HEADING, '').trim()).filter(Boolean).join('\n\n');
}
