import { access, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { family } from './nonmodel-library.mjs';
import { gate, soon } from './console-families.mjs';
import { FRESH } from './mineru-setup-harness.mjs';
import { readJsonFile, writeJsonFile } from './wait.mjs';

// PDF has its own console matrix. These legacy paths have a family status panel
// but no job card until their migration switch is enabled.
const CLI = fileURLToPath(new URL('./console-families-cli.mjs', import.meta.url));
const ENDED = ['complete', 'done', 'failed', 'cancelled', 'canceled'];
async function open(t) {
  const index = { hold: null, fail: false };
  const world = await family(t, { paths: [], fakes: { cliWrapper: CLI, release: () => index.hold?.open(), onIngest: async () => {
    if (index.hold) { index.hold.entered = true; await index.hold.promise; }
    if (index.fail) throw new Error('network fixture indexing failed');
  } } });
  world.indexControl = index; world.releaseFile = join(world.dir, 'cli-release');
  world.set = (on, switches) => { for (const name of switches) world.pilot[name] = on; };
  await writeFile(world.releaseFile, 'release');
  return world;
}
const cliHold = async world => {
  await rm(world.releaseFile, { force: true }); await rm(`${world.releaseFile}.entered`, { force: true });
};
const cliEntered = world => soon(() => access(`${world.releaseFile}.entered`).then(() => true, () => false), 'fake installer process to enter its gate');
const cliRelease = world => writeFile(world.releaseFile, 'release');
const finish = async (world, driver) => soon(async () => {
  const state = await world.call(driver.status, driver.args);
  return ENDED.includes(state.status) && state;
}, `${driver.id} to finish`);

const marker = {
  id: 'marker', kind: 'marker-install', switches: ['markerInstall'], status: 'marker.install.status', cancel: 'marker.install.cancel', args: {}, open,
  start: world => world.call('marker.install.start', { confirm: true }),
  reset: world => world.call('marker.install.uninstall', { confirm: true }),
  hold: cliHold, entered: cliEntered, release: cliRelease,
  fail: world => writeJsonFile(world.files.py, { failPip: true }),
};
const setup = {
  id: 'mineru-setup', kind: 'mineru-setup', switches: ['mineruSetup'], status: 'mineru.local.setup.status', cancel: 'mineru.local.setup.cancel', args: {}, open,
  start: world => world.call('mineru.local.setup', { tier: 'basic', confirm: true }),
  reset: async world => writeJsonFile(world.files.mineru, { ...await readJsonFile(world.files.mineru), ...FRESH }),
  hold: cliHold, entered: cliEntered, release: cliRelease,
  fail: async world => writeJsonFile(world.files.mineru, { ...await readJsonFile(world.files.mineru), downloadFails: true }),
};
const index = {
  id: 'index', kind: 'retrieval-index', switches: ['retrievalIndex'], status: 'retrieval.index.status', cancel: 'retrieval.index.cancel', args: { course: 'OS' }, open,
  start: world => world.call('retrieval.index.start', { course: 'OS' }),
  reset: world => world.service.store.update(state => { for (const source of state.sources) source.text += '\nOne more indexable fact.'; }),
  hold: async world => { world.indexControl.hold = gate(); },
  entered: world => soon(() => world.indexControl.hold.entered, 'fake search extension to receive an ingest'),
  release: async world => { world.indexControl.hold?.open(); },
  fail: async world => { world.indexControl.fail = true; },
};
export const PROCESS_DRIVERS = [marker, setup, index].map(driver => ({ ...driver, finish: world => finish(world, driver) }));
