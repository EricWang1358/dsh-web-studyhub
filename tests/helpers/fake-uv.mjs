#!/usr/bin/env node
/* A stand-in for `uv`, for the one-click MinerU install tests. It never touches the network:
   `uv --version` prints the pinned version; `uv venv <dir> --python X` makes the folders and a placeholder python; `uv pip install --python <py> <req>`
   prints progress and writes placeholder `mineru` and `mineru-kit` programs next to that python (the tests run the fake mineru through a seam).
   Behaviour comes from the JSON file named by FAKE_UV_STATE (absent: defaults): version, failVenv, failPip, pipError, delayPipMs, delayVenvMs.
   Every call is logged to FAKE_UV_LOG, one JSON line with the arguments and the UV_* / TEMP variables it was given. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
async function readState() {
  if (!process.env.FAKE_UV_STATE) return {};
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await readFile(process.env.FAKE_UV_STATE, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return {}; if (attempt > 400) throw error; await new Promise(resolve => setTimeout(resolve, 15)); }
  }
}
const state = await readState();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('UV_') || ['TEMP', 'TMP', 'TMPDIR'].includes(key)));
if (process.env.FAKE_UV_LOG) await appendFile(process.env.FAKE_UV_LOG, `${JSON.stringify({ args, env, pid: process.pid })}\n`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const exe = name => (process.platform === 'win32' ? `${name}.exe` : name);
const fail = (text, code = 2) => { process.stderr.write(`${text}\n`); process.exit(code); };

if (args[0] === '--version') { console.log(`uv ${state.version || '0.13.1'} (fake)`); process.exit(0); }
if (args[0] === 'venv') {
  const folder = args[1];
  if (state.delayVenvMs) await wait(state.delayVenvMs);
  if (state.failVenv) fail(state.venvError || 'error: Failed to download https://registry.npmmirror.com/-/binary/python-build-standalone/cpython-3.12.fake.tar.gz: error sending request');
  console.log(`Using CPython 3.12.15`);
  console.log(`Creating virtual environment at: ${folder}`);
  const bin = join(folder, process.platform === 'win32' ? 'Scripts' : 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, exe('python')), 'fake python');
  await writeFile(join(folder, 'pyvenv.cfg'), 'home = fake\nversion_info = 3.12.15\n');
  process.exit(0);
}
if (args[0] === 'pip' && args[1] === 'install') {
  const python = args[args.indexOf('--python') + 1];
  console.log('Resolved 74 packages in 1.2s');
  console.log('Downloading onnxruntime (12.0MiB)');
  console.log(' 42%|####      | 5.0M/12.0M');
  if (state.failPip) fail(state.pipError || 'error: Failed to fetch: `https://pypi.tuna.tsinghua.edu.cn/simple/mineru/`\n  Caused by: error sending request for url');
  if (state.delayPipMs) await wait(state.delayPipMs);
  const bin = dirname(python);
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, exe('mineru')), 'fake mineru');
  await writeFile(join(bin, exe('mineru-kit')), 'fake mineru-kit');
  console.log('Installed 74 packages in 3.1s');
  console.log(' + mineru==4.0.12');
  process.exit(0);
}
fail(`fake uv: unexpected arguments ${JSON.stringify(args)}`);
