/* One process writing to a library another process writes to as well (tests/zcode-shared-library.test.mjs): DSH and
   ZCode opening the same StudyHub library at once. Usage: node zcode-shared-writer.mjs <library> <name> <count> */
import { StudyService } from '../../lib/service.js';

const [root, name, count] = process.argv.slice(2);
const service = new StudyService(root, {});
for (let index = 0; index < Number(count); index++)
  await service.call('source.add', { title: `${name} ${index}`, text: `${name} writes material number ${index} into the shared library. `.repeat(4) });
await service.dispose();
process.stdout.write('done');
