#!/usr/bin/env node
/* Doc-drift detector (#1756): scans active repository markdown documentation for broken local
   links, missing referenced repo paths, and stale `npm run` / `node <file>` commands.

   Usage:
     node scripts/doc-drift.mjs                     advisory summary (exits 0)
     node scripts/doc-drift.mjs --annotations       advisory summary + GitHub Actions ::warning + $GITHUB_STEP_SUMMARY
     node scripts/doc-drift.mjs --json              machine-readable JSON report on stdout
     node scripts/doc-drift.mjs --strict            exit 1 if any drift findings are reported
     node scripts/doc-drift.mjs --root <dir>        scan another checkout (also accepts --root=<dir>)
*/

import { appendFileSync, existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MAX_ANNOTATIONS = 20;

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'output',
  'coverage',
  'tmp',
  '.local',
  '.dsh-study',
  'target',
  'test-results',
  'playwright-report',
  '.playwright-cli',
  'videos',
]);

// Historical / generated / snapshot doc locations that intentionally record past states,
// review logs, or build outputs rather than current active documentation.
const EXCLUDED_DOC_PATTERNS = [
  /^CHANGELOG(?:\.[^/]+)?\.md$/i,
  /^changes\/unreleased\//,
  /^docs\/plans\//,
  /^docs\/handoffs\//,
  /^docs\/validation\//,
  /^docs\/agent-lessons\//,
  /^docs\/test-audit\.md$/,
  /^docs\/repair-\d{4}-\d{2}-\d{2}\.md$/,
  /^packages\/[^/]+\/docs\/PR\d+-REVIEW\.md$/i,
  /^packages\/[^/]+\/docs\/ROADMAP-[^/]+\.md$/i,
  /^packages\/[^/]+\/docs\/m0-audit\.md$/i,
  /^tests\/fixtures\//,
];

const KNOWN_REPO_ROOT_DIRS = new Set([
  'scripts',
  'lib',
  'ui',
  'docs',
  'packages',
  'tests',
  'skills',
  'references',
  'locale',
  'presets',
  'site',
  'evals',
  'changes',
  'web-demo',
  '.github',
  '.claude',
  '.agents',
  '.codex',
]);

const PKG_LOCAL_DIRS = new Set(['src', 'bin', 'scripts', 'docs', 'tests', 'locale', 'assets', 'src-tauri']);

const GENERATED_OR_RUNTIME_PREFIXES = [
  'dist/',
  'node_modules/',
  'build/',
  'output/',
  'coverage/',
  'tmp/',
  '.local/',
  '.dsh-study/',
  'test-results/',
  'playwright-report/',
  'site/assets/_src/',
  'site/assets/shots/',
];

const GENERATED_EXACT_PATHS = new Set([
  'lib/client.js',
]);

const GENERATED_PATH_PATTERNS = [
  /^lib\/client\.[^/]+\.js$/,
  /(?:^|\/)(?:dist|node_modules|build|output|target|coverage|\.local|tmp)(?:\/|$)/,
];

const WINDOWS_SHELL_LANGUAGES = new Set(['powershell', 'pwsh', 'cmd', 'dos']);

const SHELL_LANGUAGES = new Set([
  '',
  'sh',
  'bash',
  'zsh',
  'shell',
  'console',
  ...WINDOWS_SHELL_LANGUAGES,
]);

const NODE_VALUE_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '-C',
  '--conditions',
  '--env-file',
  '--env-file-if-exists',
  '--input-type',
  '--title',
  '--redirect-warnings',
  '--watch-path',
  '--test-name-pattern',
  '--test-skip-pattern',
  '--test-reporter',
  '--test-reporter-destination',
  '--test-shard',
  '--test-concurrency',
  '--test-timeout',
  '--max-old-space-size',
  '--cpu-prof-dir',
  '--cpu-prof-name',
  '--heap-prof-dir',
  '--heap-prof-name',
  '--diagnostic-dir',
  '--openssl-config',
  '--heapsnapshot-near-heap-limit',
  '--heapsnapshot-signal',
  '--inspect',
  '--inspect-brk',
  '--inspect-port',
  '--debug-port',
]);

const NODE_NON_FILE_FLAGS = new Set([
  '-e',
  '--eval',
  '-p',
  '--print',
  '-i',
  '--interactive',
  '-v',
  '--version',
  '-h',
  '--help',
]);

