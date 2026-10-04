/* Which stylesheet owns which class (ui-consistency #151). A class is styled in the file that owns it; a second file that also
   writes a rule for it changes the result by injection order and specificity, so in the "home" file of the class a change may
   not take effect at all. A rule's *subject* is the last compound of each selector entry (the element it styles).
     node scripts/qa/css-ownership.mjs            list classes styled by more than one stylesheet
     node scripts/qa/css-ownership.mjs --update   rewrite tests/fixtures/css-ownership-allow.json (only ever shrinks: refuses new entries)
   The allow-list is the debt: it may only get shorter. tests/css-ownership.test.mjs enforces that. */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, cssFiles, parseTree, splitSelectorList } from './css-tools.mjs';

/* Sheets that exist to reach across features, so they name classes of other sheets on purpose: the theme and paper tokens, the motion
   switches, the appearance themes and accent presets, the shared floating surface, and the English-layout adjustments. */
export const CROSS_CUTTING = ['ui/tokens.css', 'ui/paper.css', 'ui/motion.css', 'ui/appearance-themes.css', 'ui/accent.css', 'ui/components/overlays.css', 'ui/language.css'];

export const ALLOW_FILE = join(ROOT, 'tests/fixtures/css-ownership-allow.json');

/* The subject classes of one selector entry: the classes of its last compound (inside :is()/:where() they count too, `:not()` does not). */
export function subjectClasses(entry) {
  let depth = 0, cut = 0;
  for (let i = 0; i < entry.length; i++) {
    const ch = entry[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (depth === 0 && /[\s>+~]/.test(ch)) cut = i + 1;
  }
  let compound = entry.slice(cut);
  compound = compound.replace(/:not\((?:[^()]|\([^()]*\))*\)/g, '').replace(/\[[^\]]*\]/g, '');
  const inner = [...compound.matchAll(/:(?:is|where|matches)\(((?:[^()]|\([^()]*\))*)\)/g)].map((m) => m[1]);
  const text = [compound.replace(/:(?:is|where|matches)\((?:[^()]|\([^()]*\))*\)/g, ''), ...inner.flatMap((part) => part.split(','))].join(' ');
  return [...new Set([...text.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1]))];
}

/** class -> sorted list of the stylesheets that write a rule whose subject it is. */
export function classOwners(root = ROOT) {
  const map = new Map();
  for (const file of cssFiles(root)) {
    if (CROSS_CUTTING.includes(file)) continue;
    const tree = parseTree(readFileSync(join(root, file), 'utf8'));
    const visit = (node) => {
      for (const child of node.children) {
        if (child.kind === 'rule') {
          for (const entry of splitSelectorList(child.prelude.replace(/^&\s*/, ''))) {
            if (/^(\.study-app|\.study-seat|:is\(\.study-app, \.study-seat\)|:where\(\.study-app, \.study-seat\))$/.test(entry.trim())) continue;
            for (const name of subjectClasses(entry.replace(/^:(is|where)\(\.study-app, \.study-seat\)\s*/, '').replace(/^\.study-(app|seat)\s*/, ''))) {
              if (!map.has(name)) map.set(name, new Set());
              map.get(name).add(file);
            }
          }
        }
        if (child.children.length) visit(child);
      }
    };
    visit(tree);
  }
  const out = {};
  for (const [name, files] of [...map].sort((a, b) => a[0].localeCompare(b[0]))) if (files.size > 1) out[name] = [...files].sort();
  return out;
}

export const readAllow = () => (existsSync(ALLOW_FILE) ? JSON.parse(readFileSync(ALLOW_FILE, 'utf8')).classes : {});

function main() {
  const owners = classOwners();
  if (process.argv.includes('--update')) {
    const allow = readAllow();
    const next = {};
    for (const [name, files] of Object.entries(owners)) {
      const was = allow[name];
      if (!was && Object.keys(allow).length) { console.error(`new shared class .${name}: ${files.join(', ')} (give it one owner)`); process.exitCode = 1; continue; }
      next[name] = was ? files.filter((f) => was.includes(f)) : files;
    }
    if (process.exitCode) return;
    writeFileSync(ALLOW_FILE, `${JSON.stringify({ note: 'Classes that more than one stylesheet writes a rule for. May only shrink: regenerate with node scripts/qa/css-ownership.mjs --update.', classes: next }, null, 2)}\n`);
    console.log(`${Object.keys(next).length} shared classes recorded`);
    return;
  }
  for (const [name, files] of Object.entries(owners)) console.log(`.${name}  ${files.join('  ')}`);
  console.log(`\n${Object.keys(owners).length} classes are styled by more than one stylesheet`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
