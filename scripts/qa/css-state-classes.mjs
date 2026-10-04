/* Bare state classes in selectors (ui-consistency #159). A state is an ARIA or data attribute ([aria-pressed="true"], [aria-selected],
   [aria-current], [data-state="done"]); where only a class will do it is `is-*`. `.on`, `.active`, `.selected`, `.picked`, `.current`,
   `.open` and `.done` collide across features (`.on` is styled in four sheets) and name no ARIA state. The ones that exist today are
   recorded per file in tests/fixtures/css-state-classes.json; the count may only fall.
     node scripts/qa/css-state-classes.mjs            list them
     node scripts/qa/css-state-classes.mjs --update   lower the recorded counts (refuses to raise one) */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, cssFiles, parseTree, splitSelectorList, mentionedClasses } from './css-tools.mjs';

export const STATE_FILE = join(ROOT, 'tests/fixtures/css-state-classes.json');
export const BARE_STATES = ['active', 'on', 'selected', 'picked', 'current', 'open', 'done'];

/** { file: { class: count } } of the bare state classes the selectors of each stylesheet mention. */
export function scanStateClasses(root = ROOT) {
  const out = {};
  for (const file of cssFiles(root)) {
    const tree = parseTree(readFileSync(join(root, file), 'utf8'));
    const visit = (node) => {
      for (const child of node.children) {
        if (child.kind === 'rule') {
          for (const entry of splitSelectorList(child.prelude)) {
            for (const name of mentionedClasses(entry)) if (BARE_STATES.includes(name)) { out[file] ||= {}; out[file][name] = (out[file][name] || 0) + 1; }
          }
        }
        if (child.children.length) visit(child);
      }
    };
    visit(tree);
  }
  return out;
}

export const readStateBaseline = () => (existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')).files : {});

function main() {
  const now = scanStateClasses();
  if (process.argv.includes('--update')) {
    const was = readStateBaseline();
    const next = {};
    for (const [file, names] of Object.entries(now)) for (const [name, n] of Object.entries(names)) {
      const before = was[file]?.[name];
      if (before !== undefined && n > before) { console.error(`${file} .${name}: ${before} -> ${n}`); process.exitCode = 1; }
      (next[file] ||= {})[name] = before === undefined && Object.keys(was).length ? n : Math.min(before ?? n, n);
    }
    if (process.exitCode) return;
    writeFileSync(STATE_FILE, `${JSON.stringify({ note: 'Bare state classes in selectors, per file. May only fall: node scripts/qa/css-state-classes.mjs --update. Use [aria-*] / [data-state] or is-* instead.', files: next }, null, 2)}\n`);
    console.log('recorded');
    return;
  }
  for (const [file, names] of Object.entries(now)) console.log(`${file}  ${Object.entries(names).map(([n, c]) => `.${n}x${c}`).join(' ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
