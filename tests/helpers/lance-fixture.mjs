/* Writes a real LanceDB table for tests/retrieval-self-heal.test.mjs, in a process of its own so no file of it stays open in the test:
   node lance-fixture.mjs <LanceDB module URL> <apache-arrow module URL> <database folder> good|empty
   good: a 'chunks' table with a text and a vector column, written twice (two versions); empty: a 'chunks' table with no fields at all, which is what
   LanceDB 0.38 reads from a table whose newest manifest is all zeros. */
const [lanceUrl, arrowUrl, dbPath, kind] = process.argv.slice(2);
const lance = await import(lanceUrl), connect = lance.connect ?? lance.default.connect;
const db = await connect(dbPath);
if (kind === 'empty') {
  const arrow = await import(arrowUrl), Schema = arrow.Schema ?? arrow.default.Schema;
  await db.createEmptyTable('chunks', new Schema([]), { mode: 'overwrite' });
} else {
  const table = await db.createTable('chunks', [{ text: '进程是资源分配的单位。', vector: [0.1, 0.2, 0.3] }], { mode: 'overwrite' });
  await table.add([{ text: '线程是调度的单位。', vector: [0.3, 0.2, 0.1] }]);
  table.close?.();
}
db.close?.();
