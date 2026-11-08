import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { Store } from '../lib/store.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const STORE_URL = new URL('../lib/store.js', import.meta.url).href;

const shardHash = (text) => createHash('sha1').update(text).digest('hex').slice(0, 20);

async function makeTempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'study-shard-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

/** Read a library in a brand-new child Node process so in-memory caches cannot hide disk corruption. */
async function readInFreshProcess(root) {
  const script = `
    import { Store } from ${JSON.stringify(STORE_URL)};
    const store = new Store(process.argv[1]);
    const state = await store.read();
    process.stdout.write(JSON.stringify({
      revision: state.revision,
      notes: state.notes,
      sources: state.sources,
      decks: state.decks,
      feedback: state.feedback,
      storageIssues: state.storageIssues || [],
    }));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script, root], { cwd: REPO_ROOT });
  return JSON.parse(stdout);
}

test('#839: truncated orphan shard at target hash path is atomically replaced instead of causing false-positive save', async (t) => {
  const root = await makeTempRoot(t);
  const store = new Store(root);
  // Seed an initial valid sharded library with empty notes.
  await store.update((state) => {
    state.sources.push({ id: 'src-1', title: 'Initial source', text: ' Baseline content.' });
  });

  const targetNote = { id: 'note-1', title: ' Atomic shard note ', body: 'Must survive cold restart.' };
  const expectedNotesText = JSON.stringify([targetNote]);
  const orphanShardRel = `misc/notes.${shardHash(expectedNotesText)}.json`;
  const orphanShardPath = join(root, 'shards', orphanShardRel);
  await mkdir(dirname(orphanShardPath), { recursive: true });
  // Pre-seed a truncated leftover shard from an earlier interrupted write (#839 reproduction).
  await writeFile(orphanShardPath, '[{"id":', 'utf8');

  await store.update((state) => {
    state.notes.push(targetNote);
  });

  const hot = await store.read();
  assert.equal(hot.notes.length, 1);
  assert.equal(hot.notes[0].id, 'note-1');
  assert.equal(hot.storageIssues, undefined);

  const diskText = await readFile(orphanShardPath, 'utf8');
  assert.equal(diskText, expectedNotesText, 'truncated orphan shard was atomically replaced with complete JSON');

  const cold = await readInFreshProcess(root);
  assert.deepEqual(cold.storageIssues, [], 'fresh child process sees zero storage issues');
  assert.deepEqual(cold.notes, hot.notes, 'hot process and fresh child process read identical notes');

  // Subsequent writes in a fresh process succeed (not locked into write-protection).
  const store2 = new Store(root);
  await store2.update((state) => {
    state.notes.push({ id: 'note-2', title: 'Second note', body: 'Still writable.' });
  });
  const afterSecond = await readInFreshProcess(root);
  assert.equal(afterSecond.notes.length, 2);
});

test('#839: wrong-content orphan shard at target hash path is replaced, while valid matching orphan shard is reused cleanly', async (t) => {
  const root = await makeTempRoot(t);
  const store = new Store(root);
  await store.update((state) => {
    state.sources.push({ id: 'src-a', title: 'A', text: 'Alpha' });
  });

  const noteA = { id: 'n-wrong', title: 'Expected note', body: 'Right payload' };
  const textA = JSON.stringify([noteA]);
  const pathA = join(root, 'shards', `misc/notes.${shardHash(textA)}.json`);
  await mkdir(dirname(pathA), { recursive: true });
  // Valid JSON, but wrong content under the target filename.
  await writeFile(pathA, JSON.stringify([{ id: 'n-wrong', title: 'Tampered payload', body: 'Wrong' }]), 'utf8');

  await store.update((state) => {
    state.notes = [noteA];
  });

  const coldA = await readInFreshProcess(root);
  assert.deepEqual(coldA.storageIssues, []);
  assert.deepEqual(coldA.notes, [noteA], 'mismatched existing shard content was overwritten with verified payload');

  // Now pre-seed an exact matching shard for a new source item and verify commit succeeds cleanly.
  const newSource = { id: 'src-exact', title: 'Exact match', text: 'Pre-written complete shard', courses: [], courseIds: [] };
  // First compute exact normalized form by committing in a throwaway store, or test misc/feedback shard which has deterministic JSON.
  const feedbackItems = [{ id: 'fb-1', rating: 'good', note: 'Verified reuse' }];
  const feedbackText = JSON.stringify(feedbackItems);
  const feedbackPath = join(root, 'shards', `misc/feedback.${shardHash(feedbackText)}.json`);
  await writeFile(feedbackPath, feedbackText, 'utf8');

  await store.update((state) => {
    state.feedback = feedbackItems;
    state.sources.push(newSource);
  });
  const coldB = await readInFreshProcess(root);
  assert.deepEqual(coldB.storageIssues, []);
  assert.deepEqual(coldB.feedback, feedbackItems);
});

test('#839: commit fault matrix across shard write, post-shard/pre-manifest, manifest write, and post-manifest leaves either complete old or complete new state', async (t) => {
  const stages = [
    { stage: 'during-shard-write', expectRevision: 1, expectNotes: 0 },
    { stage: 'before-manifest-write', expectRevision: 1, expectNotes: 0 },
    { stage: 'before-manifest-replace', expectRevision: 1, expectNotes: 0 },
    { stage: 'after-manifest-replace', expectRevision: 2, expectNotes: 1 },
  ];

  for (const { stage, expectRevision, expectNotes } of stages) {
    await t.test(`fault at ${stage}`, async (sub) => {
      const root = await makeTempRoot(sub);
      const baseline = new Store(root);
      await baseline.update((state) => {
        state.sources.push({ id: 'base-src', title: 'Baseline', text: 'Committed v1' });
      });

      const faulty = new Store(root, {
        onCommitStage: async (point, info) => {
          if (point !== stage) return;
          if (stage === 'during-shard-write' && info?.tempPath) {
            await writeFile(info.tempPath, '{"id":"half-written', 'utf8');
          }
          const err = new Error(`injected-${stage}`);
          err.code = 'EINJECTED';
          throw err;
        },
      });

      await assert.rejects(
        () => faulty.update((state) => {
          state.notes.push({ id: `note-${stage}`, title: 'Candidate', body: 'Atomic check' });
        }),
        /injected-/,
      );

      // Cold restart in a separate process must see a 100% healthy library (either complete old or complete new).
      const coldAfterCrash = await readInFreshProcess(root);
      assert.deepEqual(coldAfterCrash.storageIssues, [], `${stage}: zero storage issues on cold restart`);
      assert.equal(coldAfterCrash.revision, expectRevision, `${stage}: expected revision`);
      assert.equal(coldAfterCrash.notes.length, expectNotes, `${stage}: expected notes count`);
      assert.equal(coldAfterCrash.sources.length, 1, `${stage}: baseline source preserved`);

      // Recovery commit on a fresh Store instance must succeed cleanly and match cold process read.
      const recovery = new Store(root);
      await recovery.update((state) => {
        if (!state.notes.some((n) => n.id === `note-${stage}`)) {
          state.notes.push({ id: `note-${stage}`, title: 'Candidate', body: 'Atomic check' });
        }
        state.notes.push({ id: `recovered-${stage}`, title: 'Recovered', body: 'Post-fault write' });
      });
      const hotFinal = await recovery.read();
      const coldFinal = await readInFreshProcess(root);
      assert.deepEqual(coldFinal.storageIssues, []);
      assert.deepEqual(coldFinal.notes, hotFinal.notes, `${stage}: hot and cold state match after recovery write`);
      assert.equal(coldFinal.notes.length, 2);
    });
  }
});

test('#839: already-referenced corrupt shard still triggers write-protection and preserves damaged evidence without overwriting', async (t) => {
  const root = await makeTempRoot(t);
  const store = new Store(root);
  await store.update((state) => {
    state.sources.push({ id: 'keep-me', title: 'Healthy source', text: 'Still readable' });
    state.notes.push({ id: 'n-1', title: 'Important note', body: 'Original data' });
  });

  const manifest = JSON.parse(await readFile(join(root, 'study-workspace.json'), 'utf8'));
  const referencedNotesShard = join(root, 'shards', manifest.shards.notes);
  await writeFile(referencedNotesShard, '[{"id":"corrupt-in-place', 'utf8');

  const cold = await readInFreshProcess(root);
  assert.equal(cold.sources.length, 1, 'healthy shards remain readable');
  assert.equal(cold.storageIssues.length, 1, 'referenced corrupt shard is reported in storageIssues');
  assert.match(cold.storageIssues[0].file, /shards\/misc\/notes\./);

  const freshStore = new Store(root);
  await assert.rejects(
    () => freshStore.update((state) => {
      state.notes.push({ id: 'n-2', title: 'Overwrite attempt', body: 'Must be refused' });
    }),
    /学习库有损坏文件/,
    'writes are blocked while a referenced shard is damaged',
  );

  // Evidence on disk is untouched.
  assert.equal(await readFile(referencedNotesShard, 'utf8'), '[{"id":"corrupt-in-place');
});
