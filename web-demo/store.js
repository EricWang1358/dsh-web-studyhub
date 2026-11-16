import { defaults, initialReview } from '../lib/domain.js';
import { source, sampleCards as cards, stripDemoCardFields } from './content.js';
import { seedDemo } from './seed.js';

export const STORAGE_KEY = 'daily-flashcard-demo-v1';
export const LATEST_VERSION = 3, SHARD_FORMAT = 'study-sharded';
const fields = ['sources','decks','drafts','attempts','runs','oralRuns','teaching','coach','feedback','prepared','inbox','skeletons','topicGroups','notes','workflowTemplates','workflowSessions'];
export function initialState() {
  const now = new Date().toISOString();
  return Object.assign(seedDemo({
    version: 3, revision: 0, settings: { ...defaults }, courses: [],
    ...Object.fromEntries(fields.map(key => [key, []])),
    sources: [{ ...source, createdAt: now }],
    decks: [{ id: 'patterns-demo', title: 'Design patterns · understand & apply', folder: 'Design patterns', publishedAt: now,
      cards: cards.map(card => ({ ...stripDemoCardFields(card), review: initialReview(defaults) })) }],
  }), { revision: 0 });
}
export const emptyState = initialState;
let memory;
let memoryOnly = false;
let queue = Promise.resolve();
export let storageWarning = '';
const demoEn = () => { try { return (globalThis.localStorage?.getItem?.('study-ui-language') || 'en') !== 'zh'; } catch { return true; } };
function readState() {
  if (memoryOnly && memory) return structuredClone(memory);
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed.version !== 3 || fields.some(key => !Array.isArray(parsed[key]))) throw new Error('invalid demo data');
      parsed.courses = Array.isArray(parsed.courses) ? parsed.courses : [];
      const oldVersion = parsed.demoSeedVersion;
      seedDemo(parsed);
      if (oldVersion !== parsed.demoSeedVersion) persist(parsed);
      return parsed;
    }
  } catch {
    storageWarning = demoEn() ? 'Browser could not read saved demo progress; using temporary session progress.' : '浏览器无法读取保存的体验进度，当前使用临时进度。';
  }
  if (!memory) persist(initialState());
  return structuredClone(memory);
}
function persist(state) {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    storageWarning = demoEn() ? 'Browser storage is unavailable or full; progress is kept only while this tab stays open.' : '浏览器存储不可用或空间不足，进度仅在本次打开期间保留。';
    memoryOnly = true;
  }
  memory = structuredClone(state);
}
export class Store {
  constructor(root = '/demo') { this.root = root; this.collections = new Set([...fields, 'courses']); }
  registerCollection(name) { this.collections.add(name); return () => {}; }
  scoped(names) {
    const own = state => Object.fromEntries(names.map(name => [name, structuredClone(state[name] ?? (this.collections.has(name) ? [] : undefined))]));
    return Object.freeze({
      read: async () => { const state = await this.read(); return { revision: state.revision, ...own(state) }; },
      update: fn => this.update(async state => {
        const subset = own(state), result = await fn(subset);
        for (const name of names) state[name] = subset[name];
        return result;
      }),
    });
  }
  async read() { return readState(); }
  async stamp() { return String(readState().revision); }
  async update(fn) {
    const run = async () => {
      const state = readState();
      const value = await fn(state);
      state.revision++;
      persist(state);
      return structuredClone(value);
    };
    const locked = () => globalThis.navigator?.locks
      ? navigator.locks.request(STORAGE_KEY, run) : run();
    const result = queue.then(locked);
    const tail = result.catch(() => {});
    queue = tail;
    return result;
  }
}
export function resetDemo() {
  globalThis.localStorage?.removeItem(STORAGE_KEY);
  for (const key of Object.keys(globalThis.localStorage || {})) {
    if (
      key.startsWith('daily-flashcard-demo-file:')
      || key.startsWith('daily-flashcard-demo-companion-state:')
      || key.startsWith('lesson:demo-')
      || key.startsWith('study-workflow-output:/demo:')
      || key.startsWith('study-workflow-draft:/demo:')
    ) globalThis.localStorage.removeItem(key);
  }
  globalThis.sessionStorage?.removeItem("study-draft:/demo");
  memory = undefined;
  memoryOnly = false;
}
