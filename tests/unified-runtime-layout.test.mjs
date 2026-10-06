import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// Layered runtime code stays small and readable so later fixes touch one module.
// Add a directory here when its family moves onto the runtime; never raise a limit
// to fit a file — split the file instead.
const RULES = [
  { root: 'lib/jobs', maxLines: 200, maxLineLength: 181, forbidImports: ['/contexts/', '/ui/'] },
  { root: 'lib/contexts/notes/jobs', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'], textIn: ['messages.js'] },
  { root: 'lib/contexts/audio/jobs', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'] },
  { root: 'lib/contexts/generation/translation', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'] },
  { root: 'lib/contexts/generation/jobs', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'], textIn: ['messages.js'] },
  { root: 'lib/contexts/notes/jobs', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'], textIn: ['messages.js'] },
  { root: 'lib/contexts/coach/jobs', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'], textIn: ['messages.js'] },
  { root: 'lib/contexts/generation/retrieval', maxLines: 200, maxLineLength: 181, forbidImports: ['/ui/'] },
];
const CJK = /[㐀-鿿]/;
const repo = fileURLToPath(new URL('../', import.meta.url));

async function sources(dir) {
  const files = [];
  for (const entry of await readdir(join(repo, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await sources(path));
    else if (entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

for (const rule of RULES) {
  test(`${rule.root}: small files, short lines, inward-only imports, no user-facing text`, async () => {
    const problems = [];
    for (const file of await sources(rule.root)) {
      const name = relative(repo, join(repo, file)).replaceAll('\\', '/');
      const lines = (await readFile(join(repo, file), 'utf8')).split(/\r?\n/);
      if (lines.length > rule.maxLines) problems.push(`${name}: ${lines.length} lines > ${rule.maxLines}; split it`);
      lines.forEach((line, index) => {
        if (line.length > rule.maxLineLength) problems.push(`${name}:${index + 1}: ${line.length} chars > ${rule.maxLineLength}`);
        const imported = /^\s*(?:import|export)\b.*\bfrom\s+['"]([^'"]+)['"]/.exec(line)?.[1];
        if (imported && rule.forbidImports.some(part => imported.includes(part))) problems.push(`${name}:${index + 1}: imports ${imported} (outer layer)`);
        if (!rule.textIn?.includes(basename(file)) && CJK.test(line.replace(/\/\/.*$|\/\*.*?\*\//g, ''))) problems.push(`${name}:${index + 1}: user-facing text belongs in locales/application messages`);
      });
    }
    assert.deepEqual(problems, []);
  });
}
