import type { StudySnapshot } from '../types/contracts.js';

const FNV_PRIME = 0x01000193;
const FNV_OFFSET_1 = 0x811c9dc5 | 0;
const FNV_OFFSET_2 = 0x9e3779b9 | 0;
const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Dual signed-int32 FNV-1a rolling hasher with zero HeapNumber boxing in V8.
 * Keeping `h1`/`h2` as signed 32-bit integers (`Math.imul` returns int32) avoids
 * `>>> 0` double-boxing on every step; unsigned conversion happens once in `digest()`.
 */
class RollingHasher {
  private h1 = FNV_OFFSET_1;
  private h2 = FNV_OFFSET_2;

  private mixInt32(n: number): void {
    const x = n | 0;
    this.h1 = Math.imul(this.h1 ^ x, FNV_PRIME);
    this.h2 = Math.imul(this.h2 ^ ((x >>> 16) ^ (x << 16) ^ 0x55555555), FNV_PRIME);
  }

  private mixChars(s: string): void {
    const len = s.length;
    let h1 = Math.imul(this.h1 ^ len, FNV_PRIME);
    let h2 = Math.imul(this.h2 ^ (len ^ 0x55), FNV_PRIME);
    for (let i = 0; i < len; i++) {
      const code = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, FNV_PRIME);
      h2 = Math.imul(h2 ^ ((code >>> 8) ^ 0x55), FNV_PRIME);
    }
    this.h1 = h1;
    this.h2 = h2;
  }

  tag(t: number): void {
    const x = (0xfe00 | (t & 0xff)) | 0;
    this.h1 = Math.imul(this.h1 ^ x, FNV_PRIME);
    this.h2 = Math.imul(this.h2 ^ (x ^ 0x55), FNV_PRIME);
  }

  val(v: unknown): void {
    if (v === undefined) {
      this.h1 = Math.imul(this.h1 ^ 0xff00, FNV_PRIME);
      this.h2 = Math.imul(this.h2 ^ 0xaa00, FNV_PRIME);
      return;
    }
    if (v === null) {
      this.h1 = Math.imul(this.h1 ^ 0xff01, FNV_PRIME);
      this.h2 = Math.imul(this.h2 ^ 0xaa01, FNV_PRIME);
      return;
    }
    const kind = typeof v;
    if (kind === 'string') {
      this.h1 = Math.imul(this.h1 ^ 0xff06, FNV_PRIME);
      this.h2 = Math.imul(this.h2 ^ 0xaa06, FNV_PRIME);
      this.mixChars(v as string);
      return;
    }
    if (kind === 'number') {
      const num = v as number;
      if (num !== num) {
        this.h1 = Math.imul(this.h1 ^ 0xff04, FNV_PRIME);
        this.h2 = Math.imul(this.h2 ^ 0xaa04, FNV_PRIME);
        return;
      }
      this.h1 = Math.imul(this.h1 ^ 0xff05, FNV_PRIME);
      this.h2 = Math.imul(this.h2 ^ 0xaa05, FNV_PRIME);
      const asInt = num | 0;
      if (asInt === num) {
        this.mixInt32(asInt);
        return;
      }
      this.mixChars(String(num));
      return;
    }
    if (kind === 'boolean') {
      const code = v ? 0xff02 : 0xff03;
      this.h1 = Math.imul(this.h1 ^ code, FNV_PRIME);
      this.h2 = Math.imul(this.h2 ^ (code ^ 0x5500), FNV_PRIME);
      return;
    }
    this.h1 = Math.imul(this.h1 ^ 0xff07, FNV_PRIME);
    this.h2 = Math.imul(this.h2 ^ 0xaa07, FNV_PRIME);
    this.mixChars(String(v));
  }

  digest(): string {
    return `${(this.h1 >>> 0).toString(36)}-${(this.h2 >>> 0).toString(36)}`;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashShallowRecord(h: RollingHasher, raw: unknown, depth = 0): void {
  const rec = asRecord(raw);
  if (!rec) {
    h.val(raw);
    return;
  }
  h.tag(10 + depth);
  for (const key in rec) {
    if (!hasOwn.call(rec, key)) continue;
    h.val(key);
    const v = rec[key];
    if (depth < 1 && Array.isArray(v)) {
      h.tag(20);
      h.val(v.length);
      for (let i = 0; i < v.length; i++) h.val(v[i]);
    } else if (depth < 1 && v && typeof v === 'object') {
      hashShallowRecord(h, v, depth + 1);
    } else {
      h.val(v);
    }
  }
}

function hashMaterialFolders(h: RollingHasher, raw: unknown): void {
  const rec = asRecord(raw);
  if (!rec) {
    h.val(rec);
    return;
  }
  const folders = rec.folders;
  if (Array.isArray(folders)) {
    h.val(folders.length);
    for (let i = 0; i < folders.length; i++) h.val(folders[i]);
  } else {
    h.val(-1);
  }
  const items = asRecord(rec.items);
  if (items) {
    h.tag(30);
    for (const key in items) {
      if (!hasOwn.call(items, key)) continue;
      h.val(key);
      h.val(items[key]);
    }
  } else {
    h.val(null);
  }
}

function hashStringCollection(h: RollingHasher, raw: unknown): void {
  if (Array.isArray(raw)) {
    h.tag(40);
    h.val(raw.length);
    for (let i = 0; i < raw.length; i++) h.val(raw[i]);
    return;
  }
  hashShallowRecord(h, raw);
}

function hashInbox(h: RollingHasher, inbox: unknown): void {
  h.tag(1);
  if (Array.isArray(inbox)) {
    h.val(0);
    h.val(inbox.length);
    let unread = 0;
    for (let i = 0; i < inbox.length; i++) {
      const item = asRecord(inbox[i]);
      if (item && !item.read) unread++;
      h.val(item?.id);
      h.val(item?.read);
      h.val(item?.at);
    }
    h.val(unread);
    return;
  }
  const obj = asRecord(inbox);
  if (obj) {
    h.val(1);
    h.val(obj.unread);
    const items = Array.isArray(obj.items) ? obj.items : null;
    h.val(items ? items.length : -1);
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = asRecord(items[i]);
        h.val(item?.id);
        h.val(item?.read);
        h.val(item?.at);
      }
    }
    return;
  }
  h.val(inbox);
}

