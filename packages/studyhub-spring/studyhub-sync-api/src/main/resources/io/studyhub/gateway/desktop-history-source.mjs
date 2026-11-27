// Invoked through node --input-type=module -e so this resource can live inside the Boot JAR.
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const [sidecar, configuredRoot] = process.argv.slice(1);
if (!isAbsolute(sidecar) || !isAbsolute(configuredRoot)) throw new Error('Absolute desktop entry and library paths are required');
const entryUrl = pathToFileURL(await realpath(sidecar));
const { Store } = await import(new URL('../../../lib/store.js', entryUrl));
const root = await realpath(configuredRoot);
const store = new Store(root);
const rootIdentity = await stat(root, { bigint: true });
if (!rootIdentity.isDirectory()) throw new Error('The desktop history source must be a library directory');

async function verifyRoot() {
  const now = await stat(root, { bigint: true });
  if (now.dev !== rootIdentity.dev || now.ino !== rootIdentity.ino || (await realpath(root)) !== root) {
    throw new Error('The bound desktop library directory has been replaced');
  }
}

const hasId = value => typeof value === 'string' && value.length > 0;
const optionalId = value => value == null || value === '' ? null : value;
const digest = value => createHash('sha256').update(value).digest('hex');
function canonicalJson(value) {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
async function send(value) {
  if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain');
}

function deckCourses(state) {
  const knownCourses = new Set(state.courses.map(course => course?.id).filter(hasId));
  const bindings = new Map();
  for (const deck of state.decks) {
    if (!hasId(deck?.id)) continue;
    const course = knownCourses.has(deck.courseId) ? deck.courseId : null;
    if (!bindings.has(deck.id)) bindings.set(deck.id, course);
    else if (bindings.get(deck.id) !== course) bindings.set(deck.id, null);
  }
  return bindings;
}

function snapshotFingerprint(entry, bindings) {
  if (entry.storageIssues?.length) throw new Error('Desktop library has unreadable shards: ' + entry.storageIssues.length);
  if (!entry.manifest) {
    if (entry.state.format != null || entry.state.shards != null) throw new Error('Unsupported desktop library format');
    return 'legacy:' + entry.stamp;
  }
  const { shards } = entry.manifest;
  for (const key of ['attempts', 'decks', 'courses']) {
    if (Object.hasOwn(shards, key) && !(Array.isArray(shards[key]) && shards[key].every(name => typeof name === 'string'))) {
      throw new Error('Invalid desktop library shard list: ' + key);
    }
  }
  // Older manifests may keep a collection inline. Store's commit stamp then covers the whole value.
  if (!Array.isArray(shards.attempts)) return 'legacy:' + entry.stamp;
  return digest(JSON.stringify([shards.attempts, [...bindings]]));
}

let acknowledged;
let pending;
// Store shares frozen attempt objects from unchanged chunks across revisions. Cache only their small hashes.
const recordDigests = new WeakMap();
function recordIdentity(attempt, occurrences) {
  let saved = recordDigests.get(attempt);
  if (!saved) {
    const unnamed = attempt.id == null || attempt.id === '';
    const content = digest(JSON.stringify(attempt));
    const stable = unnamed ? digest(canonicalJson(attempt)) : attempt.id;
    const key = digest(JSON.stringify([optionalId(attempt.deckId), attempt.quiz_id ?? null, unnamed ? 'anonymous' : 'id', stable]));
    saved = { unnamed, content, key };
    recordDigests.set(attempt, saved);
  }
  // Store imports can contain colliding named IDs. The first preserves its customary identity.
  const occurrence = occurrences.get(saved.key) ?? 0;
  occurrences.set(saved.key, occurrence + 1);
  if (occurrence === 0 && !saved.unnamed) return saved;
  return { content: saved.content, key: saved.key + ':' + occurrence, occurrence };
}

async function deliverChanges(attempts, bindings, previous) {
  const heads = new Map();
  const occurrences = new Map();
  if (attempts.some(attempt => !attempt || typeof attempt !== 'object' || Array.isArray(attempt))) {
    throw new Error('Invalid desktop attempt record');
  }
  for (const attempt of attempts) {
    const deck = optionalId(attempt.deckId);
    const course = Object.hasOwn(attempt, 'courseId') ? optionalId(attempt.courseId) : bindings.get(deck) ?? null;
    const { content, key, occurrence } = recordIdentity(attempt, occurrences);
    const signature = content + ':' + JSON.stringify(course);
    heads.set(key, signature);
    if (signature !== previous?.get(key)) await send({ attempt, course, deck, occurrence });
  }
  return heads;
}

async function scan() {
  // A scan repeated without ack must redeliver even when the previous scan was a cache hit.
  if (pending) acknowledged = undefined;
  pending = undefined;
  await verifyRoot();
  if (acknowledged && (await store.stamp()) === acknowledged.stamp) {
    pending = acknowledged;
    return;
  }
  const entry = await store.load();
  await verifyRoot();
  const bindings = deckCourses(entry.state);
  const fingerprint = snapshotFingerprint(entry, bindings);
  const heads = fingerprint === acknowledged?.fingerprint ? acknowledged.heads
    : await deliverChanges(entry.state.attempts, bindings, acknowledged?.heads);
  pending = { stamp: entry.stamp, fingerprint, heads };
}

const commands = createInterface({ input: process.stdin, crlfDelay: Infinity });
try {
  for await (const command of commands) {
    if (command === 'ack') {
      if (pending) acknowledged = pending;
      pending = undefined;
      continue;
    }
    try {
      if (command === 'identity') {
        await verifyRoot();
        await send({ identity: rootIdentity.dev.toString() + ':' + rootIdentity.ino.toString() });
        continue;
      }
      if (command !== 'scan') throw new Error('Unknown desktop history command');
      await scan();
      await send({ done: true });
    } catch (error) {
      acknowledged = pending = undefined;
      await send({ error: error.message });
    }
  }
} finally {
  commands.close();
  store.releaseMemory();
}
