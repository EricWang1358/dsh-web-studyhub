/* Which rules did a stylesheet change really add or remove? (ui-consistency #151, #137)
     node scripts/qa/css-rules-diff.mjs [<git ref>]      every ui/**.css at the ref (default origin/main) against the working tree
   A rule is its layer and wrappers (@layer, :is() / :where() scope, @media, @container), one selector entry and its sorted declarations, so a
   rule that only moved to another file, or was split out of a selector list, is the same rule. What is printed is what actually changed
   (- gone from the ref, + new); "0 / 0" means the cascade was only re-ordered. Pair it with scripts/qa/css-fingerprint.mjs, which checks
   what the browser computes for the states it can reach. */
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, cssFiles, parseTree, splitSelectorList } from './css-tools.mjs';

const norm = (text) => text.replace(/\s+/g, ' ').trim();

/** The rules of one stylesheet as strings: "<wrappers> || <selector entry> || <sorted declarations>". */
export function ruleSignatures(text) {
  const out = [];
  const walk = (node, context) => {
    for (const child of node.children) {
      if (child.kind === 'rule') {
        const decls = child.decls.map((d) => `${d.prop}:${norm(d.value)}`).sort().join(';');
        if (decls) for (const entry of splitSelectorList(child.prelude)) out.push(`${context.join(' > ')} || ${norm(entry)} || ${decls}`);
        if (child.children.length) walk(child, [...context, norm(child.prelude)]);
      } else if (child.kind === 'at') walk(child, [...context, norm(child.prelude)]);
    }
  };
  walk(parseTree(text), []);
  return out;
}

/** Signatures that exist on one side more often than on the other: { removed, added } (multiset difference). */
export function diffSignatures(before, after) {
  const count = (list) => list.reduce((map, sig) => map.set(sig, (map.get(sig) || 0) + 1), new Map());
  const a = count(before), b = count(after);
  const spill = (x, y) => [...x].flatMap(([sig, n]) => Array(Math.max(0, n - (y.get(sig) || 0))).fill(sig));
  return { removed: spill(a, b), added: spill(b, a) };
}

function main() {
  const ref = process.argv[2] || 'origin/main';
  const before = [], after = [];
  for (const file of cssFiles(ROOT)) {
    let old = '';
    try { old = execFileSync('git', ['show', `${ref}:${file}`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { /* new file */ }
    before.push(...ruleSignatures(old));
    after.push(...ruleSignatures(readFileSync(join(ROOT, file), 'utf8')));
  }
  const { removed, added } = diffSignatures(before, after);
  for (const sig of removed) console.log(`- ${sig}`);
  for (const sig of added) console.log(`+ ${sig}`);
  console.log(`rules only in ${ref}: ${removed.length}, only in the working tree: ${added.length}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
