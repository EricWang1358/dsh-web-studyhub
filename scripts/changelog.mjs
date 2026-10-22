#!/usr/bin/env node
/* The changelog of the next release is kept as fragments, one pair of files per change, so that pull requests never edit the same lines of
   CHANGELOG.md and CHANGELOG.zh-CN.md (one merged PR made every other open PR conflict and run CI again). changes/README.md says how to write one.

   changes/unreleased/<slug>.en.md + <slug>.zh-CN.md            one bullet: "- **What changed.** What a learner notices ... Not verified: ..."
                                                                (未验证：... in Chinese); --check fails a change without that line
   changes/unreleased/<slug>.note.en.md + <slug>.note.zh-CN.md  a paragraph after the bullets: "Upgrading: ...", "Known issue: ..."

   node scripts/changelog.mjs --check                        every fragment is well formed and has both languages
   node scripts/changelog.mjs --preview <version> [--lang=zh-CN]  prints the section the release adds (English by default), or that section of the
                                                             changelog once it is released: the gh release notes
   node scripts/changelog.mjs --release <version> <date>     writes "## <version> — <date>" with the fragments into both changelogs, deletes the fragments
                                                             and seals the changelogs (changes/released.json)
   node scripts/changelog.mjs --seal                         the release commit only, after a released section was corrected by hand
   (--check also fails when a changelog no longer matches its seal: it was edited outside a release.)
   (--root=<dir> works on another checkout; the tests use it.)

   Order: by the commit that added each change (git log --diff-filter=A, oldest first), the same in both languages; changes added in the
   same commit, and files git does not know yet, by name. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANGS = ['en', 'zh-CN'];
const CHANGELOGS = { en: 'CHANGELOG.md', 'zh-CN': 'CHANGELOG.zh-CN.md' };
export const FRAGMENTS_DIR = 'changes/unreleased';
const NAME = /^(?<slug>[a-z0-9][a-z0-9-]*)(?<note>\.note)?\.(?<lang>en|zh-CN)\.md$/;
const KEEP = new Set(['.gitkeep']);
/** What every change (not a note) says in its own language: what was not checked. */
const UNVERIFIED = { en: 'Not verified: ', 'zh-CN': '未验证：' };
export const SEAL = 'changes/released.json';

const text = file => readFileSync(file, 'utf8').replace(/^﻿/, '').replace(/\r\n?/g, '\n').trim();

/** The fragments of `root`: { changes: [{ slug, note, files: { en, zh-CN }, text: { en, zh-CN } }], problems: [message] }. */
export function readFragments(root) {
  const dir = join(root, FRAGMENTS_DIR), problems = [], byKey = new Map();
  for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
    if (KEEP.has(name)) continue;
    const match = NAME.exec(name);
    if (!match) { problems.push(`${FRAGMENTS_DIR}/${name}: not a fragment name (<slug>.en.md, <slug>.zh-CN.md, <slug>.note.en.md, <slug>.note.zh-CN.md; slug in a-z, 0-9 and -)`); continue; }
    const { slug, note, lang } = match.groups, key = `${slug}${note || ''}`;
    if (!byKey.has(key)) byKey.set(key, { slug, note: !!note, files: {}, text: {} });
    const change = byKey.get(key);
    change.files[lang] = `${FRAGMENTS_DIR}/${name}`;
    change.text[lang] = text(join(dir, name));
  }
  for (const change of byKey.values()) {
    for (const lang of LANGS) {
      const label = change.files[lang] || `${FRAGMENTS_DIR}/${change.slug}${change.note ? '.note' : ''}.${lang}.md`;
      const body = change.text[lang];
      if (body === undefined) { problems.push(`${label}: missing (every change is written in both languages)`); continue; }
      if (!body) { problems.push(`${label}: empty`); continue; }
      if (/^#/m.test(body)) problems.push(`${label}: no headings; the release writes the version heading`);
      if (change.note) {
        if (/^\s*[-*] /.test(body)) problems.push(`${label}: a note is a paragraph, not a bullet (a bullet is <slug>.${lang}.md)`);
      } else {
        const [first, ...rest] = body.split('\n');
        if (!/^- \*\*\S.*?\*\*/.test(first)) problems.push(`${label}: a change starts with "- **" and a bold first sentence, e.g. "- **Pausing an install stops it.** ..."`);
        if (rest.some(line => !/^\s+\S/.test(line))) problems.push(`${label}: one bullet; any further line is indented (a sub-bullet "  - ..."), with no blank line`);
        if (!body.includes(UNVERIFIED[lang])) problems.push(`${label}: no "${UNVERIFIED[lang]}..." line; every change says plainly what was not checked`);
      }
    }
  }
  return { changes: [...byKey.values()], problems };
}

