// Export a local HTML fragment; this does not publish to any service.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parse, serializeOuter } from 'parse5';
import { buildSite } from './site-build.mjs';

const output = process.argv[2], language = process.argv.includes('--lang=en') ? 'en' : 'zh';
if (!output) throw new Error('usage: node scripts/site-artifact.mjs <out.html> [--lang=en]');
const built = await buildSite();
const source = await readFile(join(built.outdir, language === 'en' ? 'en.html' : 'index.html'), 'utf8');
const tree = parse(source), html = tree.childNodes.find(node => node.tagName === 'html');
const head = html.childNodes.find(node => node.tagName === 'head'), body = html.childNodes.find(node => node.tagName === 'body');
async function embed(node) {
  if (node.tagName === 'script' && node.attrs.some(attribute => attribute.name === 'src')) {
    const src = node.attrs.find(attribute => attribute.name === 'src').value;
    if (src !== 'assets/site-demo.js') throw new Error(`Unexpected script: ${src}`);
    node.attrs = [];
    node.childNodes = [{ nodeName: '#text', value: await readFile(join(built.outdir, src), 'utf8'), parentNode: node }];
  }
  if (node.tagName === 'img') {
    const srcset = node.attrs.find(attribute => attribute.name === 'srcset');
    const src = node.attrs.find(attribute => attribute.name === 'src');
    if (srcset) src.value = srcset.value.split(',').at(-1).trim().split(/\s+/)[0];
    if (!built.assets.includes(src.value)) throw new Error(`Unexpected image: ${src.value}`);
    src.value = `data:image/webp;base64,${(await readFile(join(built.outdir, src.value))).toString('base64')}`;
    node.attrs = node.attrs.filter(attribute => attribute.name !== 'srcset');
  }
  node.childNodes = (node.childNodes || []).filter(child => !child.attrs?.some(attribute => attribute.name === 'class' && attribute.value === 'language-switch'));
  for (const child of node.childNodes) await embed(child);
}
await embed(body);
const keptHead = head.childNodes.filter(node => ['title', 'style'].includes(node.tagName));
const result = [...keptHead, ...body.childNodes].map(node => serializeOuter(node)).join('\n');
if (/<(?:!doctype|html|head|body)\b/i.test(result)) throw new Error('Wrapper tags survived fragment export');
await mkdir(dirname(output), { recursive: true }); await writeFile(output, result + '\n');
console.log(`Exported local ${language} fragment: ${output} (${(Buffer.byteLength(result) / 1024).toFixed(1)} KB)`);
