import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REPO_ROOT_PREFIXES = [
  "lib/",
  "ui/",
  "scripts/",
  "tests/",
  "docs/",
  "packages/",
  "presets/",
  "locale/",
  "references/",
  ".agents/",
  ".claude/",
  ".github/",
  "changes/",
  "skills/",
];

const PACKAGE_RELATIVE_PREFIXES = ["src/", "tests/", "docs/", "scripts/", "bin/"];

/**
 * Historical/archive snapshots whose prose intentionally records filenames
 * from earlier commits or consolidated test suites. Path checks skip only
 * these explicitly archived snapshots; command and CLI checks still run on all docs.
 */
const HISTORICAL_PATH_DOCS = new Set([
  "CHANGELOG.md",
  "CHANGELOG.zh-CN.md",
  "docs/performance-2026-09-16.md",
  "docs/repair-2026-09-14.md",
  "docs/studyhub-workflow-verification.md",
  "docs/verification.md",
  "packages/studyhub-desktop/docs/m0-audit.md",
  "packages/studyhub-tui/docs/PR1297-REVIEW.md",
  "packages/studyhub-tui/docs/ROADMAP-21-40.md",
  "packages/studyhub-tui/docs/ROADMAP-41-50.md",
  "packages/studyhub-tui/docs/ROADMAP-51-55.md",
  "packages/studyhub-tui/docs/ROADMAP-56-60.md",
  "packages/studyhub-tui/docs/ROADMAP-61-65.md",
  "packages/studyhub-tui/docs/ROADMAP-66-70.md",
  "packages/studyhub-tui/docs/ROADMAP-82-100.md",
]);

/**
 * Explicit, minimal allowlist of non-existent paths referenced in active docs
 * (e.g., gitignored build outputs). Keep each entry justified with a short comment.
 */
const ALLOWED_MISSING_PATHS = new Set([
  // Build/runtime output directories and generated client bundle (gitignored; produced by `npm run build`)
  "dist/",
  "output/",
  "lib/client.js",
]);

/**
 * Root-level docs whose TUI-specific examples invoke package-relative `tests/...`
 * paths executed from inside a package directory. We still verify those files
 * exist inside the listed package root.
 */
const EXTRA_PACKAGE_ROOTS_FOR_DOC = new Map([
  ["docs/test-audit-gate.md", ["packages/studyhub-tui"]],
]);

const ALLOWED_MISSING_COMMANDS = new Set([]);

function toPosix(p) {
  return p.replace(/\\/g, "/");
}

async function listDirMd(dirRel) {
  const full = join(ROOT, dirRel);
  if (!existsSync(full)) return [];
  const entries = await readdir(full, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `${dirRel}/${e.name}`);
}

async function collectTargetDocs() {
  const docs = new Set();

  for (const name of ["README.md", "README.zh-CN.md", "CHANGELOG.md", "CHANGELOG.zh-CN.md"]) {
    if (existsSync(join(ROOT, name))) docs.add(name);
  }
  for (const f of await listDirMd("docs")) docs.add(f);

  const pkgsDir = join(ROOT, "packages");
  if (existsSync(pkgsDir)) {
    const pkgs = await readdir(pkgsDir, { withFileTypes: true });
    for (const pkg of pkgs) {
      if (!pkg.isDirectory()) continue;
      const base = `packages/${pkg.name}`;
      for (const topDoc of ["README.md", "ARCHITECTURE.md"]) {
        if (existsSync(join(ROOT, base, topDoc))) docs.add(`${base}/${topDoc}`);
      }
      for (const f of await listDirMd(`${base}/docs`)) docs.add(f);
      // Nested sub-modules (e.g. packages/studyhub-spring/*)
      const subEntries = await readdir(join(ROOT, base), { withFileTypes: true });
      for (const sub of subEntries) {
        if (!sub.isDirectory() || sub.name === "docs" || sub.name === "node_modules") continue;
        if (existsSync(join(ROOT, base, sub.name, "README.md"))) {
          docs.add(`${base}/${sub.name}/README.md`);
        }
      }
    }
  }

  for (const skillRoot of [".agents/skills", ".claude/skills"]) {
    const abs = join(ROOT, skillRoot);
    if (!existsSync(abs)) continue;
    for (const entry of await readdir(abs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const candidate = `${skillRoot}/${entry.name}/SKILL.md`;
      if (existsSync(join(ROOT, candidate))) docs.add(candidate);
    }
  }

  if (existsSync(join(ROOT, "scripts/report/README.md"))) {
    docs.add("scripts/report/README.md");
  }

  return [...docs].sort();
}

function packageRootForDoc(docRel) {
  const m = /^(packages\/[^/]+)\//.exec(docRel);
  return m ? m[1] : null;
}

function stripFencedCodeBlocks(text) {
  const lines = text.split(/\r?\n/);
  const out = [];
  let inFence = false;
  let fenceChar = "";
  for (const line of lines) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceChar = m[1][0];
      } else if (m[1][0] === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      out.push("");
      continue;
    }
    out.push(inFence ? "" : line);
  }
  return out.join("\n");
}

