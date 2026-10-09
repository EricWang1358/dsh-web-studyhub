import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
const args = process.argv.slice(2);
if (args.includes('--help')) { console.log('--output_dir --page_range --paginate_output --output_format --disable_image_extraction'); process.exit(0); }
const state = JSON.parse(await readFile(process.env.FAKE_MARKER_STATE, 'utf8'));
const at = flag => args[args.indexOf(flag) + 1];
const [start, end] = at('--page_range').split('-').map(Number);
await appendFile(process.env.FAKE_MARKER_LOG, `${JSON.stringify(args)}\n`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// What a real Marker prints while it works: a log line, then tqdm bars that redraw themselves after "\r" (state.progress).
if (state.progress) {
  process.stderr.write(`2026-10-09 12:44:44,100 [INFO] marker: Loading models from ${join(process.cwd(), 'models', 'layout')}\n`);
  for (const label of ['Recognizing layout', 'Recognizing text']) {
    const total = end - start + 1;
    for (let done = 0; done <= total; done++) {
      const percent = Math.round(done / total * 100);
      process.stderr.write(`\r${label}: ${String(percent).padStart(3)}%|${'#'.repeat(Math.round(percent / 10)).padEnd(10)}| ${done}/${total} [00:01<00:01,  1.00it/s]`);
      await wait(2);
    }
    process.stderr.write('\n');
  }
}
// A crash the way Python reports it (state.traceback: 'docker' is marker-pdf 2.x without Docker, 'cuda' a model that does not fit): the cause is the LAST line.
const TRACEBACKS = {
  docker: ['  File "F:\\StudyHub-Marker\\venv\\Lib\\site-packages\\surya\\inference\\backends\\vllm.py", line 195, in spawn_fn',
    '    raise SpawnError(f"docker run failed: {result.stderr or result.stdout}")',
    'surya.inference.backends.spawn.SpawnError: docker run failed: failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine; check if the path is correct and if the daemon is running: open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'],
  cuda: ['  File "C:\\Users\\Learner Name\\marker-env\\Lib\\site-packages\\torch\\nn\\modules\\module.py", line 1751, in _call_impl',
    '    return forward_call(*args, **kwargs)',
    '           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^',
    'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB. GPU 0 has a total capacity of 4.00 GiB'],
};
if (state.failStart === start) {
  if (state.traceback) {
    const frames = Array.from({ length: 30 }, (_, index) => `  File "C:\\Users\\Learner Name\\marker-env\\Lib\\site-packages\\marker\\step${index}.py", line ${index + 1}, in call\n    value = run(${index})\n            ^^^^^^^^^`);
    console.error(['Traceback (most recent call last):', ...frames, ...TRACEBACKS[state.traceback]].join('\n'));
  } else console.error('OCR backend unavailable');
  process.exit(1);
}
if (state.delayStart === start) await wait(60_000);
const stem = basename(args[0], '.pdf'), folder = join(at('--output_dir'), stem);
await mkdir(folder, { recursive: true });
const text = Array.from({ length: end - start + 1 }, (_, index) => {
  const page = start + index;
  return `{${page}}${'-'.repeat(48)}\n\n${state.blank?.includes(page) ? '' : `Marker page ${page + 1} text`}`;
}).join('\n\n');
await writeFile(join(folder, `${stem}.md`), text);