function hashDecksAndProgress(
  h: RollingHasher,
  decks: StudySnapshot['decks'],
  progress: StudySnapshot['progress'],
): void {
  h.tag(2);
  if (Array.isArray(decks)) {
    h.val(decks.length);
    for (let i = 0; i < decks.length; i++) {
      const d = decks[i];
      if (!d) {
        h.val(null);
        continue;
      }
      const r = d as Record<string, unknown>;
      h.val(d.id);
      h.val(d.title);
      h.val(d.name);
      h.val(d.course);
      h.val(r.folder);
      h.val(r.count);
      h.val(d.cardCount);
      h.val(r.due);
      h.val(d.dueCount);
      h.val(r.wrong);
      h.val(d.wrongCount);
      h.val(d.masteredCount);
      h.val(d.newCount);
      h.val(d.archived);
      h.val(r.flagged);
      h.val(r.suspended);
      h.val(r.publishedAt);
      h.val(d.updatedAt);
      h.val(d.lastStudiedAt);
      h.val(Array.isArray(r.cards) ? r.cards.length : -1);
    }
  } else {
    h.val(-1);
  }

  h.tag(3);
  const prog = asRecord(progress);
  if (!prog) {
    h.val(null);
    return;
  }
  for (const deckId in prog) {
    if (!hasOwn.call(prog, deckId)) continue;
    const entry = asRecord(prog[deckId]);
    h.val(deckId);
    if (!entry) {
      h.val(prog[deckId]);
      continue;
    }
    h.val(entry.mastery);
    h.val(entry.total);
    h.val(entry.due);
    const counts = asRecord(entry.counts);
    if (counts) {
      h.val(counts.new);
      h.val(counts.weak);
      h.val(counts.learning);
      h.val(counts.familiar);
      h.val(counts.mastered);
    } else {
      h.val(null);
    }
    h.val(Array.isArray(entry.topics) ? entry.topics.length : -1);
  }
}

function hashSources(h: RollingHasher, sources: StudySnapshot['sources']): void {
  h.tag(4);
  if (!Array.isArray(sources)) {
    h.val(-1);
    return;
  }
  h.val(sources.length);
  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    if (!s) {
      h.val(null);
      continue;
    }
    const r = s as Record<string, unknown>;
    h.val(s.id);
    h.val(s.title);
    h.val(s.name);
    h.val(s.archived);
    h.val(s.pinned);
    h.val(s.folder);
    h.val(s.updatedAt);
    h.val(r.chars);
    h.val(s.course);
    h.val(s.status);
    h.val(s.pageCount);
    h.val(s.pages);
    if (Array.isArray(s.courses)) {
      h.val(s.courses.length);
      for (let j = 0; j < s.courses.length; j++) h.val(s.courses[j]);
    } else {
      h.val(-1);
    }
  }
}

function hashCourses(h: RollingHasher, courses: StudySnapshot['courses']): void {
  h.tag(5);
  if (!Array.isArray(courses)) {
    h.val(-1);
    return;
  }
  h.val(courses.length);
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i];
    if (!c) {
      h.val(null);
      continue;
    }
    const r = c as Record<string, unknown>;
    h.val(c.id);
    h.val(c.name);
    h.val(c.title);
    h.val(c.active);
    h.val(c.dueCount);
    h.val(c.deckCount);
    h.val(c.cardCount);
    h.val(c.masteredCount);
    h.val(c.sourceCount);
    h.val(r.updatedAt);
  }
}

function hashDrafts(h: RollingHasher, drafts: StudySnapshot['drafts']): void {
  h.tag(6);
  if (!Array.isArray(drafts)) {
    h.val(-1);
    return;
  }
  h.val(drafts.length);
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];
    if (!d) {
      h.val(null);
      continue;
    }
    const r = d as Record<string, unknown>;
    h.val(d.id);
    h.val(d.title);
    h.val(d.course);
    h.val(d.status);
    h.val(r.draftVersion);
    h.val(r.editingDeckId);
    h.val(Array.isArray(d.cards) ? d.cards.length : -1);
    h.val(d.cardCount);
    h.val(r.updatedAt);
    h.val(d.createdAt);
  }
}

