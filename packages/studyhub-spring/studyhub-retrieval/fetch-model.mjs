// Explicit provisioning step. Every file is verified before the atomic rename.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';

const manifest = Object.fromEntries((await readFile(new URL('./src/main/resources/io/studyhub/retrieval/model.properties', import.meta.url), 'utf8'))
  .trim().split(/\r?\n/).map(line => line.split('=')));
const root = resolve(process.argv[2] || 'target/model');
const base = 'https://huggingface.co/' + manifest.repository + '/resolve/' + manifest.revision + '/';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}

async function fetchPart(name) {
  const relative = manifest[name + '.file'];
  const expected = manifest[name + '.sha256'];
  const limit = Number(manifest[name + '.bytes']);
  const file = join(root, relative);
  let existing = false;
  try { existing = await digest(file) === expected; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) return;
  await mkdir(dirname(file), { recursive: true });
  for (let attempt = 1; ; attempt++) {
    const temporary = file + '.' + randomUUID() + '.part';
    try {
      const response = await fetch(base + relative, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) {
        await response.body?.cancel();
        throw Object.assign(new Error('Download returned HTTP ' + response.status), { permanent: response.status < 500 && response.status !== 429 });
      }
      let count = 0;
      const hash = createHash('sha256');
      const verify = new Transform({ transform(chunk, _, cb) {
        count += chunk.length;
        if (count > limit) return cb(Object.assign(new Error('Model size exceeds manifest'), { permanent: true }));
        hash.update(chunk);
        cb(null, chunk);
      } });
      await pipeline(response.body, verify, createWriteStream(temporary, { flags: 'wx' }));
      if (count !== limit || hash.digest('hex') !== expected) {
        throw Object.assign(new Error('Model size or SHA-256 mismatch for ' + relative), { permanent: true });
      }
      await rename(temporary, file);
      console.log(relative, expected);
      return;
    } catch (error) {
      if (error.permanent || attempt === 3) throw error;
      await delay(attempt * 1000);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

for (const name of ['model', 'tokenizer']) await fetchPart(name);
