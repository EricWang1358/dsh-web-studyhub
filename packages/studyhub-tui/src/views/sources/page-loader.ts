/**
 * Whole-page loading for the reader (#1418).
 *
 * `source.pages` and `source.get` answer in slices sized for a chat tool result (about 6000 and
 * 20000 characters) and say where the rest starts. The reader shows a page as one scrollable text,
 * so it reads on from that offset until the page ends instead of showing the first slice as if it
 * were the whole page.
 */
import type { HostCallResult } from '../../types/contracts.js';

type Fields = Record<string, unknown>;

/** One more request to the same action; `args` already carries the page or source being read. */
export type SliceCall = (args: Fields) => Promise<HostCallResult<Fields>>;

/** Upper bound on follow-up requests for one text; far beyond any real page. */
export const MAX_FOLLOW_UP_SLICES = 200;
/** Largest slice `source.get` hands out in one call. */
export const SOURCE_SLICE_CHARS = 60000;

export interface WholeText {
  text: string;
  /** True when a later slice could not be read: `text` is only the part that arrived. */
  incomplete: boolean;
}

function firstShown(value: Fields): Fields | undefined {
  return Array.isArray(value.shown) ? (value.shown[0] as Fields | undefined) : undefined;
}

/** Where the same page continues, or null when `value` reached its end (or points at another page). */
function continuationOffset(value: Fields, page: number, readFrom: number): number | null {
  const next = value.next as { from?: unknown; offset?: unknown } | undefined;
  if (!next || next.from !== page || typeof next.offset !== 'number' || !Number.isInteger(next.offset)) return null;
  return next.offset > readFrom ? next.offset : null;
}

/** The full text of the page that `first` (a `source.pages` answer for one page) only started. */
export async function readWholePage(call: SliceCall, first: Fields): Promise<WholeText> {
  const opening = firstShown(first);
  const page = Number(opening?.page);
  let text = String(opening?.text ?? '');
  let value = first;
  let readFrom = 0;
  for (let slice = 0; slice < MAX_FOLLOW_UP_SLICES; slice += 1) {
    const offset = continuationOffset(value, page, readFrom);
    if (offset === null) return { text, incomplete: false };
    const res = await call({ from: page, to: page, offset });
    const part = res.ok && res.value ? firstShown(res.value)?.text : undefined;
    if (typeof part !== 'string' || !part || !res.value) return { text, incomplete: true };
    text += part;
    value = res.value;
    readFrom = offset;
  }
  return { text, incomplete: true };
}

/** The full text of the source that `first` (a `source.get` answer from offset 0) only started. */
export async function readWholeSource(call: SliceCall, first: Fields): Promise<WholeText> {
  let text = String(first.text ?? '');
  const total = Number(first.chars ?? 0);
  for (let slice = 0; text.length < total; slice += 1) {
    if (slice >= MAX_FOLLOW_UP_SLICES) return { text, incomplete: true };
    const res = await call({ offset: text.length, limit: SOURCE_SLICE_CHARS });
    const part = res.ok && res.value ? res.value.text : undefined;
    if (typeof part !== 'string' || !part) return { text, incomplete: true };
    text += part;
  }
  return { text, incomplete: false };
}
