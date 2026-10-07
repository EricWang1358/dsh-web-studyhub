/* S6-5a guard: the host's model is made in ONE place. `modelServices(...)` (host complete/light -> the services a request or executor is handed) may be called only from the metered
   entry lib/runtime/instant.js, its definition lib/runtime/models.js and the compatibility getters the inventory lists; anything else fails until it is registered with a disposition in
   docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json (`hostModelAccess`) and explained in s6-5a-instant.md. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectHostModelAccess } from './helpers/runtime-architecture.mjs';
import { INSTANT_ACTIONS } from '../lib/runtime/instant.js';

const ROOT = new URL('../', import.meta.url);
const INVENTORY = new URL('../docs/plans/unified-job-runtime/s1-7-legacy-exceptions.json', import.meta.url);
const DESIGN = new URL('../docs/plans/unified-job-runtime/s6-5a-instant.md', import.meta.url);
const DISPOSITIONS = ['entry', 'definition', 'exception'];

async function observed() {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(new URL(directory, ROOT), { withFileTypes: true })) {
      const file = join(directory, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) await visit(file + '/');
      else if (entry.name.endsWith('.js') && !entry.name.startsWith('client.')) {
        const calls = inspectHostModelAccess(await readFile(new URL(file, ROOT), 'utf8'));
        if (calls.length) found.push({ file, calls });
      }
    }
  }
  await visit('lib/');
  return found.sort((a, b) => a.file.localeCompare(b.file));
}

test('inspectHostModelAccess sees real calls, not strings, comments or the name as a value', () => {
  assert.deepEqual(inspectHostModelAccess('const models = modelServices(options);'), [{ callee: 'modelServices', count: 1 }]);
  assert.deepEqual(inspectHostModelAccess('const a = modelServices(x), b = modelServices(y);'), [{ callee: 'modelServices', count: 2 }]);
  assert.deepEqual(inspectHostModelAccess('// modelServices(x)\nconst text = "modelServices(x)"; export { modelServices }; import { modelServices } from "./m.js";'), []);
});

test('the host model is made only where the inventory says, each with its disposition', async () => {
  const inventory = JSON.parse(await readFile(INVENTORY, 'utf8')).hostModelAccess;
  assert.deepEqual(await observed(), inventory.map(({ file, calls }) => ({ file, calls })).sort((a, b) => a.file.localeCompare(b.file)),
    'a new call of modelServices must go through lib/runtime/instant.js or be registered with a disposition');
  for (const entry of inventory) {
    assert.ok(DISPOSITIONS.includes(entry.disposition), `${entry.file}: ${entry.disposition}`);
    for (const field of ['owner', 'reason', 'removeAt', 'evidence']) assert.ok(entry[field], `${entry.file}: ${field}`);
  }
  assert.deepEqual(inventory.filter(entry => entry.disposition === 'entry').map(entry => entry.file), ['lib/runtime/instant.js'], 'exactly one metered entry');
});

test('the instant requests of the design note are the ones the entry leases', async () => {
  const note = await readFile(DESIGN, 'utf8'), listed = [...note.matchAll(/^- `([a-z][\w.*]*)`/gm)].map(match => match[1]);
  assert.deepEqual([...listed].sort(), [...INSTANT_ACTIONS, 'oral.*'].sort(), 'docs/plans/unified-job-runtime/s6-5a-instant.md lists the same actions as INSTANT_ACTIONS (and every oral.*)');
});
