import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, access } from 'node:fs/promises';
import { dirname, join, normalize } from 'node:path';

// Every relative link in the user-facing docs must reach a file, and every
// #anchor must match a heading in that file. External URLs are checked at
// release time, not here, so the suite stays offline.
const roots = ['README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'CHANGELOG.zh-CN.md'];
const docs = (await readdir('docs')).filter((name) => name.endsWith('.md')).map((name) => `docs/${name}`);
const files = [...roots, ...docs];

/** GitHub-style heading slug: lower-case, punctuation removed, spaces to hyphens. */
export function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/[`*_~]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s/g, '-');
}
function anchors(markdown) {
  const seen = new Map(), result = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!match) continue;
    const base = slug(match[1]), count = seen.get(base) || 0;
    seen.set(base, count + 1);
    result.add(count ? `${base}-${count}` : base);
  }
  for (const match of markdown.matchAll(/<a\s+(?:name|id)="([^"]+)"/g)) result.add(match[1]);
  return result;
}
const exists = (path) => access(path).then(() => true, () => false);

test('documentation relative links and anchors resolve', async () => {
  const broken = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // Ignore fenced code blocks.
    const prose = text.replace(/```[\s\S]*?```/g, '');
    for (const [, target] of prose.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(?:[a-z]+:|\/\/)/i.test(target)) continue;
      const [path, hash] = target.split('#');
      const resolved = path ? normalize(join(dirname(file), decodeURIComponent(path))) : file;
      if (path && !await exists(resolved)) { broken.push(`${file}: ${target} (missing file)`); continue; }
      if (hash !== undefined && resolved.endsWith('.md')) {
        const wanted = decodeURIComponent(hash).toLowerCase();
        if (!anchors(await readFile(resolved, 'utf8')).has(wanted)) broken.push(`${file}: ${target} (missing anchor)`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test('the Chinese README links to Chinese documents when a translation exists', async () => {
  const text = await readFile('README.zh-CN.md', 'utf8');
  const english = [];
  for (const [, target] of text.matchAll(/\]\(([^)\s#]+\.md)(?:#[^)]*)?\)/g)) {
    // README.md is the language switch at the top of the Chinese README.
    if (target === 'README.md' || /\.zh-CN\.md$/.test(target) || /^(?:[a-z]+:|\/\/)/i.test(target)) continue;
    const translated = target.replace(/\.md$/, '.zh-CN.md');
    if (await exists(translated)) english.push(target);
  }
  assert.deepEqual(english, []);
});
