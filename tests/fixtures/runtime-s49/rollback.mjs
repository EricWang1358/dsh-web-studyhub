import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { FAMILIES, fakeModel, optionsFor } from './families.mjs';

/* The S4-9 rollback drill, one step per process (run it with run-drill.mjs; everything is a fake and nothing leaves the machine):
     prepare <family> <phase>   the CURRENT code, the family's switch on, seeds a library and either finishes the run (`settled`) or leaves it going and ENDS HARD (`crash`);
     read <family>              a code tree (the fixed older one, or the current one) opens the same library and DSH home, reports what it shows and, with `act`, starts the work again.
   argv: mode, family, phase, workdir, libRoot, switch ('on' | 'off'), act ('act' | 'look'). The result is one line, `RESULT <json>`. */

const [mode, familyName, phase, work, libRoot, switchValue, act] = process.argv.slice(2);
const family = FAMILIES[familyName], root = join(work, 'library');
process.env.DSH_HOME = join(work, 'home'); delete process.env.MINERU_API_KEY;
await mkdir(work, { recursive: true });
const { StudyService } = await import(pathToFileURL(join(libRoot, 'lib/service.js')).href);
const context = { lib: libRoot, root };

if (mode === 'prepare') {
  const model = fakeModel(familyName, phase === 'crash' ? 'hold' : 'finish');
  const service = new StudyService(root, optionsFor(familyName, model.complete, true));
  await family.seed(service, context);
  await family.start(service, context);
  if (phase === 'settled') {
    await family.ended(service, context);
    const view = await family.view(service, context);
    await service.dispose();
    console.log(`RESULT ${JSON.stringify({ family: familyName, phase, view })}`);
  } else {
    await model.reached;
    console.log(`RESULT ${JSON.stringify({ family: familyName, phase, endedHard: true, view: await family.view(service, context) })}`);
  }
  process.exit(0); // no dispose, no cleanup: a crash or a rollback
}

const model = fakeModel(familyName, 'finish');
const service = new StudyService(root, optionsFor(familyName, model.complete, switchValue === 'on'));
const result = { family: familyName, phase, lib: switchValue === 'on' ? 'current' : 'older', seen: await family.view(service, context) };
if (act === 'act') {
  try { await family.start(service, context); await family.ended(service, context); result.again = { outcome: 'finished' }; }
  catch (error) { result.again = { outcome: 'refused', message: String(error.message).slice(0, 160) }; }
  result.after = await family.view(service, context);
}
await service.dispose();
console.log(`RESULT ${JSON.stringify(result)}`);
process.exit(0);
