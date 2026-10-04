import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--output_dir --page_range --paginate_output --output_format --disable_image_extraction'); process.exit(0); }
const state = JSON.parse(await readFile(process.env.FAKE_MARKER_STATE, 'utf8'));
const at = flag => args[args.indexOf(flag) + 1];
const [start, end] = at('--page_range').split('-').map(Number);
await appendFile(process.env.FAKE_MARKER_LOG, `${JSON.stringify(args)}\n`);
if (state.failStart === start) { console.error('OCR backend unavailable'); process.exit(1); }
if (state.delayStart === start) await new Promise(resolve => setTimeout(resolve, 60_000));
const stem = basename(args[0], '.pdf'), folder = join(at('--output_dir'), stem);
await mkdir(folder, { recursive: true });
const text = Array.from({ length: end - start + 1 }, (_, index) => {
  const page = start + index;
  return `{${page}}${'-'.repeat(48)}\n\n${state.blank?.includes(page) ? '' : `Marker page ${page + 1} text`}`;
}).join('\n\n');
await writeFile(join(folder, `${stem}.md`), text);