function hashRuns(h: RollingHasher, runs: StudySnapshot['runs']): void {
  h.tag(7);
  if (!Array.isArray(runs)) {
    h.val(-1);
    return;
  }
  h.val(runs.length);
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run) {
      h.val(null);
      continue;
    }
    const r = run as Record<string, unknown>;
    h.val(run.id);
    h.val(run.mode);
    h.val(run.status);
    h.val(run.index);
    h.val(run.answered);
    h.val(run.total);
    h.val(r.closedAt);
    h.val(r.submittedAt);
    h.val(run.updatedAt);
  }
}

function hashJobs(h: RollingHasher, jobs: StudySnapshot['jobs']): void {
  h.tag(8);
  if (!Array.isArray(jobs)) {
    h.val(-1);
    return;
  }
  h.val(jobs.length);
  for (let i = 0; i < jobs.length; i++) {
    const j = jobs[i];
    if (!j) {
      h.val(null);
      continue;
    }
    h.val(j.id);
    h.val(j.type);
    h.val(j.kind);
    h.val(j.status);
    h.val(j.progress);
    h.val(j.phase);
    h.val(j.error);
    h.val(j.updatedAt);
  }
}

function hashBoundaryEntries(
  h: RollingHasher,
  tagId: number,
  list: Array<Record<string, unknown>> | undefined,
  fields: readonly string[],
): void {
  h.tag(tagId);
  if (!Array.isArray(list)) {
    h.val(-1);
    return;
  }
  h.val(list.length);
  if (list.length === 0) return;
  const first = asRecord(list[0]);
  const last = list.length > 1 ? asRecord(list[list.length - 1]) : first;
  for (const field of fields) h.val(first?.[field]);
  if (list.length > 1) {
    for (const field of fields) h.val(last?.[field]);
  }
}

function hashSettings(h: RollingHasher, snapshot: StudySnapshot): void {
  h.tag(11);
  const settings = asRecord(snapshot.settings);
  hashShallowRecord(h, settings?.practice);
  hashMaterialFolders(h, settings?.materialFolders);
  hashMaterialFolders(h, snapshot.materialFolders);
  hashStringCollection(h, settings?.pinnedSources);
  hashStringCollection(h, settings?.materialPins);
}

/**
 * Computes a fast O(K) structural fingerprint for a StudySnapshot without serializing
 * card/source bodies (`JSON.stringify`). Used by `syncFromHost` to skip redundant store writes.
 */
export function computeSnapshotFingerprint(snapshot: StudySnapshot | null | undefined): string {
  if (!snapshot) return 'empty';

  const h = new RollingHasher();
  const snapRecord = snapshot as Record<string, unknown>;

  h.val(snapshot.root);
  h.val(snapshot.revision);
  h.val(snapshot.fingerprint);
  h.val(snapshot.sample?.loaded);
  h.val(snapshot.modelReady);

  h.tag(12);
  const focus = asRecord(snapshot.focus);
  h.val(focus?.course);
  h.val(focus?.mode);

  h.tag(13);
  const today = asRecord(snapshot.today);
  h.val(today?.due);
  h.val(today?.reviewed);
  h.val(today?.done);
  h.val(today?.streak);
  h.val(today?.goal);
  h.val(today?.new);

  hashInbox(h, snapRecord.inbox);
  hashDecksAndProgress(h, snapshot.decks, snapshot.progress);
  hashSources(h, snapshot.sources);
  hashCourses(h, snapshot.courses);
  hashDrafts(h, snapshot.drafts);
  hashRuns(h, snapshot.runs);
  hashJobs(h, snapshot.jobs);
  hashBoundaryEntries(h, 9, snapshot.oralExams, ['id', 'runId', 'status', 'updatedAt', 'createdAt']);
  hashBoundaryEntries(h, 10, snapshot.attempts, ['id', 'at', 'timestamp', 'voidedAt', 'cardId', 'deckId']);
  hashSettings(h, snapshot);

  h.tag(14);
  const lastRun = asRecord(snapshot.lastRun);
  h.val(lastRun?.id);
  h.val(lastRun?.status);
  h.val(lastRun?.index);
  h.val(lastRun?.answered);
  h.val(lastRun?.total);
  h.val(lastRun?.closedAt);
  h.val(lastRun?.submittedAt);

  h.val(Array.isArray(snapshot.notes) ? snapshot.notes.length : -1);
  h.val(Array.isArray(snapshot.exams) ? snapshot.exams.length : -1);
  h.val(Array.isArray(snapshot.skeletons) ? snapshot.skeletons.length : -1);
  h.val(Array.isArray(snapshot.examPointLists) ? snapshot.examPointLists.length : -1);
  h.val(Array.isArray(snapshot.archivedJobs) ? snapshot.archivedJobs.length : -1);
  h.val(Array.isArray(snapshot.bookCourses) ? snapshot.bookCourses.length : -1);

  return h.digest();
}