/** The lines inside fenced code blocks: the examples a reader copies into a terminal (same fence rules as stripFencedCodeBlocks). */
function fencedCodeLines(text) {
  const out = [];
  let inFence = false;
  let fenceChar = "";
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!inFence) {
        inFence = true;
        fenceChar = m[1][0];
      } else if (m[1][0] === fenceChar) {
        inFence = false;
        fenceChar = "";
      }
      continue;
    }
    if (inFence) out.push(line);
  }
  return out;
}

/** In a fenced example, the token after one of these names a file the command writes, so it need not exist before the command runs. */
const OUTPUT_TOKENS = new Set([">", ">>", "1>", "2>", "&>", "-o", "--out", "--output", "--out-dir", "--outfile", "tee"]);
/** A fenced line that starts with one of these creates, moves or removes files, so its paths are not required to exist. */
const FILE_CREATING_COMMANDS = new Set(["cp", "mv", "mkdir", "touch", "rm", "ln"]);

function isPlaceholderPath(p) {
  return (
    /[<>*?{}[\]$]/.test(p) ||
    p.includes("...") ||
    p.includes("YYYY") ||
    p.includes("x.y.z") ||
    p.includes("your-") ||
    p.includes("node_modules/")
  );
}

function cleanCandidatePath(raw) {
  let p = raw.trim();
  // Drop wrapping quotes/parens/punctuation
  p = p.replace(/^['"(]+/, "").replace(/[',.);:!?)]+$/, "");
  // Strip #anchor and :line or :line-line suffix
  p = p.split("#")[0];
  p = p.replace(/:\d+(?:[-–,]\d+)*$/, "");
  p = p.replace(/^\.\//, "");
  return toPosix(p);
}

