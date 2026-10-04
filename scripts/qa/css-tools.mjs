/* A small CSS reader that keeps source positions, shared by the stylesheet checks (dead selectors, class ownership,
   layer and scope structure) and the one-off stylesheet moves. It understands comments, strings, parentheses and
   nesting; it does not evaluate anything. Offsets index the string you pass in, so `source.slice(node.start, node.end)`
   is the exact text of a rule, including its closing brace. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));

export function walkFiles(dir, exts, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkFiles(full, exts, out);
    else if (exts.some((ext) => name.endsWith(ext))) out.push(full);
  }
  return out;
}

export const toRel = (file, root = ROOT) => relative(root, file).split(sep).join('/');

/* Stylesheets another work package owns this wave: no mechanical pass (dead rules, tokens, layers) may rewrite them.
   ui/daily-plan.css moved to WP-P (#173, home daily-plan redesign). Remove the entry when that work lands. */
export const FROZEN_FILES = ['ui/daily-plan.css'];

/** All stylesheets under ui/ as repo-relative paths (sorted). `frozen: false` leaves out the files in FROZEN_FILES. */
export function cssFiles(root = ROOT, { frozen = true } = {}) {
  return walkFiles(join(root, 'ui'), ['.css']).map((file) => toRel(file, root)).sort()
    .filter((file) => frozen || !FROZEN_FILES.includes(file));
}

/**
 * Parse a stylesheet into a tree.
 * node: { kind: 'rule' | 'at' | 'comment' | 'statement', prelude, start, end, bodyStart, bodyEnd, line, children, decls, parent }
 *   - rule: a style rule (selector prelude) with declarations and nested children
 *   - at: an at-rule with a block (@media, @layer x {}, @keyframes, @font-face ...)
 *   - statement: an at-rule without a block (@layer a, b; @import ...)
 *   - comment: a block comment, top level or nested (only kept when `comments` is true)
 * decl: { prop, value, start, end, line }
 */
export function parseTree(source, { comments = false } = {}) {
  const root = { kind: 'root', prelude: '', start: 0, end: source.length, children: [], decls: [], parent: null, line: 1 };
  let node = root, i = 0, segStart = 0, paren = 0, quote = '';
  // lines[k] = line number at offset k.
  const lines = new Uint32Array(source.length + 1);
  for (let k = 0, n = 1; k <= source.length; k++) { lines[k] = n; if (source.charCodeAt(k) === 10) n++; }
  const pushDecl = (end) => {
    const raw = source.slice(segStart, end);
    const text = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;$/, '').trim();
    if (!text) return;
    const colon = text.indexOf(':');
    if (colon < 1) return;
    const lead = raw.length - raw.trimStart().length;
    node.decls.push({ prop: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim(), start: segStart + lead, end, line: lines[segStart + lead] });
  };
  const skipSpace = (index) => { while (index < source.length && /\s/.test(source[index])) index++; return index; };
  segStart = skipSpace(0);
  i = segStart;
  while (i < source.length) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === quote) quote = '';
      i++; continue;
    }
    if (ch === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close < 0 ? source.length : close + 2;
      if (comments && source.slice(segStart, i).trim() === '') {
        node.children.push({ kind: 'comment', prelude: source.slice(i, end), start: i, end, line: lines[i], children: [], decls: [], parent: node });
      }
      // A comment inside a segment is dropped from the prelude/value by slicing around it later; keep the segment start when it is empty.
      if (source.slice(segStart, i).trim() === '') segStart = skipSpace(end);
      i = end; continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; i++; continue; }
    if (ch === '(') paren++;
    else if (ch === ')') paren = Math.max(0, paren - 1);
    if (paren === 0 && ch === '{') {
      const prelude = source.slice(segStart, i).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
      const child = { kind: prelude.startsWith('@') ? 'at' : 'rule', prelude, start: segStart, bodyStart: i + 1, end: -1, bodyEnd: -1, line: lines[segStart], children: [], decls: [], parent: node };
      node.children.push(child);
      node = child; i++; segStart = skipSpace(i); continue;
    }
    if (paren === 0 && ch === ';') {
      const text = source.slice(segStart, i).trim();
      if (/^@(import|layer|charset|namespace)\b/.test(text)) {
        node.children.push({ kind: 'statement', prelude: text.replace(/\s+/g, ' '), start: segStart, end: i + 1, line: lines[segStart], children: [], decls: [], parent: node });
      } else pushDecl(i + 1);
      i++; segStart = skipSpace(i); continue;
    }
    if (paren === 0 && ch === '}') {
      pushDecl(i);
      node.bodyEnd = i; node.end = i + 1;
      node = node.parent || root;
      i++; segStart = skipSpace(i); continue;
    }
    i++;
  }
  pushDecl(source.length);
  return root;
}

/** Depth-first walk over rule/at nodes. visit(node, ancestors) */
export function walkTree(node, visit, ancestors = []) {
  for (const child of node.children) {
    visit(child, ancestors);
    if (child.children.length) walkTree(child, visit, [...ancestors, child]);
  }
}

/** Split a selector list on top-level commas. */
export function splitSelectorList(prelude) {
  const out = [];
  let depth = 0, cur = '', quote = '';
  for (const ch of prelude) {
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Class names a selector needs to exist (classes inside :not() or :where(:not()) are conditions, not requirements). */
export function requiredClasses(selector) {
  const stripped = stripNegations(selector).replace(/\[[^\]]*\]/g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  return [...stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

/** Every class a selector mentions, including inside :not(). */
export function mentionedClasses(selector) {
  const stripped = selector.replace(/\[[^\]]*\]/g, '').replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '');
  return [...stripped.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]);
}

function stripNegations(selector) {
  let out = '';
  for (let i = 0; i < selector.length; i++) {
    if (selector.startsWith(':not(', i)) {
      let depth = 0, j = i + 4;
      for (; j < selector.length; j++) {
        if (selector[j] === '(') depth++;
        else if (selector[j] === ')' && --depth === 0) break;
      }
      i = j; continue;
    }
    out += selector[i];
  }
  return out;
}

export const readText = (file, root = ROOT) => readFileSync(join(root, file), 'utf8');
