#!/usr/bin/env node
/* skill-forge check-skills: size, trigger and structure budgets for every skill under a skills root. Errors fail (exit 1), warnings do not. */
import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { intOption, isMain, parseCli, runMain } from './forge-lib.mjs';

export const DEFAULT_LIMITS = {
  maxDescription: 1024, warnDescription: 400, maxSkillBytes: 8000, warnSkillBytes: 6000, warnRefBytes: 12000, maxTotalDescription: 3000, refTocLines: 100,
};
const ALLOWED_TOP = new Set(['SKILL.md', 'scripts', 'references', 'assets']);
const NAME_RE = /^[a-z0-9-]{1,64}$/;
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TOKEN_NOTE = 'tokens are an estimate: ASCII chars / 4 + CJK chars x 1';
const CJK = /[　-〿぀-ヿ㐀-䶿一-鿿가-힯豈-﫿＀-￯]/gu;

const USAGE = `Usage: node check-skills.mjs [--root .claude/skills] [--taxonomy <file>] [--json] [limit flags]

Checks every directory under --root (default: the skills directory this script lives in):
  SKILL.md exists; frontmatter name equals the directory and matches ^[a-z0-9-]{1,64}$; description is not empty
  (error over ${DEFAULT_LIMITS.maxDescription} chars, warning over ${DEFAULT_LIMITS.warnDescription}); SKILL.md error over ${DEFAULT_LIMITS.maxSkillBytes} bytes, warning over ${DEFAULT_LIMITS.warnSkillBytes};
  only SKILL.md, scripts/, references/, assets/ at the top level; every file in references/ is mentioned in SKILL.md and every
  references/... path SKILL.md mentions exists; a reference over ${DEFAULT_LIMITS.refTocLines} lines has a Contents heading in its first 20 lines;
  reference warning over ${DEFAULT_LIMITS.warnRefBytes} bytes; all descriptions together error over ${DEFAULT_LIMITS.maxTotalDescription} chars;
  every "- [Cnn] question" line equals class Cnn's "- Catch:" line in --taxonomy (default <root>/../../docs/agent-lessons/taxonomy.md; skipped if absent).
Prints bytes and an estimated token count per file (${TOKEN_NOTE}). Exit 1 on errors only.
Limit flags: --max-description --warn-description --max-skill-bytes --warn-skill-bytes --warn-ref-bytes --max-total-description --ref-toc-lines`;

/** ASCII (and other non-CJK) chars / 4 plus one token per CJK char, rounded up. A rough guide, not a tokenizer. */
export function estimateTokens(text) {
  const cjk = (text.match(CJK) ?? []).length;
  return Math.ceil((text.length - cjk) / 4 + cjk);
}

