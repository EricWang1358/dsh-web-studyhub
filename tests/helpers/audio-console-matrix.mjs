import { KINDS, cardOf } from './audio-console.mjs';
import { readCard as readCardOf, refuse as refuseTo } from './console-card.mjs';
import { until } from './wait.mjs';

/* What the three files of the audio console regression (S6-5) share: the n-th work of each kind, the loop that starts every kind a mode asks for, and how a test waits for
   and reads a card. The service, its fakes and their teardown are in helpers/audio-console.mjs; the three files are tests/unified-runtime-audio-console-{off,on,mixed}.test.mjs. */

const INDEX = { single: { off: 1, on: 2 }, batch: { off: 3, on: 5 }, subtitles: { off: 1, on: 2 }, review: { off: 1, on: 2 }, save: { off: 1, on: 2 }, correction: { off: 3, on: 4 } };
export const refuse = (lib, args, action = 'job.control') => refuseTo(lib.service, args, action);

/** Start every kind the mode asks for: the switch of the side set, the n-th work of that kind started. Returns [{ name, side, started }]. */
export async function startAll(lib, mode) {
  const cards = [];
  for (const [name, kind] of Object.entries(KINDS)) for (const side of mode === 'mixed' ? ['off', 'on'] : [mode]) {
    lib.set(side === 'on', kind.switchKey);
    cards.push({ name, side, kind, started: await kind.start(lib, INDEX[name][side]) });
  }
  return cards;
}

export const live = async (lib, id, what = id) => {
  await until(async () => ['queued', 'running'].includes((await cardOf(lib, id))?.status), `job ${what} to be listed as live (it is ${(await cardOf(lib, id))?.status}: ${(await cardOf(lib, id))?.stage})`, { timeoutMs: 10_000 });
  return cardOf(lib, id);
};

export const readCard = (row, card) => readCardOf(row, card);