const FILE_EXT_RE = /\.(?:m?js|cjs|jsx|m?ts|cts|tsx|json|ya?ml|md|markdown|html?|css|scss|sh|bash|ps1|cmd|bat|py|rs|java|xml|toml|sql|svg|png|jpe?g|webp|gif|pdf|txt|patch|lock)$/i;
const SHELL_ESCAPABLE_RE = /[\s'"\\$;&|()<>#]/;
const SECTION_CWD_HINT_RE = /(?:from|in|under|inside|在|从)\s+`(packages\/[^/`\s]+)\/?`/i;

const toPosix = filePath => filePath.split(sep).join('/');
const compareText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function safeStat(filePath) {
  try {
    return statSync(filePath);
  } catch {
    return null;
  }
}

function safeLstat(filePath) {
  try {
    return lstatSync(filePath);
  } catch {
    return null;
  }
}

function pathExists(filePath) {
  try {
    return existsSync(filePath);
  } catch {
    return false;
  }
}

function isInsideRoot(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function isBinaryBuffer(buf) {
  const sampleLen = Math.min(buf.length, 4096);
  for (let i = 0; i < sampleLen; i += 1) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function safeReadUtf8(filePath) {
  try {
    const stat = safeLstat(filePath);
    if (!stat || stat.isSymbolicLink() || !stat.isFile()) return null;
    const buf = readFileSync(filePath);
    if (isBinaryBuffer(buf)) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}

function walkMarkdown(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => compareText(a.name, b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walkMarkdown(root, join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      const fullPath = join(dir, entry.name);
      const rel = toPosix(relative(root, fullPath));
      if (!EXCLUDED_DOC_PATTERNS.some(pattern => pattern.test(rel))) {
        out.push(rel);
      }
    }
  }
}

/** Discover active repository markdown documentation files (repo-relative POSIX paths, sorted). */
export function discoverDocFiles(root) {
  const absRoot = resolve(root);
  const found = new Set();

  // 1. Root active markdown files (README*.md, AGENTS.md, CLAUDE.md, CONTRIBUTING*.md)
  let rootEntries = [];
  try {
    rootEntries = readdirSync(absRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const entry of rootEntries) {
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    if (/^(?:README(?:\.[^/]+)?|AGENTS|CLAUDE|CONTRIBUTING(?:\.[^/]+)?)\.md$/i.test(entry.name)) {
      found.add(entry.name);
    }
  }

  // 2. docs/**/*.md, skills/**/*.md, references/**/*.md
  for (const topDir of ['docs', 'skills', 'references']) {
    const absDir = join(absRoot, topDir);
    if (safeStat(absDir)?.isDirectory()) {
      const list = [];
      walkMarkdown(absRoot, absDir, list);
      for (const rel of list) found.add(rel);
    }
  }

  // 3. packages/*/README*.md, packages/*/ARCHITECTURE.md, packages/*/docs/**/*.md, packages/*/*/README*.md
  const packagesDir = join(absRoot, 'packages');
  if (safeStat(packagesDir)?.isDirectory()) {
    let pkgDirs = [];
    try {
      pkgDirs = readdirSync(packagesDir, { withFileTypes: true });
    } catch {
      pkgDirs = [];
    }
    for (const pkg of pkgDirs) {
      if (!pkg.isDirectory() || pkg.isSymbolicLink() || IGNORED_DIRS.has(pkg.name)) continue;
      const pkgPath = join(packagesDir, pkg.name);
      let pkgEntries = [];
      try {
        pkgEntries = readdirSync(pkgPath, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of pkgEntries) {
        if (entry.isSymbolicLink()) continue;
        if (entry.isFile() && /^(?:README(?:\.[^/]+)?|ARCHITECTURE)\.md$/i.test(entry.name)) {
          const rel = toPosix(relative(absRoot, join(pkgPath, entry.name)));
          if (!EXCLUDED_DOC_PATTERNS.some(pattern => pattern.test(rel))) found.add(rel);
        } else if (entry.isDirectory() && entry.name === 'docs') {
          const list = [];
          walkMarkdown(absRoot, join(pkgPath, 'docs'), list);
          for (const rel of list) found.add(rel);
        } else if (entry.isDirectory() && !IGNORED_DIRS.has(entry.name) && entry.name !== 'tests' && entry.name !== 'src') {
          const subReadme = join(pkgPath, entry.name, 'README.md');
          if (safeLstat(subReadme)?.isFile()) {
            const rel = toPosix(relative(absRoot, subReadme));
            if (!EXCLUDED_DOC_PATTERNS.some(pattern => pattern.test(rel))) found.add(rel);
          }
        }
      }
    }
  }

  return [...found].sort(compareText);
}

// --------------------------------------------------------------------------------------------- markdown parsing

/** Extract inline code spans from a single markdown line and return a masked copy for link scanning. */
function extractInlineCode(line, lineNumber, sectionCwdHint) {
  const spans = [];
  const masked = line.split('');
  let i = 0;
  while (i < line.length) {
    if (line[i] === '\\' && i + 1 < line.length) {
      i += 2;
      continue;
    }
    if (line[i] !== '`') {
      i += 1;
      continue;
    }
    let tickCount = 0;
    while (i + tickCount < line.length && line[i + tickCount] === '`') tickCount += 1;
    const contentStart = i + tickCount;
    let search = contentStart;
    let closeStart = -1;
    while (search < line.length) {
      if (line[search] === '`') {
        let run = 0;
        while (search + run < line.length && line[search + run] === '`') run += 1;
        if (run === tickCount) {
          closeStart = search;
          break;
        }
        search += run;
      } else {
        search += 1;
      }
    }
    if (closeStart === -1) {
      i = contentStart;
      continue;
    }
    let text = line.slice(contentStart, closeStart);
    if (text.length >= 2 && text.startsWith(' ') && text.endsWith(' ') && /[^ ]/.test(text)) {
      text = text.slice(1, -1);
    }
    spans.push({ line: lineNumber, text: text.trim(), sectionCwdHint });
    for (let k = i; k < closeStart + tickCount; k += 1) masked[k] = ' ';
    i = closeStart + tickCount;
  }
  return { spans, maskedLine: masked.join('') };
}

