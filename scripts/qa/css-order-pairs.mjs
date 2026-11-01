/* Which moved rules could change a winner? (ui-consistency #151)
     node scripts/qa/css-order-pairs.mjs <ref before> [<ref after>]      default after: the working tree's HEAD
   Moving a rule to another stylesheet changes its place in the source order, and at equal specificity, in the same layer, the later rule
   wins. How the sheets are ordered is not the same in the two builds: the preview bundles them in import order, the DSH host puts the
   global sheets (ui/styles.js and a few more) into one <style> and appends every other sheet as its own <style> the first time its view
   mounts (ui/components/css.js). So a move is only safe when no such pair exists. For every rule that sits in another stylesheet after the
   change this prints (1) rules of other stylesheets with equal specificity, a property in common and a subject class in common: their order
   was decided by mount order and is now decided by the moved rule's new sheet; (2) the same kind of pair inside the new sheet, where the moved
   rule now comes last. css-rules-diff proves the rules are unchanged, the fingerprint checks the preview's order; this checks the rest. */
import { pathToFileURL } from 'node:url';
import { parseTree, splitSelectorList } from './css-tools.mjs';
import { subjectClasses } from './css-ownership.mjs';

const norm = (text) => text.replace(/\s+/g, ' ').trim();
const plus = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const bigger = (a, b) => (a[0] - b[0] || a[1] - b[1] || a[2] - b[2]) > 0;

/** Specificity [ids, classes, types] of one complex selector: :where() counts 0, :is()/:not()/:has() their most specific argument. */
export function specificity(selector) {
  let total = [0, 0, 0], i = 0;
  const word = () => { while (/[\w-]/.test(selector[i] || '')) i++; };
  const group = (from) => { let depth = 1, j = from; while (j < selector.length && depth) { if (selector[j] === '(') depth++; else if (selector[j] === ')') depth--; j++; } return [selector.slice(from, j - 1), j]; };
  while (i < selector.length) {
    const ch = selector[i];
    if (ch === '.') { total[1]++; i++; word(); }
    else if (ch === '#') { total[0]++; i++; word(); }
    else if (ch === '[') { total[1]++; i = selector.indexOf(']', i) + 1 || selector.length; }
    else if (ch === ':' && selector[i + 1] === ':') { total[2]++; i += 2; word(); }
    else if (ch === ':') {
      i++; const start = i; word(); const name = selector.slice(start, i);
      if (selector[i] === '(') {
        const [inner, end] = group(i + 1);
        if (['is', 'not', 'has', 'matches'].includes(name)) total = plus(total, splitSelectorList(inner).map(specificity).reduce((m, s) => (bigger(s, m) ? s : m), [0, 0, 0]));
        else if (name !== 'where') total[1]++;
        i = end;
      } else total[1]++;
    } else if (/[a-zA-Z]/.test(ch)) { total[2]++; word(); }
    else i++;
  }
  return total;
}

/** Every rule of a stylesheet: { layer, scope, entry, props, sig, spec, subject }. The scope :is(.study-app, .study-seat) adds one class. */
export function rulesOf(text, file) {
  const out = [];
  const walk = (node, layer, wrappers, scope) => {
    for (const child of node.children) {
      if (child.kind === 'at') walk(child, /^@layer\b/.test(child.prelude) ? child.prelude : layer, /^@layer\b/.test(child.prelude) ? wrappers : [...wrappers, child.prelude], scope);
      else if (child.kind === 'rule' && /^:(is|where)\(\.study-app, \.study-seat\)$/.test(child.prelude)) walk(child, layer, wrappers, child.prelude);
      else if (child.kind === 'rule' && child.decls.length) {
        for (const entry of splitSelectorList(child.prelude).map(norm)) {
          const spec = scope?.startsWith(':is') ? plus(specificity(entry), [0, 1, 0]) : specificity(entry);
          out.push({ file, layer, entry, props: child.decls.map((d) => d.prop), spec: spec.join(','), subject: subjectClasses(entry),
            sig: `${wrappers.join('>')}||${scope}||${entry}||${child.decls.map((d) => `${d.prop}:${norm(d.value)}`).sort().join(';')}` });
        }
      }
    }
  };
  walk(parseTree(text), '', [], '');
  return out;
}

const meets = (a, b) => a.layer === b.layer && a.spec === b.spec && a.props.some((p) => b.props.includes(p)) && a.subject.some((s) => b.subject.includes(s));

/** Rules that changed stylesheet between two rule lists, and the pairs described above. */
export function orderPairs(before, after) {
  const was = new Map();
  for (const rule of before) { if (!was.has(rule.sig)) was.set(rule.sig, new Set()); was.get(rule.sig).add(rule.file); }
  const moved = after.filter((rule) => was.has(rule.sig) && !was.get(rule.sig).has(rule.file));
  const across = [], within = [];
  for (const rule of moved) for (const other of after) {
    if (other.sig === rule.sig || !meets(rule, other)) continue;
    (other.file === rule.file ? within : across).push([rule, other]);
  }
  return { moved, across, within };
}

async function main() {
  const { execFileSync } = await import('node:child_process');
  const [refBefore, refAfter = 'HEAD'] = process.argv.slice(2);
  if (!refBefore) { console.error('usage: node scripts/qa/css-order-pairs.mjs <ref before> [<ref after>]'); process.exitCode = 2; return; }
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 27, stdio: ['ignore', 'pipe', 'ignore'] });
  const files = git('ls-tree', '-r', '--name-only', refAfter, 'ui').split('\n').filter((f) => f.endsWith('.css'));
  const load = (ref) => files.flatMap((file) => { try { return rulesOf(git('show', `${ref}:${file}`), file); } catch { return []; } });
  const { moved, across, within } = orderPairs(load(refBefore), load(refAfter));
  console.log(`${moved.length} rules changed stylesheet`);
  console.log(`${across.length} pairs with a rule of another stylesheet (decided by mount order before):`);
  for (const [a, b] of across) console.log(`  ${a.file} ${a.entry}  vs  ${b.file} ${b.entry}`);
  console.log(`${within.length} pairs inside the new stylesheet (the moved rule now comes last; check they cannot meet on one element):`);
  for (const [a, b] of within) console.log(`  ${a.file} ${a.entry}  vs  ${b.entry}  (${b.props.filter((p) => a.props.includes(p)).join(', ')})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
