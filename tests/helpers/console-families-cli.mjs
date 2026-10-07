import { access, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { until } from './wait.mjs';

// Hold only the synthetic installer work, after its process exists. Releasing the marker
// lets the existing fake continue; cancellation exercises the real process stop path.
const [, , target, ...args] = process.argv;
if ((args[0] === '-m' && args[1] === 'pip') || args[0] === '--tier') {
  const gate = process.env.CONSOLE_CLI_GATE;
  if (gate) {
    await writeFile(`${gate}.entered`, 'entered');
    await until(() => access(gate).then(() => true, () => false), 'console fixture release', { timeoutMs: 240_000 });
  }
}
process.argv = [process.argv[0], target, ...args];
await import(pathToFileURL(target).href);
