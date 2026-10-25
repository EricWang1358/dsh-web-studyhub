/* Run by heal.js in a process of its own (so LanceDB never loads into DSH itself):
   node check-index.mjs <LanceDB module URL> <database folder> <table>
   Prints one JSON line: { verdict: 'ok' | 'no-text-field' | 'cannot-open' | 'absent' | 'unknown', detail? }. */
const [moduleUrl, dbPath, table] = process.argv.slice(2);
const message = error => { const parts = []; for (let cause = error; cause && parts.length < 4; cause = cause.cause) parts.push(String(cause.message || cause)); return parts.join(' <- '); };

async function verdict() {
  let connect, db, names;
  try { const module = await import(moduleUrl); connect = module.connect ?? module.default?.connect; } catch (error) { return { verdict: 'unknown', detail: message(error) }; }
  if (typeof connect !== 'function') return { verdict: 'unknown', detail: 'LanceDB has no connect()' };
  try { db = await connect(dbPath); names = await db.tableNames(); } catch (error) { return { verdict: 'unknown', detail: message(error) }; }
  if (!names.includes(table)) return { verdict: 'absent' };
  try {
    const opened = await db.openTable(table);
    const fields = (await opened.schema()).fields.map(field => field.name);
    opened.close?.();
    return { verdict: fields.includes('text') ? 'ok' : 'no-text-field', detail: fields.join(',') };
  } catch (error) { return { verdict: 'cannot-open', detail: message(error) }; }
  finally { db.close?.(); }
}

const { verdict: answer, detail } = await verdict();
process.stdout.write(`${JSON.stringify({ verdict: answer, ...(detail ? { detail: String(detail).slice(0, 300) } : {}) })}\n`);
