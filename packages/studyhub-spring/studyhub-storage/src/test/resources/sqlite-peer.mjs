import { DatabaseSync } from 'node:sqlite';
import { Store } from '../../../../../../lib/store.js';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const [mode, file, temp] = process.argv.slice(2);
const db = new DatabaseSync(file);
try {
  if (mode === 'future') { db.exec('PRAGMA user_version=99'); }
  if (mode === 'foreign') { db.exec('CREATE TABLE inventory(owner TEXT)'); }
  if (mode === 'write') {
    const source = new Store(await mkdtemp(join(temp, 'node-source-')));
    await source.update(state => { state.sources.push({ id:'s1', title:'模型', text:'Cycles', custom:{ durable:true } }); });
    const bytes = Buffer.from(JSON.stringify(await source.read()));
    await writeFile(join(temp, 'from-node.json'), bytes);
    db.prepare('INSERT INTO study_records VALUES(?,?,?,?,?)').run('L1','exports','book',1,bytes);
  }
  if (mode === 'restore') {
    const row = db.prepare('SELECT version,payload FROM study_records WHERE library_id=? AND collection=? AND record_id=?')
      .get('L1','exports','restored');
    assert.equal(row.version, 1);
    assert.deepEqual(Buffer.from(row.payload), await readFile(join(temp, 'from-node.json')));
    const store = new Store(await mkdtemp(join(temp, 'node-restore-')));
    await store.restore(JSON.parse(Buffer.from(row.payload).toString('utf8')));
    const [source] = (await store.read()).sources;
    assert.equal(source.title, '模型');
    assert.deepEqual(source.custom, { durable:true });
  }
} finally { db.close(); }