/** When each fragment file was last added, as an index into the history (oldest commit first); files git does not know are left out. */
export function addedOrder(root, log = gitLog(root)) {
  const order = new Map();
  let commit = -1;
  for (const line of log.split('\n')) {
    if (/^[0-9a-f]{40}$/.test(line)) commit++;
    else if (line.trim() && commit >= 0) order.set(line.trim(), commit);
  }
  return order;
}
function gitLog(root) {
  try {
    return execFileSync('git', ['log', '--diff-filter=A', '--no-renames', '--reverse', '--format=%H', '--name-only', '--', FRAGMENTS_DIR],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; } // no git, or not a checkout: by name
}

/** The changes in release order: by the commit that added them (the earlier of their two files), then by name. */
export function ordered(changes, order) {
  const at = change => Math.min(...LANGS.map(lang => order.get(change.files[lang]) ?? Infinity));
  return [...changes].sort((a, b) => at(a) - at(b) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/** The section of one language: heading, bullets, then notes. Lines end in \n. */
export function section(changes, lang, version, date) {
  const bullets = changes.filter(change => !change.note).map(change => change.text[lang]);
  const notes = changes.filter(change => change.note).map(change => change.text[lang]);
  const heading = date ? `## ${version} — ${date}` : `## ${version}`;
  return [heading, bullets.join('\n'), ...notes].filter(Boolean).join('\n\n') + '\n';
}

/** `changelog` (its text) with `added` (a section) before its first version heading, in the file's own line endings. */
export function insertSection(changelog, added) {
  const eol = changelog.includes('\r\n') ? '\r\n' : '\n';
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const at = lines.findIndex(line => line.startsWith('## '));
  const block = added.replace(/\n$/, '').split('\n');
  const result = at < 0 ? [...lines.slice(0, lines.at(-1) === '' ? -1 : undefined), '', ...block, ''] : [...lines.slice(0, at), ...block, '', ...lines.slice(at)];
  return result.join(eol);
}

/** The section of `version` as `changelog` (its text) has it, heading included, or null. */
export function releasedSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex(line => line === `## ${version}` || line.startsWith(`## ${version} `));
  if (start < 0) return null;
  const next = lines.findIndex((line, at) => at > start && line.startsWith('## '));
  return `${lines.slice(start, next < 0 ? undefined : next).join('\n').trim()}\n`;
}

/** The changelog text as the seal sees it: no BOM, LF line ends (a Windows checkout has CRLF), so every checkout seals the same. */
export const digest = changelog => `sha256:${createHash('sha256').update(changelog.replace(/^﻿/, '').replace(/\r\n?/g, '\n')).digest('hex')}`;

/** Writes the seal: what the release left in both changelogs. */
export function seal(root) {
  const files = Object.fromEntries(LANGS.map(lang => [CHANGELOGS[lang], digest(readFileSync(join(root, CHANGELOGS[lang]), 'utf8'))]));
  writeFileSync(join(root, SEAL), `${JSON.stringify({ about: 'Written by npm run changelog:release. A pull request adds a fragment to changes/unreleased instead of editing a changelog (changes/README.md).', files }, null, 2)}\n`, 'utf8');
}

/** The changelogs that differ from their seal: they were edited outside a release. */
export function unsealed(root) {
  let sealed;
  try { sealed = JSON.parse(readFileSync(join(root, SEAL), 'utf8')).files ?? {}; } catch { return [`${SEAL}: missing or not JSON (npm run changelog:release writes it)`]; }
  return LANGS.map(lang => CHANGELOGS[lang]).filter(file => sealed[file] !== digest(readFileSync(join(root, file), 'utf8')))
    .map(file => `${file}: edited outside a release. A change goes into changes/unreleased/ as a fragment (changes/README.md); only the release commit writes the changelogs.`);
}

function load(root) {
  const { changes, problems } = readFragments(root);
  return { changes: ordered(changes, addedOrder(root)), problems };
}

export function release(root, version, date) {
  const { changes, problems } = load(root);
  if (problems.length) throw new Error(problems.join('\n'));
  if (!changes.some(change => !change.note)) throw new Error(`${FRAGMENTS_DIR} holds no change to release`);
  for (const lang of LANGS) {
    if (releasedSection(readFileSync(join(root, CHANGELOGS[lang]), 'utf8'), version)) throw new Error(`${CHANGELOGS[lang]} already has ${version}`);
  }
  for (const lang of LANGS) {
    const file = join(root, CHANGELOGS[lang]);
    writeFileSync(file, insertSection(readFileSync(file, 'utf8'), section(changes, lang, version, date)), 'utf8');
  }
  for (const change of changes) for (const lang of LANGS) rmSync(join(root, change.files[lang]));
  seal(root);
  return changes;
}

function main(argv) {
  const option = name => argv.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const root = resolve(option('--root') ?? fileURLToPath(new URL('../', import.meta.url)));
  const positional = name => { const at = argv.indexOf(name); return at < 0 ? [] : argv.slice(at + 1).filter(arg => !arg.startsWith('--')); };
  if (argv.includes('--check')) {
    const { changes, problems: fragmentProblems } = load(root), problems = [...fragmentProblems, ...unsealed(root)];
    if (problems.length) { console.error(`Changelog fragments:\n${problems.map(problem => `  ${problem}`).join('\n')}\nSee changes/README.md.`); return 1; }
    console.log(`Changelog fragments: ${changes.filter(change => !change.note).length} changes, ${changes.filter(change => change.note).length} notes, both languages.`);
    return 0;
  }
  if (argv.includes('--preview')) {
    const [version] = positional('--preview'), lang = option('--lang') ?? 'en';
    if (!version || !LANGS.includes(lang)) { console.error('Usage: --preview <version> [--lang=en|zh-CN]'); return 2; }
    // After the release commit the fragments are gone: the released section is printed instead (for the release notes, published later).
    const released = releasedSection(readFileSync(join(root, CHANGELOGS[lang]), 'utf8'), version);
    if (released) { process.stdout.write(released); return 0; }
    const { changes, problems } = load(root);
    if (problems.length) { console.error(problems.join('\n')); return 1; }
    process.stdout.write(section(changes, lang, version));
    return 0;
  }
  if (argv.includes('--release')) {
    const [version, date] = positional('--release');
    if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) { console.error('Usage: --release <version> <YYYY-MM-DD>, e.g. --release 3.6.0 2026-10-23'); return 2; }
    try {
      const changes = release(root, version, date);
      console.log(`${version} — ${date}: ${changes.length} fragments written into ${Object.values(CHANGELOGS).join(' and ')} and deleted; ${SEAL} updated.`);
      return 0;
    } catch (error) { console.error(error.message); return 1; }
  }
  if (argv.includes('--seal')) {
    seal(root);
    console.log(`${SEAL}: sealed ${Object.values(CHANGELOGS).join(' and ')} as they are now.`);
    return 0;
  }
  console.error('Usage: node scripts/changelog.mjs --check | --preview <version> [--lang=zh-CN] | --release <version> <YYYY-MM-DD> | --seal');
  return 2;
}

const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (process.argv[1] && samePath(resolve(process.argv[1]), fileURLToPath(import.meta.url))) process.exitCode = main(process.argv.slice(2));
