// Emit an Artifact-ready variant of site/index.html.
// The Artifact runtime supplies its own <!doctype>/<head>/<body> wrapper, so the
// published file carries only <title>, the font links, <style> and the content.
// site/index.html stays the canonical standalone page (GitHub Pages, local preview).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const OUT = process.argv[2];
if (!OUT) {
  console.error('usage: node scripts/site-artifact.mjs <out.html>');
  process.exit(1);
}

const src = await readFile('site/index.html', 'utf8');

const head = src.slice(src.indexOf('<head>') + '<head>'.length, src.indexOf('</head>'));
const body = src.slice(src.indexOf('<body>') + '<body>'.length, src.lastIndexOf('</body>'));

// Keep the title, the Google Fonts links and the stylesheet; drop the metas the
// wrapper already provides.
const keep = head
  .split('\n')
  .filter((l) => !/<meta\s+charset|name="viewport"/.test(l))
  .join('\n')
  .trim();

const out = `${keep}\n${body.trim()}\n`;

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, out, 'utf8');

const bad = [/<!doctype/i, /<html[\s>]/i, /<\/html>/i, /<head>/i, /<body[\s>]/i];
const found = bad.filter((re) => re.test(out));
console.log(`${OUT}  ${(out.length / 1024).toFixed(1)} KB`);
console.log(found.length ? `WARNING: wrapper tags survived: ${found}` : 'no wrapper tags — ok');
