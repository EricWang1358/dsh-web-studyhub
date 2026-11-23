import type { StudySnapshot } from '../types/contracts.js';

const FNV_PRIME = 0x01000193;
const FNV_OFFSET_1 = 0x811c9dc5 | 0;
const FNV_OFFSET_2 = 0x9e3779b9 | 0;
const hasOwn = Object.prototype.hasOwnProperty;

const ORAL_FIELDS = ['id', 'runId', 'status', 'updatedAt', 'createdAt'] as const;
const ATTEMPT_FIELDS = ['id', 'at', 'timestamp', 'voidedAt', 'cardId', 'deckId'] as const;

/**
 * Module-scoped dual signed-int32 FNV-1a rolling state.
 * `computeSnapshotFingerprint` is strictly synchronous, so keeping `_h1`/`_h2`
 * in module locals eliminates class allocation and `this.h1`/`this.h2` field
 * loads/stores while preserving zero HeapNumber boxing in V8.
 */
let _h1 = FNV_OFFSET_1;
let _h2 = FNV_OFFSET_2;

function resetHash(): void {
  _h1 = FNV_OFFSET_1;
  _h2 = FNV_OFFSET_2;
}

function digestHash(): string {
  return `${(_h1 >>> 0).toString(36)}-${(_h2 >>> 0).toString(36)}`;
}

function mixInt32(n: number): void {
  const x = n | 0;
  _h1 = Math.imul(_h1 ^ x, FNV_PRIME);
  _h2 = Math.imul(_h2 ^ ((x >>> 16) ^ (x << 16) ^ 0x55555555), FNV_PRIME);
}

/**
 * Hash every UTF-16 code unit, packing 2 chars per 32-bit FNV-1a step (~2x fewer
 * `Math.imul` ops while maintaining full single-character sensitivity).
 */
function mixChars(s: string): void {
  const len = s.length;
  let h1 = Math.imul(_h1 ^ len, FNV_PRIME);
  let h2 = Math.imul(_h2 ^ (len ^ 0x55), FNV_PRIME);
  let i = 0;
  const end = len - 1;
  for (; i < end; i += 2) {
    const pair = s.charCodeAt(i) | (s.charCodeAt(i + 1) << 16);
    h1 = Math.imul(h1 ^ pair, FNV_PRIME);
    h2 = Math.imul(h2 ^ ((pair >>> 16) ^ (pair << 16) ^ 0x55555555), FNV_PRIME);
  }
  if (i < len) {
    const code = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, FNV_PRIME);
    h2 = Math.imul(h2 ^ ((code >>> 8) ^ 0x55), FNV_PRIME);
  }
  _h1 = h1;
  _h2 = h2;
}

function mixTag(t: number): void {
  const x = (0xfe00 | (t & 0xff)) | 0;
  _h1 = Math.imul(_h1 ^ x, FNV_PRIME);
  _h2 = Math.imul(_h2 ^ (x ^ 0x55), FNV_PRIME);
}

function mixVal(v: unknown): void {
  if (v === undefined) {
    _h1 = Math.imul(_h1 ^ 0xff00, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa00, FNV_PRIME);
    return;
  }
  if (v === null) {
    _h1 = Math.imul(_h1 ^ 0xff01, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa01, FNV_PRIME);
    return;
  }
  const kind = typeof v;
  if (kind === 'string') {
    _h1 = Math.imul(_h1 ^ 0xff06, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa06, FNV_PRIME);
    mixChars(v as string);
    return;
  }
  if (kind === 'number') {
    const num = v as number;
    if (num !== num) {
      _h1 = Math.imul(_h1 ^ 0xff04, FNV_PRIME);
      _h2 = Math.imul(_h2 ^ 0xaa04, FNV_PRIME);
      return;
    }
    _h1 = Math.imul(_h1 ^ 0xff05, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa05, FNV_PRIME);
    const asInt = num | 0;
    if (asInt === num) {
      mixInt32(asInt);
      return;
    }
    mixChars(String(num));
    return;
  }
  if (kind === 'boolean') {
    const code = v ? 0xff02 : 0xff03;
    _h1 = Math.imul(_h1 ^ code, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ (code ^ 0x5500), FNV_PRIME);
    return;
  }
  _h1 = Math.imul(_h1 ^ 0xff07, FNV_PRIME);
  _h2 = Math.imul(_h2 ^ 0xaa07, FNV_PRIME);
  mixChars(String(v));
}

