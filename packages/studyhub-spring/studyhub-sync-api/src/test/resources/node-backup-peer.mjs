import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { Store, LATEST_VERSION } from '../../../../../../lib/store.js';

const [mode, root] = process.argv.slice(2);
const store = new Store(join(root, 'node-' + mode));
if (mode === 'export') {
  await store.update(s => {
    s.sources.push({ id:'s1', title:'课程笔记', text:'学习'.repeat(25000) });
    s.decks.push({ id:'deck-a', course:'高等数学', title:'同名卡片', cards:[{ id:'quiz', prompt:'proof?' }] });
    s.attempts.push({ id:'void', quiz_id:'quiz', deckId:'deck-a', grade:5, voidedAt:'2025-05-04T08:00:00Z' },
      { id:'adjust', quiz_id:'quiz', deckId:'deck-a', grade:3, gradeOriginal:1, adjustedAt:'2026-02-01T09:01:00Z',
        before:{}, after:{ algorithm:'fsrs-6' }, extra:{ source:'preserve' } });
  });
  await writeFile(join(root, 'export.json'),JSON.stringify(await store.read(), null, 2));
} else {
  const bytes = await readFile(join(root,'restored.json'));
  assert.deepEqual(bytes,await readFile(join(root,'export.json')));
  await store.restore(JSON.parse(bytes));
  const data = await store.read();
  assert.equal(data.version,LATEST_VERSION);
  assert.equal(data.attempts[0].voidedAt,'2025-05-04T08:00:00Z');
  assert.deepEqual(data.attempts[1].extra,{source:'preserve'});
  assert.equal(data.attempts[1].gradeOriginal,1);
  assert.equal(data.decks[0].course,'高等数学');
  assert.equal(data.sources[0].text.length,50000);
}