/** Extract markdown inline links `[label](target)` and image links `![alt](target)` from a code-masked line. */
function extractMarkdownLinks(maskedLine, lineNumber) {
  const links = [];
  // Reference-style link definition: `[id]: target`
  const refDef = /^\s{0,3}\[[^\]\r\n]+\]:\s*(<[^>\r\n]+>|\S+)/.exec(maskedLine);
  if (refDef) {
    links.push({ line: lineNumber, rawTarget: refDef[1] });
    return links;
  }

  let i = 0;
  while (i < maskedLine.length) {
    if (maskedLine[i] === '\\' && i + 1 < maskedLine.length) {
      i += 2;
      continue;
    }
    if (maskedLine[i] !== '[') {
      i += 1;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    while (j < maskedLine.length && depth > 0) {
      if (maskedLine[j] === '\\' && j + 1 < maskedLine.length) { j += 2; continue; }
      if (maskedLine[j] === '[') depth += 1;
      else if (maskedLine[j] === ']') depth -= 1;
      j += 1;
    }
    if (depth !== 0 || maskedLine[j] !== '(') {
      i += 1;
      continue;
    }
    let k = j + 1;
    while (k < maskedLine.length && /\s/.test(maskedLine[k])) k += 1;
    let rawTarget = '';
    if (maskedLine[k] === '<') {
      const closeAngle = maskedLine.indexOf('>', k + 1);
      if (closeAngle !== -1) {
        rawTarget = maskedLine.slice(k + 1, closeAngle).trim();
      } else {
        i = j + 1;
        continue;
      }
    } else {
      const start = k;
      let parenDepth = 0;
      let end = -1;
      while (k < maskedLine.length) {
        const ch = maskedLine[k];
        if (ch === '\\' && k + 1 < maskedLine.length) { k += 2; continue; }
        if (ch === '(') parenDepth += 1;
        else if (ch === ')') {
          if (parenDepth === 0) { end = k; break; }
          parenDepth -= 1;
        }
        k += 1;
      }
      if (end === -1) {
        i = j + 1;
        continue;
      }
      const inside = maskedLine.slice(start, end).trim();
      const spaceIdx = inside.search(/\s/);
      rawTarget = spaceIdx === -1 ? inside : inside.slice(0, spaceIdx);
    }
    if (rawTarget) links.push({ line: lineNumber, rawTarget });
    i += 1;
  }
  return links;
}