/** Fast monomorphic path for string-typed fields (falls back to `mixVal` for non-strings). */
function mixStr(v: unknown): void {
  if (typeof v === 'string') {
    _h1 = Math.imul(_h1 ^ 0xff06, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa06, FNV_PRIME);
    mixChars(v);
    return;
  }
  if (v === undefined) {
    _h1 = Math.imul(_h1 ^ 0xff00, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa00, FNV_PRIME);
    return;
  }
  mixVal(v);
}

/** Fast monomorphic path for numeric fields (falls back to `mixVal` for non-numbers). */
function mixNum(v: unknown): void {
  if (typeof v === 'number') {
    const asInt = v | 0;
    if (asInt === v) {
      _h1 = Math.imul(_h1 ^ 0xff05, FNV_PRIME);
      _h2 = Math.imul(_h2 ^ 0xaa05, FNV_PRIME);
      mixInt32(asInt);
      return;
    }
  } else if (v === undefined) {
    _h1 = Math.imul(_h1 ^ 0xff00, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa00, FNV_PRIME);
    return;
  }
  mixVal(v);
}

/** Fast monomorphic path for boolean fields (falls back to `mixVal` for non-booleans). */
function mixBool(v: unknown): void {
  if (v === true) {
    _h1 = Math.imul(_h1 ^ 0xff02, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ (0xff02 ^ 0x5500), FNV_PRIME);
    return;
  }
  if (v === false) {
    _h1 = Math.imul(_h1 ^ 0xff03, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ (0xff03 ^ 0x5500), FNV_PRIME);
    return;
  }
  if (v === undefined) {
    _h1 = Math.imul(_h1 ^ 0xff00, FNV_PRIME);
    _h2 = Math.imul(_h2 ^ 0xaa00, FNV_PRIME);
    return;
  }
  mixVal(v);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hashShallowRecord(raw: unknown, depth = 0): void {
  const rec = asRecord(raw);
  if (!rec) {
    mixVal(raw);
    return;
  }
  mixTag(10 + depth);
  for (const key in rec) {
    if (!hasOwn.call(rec, key)) continue;
    mixStr(key);
    const v = rec[key];
    if (depth < 1 && Array.isArray(v)) {
      mixTag(20);
      mixNum(v.length);
      for (let i = 0; i < v.length; i++) mixVal(v[i]);
    } else if (depth < 1 && v && typeof v === 'object') {
      hashShallowRecord(v, depth + 1);
    } else {
      mixVal(v);
    }
  }
}

function hashMaterialFolders(raw: unknown): void {
  const rec = asRecord(raw);
  if (!rec) {
    mixVal(rec);
    return;
  }
  const folders = rec.folders;
  if (Array.isArray(folders)) {
    mixNum(folders.length);
    for (let i = 0; i < folders.length; i++) mixVal(folders[i]);
  } else {
    mixNum(-1);
  }
  const items = asRecord(rec.items);
  if (items) {
    mixTag(30);
    for (const key in items) {
      if (!hasOwn.call(items, key)) continue;
      mixStr(key);
      mixVal(items[key]);
    }
  } else {
    mixVal(null);
  }
}

function hashStringCollection(raw: unknown): void {
  if (Array.isArray(raw)) {
    mixTag(40);
    mixNum(raw.length);
    for (let i = 0; i < raw.length; i++) mixStr(raw[i]);
    return;
  }
  hashShallowRecord(raw);
}

function hashInbox(inbox: unknown): void {
  mixTag(1);
  if (Array.isArray(inbox)) {
    mixNum(0);
    mixNum(inbox.length);
    let unread = 0;
    for (let i = 0; i < inbox.length; i++) {
      const item = asRecord(inbox[i]);
      if (item && !item.read) unread++;
      mixStr(item?.id);
      mixBool(item?.read);
      mixStr(item?.at);
    }
    mixNum(unread);
    return;
  }
  const obj = asRecord(inbox);
  if (obj) {
    mixNum(1);
    mixNum(obj.unread);
    const items = Array.isArray(obj.items) ? obj.items : null;
    mixNum(items ? items.length : -1);
    if (items) {
      for (let i = 0; i < items.length; i++) {
        const item = asRecord(items[i]);
        mixStr(item?.id);
        mixBool(item?.read);
        mixStr(item?.at);
      }
    }
    return;
  }
  mixVal(inbox);
}

function hashDecksAndProgress(
  decks: StudySnapshot['decks'],
  progress: StudySnapshot['progress'],
): void {
  mixTag(2);
  if (Array.isArray(decks)) {
    const len = decks.length;
    mixNum(len);
    for (let i = 0; i < len; i++) {
      const d = decks[i];
      if (!d) {
        mixVal(null);
        continue;
      }
      const r = d as Record<string, unknown>;
      mixStr(d.id);
      mixStr(d.title);
      mixStr(d.name);
      mixStr(d.course);
      mixStr(r.folder);
      mixNum(r.count);
      mixNum(d.cardCount);
      mixNum(r.due);
      mixNum(d.dueCount);
      mixNum(r.wrong);
      mixNum(d.wrongCount);
      mixNum(d.masteredCount);
      mixNum(d.newCount);
      mixBool(d.archived);
      mixBool(r.flagged);
      mixBool(r.suspended);
      mixStr(r.publishedAt);
      mixStr(d.updatedAt);
      mixStr(d.lastStudiedAt);
      mixNum(Array.isArray(r.cards) ? r.cards.length : -1);
    }
  } else {
    mixNum(-1);
  }

  mixTag(3);
  const prog = asRecord(progress);
  if (!prog) {
    mixVal(null);
    return;
  }
  for (const deckId in prog) {
    if (!hasOwn.call(prog, deckId)) continue;
    const rawEntry = prog[deckId];
    mixStr(deckId);
    if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
      mixVal(rawEntry);
      continue;
    }
    const entry = rawEntry as Record<string, unknown>;
    mixNum(entry.mastery);
    mixNum(entry.total);
    mixNum(entry.due);
    const rawCounts = entry.counts;
    if (rawCounts && typeof rawCounts === 'object' && !Array.isArray(rawCounts)) {
      const counts = rawCounts as Record<string, unknown>;
      mixNum(counts.new);
      mixNum(counts.weak);
      mixNum(counts.learning);
      mixNum(counts.familiar);
      mixNum(counts.mastered);
    } else {
      mixVal(null);
    }
    mixNum(Array.isArray(entry.topics) ? entry.topics.length : -1);
  }
}

