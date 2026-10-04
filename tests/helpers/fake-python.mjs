/* A stand-in for `python` and for the virtual environment's python, for the Marker installer tests. It never touches the network:
   `-m venv` makes the folders, `-m pip install` writes a fake `marker_single` program file where the real one would be.
   State comes from FAKE_PY_STATE (a JSON file); FAKE_PY_VENV is the environment the "venv python" belongs to. */
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
// The test rewrites the state file while this starts: a read that lands in the middle of that is read again.
async function readState() {
  for (let attempt = 0; ; attempt++) {
    try { return JSON.parse(await readFile(process.env.FAKE_PY_STATE, 'utf8')); }
    catch (error) { if (attempt > 400) throw error; await new Promise(resolve => setTimeout(resolve, 15)); }
  }
}
const state = process.env.FAKE_PY_STATE ? await readState() : {};
if (process.env.FAKE_PY_LOG) await appendFile(process.env.FAKE_PY_LOG, `${JSON.stringify(args)}\n`);
const bin = folder => join(folder, process.platform === 'win32' ? 'Scripts' : 'bin');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

if (args[0] === '--version') { console.log(`Python ${state.version || '3.11.4'}`); process.exit(0); }
if (args[0] === '-c') {
  if (state.noVenvModule) { console.error('ModuleNotFoundError: No module named ensurepip'); process.exit(1); }
  process.exit(0);
}
if (args[0] === '-m' && args[1] === 'venv') {
  if (state.failVenv) { console.error('Error: Command failed (venv)'); process.exit(1); }
  const folder = args[args.length - 1];
  await mkdir(bin(folder), { recursive: true });
  await writeFile(join(folder, 'pyvenv.cfg'), 'home = fake\n');
  console.log(`created ${folder}`);
  process.exit(0);
}
if (args[0] === '-m' && args[1] === 'pip') {
  console.log('Collecting marker-pdf');
  console.log('  Downloading marker_pdf-1.0.0-py3-none-any.whl (200 kB)');
  if (state.failPip) { console.error(state.pipError || 'ERROR: Could not find a version that satisfies the requirement marker-pdf (from versions: none)'); process.exit(1); }
  if (state.delayPip) await wait(60_000);
  const folder = process.env.FAKE_PY_VENV;
  await mkdir(bin(folder), { recursive: true });
  await writeFile(join(bin(folder), process.platform === 'win32' ? 'marker_single.exe' : 'marker_single'), 'fake marker_single');
  console.log('Successfully installed marker-pdf-1.0.0');
  process.exit(0);
}
console.error(`fake python: unexpected arguments ${JSON.stringify(args)}`);
process.exit(2);
