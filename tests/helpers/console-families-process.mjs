import { readFile, writeFile } from 'node:fs/promises';
import { family } from './nonmodel-library.mjs';
import { soon } from './console-families.mjs';

/* The families of the 任务 console that run a program, a cloud conversion or an index build instead of a model (S5-7): a PDF conversion, the Marker install, the local MinerU setup and a
   retrieval index build. Same driver shape as console-families.mjs; every program is a fake (tests/helpers/nonmodel-library.mjs). With a switch off only the PDF conversion is a row of the
   console (the other three keep their own status door), so `done` waits on the family's own door, which answers the same on both sides of the switch. */

const ENDED = ['complete', 'done', 'failed', 'cancelled', 'canceled'];
const patient = { timeoutMs: 240_000 };
const ownEnded = (read, what) => soon(async () => ENDED.includes((await read()).status), what, patient);
const rowIs = (world, type, status) => soon(async () => (await world.jobs()).some(job => job.type === type && job.status === status), `a ${type} job to be ${status}`, patient);
const setPython = (world, state) => writeFile(world.files.py, JSON.stringify(state));
const open = fakes => async t => {
  const world = await family(t, { paths: [], fakes });
  world.holds = []; world.set = (on, names) => { for (const name of names) world.pilot[name] = on; };
  return world;
};

const pdfDriver = {
  id: 'pdf', title: 'PDF 转换', kinds: ['pdf-convert'], switches: ['pdfConvert'], message: false, open: open(),
  async start(world) { return world.call('mineru.import', { uploadId: await world.upload(3), title: 'Book', courses: ['OS'] }); },
  async done(world) { const started = await this.start(world); await world.ended(started.jobId); return started; },
  async held(world) { world.hold.pdf = true; const started = await this.start(world); await rowIs(world, 'pdf-convert', 'running'); return { started, release: () => { world.hold.pdf = false; } }; },
};
const markerDriver = {
  id: 'marker', title: 'Marker 安装', kinds: ['marker-install'], switches: ['markerInstall'], message: false, open: open(),
  async start(world) { return world.call('marker.install.start', { confirm: true }); },
  async done(world) { const started = await this.start(world); await ownEnded(() => world.call('marker.install.status'), 'the install'); return started; },
  async held(world) {
    await setPython(world, { delayPip: true });
    const started = await this.start(world);
    await soon(async () => (await world.call('marker.install.status')).stage === 'install', 'the install to reach pip', patient);
    return { started, release: () => setPython(world, {}) };
  },
};
const mineruSetupDriver = {
  id: 'mineru-setup', title: 'MinerU 本地安装', kinds: ['mineru-setup'], switches: ['mineruSetup'], message: false, open: open(),
  async start(world) { return world.call('mineru.local.setup', { tier: 'basic', confirm: true }); },
  async done(world) { const started = await this.start(world); await ownEnded(() => world.call('mineru.local.setup.status', {}), 'the setup'); return started; },
  async held(world) {
    // every call of the fake command line takes a while, so the setup is still on its first steps when the console looks
    await writeFile(world.files.mineru, JSON.stringify({ ...JSON.parse(await readFile(world.files.mineru, 'utf8')), delayMs: 20_000 }));
    const started = await this.start(world);
    return { started, release: async () => writeFile(world.files.mineru, JSON.stringify({ ...JSON.parse(await readFile(world.files.mineru, 'utf8')), delayMs: 0 })) };
  },
};
const indexDriver = {
  id: 'index', title: '检索索引', kinds: ['retrieval-index'], switches: ['retrievalIndex'], message: false, open: open(),
  async start(world) { return world.call('retrieval.index.start', { course: 'OS' }); },
  async done(world) { const started = await this.start(world); await ownEnded(() => world.call('retrieval.index.status', { course: 'OS' }), 'the index build'); return started; },
  async held(world) {
    world.hold.index = true; const started = await this.start(world);
    await soon(() => world.index.calls.length > 0, 'the build to reach the extension', patient);
    return { started, release: () => { world.hold.index = false; } };
  },
};

export const PROCESS_DRIVERS = [pdfDriver, markerDriver, mineruSetupDriver, indexDriver];