function hashSources(sources: StudySnapshot['sources']): void {
  mixTag(4);
  if (!Array.isArray(sources)) {
    mixNum(-1);
    return;
  }
  const len = sources.length;
  mixNum(len);
  for (let i = 0; i < len; i++) {
    const s = sources[i];
    if (!s) {
      mixVal(null);
      continue;
    }
    const r = s as Record<string, unknown>;
    mixStr(s.id);
    mixStr(s.title);
    mixStr(s.name);
    mixBool(s.archived);
    mixBool(s.pinned);
    mixStr(s.folder);
    mixStr(s.updatedAt);
    mixNum(r.chars);
    mixStr(s.course);
    mixStr(s.status);
    mixNum(s.pageCount);
    mixNum(s.pages);
    const courses = s.courses;
    if (Array.isArray(courses)) {
      const cLen = courses.length;
      mixNum(cLen);
      for (let j = 0; j < cLen; j++) mixStr(courses[j]);
    } else {
      mixNum(-1);
    }
  }
}

function hashCourses(courses: StudySnapshot['courses']): void {
  mixTag(5);
  if (!Array.isArray(courses)) {
    mixNum(-1);
    return;
  }
  const len = courses.length;
  mixNum(len);
  for (let i = 0; i < len; i++) {
    const c = courses[i];
    if (!c) {
      mixVal(null);
      continue;
    }
    const r = c as Record<string, unknown>;
    mixStr(c.id);
    mixStr(c.name);
    mixStr(c.title);
    mixBool(c.active);
    mixNum(c.dueCount);
    mixNum(c.deckCount);
    mixNum(c.cardCount);
    mixNum(c.masteredCount);
    mixNum(c.sourceCount);
    mixStr(r.updatedAt);
  }
}

function hashDrafts(drafts: StudySnapshot['drafts']): void {
  mixTag(6);
  if (!Array.isArray(drafts)) {
    mixNum(-1);
    return;
  }
  const len = drafts.length;
  mixNum(len);
  for (let i = 0; i < len; i++) {
    const d = drafts[i];
    if (!d) {
      mixVal(null);
      continue;
    }
    const r = d as Record<string, unknown>;
    mixStr(d.id);
    mixStr(d.title);
    mixStr(d.course);
    mixStr(d.status);
    mixNum(r.draftVersion);
    mixStr(r.editingDeckId);
    mixNum(Array.isArray(d.cards) ? d.cards.length : -1);
    mixNum(d.cardCount);
    mixStr(r.updatedAt);
    mixStr(d.createdAt);
  }
}

