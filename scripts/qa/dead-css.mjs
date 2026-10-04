/* Dead CSS finder (ui-consistency #155). A class selector is dead when no source file can put that class on an element.
     node scripts/qa/dead-css.mjs                 list dead rules per stylesheet
     node scripts/qa/dead-css.mjs --delete        cut every dead rule out of the stylesheets (review `git diff`, then run the tests)
     node scripts/qa/dead-css.mjs --classes       list the dead class names only
   "Can put on an element" means: the class name appears as a word in a ui .js or .jsx file (a string, a template piece,
   a querySelector), OR a dynamic template builds it (`is-${state}`, `${base}__icon`, 'k-' + kind), OR it belongs to a
   third-party renderer (ALLOW_PREFIX). tests/ and scripts/ never keep a class alive: a journey that clicks `.x` on an
   element nobody renders is a stale journey. Selectors the check cannot judge (attribute-only, element-only) are live. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, cssFiles, parseTree, splitSelectorList, walkFiles, toRel } from './css-tools.mjs';
import { stripJsComments } from './guardrail-baseline.mjs';

/* Class names that third-party renderers or the browser add, so the source never spells them. */
export const ALLOW_PREFIX = ['cm-', 'katex', 'CodeMirror', 'mjx', 'hljs', 'ͼ'];
/* Single classes that are set from data (a class name stored in a model value or built from a lookup), with the reason. */
export const ALLOW_CLASSES = {
  'i-membership-stem': 'lib/skeleton.js lint issue code, rendered as "sk-issue i-" + code in Skeleton.jsx',
  siliconflow: 'AUDIO_TIERS id from lib/audio-providers.js, rendered as audio-provider + tier in AudioDashboard.jsx',
};

const WORD = /[A-Za-z_][\w-]*/g;
const trailingWord = (text) => /[\w-]*$/.exec(text)[0];