function extractRepoPaths(docRel, content) {
  const found = [];
  const prose = stripFencedCodeBlocks(content);
  const pkgRoot = packageRootForDoc(docRel);

  const checkToken = (raw, sourceKind) => {
    const cleaned = cleanCandidatePath(raw);
    if (!cleaned || isPlaceholderPath(cleaned)) return;
    if (/^[a-z]+:\/\//i.test(cleaned) || cleaned.startsWith("mailto:") || cleaned.startsWith("data:")) return;

    const isRootPrefixed = REPO_ROOT_PREFIXES.some((pre) => cleaned.startsWith(pre));
    const isPkgPrefixed = pkgRoot && PACKAGE_RELATIVE_PREFIXES.some((pre) => cleaned.startsWith(pre));

    if (!isRootPrefixed && !isPkgPrefixed) return;
    // Skip paths that contain spaces (usually prose snippets inside backticks)
    if (/\s/.test(cleaned)) return;
    // Skip directory-only top-level prefixes like "lib/" with no filename unless explicitly checked
    if (cleaned.endsWith("/")) return;
    // Require a file extension (or well-known extensionless file) to avoid matching arbitrary prose tokens
    if (!/\.[A-Za-z0-9]{1,8}$/.test(cleaned)) return;

    found.push({ path: cleaned, kind: sourceKind });
  };

  // 1) Inline backtick spans in prose
  for (const m of prose.matchAll(/`([^`\n]+)`/g)) {
    const inner = m[1].trim();
    // Handle multi-token command snippets inside backticks by scanning whitespace-separated tokens
    for (const token of inner.split(/\s+/)) {
      checkToken(token, "backtick");
    }
  }

  // 2b) Fenced examples: the commands a reader copies must name files that exist, like the prose does. A token is left out when it is a placeholder,
  //    a glob, a Windows path (backslash), or a file the command itself creates (redirection, -o, cp/mv/mkdir/touch/rm).
  for (const line of fencedCodeLines(content)) {
    const tokens = line.trim().replace(/^\$\s+/, "").split(/\s+/);
    if (FILE_CREATING_COMMANDS.has(tokens[0])) continue;
    tokens.forEach((token, index) => {
      if (token.includes("\\") || OUTPUT_TOKENS.has(tokens[index - 1])) return;
      checkToken(token, "fenced");
    });
  }

  // 2) Markdown links [label](target)
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1].trim();
    if (!target || target.startsWith("#") || /^[a-z]+:\/\//i.test(target) || target.startsWith("mailto:")) continue;
    const targetNoHash = target.split("#")[0];
    if (!targetNoHash || isPlaceholderPath(targetNoHash)) continue;
    const resolved = toPosix(relative(ROOT, resolve(ROOT, dirname(docRel), targetNoHash)));
    if (!resolved.startsWith("..")) {
      found.push({ path: resolved, kind: "link", alreadyResolved: true });
    }
  }

  return found;
}

function resolvePathCandidates(docRel, entry) {
  const p = entry.path;
  if (entry.alreadyResolved) {
    return [join(ROOT, p)];
  }
  const candidates = [];
  const pkgRoot = packageRootForDoc(docRel);
  const docDir = dirname(docRel);

  // If doc lives in a package and path starts with a package-relative prefix (src/, tests/, etc.), check package root first
  if (pkgRoot) {
    candidates.push(join(ROOT, pkgRoot, p));
    // Also support nested sub-package (e.g. packages/studyhub-spring/studyhub-retrieval/README.md)
    if (docDir !== pkgRoot) {
      candidates.push(join(ROOT, docDir, p));
    }
  }
  // Check skill-relative paths (e.g. references/... inside .claude/skills/<name>/SKILL.md)
  if (docRel.startsWith(".claude/skills/") || docRel.startsWith(".agents/skills/")) {
    candidates.push(join(ROOT, docDir, p));
  }
  // Check explicitly scoped package roots for cross-package root docs (still verifies file exists)
  for (const extraPkg of EXTRA_PACKAGE_ROOTS_FOR_DOC.get(docRel) || []) {
    candidates.push(join(ROOT, extraPkg, p));
  }
  // Check repo root
  candidates.push(join(ROOT, p));
  return candidates;
}

async function loadPackageScripts() {
  const map = new Map();
  const pkgFiles = [
    "package.json",
    "packages/studyhub-desktop/package.json",
    "packages/studyhub-retrieval/package.json",
    "packages/studyhub-tui/package.json",
  ];
  for (const rel of pkgFiles) {
    const full = join(ROOT, rel);
    if (!existsSync(full)) continue;
    const json = JSON.parse(await readFile(full, "utf8"));
    const key = dirname(rel) === "." ? "" : toPosix(dirname(rel));
    map.set(key, new Set(Object.keys(json.scripts || {})));
  }
  return map;
}

test("docs path audit: backticked and linked repository file paths exist on disk", async () => {
  const docs = await collectTargetDocs();
  assert.ok(docs.length >= 100, `expected >= 100 target docs, found ${docs.length}`);

  const failures = [];
  for (const docRel of docs) {
    if (HISTORICAL_PATH_DOCS.has(docRel)) continue;
    const content = await readFile(join(ROOT, docRel), "utf8");
    const refs = extractRepoPaths(docRel, content);

    for (const ref of refs) {
      if (ALLOWED_MISSING_PATHS.has(ref.path) || [...ALLOWED_MISSING_PATHS].some((a) => a.endsWith("/") && ref.path.startsWith(a))) {
        continue;
      }
      // A file under a build-output folder (Maven `target/`) exists only after the build the doc tells the reader to run.
      if (ref.kind === "fenced" && /\/target\//.test(ref.path)) continue;
      const candidates = resolvePathCandidates(docRel, ref);
      const exists = candidates.some((c) => existsSync(c));
      if (!exists) {
        failures.push(`${docRel} (${ref.kind}): ${ref.path}`);
      }
    }
  }

  assert.deepEqual(failures, [], `Missing repo file paths referenced in docs:\n${failures.join("\n")}`);
});

test("docs command audit: npm/pnpm run scripts exist in package.json", async () => {
  const docs = await collectTargetDocs();
  const scriptsByPkg = await loadPackageScripts();
  const rootScripts = scriptsByPkg.get("") || new Set();

  const failures = [];
  const prefixCmdRe = /\b(?:npm|pnpm)\s+--prefix\s+([^\s`]+)\s+run\s+(?:(?:-s|--silent|--if-present)\s+)*([A-Za-z0-9:_-]+)(\*)?/g;
  const plainCmdRe = /\b(?:npm|pnpm)\s+run\s+(?:(?:-s|--silent|--if-present)\s+)*([A-Za-z0-9:_-]+)(\*)?/g;

  const hasScript = (set, name, isWildcard) => {
    if (!set) return false;
    if (!isWildcard) return set.has(name);
    for (const s of set) {
      if (s.startsWith(name)) return true;
    }
    return false;
  };

  for (const docRel of docs) {
    const content = await readFile(join(ROOT, docRel), "utf8");
    const pkgRoot = packageRootForDoc(docRel);
    const pkgScripts = pkgRoot ? scriptsByPkg.get(pkgRoot) || new Set() : new Set();

    // Check explicit --prefix runs
    for (const m of content.matchAll(prefixCmdRe)) {
      const prefix = toPosix(normalize(m[1])).replace(/^\.\//, "").replace(/\/$/, "");
      const scriptName = m[2];
      const isWildcard = m[3] === "*";
      if (ALLOWED_MISSING_COMMANDS.has(`${docRel}:${scriptName}`)) continue;
      const targetScripts = scriptsByPkg.get(prefix);
      if (!hasScript(targetScripts, scriptName, isWildcard)) {
        failures.push(`${docRel}: npm --prefix ${prefix} run ${scriptName}${isWildcard ? "*" : ""}`);
      }
    }

    // Remove --prefix invocations before matching plain `npm run <script>`
    const stripped = content.replace(prefixCmdRe, "");
    for (const m of stripped.matchAll(plainCmdRe)) {
      const scriptName = m[1];
      const isWildcard = m[2] === "*";
      if (ALLOWED_MISSING_COMMANDS.has(`${docRel}:${scriptName}`)) continue;
      const ok = hasScript(rootScripts, scriptName, isWildcard) || hasScript(pkgScripts, scriptName, isWildcard);
      if (!ok) {
        failures.push(`${docRel}: npm/pnpm run ${scriptName}${isWildcard ? "*" : ""}`);
      }
    }
  }

  assert.deepEqual(failures, [], `Unknown npm/pnpm scripts referenced in docs:\n${failures.join("\n")}`);
});

