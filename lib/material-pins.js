/* 置顶 on the 资料 page: the rows the learner pinned, in the learner's own order.
   A pin is the row's key (lib/source-groups.js: pdf:<hash>, doc:<materialId>, audio:<batch>, source:<id>): it belongs to the material, so
   it survives a rename, a re-import of the same document and a page or part being added. The ordered list lives in the library's settings
   as `materialPins`, a new optional field: no library format version moves, and a release that does not know it keeps it as it keeps every
   other unknown setting (lib/store.js normalizeState). Keys of materials that are gone are never drawn and leave with the next write. */
import { groupSourcesByDocument } from './source-groups.js';

export const PINS_FIELD = 'materialPins';
/** A sanity bound on the stored list, not a goal: nobody pins this many, and the field is read on every snapshot. */
export const MAX_PINS = 200;

/** The pinned keys of a settings object: text only, no repeats, in order; nothing when the field is missing or malformed. */
export function pinnedKeys(settings) {
  const stored = settings?.[PINS_FIELD];
  if (!Array.isArray(stored)) return [];
  const seen = new Set();
  for (const key of stored) if (typeof key === 'string' && key.trim() && seen.size < MAX_PINS) seen.add(key);
  return [...seen];
}

/**
 * { pinned, rest } of the rows being listed: `pinned` in the learner's order, `rest` the others in their order. A key that matches no listed row
 * (the material is gone, archived, or outside the course shown) is skipped without a trace. With nothing to pin `rest` is `items` itself, so
 * the list is exactly what it was before pinning existed.
 */
export function splitPinned(items, pins) {
  if (!pins?.length) return { pinned: [], rest: items };
  const byKey = new Map(items.map(item => [item.key, item]));
  const pinned = pins.map(key => byKey.get(key)).filter(Boolean);
  if (!pinned.length) return { pinned, rest: items };
  const taken = new Set(pinned);
  return { pinned, rest: items.filter(item => !taken.has(item)) };
}

/**
 * The source.pin.move request for one step of 上移 / 下移 / 置顶到最前, among the pinned rows that are SHOWN (`shown`: their keys in order; a pin
 * hidden by the course filter keeps its place and is never a neighbour). null when there is nothing to do.
 */
export function stepRequest(shown, key, step) {
  const at = shown.indexOf(key);
  if (at < 0) return null;
  if (step === 'front') return at === 0 ? null : { key, front: true };
  if (step === 'up') return at === 0 ? null : { key, before: shown[at - 1] };
  if (step === 'down') return at === shown.length - 1 ? null : { key, after: shown[at + 1] };
  return null;
}

/** The request for dragging `key` onto `target`: it takes the target's place, so it lands after it when it came from above and before it when from below. */
export function dropRequest(shown, key, target) {
  const from = shown.indexOf(key), to = shown.indexOf(target);
  if (from < 0 || to < 0 || from === to) return null;
  return from < to ? { key, after: target } : { key, before: target };
}

const liveKeys = state => new Set(groupSourcesByDocument(state.sources, { documents: state.documents }).map(item => item.key));
const keyOf = args => {
  if (typeof args?.key !== 'string' || !args.key.trim()) throw new Error('A material key is required');
  return args.key;
};
const write = (state, pins, live) => {
  // The write is the moment dangling keys leave; a material that is only archived is still there, so its pin waits for it.
  state.settings[PINS_FIELD] = pins.filter(key => live.has(key));
  return { pins: [...state.settings[PINS_FIELD]] };
};

/** source.pin { key, pinned }: pin a material (to the END of the list) or unpin it. Idempotent. */
export function pinMaterial(state, args) {
  const key = keyOf(args);
  if (typeof args.pinned !== 'boolean') throw new Error('pinned must be true or false');
  const live = liveKeys(state), pins = pinnedKeys(state.settings).filter(entry => live.has(entry) || entry === key);
  if (!args.pinned) return write(state, pins.filter(entry => entry !== key), live);
  if (!live.has(key)) throw new Error('Material not found');
  if (pins.includes(key)) return write(state, pins, live);
  if (pins.length >= MAX_PINS) throw new Error(`At most ${MAX_PINS} materials can be pinned; unpin one first`);
  return write(state, [...pins, key], live);
}

/** source.pin.move { key, before? | after? | front? }: put a pinned material next to another pinned one, or first. */
export function moveMaterialPin(state, args) {
  const key = keyOf(args);
  const places = ['before', 'after', 'front'].filter(name => args[name] !== undefined && args[name] !== false);
  if (!places.length) throw new Error('Say where to move it: before, after or front');
  if (places.length > 1) throw new Error('Give exactly one of before, after or front');
  const live = liveKeys(state), pins = pinnedKeys(state.settings).filter(entry => live.has(entry));
  if (!pins.includes(key)) throw new Error('That material is not pinned');
  const [place] = places;
  if (place === 'front') return write(state, [key, ...pins.filter(entry => entry !== key)], live);
  const next = typeof args[place] === 'string' ? args[place] : '';
  if (!pins.includes(next)) throw new Error('The material to move next to is not pinned');
  if (next === key) return write(state, pins, live);
  const others = pins.filter(entry => entry !== key), at = others.indexOf(next) + (place === 'after' ? 1 : 0);
  return write(state, [...others.slice(0, at), key, ...others.slice(at)], live);
}