/* Every position that opens a one-line quoted string, so a stray apostrophe in JSX text cannot hide a real className string. */
const QUOTED = /(?=(["'`])((?:\\.|(?!\1)[^\\\n])*)\1)/g;

/** The words, template prefixes and template suffixes of the ui sources. `quoted` holds the words that sit inside a quoted string. */
export function collectUsage(root = ROOT) {
  const words = new Set(), quoted = new Set(), prefixes = new Set(), suffixes = new Set();
  for (const abs of walkFiles(join(root, 'ui'), ['.js', '.jsx'])) {
    /* Comments and role="alert" are prose, not classes. */
    const text = stripJsComments(readFileSync(abs, 'utf8')).replace(/\brole=(["'])[^"'\n]*\1/g, '');
    for (const m of text.matchAll(WORD)) words.add(m[0]);
    for (const q of text.matchAll(QUOTED)) for (const m of q[2].matchAll(WORD)) quoted.add(m[0]);
    for (const m of text.matchAll(/([\w-]*)\$\{/g)) prefixes.add(m[1]);
    for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*?)\1\s*\+/g)) prefixes.add(trailingWord(m[2]));
    for (const m of text.matchAll(/\$\{[^}]*\}([\w-]+)/g)) suffixes.add(m[1]);
  }
  const all = [...prefixes].filter(Boolean);
  /* A prefix ending in - or _ names a family (`is-${state}`); one that does not (`"cell l" + level`) only builds numbered variants (l1, l2). */
  return {
    words,
    quoted,
    prefixes: all.filter((p) => p.length >= 2 && /[-_]$/.test(p)),
    numbered: all.filter((p) => !/[-_]$/.test(p)),
    suffixes: [...suffixes].filter((s) => /^(__|--)/.test(s) && s.length >= 4),
  };
}

/* One-word classes are also common identifiers, so a hand-checked list says which of them nothing renders.
   NEVER_SET: no component puts the class on anything. ONLY_COMPOUND: the class is set, but only next to another class
   (`mastery-bar empty`), so a rule that styles it alone is dead. */
export const NEVER_SET = {
  job: 'JobRow renders sh-job; no component sets a bare job class',
  deck: 'decks render as map-name / resume rows; no component sets a bare deck class',
  guide: 'the guide card was removed with the old onboarding rail; nothing sets a bare guide class',
};
export const ONLY_COMPOUND = { empty: 'set only as "mastery-bar empty" and "skc-class-attrs empty"' };

/* Rules whose classes are alive but whose selector can no longer match, checked by hand: file -> exact selector. */
export const VERIFIED_DEAD = {
  'ui/style.css': [
    '.teaching-progress::-webkit-progress-bar', '.teaching-progress::-webkit-progress-value', '.teaching-progress::-moz-progress-bar',
  ],
};

export function isAlive(name, usage, alone = false) {
  if (Object.hasOwn(NEVER_SET, name)) return false;
  if (alone && Object.hasOwn(ONLY_COMPOUND, name)) return false;
  /* A one-word class (`done`, `on`) is also a common identifier, so only a quoted occurrence counts. */
  if (/[-_]/.test(name) ? usage.words.has(name) : usage.quoted.has(name)) return true;
  if (ALLOW_PREFIX.some((p) => name.startsWith(p))) return true;
  if (Object.hasOwn(ALLOW_CLASSES, name)) return true;
  if (usage.numbered.some((p) => name.startsWith(p) && /^\d+$/.test(name.slice(p.length)))) return true;
  if (usage.prefixes.some((p) => name.startsWith(p) && name.length > p.length)) return true;
  if (usage.suffixes.some((s) => name.endsWith(s) && name.length > s.length)) return true;
  return false;
}

/* The classes a selector needs, as [{ name, alone }]. :not()/:is()/:where()/:has()/:matches() arguments are options or
   conditions, not requirements, so they are dropped. `alone` is true when the class is the only one in its compound. */
function requiredClassesOf(selector) {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    const m = /^:(not|is|where|has|matches|-webkit-any)\(/.exec(selector.slice(i));
    if (m) {
      let depth = 0, j = i + m[0].length - 1;
      for (; j < selector.length; j++) {
        if (selector[j] === '(') depth++;
        else if (selector[j] === ')' && --depth === 0) break;
      }
      i = j; continue;
    }
    out += selector[i];
  }
  out = out.replace(/\[[^\]]*\]/g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  const found = [];
  for (const compound of out.split(/[\s>+~]+/)) {
    const classes = [...compound.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
    for (const name of classes) found.push({ name, alone: classes.length === 1 });
  }
  return found;
}

/** Dead rules of one stylesheet: [{ node, line, selector, dead: [class...] }] (rules whose every selector entry needs a dead class). */
export function deadRulesOf(source, usage, file = "") {
  const tree = parseTree(source);
  const found = [];
  const rowOf = (node, inherited) => {
    if (node.kind !== 'rule') return null;
    const entries = splitSelectorList(node.prelude);
    const own = entries.map((entry) => requiredClassesOf(entry).filter((c) => !isAlive(c.name, usage, c.alone)).map((c) => c.name));
    return { entries, own, inherited };
  };
  const visit = (node, parentDead) => {
    for (const child of node.children) {
      if (child.kind === 'at') {
        if (/^@(keyframes|-webkit-keyframes|font-face)/.test(child.prelude)) continue;
        visit(child, parentDead);
        continue;
      }
      if (child.kind !== 'rule') continue;
      const row = rowOf(child);
      const dead = row.own.every((classes) => classes.length > 0) || (VERIFIED_DEAD[file] || []).includes(child.prelude);
      if (!parentDead && dead) {
        found.push({ node: child, line: child.line, selector: child.prelude, dead: [...new Set(row.own.flat())] });
        continue; // the subtree goes with it
      }
      if (!parentDead && !dead && row.entries.length > 1) {
        // a list with some dead entries: report the dead entries for pruning
        const deadEntries = row.entries.filter((_, index) => row.own[index].length > 0);
        if (deadEntries.length) found.push({ node: child, line: child.line, selector: child.prelude, dead: [...new Set(row.own.flat())], partial: deadEntries });
      }
      visit(child, parentDead || dead);
    }
  };
  visit(tree, false);
  return { tree, found };
}

export function scanDead(root = ROOT) {
  const usage = collectUsage(root);
  const report = [];
  for (const file of cssFiles(root)) {
    const source = readFileSync(join(root, file), 'utf8');
    const { found } = deadRulesOf(source, usage, file);
    for (const hit of found) report.push({ file, line: hit.line, selector: hit.selector, dead: hit.dead, partial: hit.partial });
  }
  return { usage, report };
}

/* Remove dead rules (and the whole-rule hits only; partial selector lists are pruned entry by entry). */
export function deleteDead(root = ROOT) {
  const usage = collectUsage(root);
  const removed = [];
  for (const file of cssFiles(root, { frozen: false })) {
    const path = join(root, file);
    let source = readFileSync(path, 'utf8');
    const { found } = deadRulesOf(source, usage, file);
    if (!found.length) continue;
    const edits = [];
    for (const hit of found) {
      const { node } = hit;
      if (hit.partial) {
        const keep = splitSelectorList(node.prelude).filter((entry) => !hit.partial.includes(entry));
        const original = source.slice(node.start, node.bodyStart - 1);
        const indent = /\n([ \t]*)\S[^\n]*$/.exec(original)?.[1] ?? '';
        edits.push({ start: node.start, end: node.bodyStart - 1, text: keep.join(original.includes('\n') ? `,\n${indent}` : ', ') + ' ' });
        removed.push(`${file}:${hit.line} (pruned) ${hit.partial.join(' | ')}`);
        continue;
      }
      let start = node.start;
      // take the line's leading indent and one trailing newline so no blank hole is left
      while (start > 0 && /[ \t]/.test(source[start - 1])) start--;
      let end = node.end;
      if (source[end] === '\r') end++;
      if (source[end] === '\n') end++;
      edits.push({ start, end, text: '' });
      removed.push(`${file}:${hit.line} ${node.prelude.slice(0, 90)}`);
    }
    edits.sort((a, b) => b.start - a.start);
    for (const edit of edits) source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
    writeFileSync(path, pruneEmpty(source));
  }
  removed.push(...deleteDeadKeyframes(root));
  return removed;
}

/* Remove rules and at-rules that no longer hold a declaration or a rule (the shell a deleted rule leaves behind). */
export function pruneEmpty(source) {
  for (;;) {
    const tree = parseTree(source);
    const empties = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.kind === 'rule' || (child.kind === 'at' && !/^@(font-face|page)\b/.test(child.prelude))) {
          if (!child.decls.length && !child.children.some((c) => c.kind !== 'comment')) { empties.push(child); continue; }
        }
        visit(child);
      }
    };
    visit(tree);
    if (!empties.length) return source;
    for (const node of empties.sort((a, b) => b.start - a.start)) {
      let start = node.start;
      while (start > 0 && /[ \t]/.test(source[start - 1])) start--;
      let end = node.end;
      if (source[end] === '\r') end++;
      if (source[end] === '\n') end++;
      source = source.slice(0, start) + source.slice(end);
    }
  }
}

/* @keyframes that no animation names (in any stylesheet or ui script) are dead too. */
export function deleteDeadKeyframes(root = ROOT) {
  const files = cssFiles(root, { frozen: false });
  const sources = new Map(files.map((file) => [file, readFileSync(join(root, file), 'utf8')]));
  const referenced = new Set();
  for (const file of cssFiles(root)) {
    const source = sources.get(file) ?? readFileSync(join(root, file), 'utf8');
    const walk = (node) => {
      for (const decl of node.decls) if (/^(-webkit-)?animation(-name)?$/.test(decl.prop)) for (const m of decl.value.matchAll(WORD)) referenced.add(m[0]);
      node.children.forEach(walk);
    };
    walk(parseTree(source));
  }
  const usage = collectUsage(root);
  const removed = [];
  for (const [file, source0] of sources) {
    let source = source0;
    const dead = [];
    for (const node of parseTree(source).children) {
      const m = /^@(?:-webkit-)?keyframes\s+([\w-]+)$/.exec(node.prelude);
      if (m && !referenced.has(m[1]) && !usage.words.has(m[1])) dead.push(node);
    }
    for (const node of dead.sort((a, b) => b.start - a.start)) {
      let start = node.start;
      while (start > 0 && /[ \t]/.test(source[start - 1])) start--;
      let end = node.end;
      if (source[end] === '\r') end++;
      if (source[end] === '\n') end++;
      source = source.slice(0, start) + source.slice(end);
      removed.push(`${file}:${node.line} ${node.prelude}`);
    }
    if (dead.length) writeFileSync(join(root, file), source);
  }
  return removed;
}

function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--delete')) {
    const removed = deleteDead(ROOT);
    console.log(`${removed.join('\n')}\n\n${removed.length} rule(s) removed or pruned`);
    return;
  }
  const { report, usage } = scanDead(ROOT);
  if (args.has('--classes')) {
    console.log([...new Set(report.flatMap((hit) => hit.dead))].sort().join('\n'));
    return;
  }
  for (const hit of report) console.log(`${hit.file}:${hit.line}${hit.partial ? ' (list)' : ''} ${hit.selector.slice(0, 100)}  -> ${hit.dead.join(', ')}`);
  console.log(`\n${report.length} dead rule(s); ${usage.words.size} words, ${usage.prefixes.length} template prefixes, ${usage.suffixes.length} suffixes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
export { toRel };
