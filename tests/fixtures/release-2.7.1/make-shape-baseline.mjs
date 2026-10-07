import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fingerprint, manifestPaths } from '../../helpers/kernel-shape.mjs';

/* Writes shape-baseline.json: the key paths of the kernel manifest the rollback fixtures (this folder) were checked against.
   Run it ONLY after tests/unified-runtime-rollback-shape.test.mjs passes for the new shape, in the same commit as the change:
   `node tests/fixtures/release-2.7.1/make-shape-baseline.mjs`. */
const t = { after: hook => { hooks.push(hook); } }, hooks = [];
const paths = await manifestPaths(t);
for (const hook of hooks.reverse()) await hook();
await writeFile(fileURLToPath(new URL('./shape-baseline.json', import.meta.url)), `${JSON.stringify({ release: '2.7.1', digest: fingerprint(paths), paths }, null, 2)}\n`);
console.log(`${paths.length} paths`);
process.exit(0);