const unquote = v => (/^(["']).*\1$/s.test(v) && v.length >= 2 ? v.slice(1, -1) : v);

/** Minimal frontmatter reader: top-level `key: value`, quoted values, and folded/literal/indented continuation lines. */
export function parseFrontmatter(text) {
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { data: null };
  const data = {};
  let key = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+):[ \t]*(.*)$/.exec(line);
    if (kv && !/^\s/.test(line)) {
      key = kv[1];
      data[key] = /^[>|][+-]?$/.test(kv[2].trim()) ? '' : unquote(kv[2].trim());
    } else if (key && /^\s+\S/.test(line)) {
      data[key] = `${data[key]} ${line.trim()}`.trim();
    }
  }
  return { data };
}

async function walk(dir, base = '') {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

const mentionedReferences = text => new Set([...text.matchAll(/references\/[A-Za-z0-9_\-./一-鿿]+/g)]
  .map(m => m[0]).filter(p => !p.endsWith('/')).map(p => p.replace(/[.-]+$/, '')));

async function checkOne(root, name, limits, report) {
  const dir = join(root, name);
  const skillPath = join(dir, 'SKILL.md');
  const issue = (level, path, message) => report.issues.push({ level, path: `${name}/${path}`.replace(/\/$/, ''), message });
  const addFile = (path, text) => report.files.push({ path: `${name}/${path}`, bytes: Buffer.byteLength(text), tokens: estimateTokens(text) });

  for (const entry of await readdir(dir)) {
    if (!ALLOWED_TOP.has(entry)) issue('error', entry, `unexpected top-level entry "${entry}" (only SKILL.md, scripts/, references/, assets/ are allowed)`);
  }
  if (!existsSync(skillPath)) {
    issue('error', 'SKILL.md', 'SKILL.md is missing');
    return;
  }
  const text = await readFile(skillPath, 'utf8');
  addFile('SKILL.md', text);
  const bytes = Buffer.byteLength(text);
  if (bytes > limits.maxSkillBytes) issue('error', 'SKILL.md', `SKILL.md is ${bytes} bytes, over the ${limits.maxSkillBytes} limit`);
  else if (bytes > limits.warnSkillBytes) issue('warn', 'SKILL.md', `SKILL.md is ${bytes} bytes, over the recommended ${limits.warnSkillBytes}`);

  const { data } = parseFrontmatter(text);
  if (!data) {
    issue('error', 'SKILL.md', 'frontmatter is missing (SKILL.md must start with a --- block holding name and description)');
  } else {
    if (data.name !== name) issue('error', 'SKILL.md', `frontmatter name "${data.name ?? ''}" must equal the directory name "${name}" (mismatch)`);
    if (!NAME_RE.test(data.name ?? '')) issue('error', 'SKILL.md', `frontmatter name "${data.name ?? ''}" must match [a-z0-9-]{1,64}`);
    const description = data.description ?? '';
    report.skills.push({ name, descriptionChars: description.length });
    if (!description.trim()) issue('error', 'SKILL.md', 'frontmatter description is empty');
    else if (description.length > limits.maxDescription) issue('error', 'SKILL.md', `description is ${description.length} chars, over the ${limits.maxDescription} limit`);
    else if (description.length > limits.warnDescription) issue('warn', 'SKILL.md', `description is ${description.length} chars, over the recommended ${limits.warnDescription}`);
  }

  const refsDir = join(dir, 'references');
  const refs = existsSync(refsDir) ? (await walk(refsDir)).map(f => `references/${f}`) : [];
  const mentioned = mentionedReferences(text);
  for (const ref of refs) {
    const refText = await readFile(join(dir, ref), 'utf8');
    addFile(ref, refText);
    const refBytes = Buffer.byteLength(refText);
    if (!mentioned.has(ref)) issue('error', ref, `${ref} is not mentioned in SKILL.md (a reference nobody links is never read)`);
    if (refBytes > limits.warnRefBytes) issue('warn', ref, `${ref} is ${refBytes} bytes, over the recommended ${limits.warnRefBytes}`);
    const lines = refText.replace(/\r?\n$/, '').split(/\r?\n/);
    if (lines.length > limits.refTocLines && !lines.slice(0, 20).some(l => /^#{1,6}\s*(table of contents|contents|目录)\s*$/i.test(l))) {
      issue('error', ref, `${ref} has ${lines.length} lines but no "Contents" heading in its first 20 lines`);
    }
  }
  for (const ref of mentioned) if (!refs.includes(ref)) issue('error', 'SKILL.md', `SKILL.md mentions ${ref}, which does not exist`);

  if (report.catches) {
    for (const [, id, question] of text.matchAll(/^- \[(C\d\d)\] (.*?)\s*$/gm)) {
      if (!report.catches.has(id)) issue('error', 'SKILL.md', `question [${id}] names a class that is not in the taxonomy`);
      else if (report.catches.get(id) !== question) issue('error', 'SKILL.md', `question [${id}] differs from the taxonomy Catch line; copy the Catch text exactly (the taxonomy is the source)`);
    }
  }
}

/** Reads `## Cnn …` entries and their `- Catch:` lines from a taxonomy file. Returns null when the file does not exist. */
export async function readCatches(path) {
  if (!path || !existsSync(path)) return null;
  const catches = new Map();
  let id = null;
  for (const line of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const head = /^## (C\d\d) /.exec(line);
    if (head) id = head[1];
    const catchLine = /^- Catch: (.*?)\s*$/.exec(line);
    if (catchLine && id && !catches.has(id)) catches.set(id, catchLine[1]);
  }
  return catches;
}

/** Runs every check. Returns { root, skills, files, issues, totalDescription }; `issues` items are { level: 'error'|'warn', path, message }. */
export async function checkSkills(root, overrides = {}) {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  if (!existsSync(root) || !(await stat(root)).isDirectory()) throw new Error(`skills root not found: ${root}`);
  const taxonomy = limits.taxonomy ?? resolve(root, '../../docs/agent-lessons/taxonomy.md');
  const report = { root, skills: [], files: [], issues: [], totalDescription: 0, catches: await readCatches(taxonomy) };
  const names = (await readdir(root, { withFileTypes: true })).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name).sort();
  for (const name of names) await checkOne(root, name, limits, report);
  delete report.catches;
  report.totalDescription = report.skills.reduce((s, k) => s + k.descriptionChars, 0);
  if (report.totalDescription > limits.maxTotalDescription) {
    report.issues.push({ level: 'error', path: '(all skills)', message: `descriptions total ${report.totalDescription} chars across ${report.skills.length} skills, over the ${limits.maxTotalDescription} limit` });
  }
  return report;
}

function render(report) {
  const lines = [`skills root: ${report.root}`, `descriptions: ${report.totalDescription} chars across ${report.skills.length} skills`, '', `${'file'.padEnd(52)} ${'bytes'.padStart(7)} ${'~tokens'.padStart(8)}`];
  for (const f of report.files) lines.push(`${f.path.padEnd(52)} ${String(f.bytes).padStart(7)} ${String(f.tokens).padStart(8)}`);
  lines.push(`(${TOKEN_NOTE})`, '');
  for (const i of report.issues) lines.push(`${i.level}: ${i.path}: ${i.message}`);
  const errors = report.issues.filter(i => i.level === 'error').length;
  lines.push(`${errors} error(s), ${report.issues.length - errors} warning(s)`);
  return lines.join('\n');
}

async function main() {
  const { values } = parseCli(process.argv.slice(2), {
    root: { type: 'string' }, json: { type: 'boolean' }, 'max-description': { type: 'string' }, 'warn-description': { type: 'string' },
    'max-skill-bytes': { type: 'string' }, 'warn-skill-bytes': { type: 'string' }, 'warn-ref-bytes': { type: 'string' },
    'max-total-description': { type: 'string' }, 'ref-toc-lines': { type: 'string' }, taxonomy: { type: 'string' },
  });
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const limits = {
    maxDescription: intOption(values, 'max-description', DEFAULT_LIMITS.maxDescription), warnDescription: intOption(values, 'warn-description', DEFAULT_LIMITS.warnDescription),
    maxSkillBytes: intOption(values, 'max-skill-bytes', DEFAULT_LIMITS.maxSkillBytes), warnSkillBytes: intOption(values, 'warn-skill-bytes', DEFAULT_LIMITS.warnSkillBytes),
    warnRefBytes: intOption(values, 'warn-ref-bytes', DEFAULT_LIMITS.warnRefBytes), maxTotalDescription: intOption(values, 'max-total-description', DEFAULT_LIMITS.maxTotalDescription),
    refTocLines: intOption(values, 'ref-toc-lines', DEFAULT_LIMITS.refTocLines),
    ...(values.taxonomy ? { taxonomy: resolve(values.taxonomy) } : {}),
  };
  const report = await checkSkills(resolve(values.root ?? DEFAULT_ROOT), limits);
  const failed = report.issues.some(i => i.level === 'error');
  console.log(values.json ? JSON.stringify({ ...report, estimate: true, estimateNote: TOKEN_NOTE }, null, 2) : render(report));
  return failed ? 1 : 0;
}

if (isMain(import.meta.url)) await runMain(main);
