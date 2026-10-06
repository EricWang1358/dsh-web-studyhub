/* A preload (NODE_OPTIONS=--require) that turns the Node binary itself into a stand-in program, so a test can hand StudyHub an absolute
   program path that really is executed (no shell, any platform) and see every time it is. Each start of a Node process that carries
   this preload is logged to SPAWN_PROBE_LOG as one JSON line and answered by a fake: Marker (tests/helpers/fake-marker-cli.mjs) for
   `--help` or a `--page_range` conversion, MinerU (tests/helpers/fake-mineru-cli.mjs) for anything else. Node runs a preload even for
   `node --help` / `node --version`, before it prints anything, and `node <word> ...` would run <word> as a script, so the preload answers
   and exits first. Without SPAWN_PROBE_LOG it does nothing. */
const { appendFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const { spawnSync } = require('node:child_process');
const { isMainThread } = require('node:worker_threads');

const log = process.env.SPAWN_PROBE_LOG;
if (log && isMainThread) {
  // The program's own arguments: flags Node consumed (--help, --version) and the words after the "script" (argv[1] arrives resolved to a path).
  const flags = process.execArgv.filter(flag => flag === '--help' || flag === '--version');
  const rest = process.argv.slice(2), marker = flags.includes('--help') || rest.includes('--page_range');
  // A Marker conversion names the PDF first, as an absolute path; a MinerU sub-command is a word.
  const args = [...flags, ...(process.argv[1] ? [marker ? process.argv[1] : basename(process.argv[1]), ...rest] : [])];
  const role = marker ? 'marker' : 'mineru';
  appendFileSync(log, `${JSON.stringify({ role, program: process.execPath, args })}\n`);
  const env = { ...process.env };
  delete env.NODE_OPTIONS;
  const result = spawnSync(process.execPath, [join(__dirname, `fake-${role}-cli.mjs`), ...args], { env, stdio: 'inherit', windowsHide: true });
  process.exit(result.status ?? 1);
}