/** Parse a markdown document into links, inline code spans, and fenced code blocks with line numbers. */
export function parseMarkdown(content) {
  const lines = String(content ?? '').replace(/\r\n?/g, '\n').split('\n');
  const links = [];
  const inlineCode = [];
  const codeBlocks = [];

  let inFence = false;
  let fenceChar = '';
  let fenceLen = 0;
  let currentBlock = null;
  let inHtmlComment = false;
  let sectionCwdHint = null;

  for (let idx = 0; idx < lines.length; idx += 1) {
    const lineNumber = idx + 1;
    const rawLine = lines[idx];

    if (inFence) {
      const closeRe = new RegExp(`^\\s{0,3}${fenceChar}{${fenceLen},}\\s*$`);
      if (closeRe.test(rawLine)) {
        codeBlocks.push(currentBlock);
        inFence = false;
        fenceChar = '';
        fenceLen = 0;
        currentBlock = null;
      } else {
        currentBlock.lines.push({ line: lineNumber, text: rawLine });
      }
      continue;
    }

    let line = rawLine;
    if (inHtmlComment) {
      const endComment = line.indexOf('-->');
      if (endComment === -1) continue;
      line = line.slice(endComment + 3);
      inHtmlComment = false;
    }
    while (line.includes('<!--')) {
      const startComment = line.indexOf('<!--');
      const endComment = line.indexOf('-->', startComment + 4);
      if (endComment === -1) {
        line = line.slice(0, startComment);
        inHtmlComment = true;
        break;
      }
      line = line.slice(0, startComment) + line.slice(endComment + 3);
    }

    if (/^\s{0,3}#{1,6}\s+/.test(line)) {
      sectionCwdHint = null;
    }

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})\s*([^\s`~]*)/.exec(line);
    if (fenceMatch) {
      inFence = true;
      fenceChar = fenceMatch[1][0];
      fenceLen = fenceMatch[1].length;
      currentBlock = {
        lang: (fenceMatch[2] || '').toLowerCase(),
        startLine: lineNumber,
        sectionCwdHint,
        lines: [],
      };
      continue;
    }

    const cwdHintMatch = SECTION_CWD_HINT_RE.exec(line);
    if (cwdHintMatch) {
      sectionCwdHint = cwdHintMatch[1].replace(/\/+$/, '');
    }

    const { spans, maskedLine } = extractInlineCode(line, lineNumber, sectionCwdHint);
    inlineCode.push(...spans);
    links.push(...extractMarkdownLinks(maskedLine, lineNumber));
  }

  if (inFence && currentBlock) {
    codeBlocks.push(currentBlock);
  }

  return { links, inlineCode, codeBlocks };
}

// --------------------------------------------------------------------------------------------- placeholder / ignore helpers

function hasTemplatePlaceholder(text) {
  if (!text) return true;
  if (/<[^>\s]+>/.test(text)) return true;
  if (/\$\{[^}]+\}/.test(text)) return true;
  if (/\{\{[^}]+\}\}/.test(text)) return true;
  if (/\{[^}\s]+\}/.test(text)) return true;
  if (/(?:^|[/\\])(?:\.\.\.|…)(?:[/\\]|$)/.test(text) || text.includes('...')) return true;
  if (/(?:^|\/)(?:xxx+|your-[a-z0-9_-]*|example-[a-z0-9_-]*)(?:\/|\.|-[a-z0-9_-]*|$)/i.test(text)) return true;
  if (/\$[A-Za-z_][A-Za-z0-9_]*/.test(text)) return true;
  if (/%[A-Za-z_][A-Za-z0-9_]*%/.test(text)) return true;
  return false;
}

function hasGlobChars(text) {
  return /[*?[\]]/.test(text);
}

function isExternalScheme(target) {
  // Ignore URL schemes (`https:`, `mailto:`, `data:`, etc.), excluding single-letter Windows drive prefixes (`C:\`).
  return /^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(target) || target.startsWith('//');
}

function isGeneratedOrRuntimePath(posixPath) {
  const clean = posixPath.replace(/^\.\//, '');
  if (GENERATED_EXACT_PATHS.has(clean)) return true;
  if (GENERATED_OR_RUNTIME_PREFIXES.some(prefix => clean.startsWith(prefix))) return true;
  if (GENERATED_PATH_PATTERNS.some(pattern => pattern.test(clean))) return true;
  return false;
}

function decodeUriSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// --------------------------------------------------------------------------------------------- repo context & package.json cache

function createRepoContext(root) {
  const absRoot = resolve(root);
  const pkgCache = new Map();
  const topDirs = new Set(KNOWN_REPO_ROOT_DIRS);
  try {
    for (const entry of readdirSync(absRoot, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.isSymbolicLink() && !IGNORED_DIRS.has(entry.name)) {
        topDirs.add(entry.name);
      }
    }
  } catch {
    // Fallback to KNOWN_REPO_ROOT_DIRS when root cannot be listed.
  }

  const readPackageJson = dir => {
    const key = resolve(dir);
    if (pkgCache.has(key)) return pkgCache.get(key);
    const pkgFile = join(key, 'package.json');
    const raw = safeReadUtf8(pkgFile);
    if (raw === null) {
      pkgCache.set(key, null);
      return null;
    }
    try {
      const parsed = JSON.parse(raw);
      const entry = {
        file: toPosix(relative(absRoot, pkgFile)),
        name: typeof parsed?.name === 'string' ? parsed.name : null,
        scripts: parsed && typeof parsed.scripts === 'object' && parsed.scripts !== null ? parsed.scripts : {},
      };
      pkgCache.set(key, entry);
      return entry;
    } catch {
      pkgCache.set(key, null);
      return null;
    }
  };

  const workspacesByName = new Map();
  const packagesDir = join(absRoot, 'packages');
  if (safeStat(packagesDir)?.isDirectory()) {
    try {
      for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || IGNORED_DIRS.has(entry.name)) continue;
        const dir = join(packagesDir, entry.name);
        workspacesByName.set(entry.name, dir);
        workspacesByName.set(`packages/${entry.name}`, dir);
        const pkg = readPackageJson(dir);
        if (pkg?.name) workspacesByName.set(pkg.name, dir);
      }
    } catch {
      // Ignore unreadable packages directory.
    }
  }

  const packageRootForDoc = docRel => {
    const match = /^packages\/([^/]+)\//.exec(docRel);
    if (!match) return null;
    const candidate = join(absRoot, 'packages', match[1]);
    return safeStat(candidate)?.isDirectory() ? candidate : null;
  };

  const resolveSectionDir = hint => {
    if (!hint) return null;
    const candidate = resolve(absRoot, hint);
    return isInsideRoot(absRoot, candidate) && safeStat(candidate)?.isDirectory() ? candidate : null;
  };

  return { absRoot, topDirs, readPackageJson, workspacesByName, packageRootForDoc, resolveSectionDir };
}

// --------------------------------------------------------------------------------------------- check 1: markdown links

function checkMarkdownLink(ctx, docRel, link, findings) {
  let target = link.rawTarget.trim();
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1).trim();
  if (!target) return;
  if (target.startsWith('#')) return;
  if (isExternalScheme(target)) return;
  if (/^[a-zA-Z]:[\\/]/.test(target)) return;
  if (hasTemplatePlaceholder(target)) return;

  const clean = target.split('#')[0].split('?')[0].trim();
  if (!clean) return;
  if (hasTemplatePlaceholder(clean) || hasGlobChars(clean)) return;

  const decoded = decodeUriSafe(clean);
  if (isGeneratedOrRuntimePath(decoded.replace(/^\/+/, ''))) return;

  const docDir = dirname(join(ctx.absRoot, docRel));
  const resolved = decoded.startsWith('/')
    ? resolve(ctx.absRoot, decoded.slice(1))
    : resolve(docDir, decoded);

  if (!isInsideRoot(ctx.absRoot, resolved)) {
    findings.push({
      file: docRel,
      line: link.line,
      kind: 'link',
      target,
      message: `Local markdown link resolves outside repository root: ${target}`,
    });
    return;
  }

  if (!pathExists(resolved)) {
    const expectedRel = toPosix(relative(ctx.absRoot, resolved));
    findings.push({
      file: docRel,
      line: link.line,
      kind: 'link',
      target,
      message: `Broken local markdown link "${target}" (expected ${expectedRel})`,
    });
  }
}

// --------------------------------------------------------------------------------------------- check 2: inline repo paths

function stripPathSuffix(token) {
  return token
    .replace(/#L?\d+(?:-L?\d+)?$/i, '')
    .replace(/#[A-Za-z0-9._-]+$/, '')
    .replace(/:\d+(?::\d+)?(?:-\d+)?$/, '');
}

function checkInlineRepoPath(ctx, docRel, span, findings) {
  let raw = span.text.trim();
  if (!raw || /\s/.test(raw)) return;

  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  if (!raw || /\s/.test(raw)) return;
  if (isExternalScheme(raw)) return;
  if (raw.startsWith('/') || raw.startsWith('~/') || raw.startsWith('~\\') || /^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('@')) return;
  if (hasTemplatePlaceholder(raw) || hasGlobChars(raw)) return;

  const stripped = stripPathSuffix(raw);
  if (!stripped || (!stripped.includes('/') && !stripped.includes('\\'))) return;

  if (stripped.startsWith('\\')) return;
  const posix = stripped.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!posix || posix.startsWith('../') || posix.startsWith('/')) return;
  if (isGeneratedOrRuntimePath(posix)) return;

  const firstSegment = posix.split('/')[0];
  const pkgRoot = ctx.packageRootForDoc(docRel) ?? ctx.resolveSectionDir(span.sectionCwdHint);
  const isKnownRoot = ctx.topDirs.has(firstSegment);
  const isPkgLocal = Boolean(pkgRoot && PKG_LOCAL_DIRS.has(firstSegment));

  if (!isKnownRoot && !isPkgLocal) return;

  const hasExplicitFileOrDir = FILE_EXT_RE.test(posix) || posix.endsWith('/');
  if (!hasExplicitFileOrDir) return;

  const cleanRel = posix.replace(/\/+$/, '');
  const rootCandidate = resolve(ctx.absRoot, cleanRel);
  if (isInsideRoot(ctx.absRoot, rootCandidate) && pathExists(rootCandidate)) return;

  if (pkgRoot) {
    const pkgCandidate = resolve(pkgRoot, cleanRel);
    if (isInsideRoot(ctx.absRoot, pkgCandidate) && pathExists(pkgCandidate)) return;
  }

  findings.push({
    file: docRel,
    line: span.line,
    kind: 'path',
    target: span.text,
    message: `Referenced repository path does not exist: ${cleanRel}`,
  });
}

// --------------------------------------------------------------------------------------------- check 3: commands

/** Split a shell line into command segments separated by `&&`, `||`, `;`, or `|` (respecting quotes). */
function splitShellSegments(commandLine, { isWindowsShell = false } = {}) {
  const segments = [];
  let current = '';
  let quote = '';
  for (let i = 0; i < commandLine.length; i += 1) {
    const ch = commandLine[i];
    if (!isWindowsShell && ch === '\\' && quote !== "'" && i + 1 < commandLine.length && SHELL_ESCAPABLE_RE.test(commandLine[i + 1])) {
      current += ch + commandLine[i + 1];
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(commandLine[i - 1]))) {
      break;
    }
    if (ch === ';' || ch === '|') {
      if (ch === '|' && commandLine[i + 1] === '|') i += 1;
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    if (ch === '&' && commandLine[i + 1] === '&') {
      i += 1;
      if (current.trim()) segments.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/** Tokenize a single shell command segment into unquoted argv tokens. */
function tokenizeShell(segment, { isWindowsShell = false } = {}) {
  const tokens = [];
  let current = '';
  let quote = '';
  let hasToken = false;
  for (let i = 0; i < segment.length; i += 1) {
    const ch = segment[i];
    if (!isWindowsShell && ch === '\\' && quote !== "'" && i + 1 < segment.length && SHELL_ESCAPABLE_RE.test(segment[i + 1])) {
      current += segment[i + 1];
      hasToken = true;
      i += 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        tokens.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) tokens.push(current);
  return tokens;
}

/** Strip leading shell prompts (`$ `, `> `, `PS> `) and env var assignments (`FOO=1`). */
function stripPromptAndEnv(tokens) {
  let start = 0;
  if (tokens[0] === '$' || tokens[0] === '>' || tokens[0] === 'PS>' || tokens[0] === '%') {
    start += 1;
  }
  while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) {
    start += 1;
  }
  if (tokens[start] === 'cross-env' || tokens[start] === 'env') {
    start += 1;
    while (start < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start])) {
      start += 1;
    }
  }
  return tokens.slice(start);
}

/** Remove shell I/O redirections (`> file`, `>> file`, `2>&1`, `< file`) from command tokens. */
function stripShellRedirections(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (/^(?:[0-9&]?>>?|<)$/.test(tok)) {
      i += 1; // skip redirect target filename
      continue;
    }
    if (/^(?:[0-9&]?>>?|<).+/.test(tok)) {
      continue;
    }
    out.push(tok);
  }
  return out;
}

function isCommandSpan(text) {
  const trimmed = text.trim().replace(/^(?:\$|PS>|%)\s+/, '');
  return /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+|cross-env\s+|env\s+)*(?:npm|node|cd)\b)/.test(trimmed);
}

function checkNpmCommand(ctx, docRel, lineNumber, tokens, state, findings) {
  let prefixDir = null;
  let workspace = null;
  let subcommand = null;
  let scriptName = null;

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '--') break;
    if (tok === '--prefix' && i + 1 < tokens.length) {
      prefixDir = tokens[++i];
      continue;
    }
    if (tok.startsWith('--prefix=')) {
      prefixDir = tok.slice('--prefix='.length);
      continue;
    }
    if ((tok === '-w' || tok === '--workspace') && i + 1 < tokens.length) {
      workspace = tokens[++i];
      continue;
    }
    if (tok.startsWith('--workspace=')) {
      workspace = tok.slice('--workspace='.length);
      continue;
    }
    if (tok.startsWith('-')) continue;
    if (!subcommand) {
      subcommand = tok;
      continue;
    }
    if ((subcommand === 'run' || subcommand === 'run-script') && !scriptName) {
      scriptName = tok;
    }
  }

  if (subcommand !== 'run' && subcommand !== 'run-script') return;
  if (!scriptName || hasTemplatePlaceholder(scriptName) || hasGlobChars(scriptName)) return;

  let targetDirs = [];
  let explicitTarget = false;
  if (prefixDir) {
    const normPrefix = prefixDir.replace(/\\/g, '/');
    if (hasTemplatePlaceholder(normPrefix) || isAbsolute(normPrefix) || normPrefix.startsWith('~')) return;
    if (state.cdActive && state.outsideRoot) return;
    explicitTarget = true;
    const base = state.cdActive ? state.cwd : ctx.absRoot;
    targetDirs = [resolve(base, normPrefix)];
  } else if (workspace) {
    if (hasTemplatePlaceholder(workspace)) return;
    explicitTarget = true;
    const mapped = ctx.workspacesByName.get(workspace);
    targetDirs = [mapped ?? resolve(ctx.absRoot, workspace)];
  } else if (state.cdActive) {
    if (state.outsideRoot) return;
    explicitTarget = true;
    targetDirs = [state.cwd];
  } else {
    targetDirs = [ctx.absRoot];
    if (state.pkgRoot && state.pkgRoot !== ctx.absRoot) {
      targetDirs.unshift(state.pkgRoot);
    }
  }

  if (targetDirs.every(dir => !isInsideRoot(ctx.absRoot, dir))) return;

  const validDirs = targetDirs.filter(dir => isInsideRoot(ctx.absRoot, dir));
  const pkgs = validDirs.map(dir => ({ dir, pkg: ctx.readPackageJson(dir) }));

  if (pkgs.some(entry => entry.pkg && Object.prototype.hasOwnProperty.call(entry.pkg.scripts, scriptName))) {
    return;
  }

  const primary = pkgs[0];
  const displayCmd = tokens.join(' ');
  if (explicitTarget && !primary.pkg) {
    const relPkg = toPosix(relative(ctx.absRoot, join(primary.dir, 'package.json')));
    findings.push({
      file: docRel,
      line: lineNumber,
      kind: 'command',
      target: displayCmd,
      message: `npm script "${scriptName}" references missing ${relPkg}`,
    });
    return;
  }

  const checkedFiles = pkgs.filter(entry => entry.pkg).map(entry => entry.pkg.file);
  const where = checkedFiles.length ? checkedFiles.join(' or ') : 'package.json';
  findings.push({
    file: docRel,
    line: lineNumber,
    kind: 'command',
    target: displayCmd,
    message: `npm script "${scriptName}" is not defined in ${where}`,
  });
}

function checkNodeCommand(ctx, docRel, lineNumber, rawTokens, state, findings) {
  // Ignore version constraints like `node >= 22.19` or `node v22.19`.
  if (rawTokens.length >= 2 && /^(?:>=|<=|>|<|==|=)$/.test(rawTokens[1])) return;

  const tokens = stripShellRedirections(rawTokens);
  let isTestMode = false;
  const positional = [];

  for (let i = 1; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === '--') break;
    if (tok === '-') return;
    if (NODE_NON_FILE_FLAGS.has(tok) || tok.startsWith('--eval=') || tok.startsWith('--print=')) return;
    if (tok === '--test') {
      isTestMode = true;
      continue;
    }
    if (NODE_VALUE_FLAGS.has(tok)) {
      i += 1;
      continue;
    }
    if (tok.startsWith('-')) continue;

    positional.push(tok);
    if (!isTestMode) break;
  }

  if (positional.length === 0) return;

  for (const rawPath of positional) {
    if (!rawPath || hasTemplatePlaceholder(rawPath) || hasGlobChars(rawPath)) continue;
    // Skip bare version specs (`node 22`, `node v22.19.0`, `node >=22.19`)
    if (/^[v^~>=<]*\d+(?:\.\d+)*(?:-[A-Za-z0-9.]+)?$/.test(rawPath)) continue;
    if (isExternalScheme(rawPath) || rawPath.startsWith('/') || rawPath.startsWith('~/') || /^[a-zA-Z]:[\\/]/.test(rawPath)) continue;

    const clean = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (isGeneratedOrRuntimePath(clean)) continue;

    if (state.cdActive && state.outsideRoot) continue;

    const candidateDirs = state.cdActive
      ? [state.cwd]
      : (state.pkgRoot && state.pkgRoot !== ctx.absRoot ? [state.pkgRoot, ctx.absRoot] : [ctx.absRoot]);

    if (candidateDirs.every(dir => !isInsideRoot(ctx.absRoot, dir))) continue;

    const found = candidateDirs.some(dir => {
      const resolved = resolve(dir, clean);
      return isInsideRoot(ctx.absRoot, resolved) && pathExists(resolved);
    });

    if (!found) {
      const expected = toPosix(relative(ctx.absRoot, resolve(candidateDirs[0], clean)));
      findings.push({
        file: docRel,
        line: lineNumber,
        kind: 'command',
        target: rawTokens.join(' '),
        message: `Node script target does not exist: ${rawPath} (expected ${expected})`,
      });
    }
  }
}

function processCommandLine(ctx, docRel, lineNumber, commandText, state, findings, { isWindowsShell = false } = {}) {
  const segments = splitShellSegments(commandText, { isWindowsShell });
  for (const segment of segments) {
    const rawTokens = tokenizeShell(segment, { isWindowsShell });
    if (!rawTokens.length) continue;
    const tokens = stripPromptAndEnv(rawTokens);
    if (!tokens.length) continue;

    const cmd = tokens[0];
    if (cmd === 'cd') {
      const rawDest = tokens[1];
      const dest = rawDest ? rawDest.replace(/\\/g, '/') : '';
      if (!rawDest || dest === '~' || dest.startsWith('~/') || /^[a-zA-Z]:\//.test(dest)) {
        state.cdActive = true;
        state.outsideRoot = true;
      } else if (dest === '-' || hasTemplatePlaceholder(rawDest)) {
        state.cwd = ctx.absRoot;
        state.cdActive = false;
        state.outsideRoot = false;
      } else if (isAbsolute(dest)) {
        state.cwd = resolve(dest);
        state.cdActive = true;
        state.outsideRoot = !isInsideRoot(ctx.absRoot, state.cwd);
      } else if (!state.outsideRoot) {
        if (!state.cdActive && state.cwd !== ctx.absRoot && pathExists(resolve(ctx.absRoot, dest))) {
          // A first `cd packages/foo` inside packages/foo/README.md assumes repo root.
          state.cwd = resolve(ctx.absRoot, dest);
        } else {
          state.cwd = resolve(state.cwd, dest);
        }
        state.cdActive = true;
        state.outsideRoot = !isInsideRoot(ctx.absRoot, state.cwd);
      }
      continue;
    }

    if (cmd === 'npm') {
      checkNpmCommand(ctx, docRel, lineNumber, tokens, state, findings);
    } else if (cmd === 'node') {
      checkNodeCommand(ctx, docRel, lineNumber, tokens, state, findings);
    }
  }
}

/** Combine backslash-continued shell lines while preserving the starting line number of each command. */
function joinContinuedShellLines(blockLines, { isWindowsShell = false } = {}) {
  const logical = [];
  let acc = '';
  let startLine = null;
  for (const entry of blockLines) {
    const trimmed = entry.text.trim();
    if (!acc) {
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
      startLine = entry.line;
    }
    const continued = !isWindowsShell && trimmed.endsWith('\\');
    if (continued) {
      acc += `${trimmed.slice(0, -1)} `;
    } else {
      acc += trimmed;
      logical.push({ line: startLine, text: acc });
      acc = '';
      startLine = null;
    }
  }
  if (acc && startLine != null) {
    logical.push({ line: startLine, text: acc });
  }
  return logical;
}

// --------------------------------------------------------------------------------------------- document & repo scanning

/** Scan a single markdown document string against `root`. */
export function scanDocument(root, docRel, content, ctx = createRepoContext(root)) {
  const findings = [];
  const parsed = parseMarkdown(content);
  const docPkgRoot = ctx.packageRootForDoc(docRel);

  for (const link of parsed.links) {
    checkMarkdownLink(ctx, docRel, link, findings);
  }

  for (const span of parsed.inlineCode) {
    if (!span.text) continue;
    if (isCommandSpan(span.text)) {
      const effectivePkgRoot = docPkgRoot ?? ctx.resolveSectionDir(span.sectionCwdHint);
      const state = { cwd: effectivePkgRoot ?? ctx.absRoot, cdActive: false, outsideRoot: false, pkgRoot: effectivePkgRoot };
      processCommandLine(ctx, docRel, span.line, span.text, state, findings);
    } else {
      checkInlineRepoPath(ctx, docRel, span, findings);
    }
  }

  for (const block of parsed.codeBlocks) {
    if (!SHELL_LANGUAGES.has(block.lang)) continue;
    const isWindowsShell = WINDOWS_SHELL_LANGUAGES.has(block.lang);
    const effectivePkgRoot = docPkgRoot ?? ctx.resolveSectionDir(block.sectionCwdHint);
    const state = { cwd: effectivePkgRoot ?? ctx.absRoot, cdActive: false, outsideRoot: false, pkgRoot: effectivePkgRoot };
    for (const logicalLine of joinContinuedShellLines(block.lines, { isWindowsShell })) {
      processCommandLine(ctx, docRel, logicalLine.line, logicalLine.text, state, findings, { isWindowsShell });
    }
  }

  return findings;
}

/** Scan all active docs under `root` and return structured report. */
export function scanRepo(root) {
  const absRoot = resolve(root);
  const ctx = createRepoContext(absRoot);
  const files = discoverDocFiles(absRoot);
  const findings = [];

  for (const docRel of files) {
    const content = safeReadUtf8(join(absRoot, docRel));
    if (content === null) continue;
    findings.push(...scanDocument(absRoot, docRel, content, ctx));
  }

  const seen = new Set();
  const deduped = [];
  for (const item of findings) {
    const key = `${item.file}\0${item.line}\0${item.kind}\0${item.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
  }
  deduped.sort((a, b) => compareText(a.file, b.file) || a.line - b.line || compareText(a.kind, b.kind) || compareText(a.target, b.target));

  return {
    filesScanned: files.length,
    findingsCount: deduped.length,
    findings: deduped,
  };
}

// --------------------------------------------------------------------------------------------- formatting & CI output

const escapeWorkflowData = value => String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeWorkflowProperty = value => escapeWorkflowData(value).replace(/:/g, '%3A').replace(/,/g, '%2C');
const escapeMarkdownCell = value => String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function formatAnnotations(report, { max = MAX_ANNOTATIONS, severity = 'warning' } = {}) {
  return (report?.findings ?? []).slice(0, max).map(finding => {
    const file = escapeWorkflowProperty(finding.file);
    const title = escapeWorkflowProperty(`doc-drift (${finding.kind})`);
    const message = escapeWorkflowData(finding.message);
    return `::${severity} file=${file},line=${finding.line},title=${title}::${message}`;
  });
}

export function renderConsoleReport(report) {
  if (report.findingsCount === 0) {
    return `Doc drift (advisory): 0 finding(s) across ${report.filesScanned} scanned markdown file(s).`;
  }
  const byKind = { link: 0, path: 0, command: 0 };
  for (const f of report.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  const lines = [
    `Doc drift (advisory): ${report.findingsCount} finding(s) across ${report.filesScanned} scanned markdown file(s) (links: ${byKind.link}, paths: ${byKind.path}, commands: ${byKind.command}).`,
    '',
  ];
  for (const f of report.findings) {
    lines.push(`  ${f.file}:${f.line} [${f.kind}] ${f.message}`);
  }
  return lines.join('\n');
}

export function renderSummaryMarkdown(report, { maxRows = 50 } = {}) {
  if (report.findingsCount === 0) {
    return [
      '## Doc drift check (advisory, non-blocking)',
      '',
      `Scanned **${report.filesScanned}** markdown file(s) and found **0** drift finding(s).`,
    ].join('\n');
  }

  const byKind = { link: 0, path: 0, command: 0 };
  for (const f of report.findings) byKind[f.kind] = (byKind[f.kind] ?? 0) + 1;

  const lines = [
    '## Doc drift check (advisory, non-blocking)',
    '',
    `Scanned **${report.filesScanned}** markdown file(s) and found **${report.findingsCount}** drift finding(s) (links: ${byKind.link}, paths: ${byKind.path}, commands: ${byKind.command}).`,
    'This check is **advisory only** and never blocks merge.',
    '',
    '| File | Line | Kind | Target | Message |',
    '| ---- | ---- | ---- | ------ | ------- |',
    ...report.findings.slice(0, maxRows).map(f =>
      `| \`${escapeMarkdownCell(f.file)}\` | ${f.line} | ${f.kind} | \`${escapeMarkdownCell(f.target)}\` | ${escapeMarkdownCell(f.message)} |`,
    ),
  ];

  if (report.findingsCount > maxRows) {
    lines.push('', `…and ${report.findingsCount - maxRows} more finding(s) (run \`node scripts/doc-drift.mjs --json\` for the full list).`);
  }
  return lines.join('\n');
}

function appendStepSummary(env, content, { advisory = true, log = console.log } = {}) {
  const summaryFile = env?.GITHUB_STEP_SUMMARY;
  if (!summaryFile) return false;
  try {
    let prefix = '';
    if (existsSync(summaryFile)) {
      const existing = readFileSync(summaryFile, 'utf8');
      if (existing.length > 0 && !existing.endsWith('\n\n')) {
        prefix = existing.endsWith('\n') ? '\n' : '\n\n';
      }
    }
    const suffix = content.endsWith('\n') ? '' : '\n';
    appendFileSync(summaryFile, `${prefix}${content}${suffix}`, 'utf8');
    return true;
  } catch (error) {
    if (!advisory) throw error;
    log(`Doc drift (advisory): could not append to GITHUB_STEP_SUMMARY (${error.message}); continuing (non-blocking).`);
    return false;
  }
}

export function parseArgs(argv) {
  const options = {
    root: null,
    json: false,
    annotations: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') options.json = true;
    else if (arg === '--annotations') options.annotations = true;
    else if (arg === '--strict') options.strict = true;
    else if (arg === '--root') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) throw new Error('--root requires a directory path');
      options.root = resolve(next);
      i += 1;
    } else if (arg.startsWith('--root=')) {
      const val = arg.slice('--root='.length);
      if (!val) throw new Error('--root requires a directory path');
      options.root = resolve(val);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

export function run(argv = process.argv.slice(2), { log = console.log, env = process.env } = {}) {
  const options = parseArgs(argv);
  const root = options.root ?? fileURLToPath(new URL('../', import.meta.url));
  const report = scanRepo(root);

  if (options.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(renderConsoleReport(report));
    if (options.annotations && report.findingsCount > 0) {
      const annotations = formatAnnotations(report, { max: MAX_ANNOTATIONS });
      for (const line of annotations) log(line);
      if (report.findingsCount > annotations.length) {
        log(`Doc drift (advisory): omitted ${report.findingsCount - annotations.length} additional annotation(s) (cap ${MAX_ANNOTATIONS}).`);
      }
    }
    appendStepSummary(env, renderSummaryMarkdown(report), { advisory: !options.strict, log });
  }

  const exitCode = options.strict && report.findingsCount > 0 ? 1 : 0;
  return { report, exitCode };
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedDirectly) {
  try {
    process.exitCode = run().exitCode;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