function hashRuns(runs: StudySnapshot['runs']): void {
  mixTag(7);
  if (!Array.isArray(runs)) {
    mixNum(-1);
    return;
  }
  const len = runs.length;
  mixNum(len);
  for (let i = 0; i < len; i++) {
    const run = runs[i];
    if (!run) {
      mixVal(null);
      continue;
    }
    const r = run as Record<string, unknown>;
    mixStr(run.id);
    mixStr(run.mode);
    mixStr(run.status);
    mixNum(run.index);
    mixNum(run.answered);
    mixNum(run.total);
    mixStr(r.closedAt);
    mixStr(r.submittedAt);
    mixStr(run.updatedAt);
  }
}

function hashJobs(jobs: StudySnapshot['jobs']): void {
  mixTag(8);
  if (!Array.isArray(jobs)) {
    mixNum(-1);
    return;
  }
  const len = jobs.length;
  mixNum(len);
  for (let i = 0; i < len; i++) {
    const j = jobs[i];
    if (!j) {
      mixVal(null);
      continue;
    }
    mixStr(j.id);
    mixStr(j.type);
    mixStr(j.kind);
    mixStr(j.status);
    mixNum(j.progress);
    mixStr(j.phase);
    mixStr(j.error);
    mixStr(j.updatedAt);
  }
}

function hashBoundaryEntries(
  tagId: number,
  list: Array<Record<string, unknown>> | undefined,
  fields: readonly string[],
): void {
  mixTag(tagId);
  if (!Array.isArray(list)) {
    mixNum(-1);
    return;
  }
  mixNum(list.length);
  if (list.length === 0) return;
  const first = asRecord(list[0]);
  const last = list.length > 1 ? asRecord(list[list.length - 1]) : first;
  for (let i = 0; i < fields.length; i++) mixVal(first?.[fields[i]]);
  if (list.length > 1) {
    for (let i = 0; i < fields.length; i++) mixVal(last?.[fields[i]]);
  }
}

function hashSettings(snapshot: StudySnapshot): void {
  mixTag(11);
  const settings = asRecord(snapshot.settings);
  hashShallowRecord(settings?.practice);
  hashMaterialFolders(settings?.materialFolders);
  hashMaterialFolders(snapshot.materialFolders);
  hashStringCollection(settings?.pinnedSources);
  hashStringCollection(settings?.materialPins);
}

/**
 * Computes a fast O(K) structural fingerprint for a StudySnapshot without serializing
 * card/source bodies (`JSON.stringify`). Used by `syncFromHost` to skip redundant store writes.
 */
export function computeSnapshotFingerprint(snapshot: StudySnapshot | null | undefined): string {
  if (!snapshot) return 'empty';

  resetHash();
  const snapRecord = snapshot as Record<string, unknown>;

  mixStr(snapshot.root);
  mixNum(snapshot.revision);
  mixStr(snapshot.fingerprint);
  mixBool(snapshot.sample?.loaded);
  mixBool(snapshot.modelReady);

  mixTag(12);
  const focus = asRecord(snapshot.focus);
  mixStr(focus?.course);
  mixStr(focus?.mode);

  mixTag(13);
  const today = asRecord(snapshot.today);
  mixNum(today?.due);
  mixNum(today?.reviewed);
  mixNum(today?.done);
  mixNum(today?.streak);
  mixNum(today?.goal);
  mixNum(today?.new);

  hashInbox(snapRecord.inbox);
  hashDecksAndProgress(snapshot.decks, snapshot.progress);
  hashSources(snapshot.sources);
  hashCourses(snapshot.courses);
  hashDrafts(snapshot.drafts);
  hashRuns(snapshot.runs);
  hashJobs(snapshot.jobs);
  hashBoundaryEntries(9, snapshot.oralExams, ORAL_FIELDS);
  hashBoundaryEntries(10, snapshot.attempts, ATTEMPT_FIELDS);
  hashSettings(snapshot);

  mixTag(14);
  const lastRun = asRecord(snapshot.lastRun);
  mixStr(lastRun?.id);
  mixStr(lastRun?.status);
  mixNum(lastRun?.index);
  mixNum(lastRun?.answered);
  mixNum(lastRun?.total);
  mixStr(lastRun?.closedAt);
  mixStr(lastRun?.submittedAt);

  mixNum(Array.isArray(snapshot.notes) ? snapshot.notes.length : -1);
  mixNum(Array.isArray(snapshot.exams) ? snapshot.exams.length : -1);
  mixNum(Array.isArray(snapshot.skeletons) ? snapshot.skeletons.length : -1);
  mixNum(Array.isArray(snapshot.examPointLists) ? snapshot.examPointLists.length : -1);
  mixNum(Array.isArray(snapshot.archivedJobs) ? snapshot.archivedJobs.length : -1);
  mixNum(Array.isArray(snapshot.bookCourses) ? snapshot.bookCourses.length : -1);

  return digestHash();
}
