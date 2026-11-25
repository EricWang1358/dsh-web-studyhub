import { createHash } from 'node:crypto';
import { mkdir, open, readdir, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { looksLikeHtml, titleOf } from '../skeleton-diagrams.js';
import { compileMathInLesson } from '../companion-template/mathml.js';
import { compileLessonHtml, safeJsonForScript } from '../companion-template/render-html.js';
import { LESSON_TEMPLATE_CSS } from '../companion-template/template-styles.js';
import { buildLessonTemplateRuntimeJs } from '../companion-template/template-runtime.js';
import { normalizeLessonSpec } from '../companion-template/validate.js';
import { extractEmbeddedLesson, extractWorkshopLesson, isHandsOnDrillBlock } from './companion-lesson.js';
import { id as makeId } from '../util.js';

/* Interactive Companions storage, security boundary, directory mount scanner (`mode: "linked"`),
   unbuilt `lessons/*.json` source resolver, workspace dual-output writer (ADR-9),
   companion progress sidecar, portable backup (`managed` only),
   and two-way atomic LWW sync with `feedback/questions.json` (ADR-1). */

export const MAX_COMPANION_BYTES = 15 * 1024 * 1024;
export const MAX_SCAN_FILES = 300;
export const COMPANION_FOLDER = 'companions';
export const COMPANION_BACKUP = 'study-companions/v1';

const SAFE_ID = /^[A-Za-z0-9_-]{1,96}$/;
const WINDOWS_RESERVED_STEM = /^(?:con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])$/i;
const isSafeCompanionId = id => SAFE_ID.test(String(id)) && !WINDOWS_RESERVED_STEM.test(String(id));
const VALID_FEEDBACK_TAGS = new Set(['unclear', 'deepen', 'example', 'errata']);
const TAG_LABELS_ZH = { unclear: '没看懂', deepen: '想深挖', example: '补例子', errata: '疑似有误' };
const TAG_LABELS_EN = { unclear: 'Unclear', deepen: 'Deep dive', example: 'Need example', errata: 'Possible error' };
const SOURCE_EXT_LANG = Object.freeze({
  '.java': 'java',
  '.py': 'python',
  '.js': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.ts': 'js',
  '.tsx': 'js',
  '.jsx': 'js',
  '.sql': 'sql',
});
const INDEXABLE_SOURCE_EXTS = new Set([
  '.java', '.py', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.sql',
  '.c', '.cpp', '.h', '.hpp', '.rs', '.go', '.kt', '.scala', '.rb', '.php',
  '.sh', '.yml', '.yaml', '.conf', '.txt', '.md',
]);
const MAX_SOURCE_FILE_BYTES = 256 * 1024;
const MAX_INDEXED_SOURCES = 400;
const feedbackLocks = new Map();

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel));
}

export function stripUtf8Bom(text) {
  return typeof text === 'string' && text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

function stripIllegalNtfsChars(value) {
  let out = '';
  for (const ch of String(value ?? '')) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1F || code === 0x7F || '<>:"/\\|?*'.includes(ch)) out += '-';
    else out += ch;
  }
  return out;
}

/** Sanitize a Windows NTFS path segment (filename or stem): strip control & illegal chars, trim trailing dots/spaces, and guard reserved basenames. */
export function sanitizeWindowsFilename(value, fallback = 'lesson') {
  const cleanOne = input => {
    const cleaned = stripIllegalNtfsChars(String(input ?? '').normalize('NFKC'))
      .replace(/-+/g, '-')
      .replace(/\s+/g, ' ')
      .replace(/^[.\s-]+|[.\s-]+$/g, '')
      .slice(0, 80)
      .replace(/[.\s-]+$/g, '');
    if (!cleaned) return '';
    const dotIdx = cleaned.indexOf('.');
    const stem = dotIdx >= 0 ? cleaned.slice(0, dotIdx).trim() : cleaned;
    if (WINDOWS_RESERVED_STEM.test(stem)) return `lesson-${cleaned}`;
    return cleaned;
  };
  return cleanOne(value) || cleanOne(fallback) || 'lesson';
}

