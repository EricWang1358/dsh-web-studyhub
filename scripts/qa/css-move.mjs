/* Move one rule to the stylesheet that owns its class (ui-consistency #151), keeping its cascade.
     node scripts/qa/css-move.mjs <from.css> <to.css> "<selector entry>" ["<selector entry>" ...]
   The rule lands at the end of the same place in the other sheet: same layer, same scope wrapper (:is() and :where() differ by one class of
   specificity, so a move between the two is refused), same @media / @container wrapper (which must already exist there). An entry of a
   selector list moves alone and its siblings stay. A comment above the rule is not moved: the tool reports it. Nothing else is rewritten. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseTree, splitSelectorList } from './css-tools.mjs';

const SCOPE = /^:(?:is|where)\(\.study-app, \.study-seat\)$/;
const norm = (text) => text.replace(/\s+/g, ' ').trim();

/* The first rule whose selector list holds `entry`, with the wrappers it sits in. */
function findRule(root, entry) {
  let found = null;
  const visit = (node, wrappers, scope) => {
    for (const child of node.children) {
      if (found) return;
      if (child.kind === 'rule' && scope && node === scope && splitSelectorList(child.prelude).map(norm).includes(entry)) { found = { rule: child, scope, wrappers }; return; }
      if (child.kind === 'at') visit(child, /^@layer\b/.test(child.prelude) ? wrappers : [...wrappers, child.prelude], null);
      else if (child.kind === 'rule' && SCOPE.test(child.prelude)) visit(child, wrappers, child);
    }
  };
  visit(root, [], null);
  return found;
}

/* The scope block of the other sheet that sits in the same wrappers. */
function findScope(root, wrappers, scopePrelude) {
  const layer = root.children.find((child) => child.kind === 'at' && /^@layer study\.\w+$/.test(child.prelude));
  let node = layer;
  for (const wrapper of wrappers) {
    node = node?.children.find((child) => child.kind === 'at' && child.prelude === wrapper);
    if (!node) throw new Error(`the target sheet has no ${wrapper} at-rule to receive the rule: add it first`);
  }
  const scope = node?.children.find((child) => child.kind === 'rule' && SCOPE.test(child.prelude));
  if (!scope) throw new Error('the target sheet has no scope block (:is(.study-app, .study-seat)) in that place');
  if (scope.prelude !== scopePrelude) throw new Error(`the scope differs (${scopePrelude} -> ${scope.prelude}): the rule would change specificity by one class`);
  return scope;
}

const lineStart = (text, index) => text.lastIndexOf('\n', index - 1) + 1;

export function moveRule(fromText, toText, entry) {
  const crlf = [fromText, toText].map((text) => text.includes('\r\n'));
  const from = fromText.replace(/\r\n/g, '\n'), to = toText.replace(/\r\n/g, '\n');
  entry = norm(entry);
  const hit = findRule(parseTree(from), entry);
  if (!hit) throw new Error(`no rule with the selector ${entry} in the source sheet`);
  const { rule, scope, wrappers } = hit;
  const target = findScope(parseTree(to), wrappers, scope.prelude);
  const start = lineStart(from, rule.start);
  if (from.slice(start, rule.start).trim()) throw new Error('the rule does not start its own line');
  const indent = from.slice(start, rule.start);
  const entries = splitSelectorList(rule.prelude).map(norm);
  const body = from.slice(rule.bodyStart, rule.bodyEnd);
  const moved = `${indent}${entry} {${body}}\n`;
  let nextFrom;
  if (entries.length === 1) nextFrom = from.slice(0, start) + from.slice(from[rule.end] === '\n' ? rule.end + 1 : rule.end);
  else nextFrom = `${from.slice(0, rule.start)}${entries.filter((e) => e !== entry).join(`,\n${indent}`)} {${from.slice(rule.bodyStart)}`;
  const close = lineStart(to, target.bodyEnd);
  if (to.slice(close, target.bodyEnd).trim()) throw new Error('the target scope block does not close on its own line');
  const nextTo = to.slice(0, close) + moved + to.slice(close);
  const above = from.slice(0, start).trimEnd();
  const warnings = above.endsWith('*/') ? [`a comment sits above ${entry} in the source sheet: check that it still fits`] : [];
  const back = (text, was) => (was ? text.replace(/\n/g, '\r\n') : text);
  return { from: back(nextFrom, crlf[0]), to: back(nextTo, crlf[1]), warnings };
}

function main() {
  const [from, to, ...entries] = process.argv.slice(2);
  if (!from || !to || !entries.length) { console.error('usage: node scripts/qa/css-move.mjs <from.css> <to.css> "<selector entry>" ...'); process.exitCode = 2; return; }
  let a = readFileSync(resolve(from), 'utf8'), b = readFileSync(resolve(to), 'utf8');
  for (const entry of entries) {
    let count = 0;
    for (;;) {
      let out;
      try { out = moveRule(a, b, entry); } catch (error) { if (count && /^no rule/.test(error.message)) break; throw error; }
      ({ from: a, to: b } = out); count++;
      for (const warning of out.warnings) console.warn(warning);
    }
    console.log(`moved ${count} x ${entry}`);
  }
  writeFileSync(resolve(from), a); writeFileSync(resolve(to), b);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