test("docs CLI audit: node script invocations target existing files", async () => {
  const docs = await collectTargetDocs();
  const failures = [];
  // `node [--flag ...] <file> [<file> ...]`: flags without a value (`--test`) may come first, and `node --test tests/a.test.mjs tests/b.test.mjs` names several files.
  const targetSource = String.raw`(?:\.[\\/])?(?:scripts|packages|evals|bin|tests|lib|studyhub-[a-z-]+)[\\/][A-Za-z0-9_.\-/\\]+\.(?:mjs|cjs|js)`;
  const nodeRe = new RegExp(String.raw`\bnode\s+(?:--?[A-Za-z][\w=.:-]*\s+)*(${targetSource}(?:[ \t]+${targetSource})*)\b`, "g");

  for (const docRel of docs) {
    const content = await readFile(join(ROOT, docRel), "utf8");
    const pkgRoot = packageRootForDoc(docRel);
    const docDir = dirname(docRel);

    for (const m of content.matchAll(nodeRe)) {
      for (const raw of m[1].split(/[ \t]+/)) {
        const target = toPosix(raw).replace(/^\.\//, "");
        if (isPlaceholderPath(target)) continue;
        const candidates = [join(ROOT, target)];
        if (pkgRoot) candidates.push(join(ROOT, pkgRoot, target));
        if (docDir && docDir !== ".") candidates.push(join(ROOT, docDir, target));
        for (const extraPkg of EXTRA_PACKAGE_ROOTS_FOR_DOC.get(docRel) || []) candidates.push(join(ROOT, extraPkg, target));
        if (!candidates.some((c) => existsSync(c))) {
          failures.push(`${docRel}: node ${target}`);
        }
      }
    }
  }

  assert.deepEqual(failures, [], `Missing CLI scripts invoked in docs:\n${failures.join("\n")}`);
});