export function sanitizeCompanionId(value, fallback = '') {
  const cleanOne = input => {
    const cleaned = stripIllegalNtfsChars(String(input ?? ''))
      .replace(/[^A-Za-z0-9_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 96)
      .replace(/[-_]+$/g, '');
    if (!cleaned) return '';
    return WINDOWS_RESERVED_STEM.test(cleaned) ? `comp-${cleaned.toLowerCase()}` : cleaned;
  };
  return cleanOne(value) || cleanOne(fallback) || `comp-${makeId()}`;
}

export function slugifyName(value, fallback = 'lesson') {
  const cleanSlug = input => {
    const raw = stripIllegalNtfsChars(String(input ?? '').normalize('NFKC')).trim().toLowerCase();
    const ascii = raw
      .replace(/[^a-z0-9\u4e00-\u9fff_-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[.-]+|[.-]+$/g, '')
      .slice(0, 64)
      .replace(/[.-]+$/g, '');
    if (!ascii) return '';
    return WINDOWS_RESERVED_STEM.test(ascii) ? `lesson-${ascii}` : ascii;
  };
  return cleanSlug(value) || cleanSlug(fallback) || 'lesson';
}

/** Resiliently extract `<script id="lesson-data">` (case-insensitive, BOM-safe, `<\/script>` / `\u003c` safe). */
export function extractResilientLesson(html) {
  if (typeof html !== 'string') return null;
  const clean = stripUtf8Bom(html);
  const direct = extractEmbeddedLesson(clean);
  if (direct) return direct;

  const openRe = /<script\b[^>]*\bid\s*=\s*(?:["']lesson-data["']|lesson-data(?=[>\s/]))[^>]*>/gi;
  let openMatch;
  while ((openMatch = openRe.exec(clean)) !== null) {
    const contentStart = openMatch.index + openMatch[0].length;
    const closeRe = /<\/script\s*>/gi;
    closeRe.lastIndex = contentStart;
    let closeMatch;
    let attempts = 0;
    while ((closeMatch = closeRe.exec(clean)) !== null && attempts < 8) {
      attempts++;
      const rawPayload = stripUtf8Bom(clean.slice(contentStart, closeMatch.index)).trim();
      if (!rawPayload) break;
      const candidates = [rawPayload];
      if (/\\\/script/i.test(rawPayload)) {
        candidates.push(rawPayload.replace(/<\\\/script>/gi, '</script>'));
      }
      for (const candidate of candidates) {
        try {
          const parsed = JSON.parse(candidate);
          if (parsed && typeof parsed === 'object' && Array.isArray(parsed.slides)) return parsed;
        } catch { /* try next closing script boundary */ }
      }
    }
  }
  return null;
}

const rootsFileOf = root => join(root, COMPANION_FOLDER, 'trusted-roots.json');
const managedFileOf = (root, id) => {
  if (!isSafeCompanionId(id)) throw new Error('Invalid companion id');
  return join(root, COMPANION_FOLDER, 'files', `${id}.html`);
};
const stateFileOf = (root, id) => {
  if (!isSafeCompanionId(id)) throw new Error('Invalid companion id');
  return join(root, COMPANION_FOLDER, 'state', `${id}.json`);
};

async function atomicWriteText(target, text) {
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${makeId()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
  return target;
}

/** Read learner-authorized external companion directories (Settings / Panel only). */
export async function readTrustedCompanionRoots(root) {
  try {
    const parsed = JSON.parse(stripUtf8Bom(await readFile(rootsFileOf(root), 'utf8')));
    return Array.isArray(parsed?.roots) ? parsed.roots.filter(p => typeof p === 'string' && p.trim()) : [];
  } catch {
    return [];
  }
}

export async function saveTrustedCompanionRoots(root, roots) {
  const cleaned = [];
  for (const candidate of Array.isArray(roots) ? roots : []) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const real = await realpath(candidate.trim()).catch(() => null);
    if (real && !cleaned.includes(real)) cleaned.push(real);
  }
  await atomicWriteText(rootsFileOf(root), JSON.stringify({ version: 1, roots: cleaned.slice(0, 24) }, null, 2));
  return cleaned.slice(0, 24);
}

async function resolveAllowedFolders({ workspace = '', startFolder = '', root = '' }) {
  const trusted = root ? await readTrustedCompanionRoots(root) : [];
  const allowed = [];
  for (const folder of [workspace, startFolder, root, ...trusted]) {
    if (!folder) continue;
    const real = await realpath(folder).catch(() => null);
    if (real && !allowed.includes(real)) allowed.push(real);
  }
  return allowed;
}

function givenPath(value, base) {
  if (typeof value !== 'string') throw new Error('请提供伴学文件或目录路径');
  const clean = value.trim().replace(/^"(.*)"$/, '$1').replace(/^@/, '').replace(/^"(.*)"$/, '$1').trim();
  if (!clean || clean.length > 4096 || clean.includes('\0')) {
    throw new Error('请提供有效的伴学路径');
  }
  return isAbsolute(clean) ? clean : resolve(base, clean);
}

export async function readCheckedHtmlFile(realFile) {
  const handle = await open(realFile, 'r').catch(() => { throw new Error('找不到这个伴学文件'); });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('路径不是普通文件');
    if (info.size > MAX_COMPANION_BYTES) throw new Error('伴学 HTML 文件超过 15 MB 上限');
    const bytes = await handle.readFile();
    if (bytes.length > MAX_COMPANION_BYTES) throw new Error('伴学 HTML 文件超过 15 MB 上限');
    let text;
    try {
      text = stripUtf8Bom(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw new Error('伴学文件必须是 UTF-8 编码文本');
    }
    if (!looksLikeHtml(text)) throw new Error('文件不是有效的 HTML 文档');
    const cleanBytes = Buffer.from(text, 'utf8');
    const sha256 = createHash('sha256').update(cleanBytes).digest('hex');
    const rawStem = basename(realFile, extname(realFile));
    const safeName = sanitizeWindowsFilename(rawStem, 'lesson');
    const embeddedLesson = extractResilientLesson(text) || extractWorkshopLesson(text, safeName);
    return {
      text,
      bytes: cleanBytes.length,
      sha256,
      file: realFile,
      name: safeName,
      rawStem,
      title: embeddedLesson?.title || titleOf(text) || safeName,
      lesson: embeddedLesson,
    };
  } finally {
    await handle.close();
  }
}

/* ---------- Safe Unbuilt `lessons/*.json` Source Resolution (`projects/` & `src/`) ---------- */

async function buildPackSourceIndex(realDir) {
  const entries = [];
  const subroots = ['projects', 'src'];

  async function walkSubdir(currentDir, subrootReal, depth) {
    if (depth > 8 || entries.length >= MAX_INDEXED_SOURCES) return;
    let dirEntries;
    try {
      dirEntries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of dirEntries) {
      if (entries.length >= MAX_INDEXED_SOURCES) break;
      if (ent.name.startsWith('.') || ent.name === 'node_modules' || ent.name === 'target' || ent.name === 'out' || ent.name === 'dist') continue;
      const candidate = join(currentDir, ent.name);
      const realChild = await realpath(candidate).catch(() => null);
      // Strict containment check: reject any symlink or path escaping `realDir`
      if (!realChild || !inside(realDir, realChild)) continue;
      const info = await stat(realChild).catch(() => null);
      if (!info) continue;
      if (info.isDirectory()) {
        await walkSubdir(realChild, subrootReal, depth + 1);
      } else if (info.isFile() && info.size <= MAX_SOURCE_FILE_BYTES) {
        const ext = extname(ent.name).toLowerCase();
        if (!INDEXABLE_SOURCE_EXTS.has(ext)) continue;
        const relFromRoot = relative(realDir, realChild).replaceAll('\\', '/');
        const relFromSubroot = relative(subrootReal, realChild).replaceAll('\\', '/');
        const noExtSub = relFromSubroot.slice(0, relFromSubroot.length - ext.length);
        entries.push({
          realFile: realChild,
          relFromRoot,
          relFromSubroot,
          noExtSub,
          baseName: ent.name,
          stem: basename(ent.name, ext),
          ext,
        });
      }
    }
  }

  for (const sub of subroots) {
    const subCandidate = join(realDir, sub);
    const realSub = await realpath(subCandidate).catch(() => null);
    if (!realSub || !inside(realDir, realSub)) continue;
    const info = await stat(realSub).catch(() => null);
    if (info?.isDirectory()) await walkSubdir(realSub, realSub, 0);
  }
  return entries;
}

function matchSnippetLines(snippets, srcLines) {
  if (!Array.isArray(snippets) || !srcLines.length) return [];
  const matched = [];
  for (const raw of snippets) {
    const needle = String(raw ?? '').trim();
    if (!needle) continue;
    const hitIdx = srcLines.findIndex(ln => ln.includes(needle));
    if (hitIdx >= 0) matched.push(hitIdx + 1);
  }
  return [...new Set(matched)];
}

async function resolveOfSource(ofRef, rawLesson, realDir, indexEntries, textCache) {
  if (typeof ofRef !== 'string' || !ofRef.trim()) return null;
  const cleanRef = ofRef.trim();
  if (cleanRef.includes('\0') || cleanRef.includes('..')) return null;

  const candidateSuffixes = [];
  const dotIdx = cleanRef.indexOf('.');
  if (dotIdx > 0) {
    const expKey = cleanRef.slice(0, dotIdx);
    const varId = cleanRef.slice(dotIdx + 1);
    const exp = rawLesson?.experiments?.[expKey];
    const variant = Array.isArray(exp?.variants) ? exp.variants.find(v => v?.id === varId) : null;
    if (variant?.class && typeof variant.class === 'string') {
      candidateSuffixes.push(variant.class.trim().replaceAll('.', '/'));
    }
    if (exp?.home && variant?.code) {
      candidateSuffixes.push(`${String(exp.home).trim().replaceAll('.', '/')}/${String(variant.code).trim()}`);
    }
    if (variant?.code) {
      candidateSuffixes.push(String(variant.code).trim());
    }
  }

  if (cleanRef.includes('/') || cleanRef.includes('\\')) {
    candidateSuffixes.push(cleanRef.replaceAll('\\', '/').replace(/^\/+/, ''));
  } else if (cleanRef.includes('.')) {
    const ext = extname(cleanRef).toLowerCase();
    if (INDEXABLE_SOURCE_EXTS.has(ext)) {
      candidateSuffixes.push(cleanRef);
    } else {
      candidateSuffixes.push(cleanRef.replaceAll('.', '/'));
    }
  } else {
    candidateSuffixes.push(cleanRef);
  }

  let matchedEntry = null;
  for (const suffix of candidateSuffixes) {
    const lowerSuffix = suffix.toLowerCase();
    matchedEntry = indexEntries.find(e =>
      e.relFromRoot === suffix
      || e.relFromSubroot === suffix
      || e.noExtSub === suffix
      || e.relFromSubroot.endsWith(`/${suffix}`)
      || e.noExtSub.endsWith(`/${suffix}`))
      || indexEntries.find(e =>
        e.relFromRoot.toLowerCase() === lowerSuffix
        || e.relFromSubroot.toLowerCase() === lowerSuffix
        || e.noExtSub.toLowerCase() === lowerSuffix
        || e.relFromSubroot.toLowerCase().endsWith(`/${lowerSuffix}`)
        || e.noExtSub.toLowerCase().endsWith(`/${lowerSuffix}`));
    if (matchedEntry) break;

    if (!suffix.includes('/')) {
      const baseHits = indexEntries.filter(e => e.baseName === suffix || e.stem === suffix);
      if (baseHits.length === 1) { matchedEntry = baseHits[0]; break; }
      const ciHits = indexEntries.filter(e => e.baseName.toLowerCase() === lowerSuffix || e.stem.toLowerCase() === lowerSuffix);
      if (ciHits.length === 1) { matchedEntry = ciHits[0]; break; }
    }
  }

  if (!matchedEntry) return null;
  if (!inside(realDir, matchedEntry.realFile)) return null;

  let text = textCache.get(matchedEntry.realFile);
  if (text === undefined) {
    try {
      const rawBytes = await readFile(matchedEntry.realFile);
      if (rawBytes.length > MAX_SOURCE_FILE_BYTES) return null;
      text = stripUtf8Bom(new TextDecoder('utf-8', { fatal: true }).decode(rawBytes)).replace(/\r\n/g, '\n');
      textCache.set(matchedEntry.realFile, text);
    } catch {
      return null;
    }
  }

  return {
    source: text,
    path: matchedEntry.relFromRoot,
    lang: SOURCE_EXT_LANG[matchedEntry.ext] || 'text',
  };
}

/**
 * Safely resolve unbuilt authoring `of: "<pkg>.<Class>"` code references inside `<realDir>/projects/`
 * (and `<realDir>/src/`), strictly verified via `realpath` + `inside(realDir, ...)`, and degrade
 * unbuilt benchmark/bytecode blocks gracefully so `syncLessonIntoState` and HTML compilation never crash.
 */
export async function resolveUnbuiltLessonSources(rawLesson, realDir, prebuiltIndex = null) {
  if (!rawLesson || typeof rawLesson !== 'object' || !Array.isArray(rawLesson.slides)) return rawLesson;
  const realRoot = await realpath(realDir).catch(() => null);
  if (!realRoot) return rawLesson;

  const lesson = structuredClone(rawLesson);
  const indexEntries = prebuiltIndex || await buildPackSourceIndex(realRoot);
  const textCache = new Map();

  const resolvedSlides = [];
  for (const slide of lesson.slides) {
    if (!slide || typeof slide !== 'object' || !Array.isArray(slide.blocks)) continue;
    const nextBlocks = [];

    for (const block of slide.blocks) {
      if (!block || typeof block !== 'object') continue;

      if ((block.t === 'code' || block.t === 'spot' || block.t === 'inside') && !block.source && typeof block.of === 'string') {
        const resolved = await resolveOfSource(block.of, lesson, realRoot, indexEntries, textCache);
        if (resolved) {
          block.source = resolved.source;
          block.path ||= resolved.path;
          block.lang ||= resolved.lang;
        }
      }

      if ((block.t === 'code' || block.t === 'spot' || block.t === 'inside') && typeof block.source === 'string' && block.source.trim()) {
        const srcLines = block.source.replace(/\r\n/g, '\n').split('\n');
        if (block.t === 'code') {
          if (!Array.isArray(block.focusLines) && Array.isArray(block.focus)) {
            block.focusLines = matchSnippetLines(block.focus, srcLines);
          }
          if (Array.isArray(block.walk)) {
            for (const step of block.walk) {
              if (step && !Array.isArray(step.focusLines) && Array.isArray(step.focus)) {
                step.focusLines = matchSnippetLines(step.focus, srcLines);
              }
            }
          }
        } else if (block.t === 'spot') {
          if (!Array.isArray(block.answerLines) && Array.isArray(block.answer)) {
            block.answerLines = matchSnippetLines(block.answer, srcLines);
          }
          if (!Array.isArray(block.answerLines) || !block.answerLines.length) {
            block.answerLines = [1];
          }
          block.q ||= String(block.of || 'Spot the flawed line');
          block.hint ||= String(block.found || 'Inspect the highlighted logic.');
          block.found ||= String(block.say || 'Flawed step identified.');
        } else if (block.t === 'inside' && Array.isArray(block.walk)) {
          for (const step of block.walk) {
            if (step && !Array.isArray(step.focusLines) && Array.isArray(step.focus)) {
              step.focusLines = matchSnippetLines(step.focus, srcLines);
            }
          }
        }
      }

      // Gracefully convert unbuilt blocks lacking build outputs so validation/sync never crashes
      if (block.t === 'code' && (!block.source || !String(block.source).trim())) {
        const walkText = (block.walk || []).map(w => w?.say).filter(Boolean).join('\n- ');
        const md = walkText ? `- ${walkText}` : String(block.say || block.of || 'Code walkthrough');
        nextBlocks.push({
          t: 'callout',
          tone: 'info',
          title: String(block.path || block.of || 'Code Reference'),
          md,
          say: block.say || md,
        });
        continue;
      }

      if (block.t === 'spot' && (!block.source || !String(block.source).trim())) {
        const md = [block.q, block.found].filter(Boolean).join('\n\n') || String(block.say || block.of || 'Boundary flaw check');
        nextBlocks.push({
          t: 'callout',
          tone: 'pitfall',
          title: String(block.path || block.of || 'Flaw Check'),
          md,
          say: block.say || block.found || md,
        });
        continue;
      }

      if (block.t === 'inside') {
        const validWalk = Array.isArray(block.walk) && block.walk.length > 0
          && typeof block.source === 'string' && block.source.trim().length > 0
          && block.walk.every(w => w && w.label && w.say && Array.isArray(w.focusLines) && w.focusLines.length > 0);
        if (!validWalk) {
          const items = (block.walk || [])
            .map(w => `${w?.label ? `**${w.label}**: ` : ''}${w?.say || ''}`.trim())
            .filter(Boolean);
          nextBlocks.push(items.length
            ? { t: 'points', items, say: block.say || items[0] }
            : { t: 'text', md: String(block.say || block.caption || block.of || 'Mechanism breakdown'), say: block.say || '' });
          continue;
        }
      }

      if (block.t === 'experiment') {
        const exp = lesson.experiments?.[block.lab];
        if (!exp?.results?.variants) {
          const shown = Array.isArray(exp?.variants)
            ? exp.variants.filter(v => !Array.isArray(block.show) || block.show.includes(v.id))
            : [];
          const items = shown.map(v => `**${v.label || v.id}**${v.note ? ` — ${v.note}` : ''}`).filter(Boolean);
          nextBlocks.push(items.length
            ? { t: 'points', items, say: block.say || items[0], ...(block.key ? { key: block.key } : {}) }
            : { t: 'text', md: String(block.say || block.lab || 'Experiment comparison'), say: block.say || '' });
          continue;
        }
      }

      if (block.t === 'chart') {
        const exp = lesson.experiments?.[block.of];
        if (!exp?.results?.variants) {
          const walkMd = (block.walk || []).map(w => w?.say).filter(Boolean).join('\n- ');
          const md = walkMd ? `- ${walkMd}` : String(block.say || block.y?.label || 'Benchmark trend');
          nextBlocks.push({
            t: 'callout',
            tone: 'info',
            title: String(block.y?.label || block.of || 'Benchmark Chart'),
            md,
            say: block.say || md,
          });
          continue;
        }
      }

      if (block.t === 'workshop' || block.t === 'try') {
        if (isHandsOnDrillBlock(block)) {
          nextBlocks.push({
            ...block,
            t: 'try',
            say: block.say || String(block.prompt || block.goal || block.mission || ''),
          });
        } else {
          nextBlocks.push({
            t: 'text',
            md: String(block.md || block.key || block.say || 'Interactive check'),
            say: block.say || '',
            ...(block.key ? { key: block.key } : {}),
          });
        }
        continue;
      }

      nextBlocks.push(block);
    }

    if (nextBlocks.length > 0) {
      resolvedSlides.push({
        ...slide,
        title: String(slide.title || `Slide ${resolvedSlides.length + 1}`),
        blocks: nextBlocks,
      });
    }
  }

  lesson.slides = resolvedSlides;
  return lesson;
}

function compilePlayableOrFallbackHtml(lesson) {
  try {
    return compileLessonHtml(lesson, { strictPedagogy: false });
  } catch {
    try {
      const normalized = normalizeLessonSpec({
        ...lesson,
        id: lesson?.id || 'unbuilt-lesson',
        title: lesson?.title || lesson?.id || 'Interactive Companion',
      });
      const withMath = compileMathInLesson(normalized);
      const langAttr = withMath.language === 'en' ? 'en' : 'zh-CN';
      const escTitle = String(withMath.title || 'Interactive Companion')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
      const html = `<!doctype html>
<html lang="${langAttr}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escTitle}</title>
<script>try{var t=localStorage.getItem("lesson-theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}</script>
<style>
${LESSON_TEMPLATE_CSS}
</style>
</head>
<body>
<header class="top">
  <div class="top__title" id="title"></div>
  <nav class="beats" id="beats"></nav>
  <div class="top__tools">
    <span class="num" id="count"></span>
    <div class="notes"><button class="tool" id="notes" type="button"></button><ul class="notes__list" id="notes-list" hidden></ul></div>
    <button class="tool" id="theme" type="button"></button>
  </div>
</header>
<main class="stage" id="stage"></main>
<footer class="voice">
  <div class="voice__inner">
    <div><p class="voice__line" id="line" aria-live="polite"></p><p class="voice__key" id="key" hidden></p></div>
    <div class="voice__nav">
      <button class="btn" id="prev" type="button">←</button>
      <button class="btn btn--primary" id="next" type="button">→</button>
    </div>
  </div>
</footer>
<script type="application/json" id="lesson-data">${safeJsonForScript(withMath)}</script>
<script>
${buildLessonTemplateRuntimeJs(withMath.language)}
</script>
</body>
</html>`;
      return { html, lesson: normalized };
    } catch {
      const title = String(lesson?.title || lesson?.id || 'Interactive Companion')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      const html = `<!doctype html>
<html lang="${lesson?.language === 'en' ? 'en' : 'zh-CN'}">
<head><meta charset="utf-8"><title>${title}</title></head>
<body>
<main id="stage"><h1>${title}</h1></main>
<script type="application/json" id="lesson-data">${safeJsonForScript(lesson)}</script>
</body>
</html>`;
      return { html, lesson };
    }
  }
}

/** Read one companion HTML (or authoring `.json`) file after checking workspace / library / trusted-root containment. */
export async function readCompanionSource({ path, workspace = '', startFolder = '', root, allowRememberTrusted = false }) {
  const target = givenPath(path, workspace || root);
  let real;
  try {
    real = await realpath(target);
  } catch {
    throw new Error('找不到这个伴学文件');
  }
  const allowed = await resolveAllowedFolders({ workspace, startFolder, root });
  if (!allowed.some(folder => inside(folder, real))) {
    if (allowRememberTrusted && root) {
      const parentDir = dirname(real);
      const current = await readTrustedCompanionRoots(root);
      await saveTrustedCompanionRoots(root, [...current, parentDir]);
    } else {
      throw new Error('该路径不在当前工作区或已授权伴学目录内；请在面板中挂载授权该目录');
    }
  }
  if (/\.json$/i.test(real)) {
    return loadDiskCompanionTarget(real, '', allowed);
  }
  return readCheckedHtmlFile(real);
}

/** Scan a companion pack directory (`pages/*.html`, `lessons/*.json` + `projects/` sources, or a folder of HTML files). */
export async function scanCompanionDirectory({ path, workspace = '', startFolder = '', root, allowRememberTrusted = false }) {
  const target = givenPath(path, workspace || root);
  let realDir;
  try {
    realDir = await realpath(target);
  } catch {
    throw new Error('找不到这个伴学目录');
  }
  const dirInfo = await stat(realDir).catch(() => null);
  if (!dirInfo?.isDirectory()) throw new Error('提供的路径不是目录');

  const allowed = await resolveAllowedFolders({ workspace, startFolder, root });
  if (!allowed.some(folder => inside(folder, realDir))) {
    if (allowRememberTrusted && root) {
      const current = await readTrustedCompanionRoots(root);
      await saveTrustedCompanionRoots(root, [...current, realDir]);
    } else {
      throw new Error('该目录不在当前工作区或已授权伴学目录内；请在面板中添加授权');
    }
  }

  const pagesDir = join(realDir, 'pages');
  const lessonsDir = join(realDir, 'lessons');
  const hasPagesDir = (await stat(pagesDir).catch(() => null))?.isDirectory() === true;
  const hasLessonsDir = (await stat(lessonsDir).catch(() => null))?.isDirectory() === true;
  const candidateFiles = [];

  if (hasPagesDir) {
    for (const ent of await readdir(pagesDir, { withFileTypes: true })) {
      if (/\.html$/i.test(ent.name)) candidateFiles.push(join(pagesDir, ent.name));
    }
    const workshopFile = join(realDir, 'projects', 'workshop-lab.html');
    if ((await stat(workshopFile).catch(() => null))?.isFile()) candidateFiles.push(workshopFile);
  } else {
    for (const ent of await readdir(realDir, { withFileTypes: true })) {
      if (/\.html$/i.test(ent.name) && ent.name.toLowerCase() !== 'index.html') {
        candidateFiles.push(join(realDir, ent.name));
      }
    }
  }

  let sourceIndex = null;
  const ensureSourceIndex = async () => {
    if (!sourceIndex) sourceIndex = await buildPackSourceIndex(realDir);
    return sourceIndex;
  };

  const items = [];
  const builtSlugs = new Set();
  let skippedOversized = 0;

  for (const candidate of candidateFiles.slice(0, MAX_SCAN_FILES)) {
    const realFile = await realpath(candidate).catch(() => null);
    if (!realFile || !inside(realDir, realFile)) continue;
    const fInfo = await stat(realFile).catch(() => null);
    if (!fInfo?.isFile()) continue;
    if (fInfo.size > MAX_COMPANION_BYTES) {
      skippedOversized++;
      continue;
    }
    try {
      const parsed = await readCheckedHtmlFile(realFile);
      builtSlugs.add(parsed.name);
      if (parsed.rawStem) builtSlugs.add(parsed.rawStem);
      let lesson = parsed.lesson;
      if (!lesson && hasLessonsDir) {
        const jsonPath = join(lessonsDir, `${parsed.name}.json`);
        const realJson = await realpath(jsonPath).catch(() => null);
        if (realJson && inside(realDir, realJson)) {
          const jInfo = await stat(realJson).catch(() => null);
          if (jInfo?.isFile() && jInfo.size <= MAX_COMPANION_BYTES) {
            try {
              const rawJson = JSON.parse(stripUtf8Bom(await readFile(realJson, 'utf8')));
              lesson = await resolveUnbuiltLessonSources(rawJson, realDir, await ensureSourceIndex());
            } catch { /* ignore invalid json */ }
          }
        }
      }
      items.push({
        ...parsed,
        lesson,
        linkedRoot: realDir,
        relPath: relative(realDir, realFile).replaceAll('\\', '/'),
      });
    } catch {
      /* skip unreadable or non-HTML entries */
    }
  }

  // Also discover unbuilt `lessons/<slug>.json` files that do not yet have a built `pages/<slug>.html`
  if (hasLessonsDir && items.length < MAX_SCAN_FILES) {
    const realLessonsDir = await realpath(lessonsDir).catch(() => null);
    if (realLessonsDir && inside(realDir, realLessonsDir)) {
      const jsonEntries = await readdir(realLessonsDir, { withFileTypes: true }).catch(() => []);
      for (const ent of jsonEntries) {
        if (items.length >= MAX_SCAN_FILES) break;
        if (!/\.json$/i.test(ent.name)) continue;
        const rawSlug = basename(ent.name, extname(ent.name));
        const slug = sanitizeWindowsFilename(rawSlug, 'lesson');
        if (builtSlugs.has(rawSlug) || builtSlugs.has(slug)) continue;

        const realJson = await realpath(join(realLessonsDir, ent.name)).catch(() => null);
        if (!realJson || !inside(realDir, realJson)) continue;
        const info = await stat(realJson).catch(() => null);
        if (!info?.isFile()) continue;
        if (info.size > MAX_COMPANION_BYTES) {
          skippedOversized++;
          continue;
        }

        try {
          const rawJson = JSON.parse(stripUtf8Bom(await readFile(realJson, 'utf8')));
          if (!rawJson || typeof rawJson !== 'object' || !Array.isArray(rawJson.slides) || !rawJson.slides.length) continue;
          const resolvedLesson = await resolveUnbuiltLessonSources(rawJson, realDir, await ensureSourceIndex());
          if (!Array.isArray(resolvedLesson?.slides) || !resolvedLesson.slides.length) continue;
          const compiled = compilePlayableOrFallbackHtml(resolvedLesson);
          const bytes = Buffer.byteLength(compiled.html, 'utf8');
          if (bytes > MAX_COMPANION_BYTES) {
            skippedOversized++;
            continue;
          }
          const sha256 = createHash('sha256').update(compiled.html, 'utf8').digest('hex');
          items.push({
            text: compiled.html,
            bytes,
            sha256,
            file: realJson,
            name: slug,
            title: String(compiled.lesson?.title || rawJson.title || slug),
            lesson: compiled.lesson,
            unbuiltJson: true,
            linkedRoot: realDir,
            relPath: relative(realDir, realJson).replaceAll('\\', '/'),
          });
        } catch {
          /* skip malformed authoring json */
        }
      }
    }
  }

  const feedbackJson = join(realDir, 'feedback', 'questions.json');
  const hasFeedback = (await stat(feedbackJson).catch(() => null))?.isFile() === true;
  return { rootDir: realDir, items, hasFeedback, skippedOversized };
}

export async function writeManagedCompanionFile(root, companionId, html) {
  return atomicWriteText(managedFileOf(root, companionId), html);
}

/** Atomically move a freshly written managed HTML from temporary `fromId` to the final persisted `toId` (#1367-4). */
export async function retargetManagedCompanionFile(root, fromId, toId) {
  const srcId = sanitizeCompanionId(fromId);
  const dstId = sanitizeCompanionId(toId);
  if (!srcId || !dstId || srcId === dstId) return;
  const src = managedFileOf(root, srcId);
  const dst = managedFileOf(root, dstId);
  const info = await stat(src).catch(() => null);
  if (!info?.isFile()) return;
  await mkdir(dirname(dst), { recursive: true });
  await rename(src, dst);
}

/** Resolve an explicit `.html` output path strictly inside workspace / startFolder / library / trusted companion roots. */
export async function resolveAuthorizedTarget({ outputPath, workspace = '', startFolder = '', root = '' }) {
  const candidate = givenPath(outputPath, workspace || root);
  if (extname(candidate).toLowerCase() !== '.html') {
    throw new Error('文件不是有效的 HTML 文档');
  }
  const allowed = await resolveAllowedFolders({ workspace, startFolder, root });
  if (!allowed.length) {
    throw new Error('该路径不在当前工作区或已授权伴学目录内；请在面板中挂载授权该目录');
  }

  let resolved = null;
  let foundAncestor = null;
  let foundTail = '';
  let probe = candidate;
  for (let depth = 0; depth < 64; depth++) {
    const realAncestor = await realpath(probe).catch(() => null);
    if (realAncestor) {
      foundAncestor = realAncestor;
      foundTail = relative(probe, candidate);
      resolved = foundTail ? join(realAncestor, foundTail) : realAncestor;
      break;
    }
    const parent = dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }

  if (!resolved || !allowed.some(folder => inside(folder, resolved))) {
    throw new Error('该路径不在当前工作区或已授权伴学目录内；请在面板中挂载授权该目录');
  }

  if (foundTail) {
    const rawParts = foundTail.split(/[\\/]+/).filter(Boolean);
    const safeParts = rawParts.map((part, idx) => {
      if (part === '.' || part === '..') return part;
      if (idx === rawParts.length - 1) {
        const stem = basename(part, extname(part));
        return `${sanitizeWindowsFilename(stem, 'lesson')}.html`;
      }
      return sanitizeWindowsFilename(part, 'companions');
    });
    const safeResolved = join(foundAncestor, ...safeParts);
    if (!allowed.some(folder => inside(folder, safeResolved))) {
      throw new Error('该路径不在当前工作区或已授权伴学目录内；请在面板中挂载授权该目录');
    }
    return safeResolved;
  }

  const leafStem = basename(resolved, extname(resolved));
  const safeLeaf = `${sanitizeWindowsFilename(leafStem, 'lesson')}.html`;
  const finalResolved = join(dirname(resolved), safeLeaf);
  if (!allowed.some(folder => inside(folder, finalResolved))) {
    throw new Error('该路径不在当前工作区或已授权伴学目录内；请在面板中挂载授权该目录');
  }
  return finalResolved;
}

/** Write compiled `.html` (and optional sidecar `.lesson.json`) to an authorized `outputPath`, plus managed cache when attached. */
export async function writeAuthorizedCompanionOutput({
  outputPath,
  workspace = '',
  startFolder = '',
  root,
  companionId = '',
  html,
  lesson,
  writeLessonJson = true,
}) {
  const htmlPath = await resolveAuthorizedTarget({ outputPath, workspace, startFolder, root });
  await atomicWriteText(htmlPath, html);
  let jsonPath = null;
  if (lesson && writeLessonJson) {
    const stem = sanitizeWindowsFilename(basename(htmlPath, extname(htmlPath)), 'lesson');
    jsonPath = join(dirname(htmlPath), `${stem}.lesson.json`);
    await atomicWriteText(jsonPath, JSON.stringify(lesson, null, 2));
  }
  if (companionId && root) {
    await writeManagedCompanionFile(root, sanitizeCompanionId(companionId), html);
  }
  return { htmlPath, jsonPath };
}

/** ADR-9: Write plaintext `.html` and `.lesson.json` into `<workspace>/companions/<course>/<slug>.*` AND managed copy. */
export async function writeGeneratedCompanionFiles({ workspace = '', root, companionId, course = '', slug, html, lesson, skipManaged = false }) {
  const safeId = companionId ? sanitizeCompanionId(companionId) : '';
  if (!skipManaged && safeId && root) {
    await writeManagedCompanionFile(root, safeId, html);
  }
  const baseDir = workspace ? join(workspace, 'companions', slugifyName(course || 'general', 'general')) : join(root, COMPANION_FOLDER, 'generated');
  const safeSlug = slugifyName(slug || lesson?.id || lesson?.title, safeId || 'lesson');
  const htmlPath = join(baseDir, `${safeSlug}.html`);
  const jsonPath = join(baseDir, `${safeSlug}.lesson.json`);
  await atomicWriteText(htmlPath, html);
  if (lesson) await atomicWriteText(jsonPath, JSON.stringify(lesson, null, 2));
  return { htmlPath, jsonPath };
}

async function resolveSafePackRoot(realFile, linkedRoot = '', allowed = []) {
  if (linkedRoot) {
    const realLinked = await realpath(linkedRoot).catch(() => null);
    if (realLinked && (!allowed.length || allowed.some(folder => inside(folder, realLinked)))) {
      return realLinked;
    }
  }
  const immediateDir = dirname(realFile);
  if (basename(immediateDir).toLowerCase() === 'lessons') {
    const candidateParent = dirname(immediateDir);
    if (allowed.some(folder => inside(folder, candidateParent))) {
      return candidateParent;
    }
  }
  return immediateDir;
}

async function loadDiskCompanionTarget(realFile, linkedRoot = '', allowed = []) {
  if (/\.json$/i.test(realFile)) {
    const info = await stat(realFile).catch(() => null);
    if (!info?.isFile()) throw new Error('找不到这个伴学文件');
    if (info.size > MAX_COMPANION_BYTES) throw new Error('伴学 HTML 文件超过 15 MB 上限');
    let rawJson;
    try {
      rawJson = JSON.parse(stripUtf8Bom(await readFile(realFile, 'utf8')));
    } catch {
      throw new Error('文件不是有效的 HTML 文档');
    }
    if (!rawJson || typeof rawJson !== 'object' || !Array.isArray(rawJson.slides)) {
      throw new Error('文件不是有效的 HTML 文档');
    }
    const packRoot = await resolveSafePackRoot(realFile, linkedRoot, allowed);
    const resolvedLesson = await resolveUnbuiltLessonSources(rawJson, packRoot);
    const compiled = compilePlayableOrFallbackHtml(resolvedLesson);
    const bytes = Buffer.byteLength(compiled.html, 'utf8');
    if (bytes > MAX_COMPANION_BYTES) throw new Error('伴学 HTML 文件超过 15 MB 上限');
    const sha256 = createHash('sha256').update(compiled.html, 'utf8').digest('hex');
    const slug = sanitizeWindowsFilename(basename(realFile, extname(realFile)), 'lesson');
    return {
      text: compiled.html,
      bytes,
      sha256,
      file: realFile,
      name: slug,
      title: String(compiled.lesson?.title || rawJson.title || slug),
      lesson: compiled.lesson,
      unbuiltJson: true,
    };
  }

  const loaded = await readCheckedHtmlFile(realFile);
  if (!loaded.lesson && linkedRoot) {
    const realPack = await realpath(linkedRoot).catch(() => null);
    if (realPack && (!allowed.length || allowed.some(folder => inside(folder, realPack)))) {
      const jsonPath = join(realPack, 'lessons', `${loaded.name}.json`);
      const realJson = await realpath(jsonPath).catch(() => null);
      if (realJson && inside(realPack, realJson)) {
        const jInfo = await stat(realJson).catch(() => null);
        if (jInfo?.isFile() && jInfo.size <= MAX_COMPANION_BYTES) {
          try {
            const rawJson = JSON.parse(stripUtf8Bom(await readFile(realJson, 'utf8')));
            loaded.lesson = await resolveUnbuiltLessonSources(rawJson, realPack);
          } catch { /* ignore invalid sidecar json */ }
        }
      }
    }
  }
  return loaded;
}

/** Reload a linked (or workspace-backed) companion directly from disk after verifying folder containment. */
export async function reloadLinkedCompanion({ root, workspace = '', startFolder = '', record }) {
  const diskTarget = (record?.mode === 'linked' && record.linkedPath) ? record.linkedPath : (record?.workspacePath || '');
  if (!diskTarget) {
    throw new Error('该伴学页未关联本地磁盘文件，无法从磁盘重新同步');
  }
  const allowed = await resolveAllowedFolders({ workspace, startFolder, root });
  const real = await realpath(diskTarget).catch(() => null);
  if (!real || !allowed.some(folder => inside(folder, real))) {
    throw new Error('关联的本地伴学文件当前不可达；可在桌面端重新挂载该目录，或直接点击题目「去原文看这段」离线阅读完整投影讲义');
  }
  return loadDiskCompanionTarget(real, record.linkedRoot || '', allowed);
}

/** Read a companion's HTML & stored progress state (from managed copy or linked disk file). */
export async function readCompanionDocument({ root, workspace = '', startFolder = '', record }) {
  const safeId = sanitizeCompanionId(record.id);
  const savedState = await readCompanionState(root, safeId);
  if (record.mode === 'linked' && record.linkedPath) {
    const allowed = await resolveAllowedFolders({ workspace, startFolder, root });
    const real = await realpath(record.linkedPath).catch(() => null);
    if (real && allowed.some(folder => inside(folder, real))) {
      const loaded = await loadDiskCompanionTarget(real, record.linkedRoot || '', allowed);
      return {
        html: loaded.text,
        file: real,
        sha256: loaded.sha256,
        changedOnDisk: loaded.sha256 !== record.sha256,
        lesson: loaded.lesson,
        savedState,
      };
    }
    // Fallback to managed copy if pinned, otherwise clear message
    const fallback = await stat(managedFileOf(root, safeId)).catch(() => null);
    if (!fallback?.isFile()) {
      throw new Error('关联的本地伴学文件当前不可达；可在桌面端重新挂载该目录，或直接点击题目「去原文看这段」离线阅读完整投影讲义');
    }
  }
  const file = managedFileOf(root, safeId);
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new Error('伴学页文件已不在学习库中');
  if (info.size > MAX_COMPANION_BYTES) throw new Error('伴学 HTML 文件超过 15 MB 上限');
  const text = stripUtf8Bom(await readFile(file, 'utf8'));
  return {
    html: text,
    file: record.workspacePath || file,
    sha256: createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex'),
    changedOnDisk: false,
    lesson: extractResilientLesson(text),
    savedState,
  };
}

export async function removeCompanionFiles(root, companionIds = []) {
  for (const id of companionIds) {
    if (!isSafeCompanionId(id)) continue;
    await rm(managedFileOf(root, id), { force: true }).catch(() => {});
    await rm(stateFileOf(root, id), { force: true }).catch(() => {});
  }
}

export async function readCompanionState(root, companionId) {
  try {
    const file = stateFileOf(root, companionId);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile() || info.size > MAX_COMPANION_BYTES) {
      return { memory: {}, checkResults: {}, doubts: [] };
    }
    return JSON.parse(stripUtf8Bom(await readFile(file, 'utf8')));
  } catch {
    return { memory: {}, checkResults: {}, doubts: [] };
  }
}

export async function writeCompanionState(root, companionId, patch) {
  const prev = await readCompanionState(root, companionId);
  const next = {
    memory: patch.memory !== undefined ? patch.memory : prev.memory,
    checkResults: patch.checkResults ? { ...(prev.checkResults || {}), ...patch.checkResults } : (prev.checkResults || {}),
    doubts: Array.isArray(patch.doubts) ? patch.doubts.slice(-200) : (prev.doubts || []),
    updatedAt: new Date().toISOString(),
  };
  await atomicWriteText(stateFileOf(root, companionId), JSON.stringify(next));
  return next;
}

/* ---------- Two-way incremental sync with `feedback/questions.json` (ADR-1, `study.mjs` compatible) ---------- */

function normalizeFeedbackItem(raw, existing = null, stamp = new Date().toISOString()) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const clean = (v, max) => (v == null ? '' : String(v).replace(/\r\n/g, '\n').trim().slice(0, max));
  const tag = VALID_FEEDBACK_TAGS.has(src.tag) ? src.tag : (existing?.tag || 'unclear');
  const status = src.status === 'resolved' ? 'resolved' : 'open';
  return {
    id: clean(src.id, 80) || existing?.id || `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    lessonId: clean(src.lessonId, 120) || existing?.lessonId || '',
    lessonTitle: clean(src.lessonTitle, 240) || existing?.lessonTitle || '',
    course: clean(src.course, 120) || existing?.course || '',
    slide: Math.max(1, Math.floor(Number(src.slide ?? existing?.slide) || 1)),
    slideTotal: Math.max(1, Math.floor(Number(src.slideTotal ?? existing?.slideTotal) || 1)),
    slideTitle: clean(src.slideTitle, 240) || existing?.slideTitle || '',
    beat: clean(src.beat, 80) || existing?.beat || '',
    moment: Math.max(0, Math.floor(Number(src.moment ?? existing?.moment) || 0)),
    teacherLine: src.teacherLine !== undefined ? clean(src.teacherLine, 1200) : (existing?.teacherLine || ''),
    quote: src.quote !== undefined ? clean(src.quote, 1200) : (existing?.quote || ''),
    tag,
    note: src.note !== undefined ? clean(src.note, 4000) : (existing?.note || ''),
    status,
    resolution: src.resolution !== undefined ? clean(src.resolution, 4000) : (existing?.resolution || ''),
    createdAt: clean(src.createdAt, 64) || existing?.createdAt || stamp,
    updatedAt: clean(src.updatedAt, 64) || stamp,
  };
}

function renderFeedbackMarkdown(db, language = '') {
  const items = Array.isArray(db?.items) ? db.items : [];
  const openItems = items.filter(it => it.status !== 'resolved').sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const isEn = language === 'en' || (!language && items.length > 0 && items.every(it => !/[\u4e00-\u9fff]/.test(`${it.lessonTitle || ''} ${it.slideTitle || ''} ${it.note || ''}`)));
  if (isEn) {
    const lines = [
      '# Study Questions & Feedback',
      '',
      `- Open: **${openItems.length}** | Total: **${items.length}**`,
      '',
    ];
    for (const it of openItems) {
      const tagLabel = TAG_LABELS_EN[it.tag] || it.tag;
      lines.push(`- [ ] **[${tagLabel}]** \`${it.lessonId}\` · Slide ${it.slide}/${it.slideTotal} "${it.slideTitle}"`);
      if (it.quote) lines.push(`  > Quote: ${it.quote.replace(/\n+/g, ' ')}`);
      if (it.note) lines.push(`  - Question: ${it.note.replace(/\n+/g, ' ')}`);
    }
    return `${lines.join('\n')}\n`;
  }
  const lines = [
    '# 学习疑问与改进清单 (Study Questions & Feedback)',
    '',
    `- 待解决：**${openItems.length}** 条 | 总计：**${items.length}** 条`,
    '',
  ];
  for (const it of openItems) {
    const tagLabel = TAG_LABELS_ZH[it.tag] || it.tag;
    lines.push(`- [ ] **[${tagLabel}]** \`${it.lessonId}\` · 第 ${it.slide}/${it.slideTotal} 页《${it.slideTitle}》`);
    if (it.quote) lines.push(`  > 摘录：${it.quote.replace(/\n+/g, ' ')}`);
    if (it.note) lines.push(`  - 疑问：${it.note.replace(/\n+/g, ' ')}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Atomically merge incoming feedback item(s) with `<linkedRoot>/feedback/questions.json` using LWW per `id`. */
export async function syncFeedbackLedger({ linkedRoot, workspace = '', startFolder = '', root, incoming = [], language = '' }) {
  const allowed = await resolveAllowedFolders({ workspace, startFolder, root });
  const realDir = await realpath(linkedRoot).catch(() => null);
  if (!realDir || !allowed.some(folder => inside(folder, realDir))) {
    throw new Error('伴学目录未授权，无法同步 feedback/questions.json');
  }
  const jsonPath = join(realDir, 'feedback', 'questions.json');
  const corruptBackupPath = join(realDir, 'feedback', 'questions.corrupt.json');
  const mdPath = join(realDir, 'feedback', 'questions.md');
  const prevTurn = feedbackLocks.get(realDir) || Promise.resolve();
  const nextTurn = prevTurn.then(async () => {
    let diskDb = { version: 1, updatedAt: new Date().toISOString(), items: [] };
    let recoveredFromCorrupt = false;
    const diskStat = await stat(jsonPath).catch(() => null);
    if (diskStat?.isFile() && diskStat.size <= MAX_COMPANION_BYTES) {
      const rawContent = await readFile(jsonPath, 'utf8').catch(() => '');
      const cleanContent = stripUtf8Bom(rawContent).trim();
      if (cleanContent.length > 0) {
        try {
          const parsed = JSON.parse(cleanContent);
          if (Array.isArray(parsed?.items)) {
            diskDb = parsed;
          } else if (Array.isArray(parsed)) {
            diskDb = { version: 1, updatedAt: new Date().toISOString(), items: parsed };
          } else {
            await atomicWriteText(corruptBackupPath, rawContent).catch(() => {});
            recoveredFromCorrupt = true;
          }
        } catch {
          await atomicWriteText(corruptBackupPath, rawContent).catch(() => {});
          recoveredFromCorrupt = true;
        }
      }
    }

    const byId = new Map();
    for (const item of diskDb.items) {
      if (!item || typeof item !== 'object') continue;
      const normItem = normalizeFeedbackItem(item, item, item.updatedAt);
      byId.set(normItem.id, normItem);
    }
    const now = new Date().toISOString();
    for (const raw of Array.isArray(incoming) ? incoming : [incoming]) {
      if (!raw) continue;
      const existing = raw.id ? byId.get(raw.id) : null;
      if (existing && raw.updatedAt && String(existing.updatedAt) > String(raw.updatedAt)) continue;
      const merged = normalizeFeedbackItem(raw, existing, now);
      byId.set(merged.id, merged);
    }
    const mergedDb = {
      version: 1,
      updatedAt: now,
      items: [...byId.values()],
      ...(recoveredFromCorrupt ? { recoveredFromCorrupt: true } : {}),
    };
    const diskPayload = { version: 1, updatedAt: now, items: mergedDb.items };
    if ((incoming && incoming.length) || diskStat?.isFile()) {
      await atomicWriteText(jsonPath, `${JSON.stringify(diskPayload, null, 2)}\n`);
      await atomicWriteText(mdPath, renderFeedbackMarkdown(diskPayload, language));
    }
    return mergedDb;
  });
  const tail = nextTurn.catch(() => {});
  feedbackLocks.set(realDir, tail);
  tail.then(() => { if (feedbackLocks.get(realDir) === tail) feedbackLocks.delete(realDir); });
  return nextTurn;
}

export { syncFeedbackLedger as syncFeedbackFile };

/* ---------- Portable backup (`managed` companions only; `linked` packs add 0 bytes of bloat) ---------- */

export async function exportCompanionFiles(root, courses = []) {
  const files = [];
  for (const course of courses || []) {
    for (const record of course?.companions || []) {
      if (record.mode !== 'managed') continue;
      try {
        const html = await readFile(managedFileOf(root, record.id), 'utf8');
        const bytes = Buffer.byteLength(html, 'utf8');
        const sha256 = createHash('sha256').update(html, 'utf8').digest('hex');
        if (bytes <= MAX_COMPANION_BYTES && sha256 === record.sha256) {
          files.push({ courseId: course.id, id: record.id, sha256, bytes, dataBase64: Buffer.from(html, 'utf8').toString('base64') });
        }
      } catch { /* missing managed file is skipped */ }
    }
  }
  return files;
}

export function verifyCompanionBackup(backup, courses = []) {
  if (!backup) return [];
  if (backup.format !== COMPANION_BACKUP || !Array.isArray(backup.files)) {
    throw new Error('Portable backup has an unreadable companion section');
  }
  const verified = [];
  for (const file of backup.files) {
    const course = (courses || []).find(c => c.id === file?.courseId);
    const record = (course?.companions || []).find(item => item.id === file?.id);
    if (!record) continue;
    const bytes = Buffer.from(String(file.dataBase64 || ''), 'base64');
    let text = '';
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* checked below */ }
    if (!isSafeCompanionId(record.id) || bytes.length > MAX_COMPANION_BYTES || bytes.length !== record.bytes
      || createHash('sha256').update(bytes).digest('hex') !== record.sha256 || !looksLikeHtml(text)) {
      throw new Error('Portable backup companion file does not match its record');
    }
    verified.push({ id: record.id, text });
  }
  return verified;
}

export async function restoreCompanionFiles(root, verified = []) {
  for (const file of verified) await writeManagedCompanionFile(root, file.id, file.text);
  return { restored: verified.length };
}

/** Host-enforced workspace/startFolder injection (never trusts caller-supplied workspace/startFolder). */
const SCOPED_COMPANION_ACTIONS = new Set([
  'companion.attach',
  'companion.scan',
  'companion.get',
  'companion.sync',
  'companion.feedback.sync',
  'companion.catchup.save',
  'companion.compile',
  'companion.build',
  'generation.companion.build',
]);

export function scopeCompanionArgs(action, args, cwd, started, { fromPanel = false } = {}) {
  if (!SCOPED_COMPANION_ACTIONS.has(action)) return args;
  const { workspace: _w, startFolder: _s, allowRememberTrusted: _t, ...rest } = args || {};
  const workspace = typeof cwd === 'string' ? cwd : '';
  return {
    ...rest,
    workspace,
    ...(typeof started === 'string' && started && started !== workspace ? { startFolder: started } : {}),
    ...(fromPanel ? { allowRememberTrusted: Boolean(args?.allowRememberTrusted) } : {}),
  };
}
