import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/* Counts the weights and the small type of every stylesheet in ui/ (#1079; the rule is ui/DESIGN.md › Type). tests/type-weight-ratchet.test.mjs pins the
   numbers; `node scripts/qa/type-weight-counts.mjs` prints them (all files, then the total) when you sweep. */

const root = fileURLToPath(new URL('../..', import.meta.url));

async function cssFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await cssFiles(path));
    else if (entry.name.endsWith('.css')) out.push(path);
  }
  return out;
}

// A selector whose small type is allowed to stay 12px: a badge, chip, tag, key cap, a count, a number, a time, a tiny group label, a table cell, a chart axis, code.
const SMALL_OK = /badge|chip|pill|tag|kbd|keycap|key\b|-key|count|counter|num|stat|table|\bth\b|\btd\b|cell|dot|meter|axis|tick|legend|unit|index|eyebrow|mark|code|\bpre\b|\btext\b|delta|pct|clock|time|mins|::before|::after|option-letter|--xs|__raw|command|group-label|brand small/i;

/** Walk a stylesheet (nested CSS included) and report each declaration with the selector of its innermost rule. */
function declarations(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
  const stack = [];
  const out = [];
  let start = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (ch === '{') { stack.push(clean.slice(start, i).trim()); start = i + 1; }
    else if (ch === '}') {
      const body = clean.slice(start, i).trim();
      if (body) out.push({ selector: ruleSelector(stack), decl: body });
      stack.pop();
      start = i + 1;
    } else if (ch === ';') {
      const decl = clean.slice(start, i).trim();
      if (decl) out.push({ selector: ruleSelector(stack), decl });
      start = i + 1;
    }
  }
  return out;
}
const ruleSelector = (stack) => [...stack].reverse().find((item) => item && !item.startsWith('@')) || '';

export async function typeCounts() {
  const files = {};
  const total = { strong: 0, medium: 0, regular: 0, xs: 0 };
  for (const file of await cssFiles(join(root, 'ui'))) {
    const rel = relative(root, file).replaceAll('\\', '/');
    const row = { strong: 0, medium: 0, regular: 0, xs: 0 };
    for (const { selector, decl } of declarations(await readFile(file, 'utf8'))) {
      const m = decl.match(/^(font-weight|font-size)\s*:\s*var\(--(fw-strong|fw-medium|fw-regular|fs-xs)\)\s*(?:!important)?$/);
      if (!m) continue;
      if (m[2] === 'fw-strong') row.strong += 1;
      else if (m[2] === 'fw-medium') row.medium += 1;
      else if (m[2] === 'fw-regular') row.regular += 1;
      else if (m[2] === 'fs-xs' && !SMALL_OK.test(selector)) row.xs += 1;
    }
    for (const k of Object.keys(total)) total[k] += row[k];
    files[rel] = row;
  }
  return { files, total };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { files, total } = await typeCounts();
  for (const [file, row] of Object.entries(files)) if (row.strong || row.xs) console.log(`${file}	strong ${row.strong}	medium ${row.medium}	regular ${row.regular}	xs ${row.xs}`);
  console.log(`TOTAL	strong ${total.strong}	medium ${total.medium}	regular ${total.regular}	xs ${total.xs}`);
}
